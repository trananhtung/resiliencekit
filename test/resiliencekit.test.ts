import { jest } from "@jest/globals";
import {
  retry, RetryError,
  withTimeout, TimeoutError,
  CircuitBreaker, circuitBreaker, CircuitOpenError,
  withFallback,
  bulkhead, BulkheadFullError,
  fixed, exponential, linear, jitter, withJitter,
} from "../src/index.js";

// ── retry ─────────────────────────────────────────────────────────────────────

describe("retry — basic", () => {
  test("succeeds on first attempt", async () => {
    const result = await retry(async () => 42);
    expect(result).toBe(42);
  });

  test("succeeds after failure", async () => {
    let calls = 0;
    const result = await retry(async () => {
      if (++calls < 3) throw new Error("fail");
      return "ok";
    }, { maxAttempts: 3, delay: 0 });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  test("throws RetryError after maxAttempts", async () => {
    let calls = 0;
    await expect(retry(async () => { calls++; throw new Error("boom"); }, { maxAttempts: 3, delay: 0 }))
      .rejects.toThrow(RetryError);
    expect(calls).toBe(3);
  });

  test("RetryError contains attempt count and last error", async () => {
    try {
      await retry(async () => { throw new Error("original"); }, { maxAttempts: 2, delay: 0 });
    } catch (e) {
      expect(e).toBeInstanceOf(RetryError);
      const re = e as RetryError;
      expect(re.attempts).toBe(2);
      expect((re.lastError as Error).message).toBe("original");
    }
  });

  test("passes attempt number to fn", async () => {
    const attempts: number[] = [];
    await retry(async (attempt) => { attempts.push(attempt); if (attempt < 3) throw new Error(); }, { maxAttempts: 3, delay: 0 });
    expect(attempts).toEqual([1, 2, 3]);
  });

  test("onRetry called before each retry", async () => {
    const retries: number[] = [];
    let calls = 0;
    await retry(async () => { if (++calls < 3) throw new Error(); }, {
      maxAttempts: 3,
      delay: 0,
      onRetry: (_, attempt) => retries.push(attempt),
    });
    expect(retries).toEqual([1, 2]); // called after attempt 1 and 2
  });

  test("shouldRetry=false stops immediately", async () => {
    let calls = 0;
    await expect(
      retry(async () => { calls++; throw new TypeError("nope"); }, {
        maxAttempts: 5,
        delay: 0,
        shouldRetry: (e) => !(e instanceof TypeError),
      })
    ).rejects.toThrow(TypeError);
    expect(calls).toBe(1);
  });

  test("default maxAttempts=3", async () => {
    let calls = 0;
    await expect(retry(async () => { calls++; throw new Error(); }, { delay: 0 })).rejects.toThrow(RetryError);
    expect(calls).toBe(3);
  });
});

describe("retry — delay", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("fixed delay between retries", async () => {
    let calls = 0;
    const p = retry(async () => { if (++calls < 3) throw new Error(); }, { maxAttempts: 3, delay: fixed(100) });
    await jest.runAllTimersAsync();
    await p;
    expect(calls).toBe(3);
  });

  test("numeric delay shorthand", async () => {
    let calls = 0;
    const p = retry(async () => { if (++calls < 2) throw new Error(); }, { maxAttempts: 2, delay: 200 });
    await jest.runAllTimersAsync();
    await p;
    expect(calls).toBe(2);
  });
});

describe("retry — abort signal", () => {
  test("aborted signal stops retry immediately", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(retry(async () => { calls++; throw new Error(); }, { maxAttempts: 5, delay: 0, signal: controller.signal }))
      .rejects.toThrow();
    expect(calls).toBe(0); // aborted before first attempt
  });
});

// ── withTimeout ───────────────────────────────────────────────────────────────

describe("withTimeout", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("resolves within timeout", async () => {
    const p = withTimeout(async () => "done", 1000);
    await jest.runAllTimersAsync();
    expect(await p).toBe("done");
  });

  test("throws TimeoutError when fn is slow", async () => {
    const p = withTimeout(
      () => new Promise<never>(() => {}), // never resolves
      100
    );
    jest.advanceTimersByTime(101);
    await expect(p).rejects.toThrow(TimeoutError);
  });

  test("TimeoutError contains ms", async () => {
    const p = withTimeout(() => new Promise<never>(() => {}), 500);
    jest.advanceTimersByTime(501);
    try { await p; } catch (e) {
      expect(e).toBeInstanceOf(TimeoutError);
      expect((e as TimeoutError).ms).toBe(500);
    }
  });

  test("passes AbortSignal to fn", async () => {
    let receivedSignal: AbortSignal | undefined;
    const p = withTimeout((signal) => {
      receivedSignal = signal;
      return new Promise<never>(() => {});
    }, 100);
    jest.advanceTimersByTime(101);
    await expect(p).rejects.toThrow(TimeoutError);
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });

  test("fn error propagates (not masked as TimeoutError)", async () => {
    jest.useRealTimers(); // fn rejects immediately; no timer interaction needed
    const p = withTimeout(async () => { throw new TypeError("custom"); }, 5000);
    await expect(p).rejects.toThrow(TypeError);
  });
});

// ── CircuitBreaker ────────────────────────────────────────────────────────────

describe("CircuitBreaker — state machine", () => {
  test("starts CLOSED", () => {
    const cb = new CircuitBreaker();
    expect(cb.currentState).toBe("CLOSED");
    expect(cb.isClosed).toBe(true);
  });

  test("opens after failureThreshold failures", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    for (let i = 0; i < 3; i++) {
      await cb.call(async () => { throw new Error(); }).catch(() => {});
    }
    expect(cb.currentState).toBe("OPEN");
    expect(cb.isOpen).toBe(true);
  });

  test("rejects immediately when OPEN", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2 });
    await cb.call(async () => { throw new Error(); }).catch(() => {});
    await cb.call(async () => { throw new Error(); }).catch(() => {});
    await expect(cb.call(async () => "ok")).rejects.toThrow(CircuitOpenError);
  });

  test("transitions to HALF_OPEN after halfOpenAfter, then closes on success", async () => {
    jest.useFakeTimers();
    const cb = new CircuitBreaker({ failureThreshold: 1, successThreshold: 1, halfOpenAfter: 1000 });
    await cb.call(async () => { throw new Error(); }).catch(() => {});
    expect(cb.currentState).toBe("OPEN");
    jest.advanceTimersByTime(1001);
    // Trigger transition check via probe call — probe succeeds → CLOSED
    const result = await cb.call(async () => "probe");
    expect(result).toBe("probe");
    expect(cb.currentState).toBe("CLOSED");
    jest.useRealTimers();
  });

  test("HALF_OPEN: success closes circuit", async () => {
    jest.useFakeTimers();
    const cb = new CircuitBreaker({ failureThreshold: 1, successThreshold: 1, halfOpenAfter: 100 });
    await cb.call(async () => { throw new Error(); }).catch(() => {});
    jest.advanceTimersByTime(101);
    await cb.call(async () => "ok");
    expect(cb.currentState).toBe("CLOSED");
    jest.useRealTimers();
  });

  test("HALF_OPEN: failure re-opens circuit", async () => {
    jest.useFakeTimers();
    const cb = new CircuitBreaker({ failureThreshold: 1, halfOpenAfter: 100 });
    await cb.call(async () => { throw new Error(); }).catch(() => {});
    jest.advanceTimersByTime(101);
    await cb.call(async () => { throw new Error(); }).catch(() => {});
    expect(cb.currentState).toBe("OPEN");
    jest.useRealTimers();
  });

  test("onStateChange called on transitions", async () => {
    const transitions: string[] = [];
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      onStateChange: (from, to) => transitions.push(`${from}→${to}`),
    });
    await cb.call(async () => { throw new Error(); }).catch(() => {});
    expect(transitions).toEqual(["CLOSED→OPEN"]);
  });

  test("reset() returns to CLOSED", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    await cb.call(async () => { throw new Error(); }).catch(() => {});
    expect(cb.isOpen).toBe(true);
    cb.reset();
    expect(cb.isClosed).toBe(true);
    expect(await cb.call(async () => 42)).toBe(42);
  });
});

describe("circuitBreaker() function wrapper", () => {
  test("wraps function with .state and .reset", async () => {
    const fn = circuitBreaker(async (x: number) => x * 2, { failureThreshold: 2 });
    expect(fn.state).toBe("CLOSED");
    expect(await fn(5)).toBe(10);
  });

  test(".state updates on failure", async () => {
    const fn = circuitBreaker(async () => { throw new Error(); }, { failureThreshold: 1 });
    await fn().catch(() => {});
    expect(fn.state).toBe("OPEN");
    fn.reset();
    expect(fn.state).toBe("CLOSED");
  });
});

// ── withFallback ──────────────────────────────────────────────────────────────

describe("withFallback", () => {
  test("returns fn result on success", async () => {
    const fn = withFallback(async () => 42, 0);
    expect(await fn()).toBe(42);
  });

  test("returns fallback value on error", async () => {
    const fn = withFallback(async () => { throw new Error(); }, 99);
    expect(await fn()).toBe(99);
  });

  test("calls fallback function with error", async () => {
    const err = new Error("boom");
    const fn = withFallback(
      async () => { throw err; },
      (e) => `fallback: ${(e as Error).message}`
    );
    expect(await fn()).toBe("fallback: boom");
  });

  test("async fallback function", async () => {
    const fn = withFallback(
      async (): Promise<number> => { throw new Error(); },
      async () => 42
    );
    expect(await fn()).toBe(42);
  });
});

// ── bulkhead ──────────────────────────────────────────────────────────────────

describe("bulkhead", () => {
  test("limits concurrent executions", async () => {
    let concurrent = 0;
    let maxSeen = 0;
    const fn = bulkhead(async () => {
      concurrent++;
      maxSeen = Math.max(maxSeen, concurrent);
      await new Promise(r => setTimeout(r, 10));
      concurrent--;
    }, { maxConcurrency: 2 });

    await Promise.all([fn(), fn(), fn(), fn()]);
    expect(maxSeen).toBeLessThanOrEqual(2);
  });

  test("throws BulkheadFullError when queue is full", async () => {
    const fn = bulkhead(
      () => new Promise<void>(r => setTimeout(r, 100)),
      { maxConcurrency: 1, maxQueueLength: 0 }
    );
    fn(); // running
    await expect(fn()).rejects.toThrow(BulkheadFullError);
  });

  test("queued calls execute after slot opens", async () => {
    const order: number[] = [];
    const fn = bulkhead(async (n: number) => {
      await new Promise(r => setTimeout(r, 10));
      order.push(n);
    }, { maxConcurrency: 1 });

    await Promise.all([fn(1), fn(2), fn(3)]);
    expect(order).toEqual([1, 2, 3]);
  });
});

// ── backoff strategies ────────────────────────────────────────────────────────

describe("backoff strategies", () => {
  test("fixed returns constant", () => {
    const b = fixed(100);
    expect(b(1, null)).toBe(100);
    expect(b(5, null)).toBe(100);
  });

  test("exponential doubles each attempt", () => {
    const b = exponential(100, 2);
    expect(b(1, null)).toBe(100);
    expect(b(2, null)).toBe(200);
    expect(b(3, null)).toBe(400);
  });

  test("exponential respects maxMs", () => {
    const b = exponential(100, 2, 300);
    expect(b(1, null)).toBe(100);
    expect(b(2, null)).toBe(200);
    expect(b(3, null)).toBe(300);
    expect(b(4, null)).toBe(300);
  });

  test("linear grows linearly", () => {
    const b = linear(100, 50);
    expect(b(1, null)).toBe(100);
    expect(b(2, null)).toBe(150);
    expect(b(3, null)).toBe(200);
  });

  test("jitter returns value in range", () => {
    const b = jitter(100, 200);
    for (let i = 0; i < 20; i++) {
      const v = b(1, null);
      expect(v).toBeGreaterThanOrEqual(100);
      expect(v).toBeLessThanOrEqual(200);
    }
  });

  test("withJitter adds noise to base strategy", () => {
    const base = fixed(1000);
    const noisy = withJitter(base, 100);
    for (let i = 0; i < 20; i++) {
      const v = noisy(1, null);
      expect(v).toBeGreaterThanOrEqual(900);
      expect(v).toBeLessThanOrEqual(1100);
    }
  });
});

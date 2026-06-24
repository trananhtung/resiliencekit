/** Backoff strategy: given attempt number (1-based), returns delay in ms. */
export type BackoffFn = (attempt: number, error: unknown) => number;

/** Fixed delay every retry. */
export function fixed(ms: number): BackoffFn {
  return () => ms;
}

/**
 * Exponential backoff: initialMs * multiplier^(attempt-1), capped at maxMs.
 * @example exponential(100, 2, 10_000) → 100, 200, 400, 800, …
 */
export function exponential(initialMs: number, multiplier = 2, maxMs = Infinity): BackoffFn {
  return (attempt) => Math.min(initialMs * multiplier ** (attempt - 1), maxMs);
}

/**
 * Linear backoff: initialMs + (attempt-1) * stepMs, capped at maxMs.
 * @example linear(100, 50, 500) → 100, 150, 200, 250, …
 */
export function linear(initialMs: number, stepMs: number, maxMs = Infinity): BackoffFn {
  return (attempt) => Math.min(initialMs + (attempt - 1) * stepMs, maxMs);
}

/**
 * Jitter: randomizes between minMs and maxMs each retry (full jitter).
 * Good for preventing thundering-herd on shared services.
 */
export function jitter(minMs: number, maxMs: number): BackoffFn {
  return () => minMs + Math.random() * (maxMs - minMs);
}

/**
 * Decorrelated jitter (AWS recommended): randomized, slightly growing.
 * Each delay = random(minMs, prev * 3), capped at capMs.
 */
export function decorrelatedJitter(minMs: number, capMs: number): BackoffFn {
  let prev = minMs;
  return () => {
    prev = Math.min(capMs, minMs + Math.random() * (prev * 3 - minMs));
    return prev;
  };
}

/**
 * Add uniform jitter to another strategy (±jitterMs).
 * @example withJitter(exponential(100, 2), 50) — adds ±50ms noise
 */
export function withJitter(base: BackoffFn, jitterMs: number): BackoffFn {
  return (attempt, err) => {
    const delay = base(attempt, err);
    return Math.max(0, delay + (Math.random() * 2 - 1) * jitterMs);
  };
}

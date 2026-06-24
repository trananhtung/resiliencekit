import { CircuitOpenError } from "./errors.js";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  /** Number of consecutive failures to open the circuit. Default: 5. */
  failureThreshold?: number;
  /** Number of consecutive successes to close from HALF_OPEN. Default: 2. */
  successThreshold?: number;
  /** Milliseconds to wait in OPEN before trying HALF_OPEN. Default: 30_000. */
  halfOpenAfter?: number;
  /** Called when state changes. */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failures = 0;
  private successes = 0;
  private openedAt: number | null = null;

  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly halfOpenAfter: number;
  private readonly onStateChange?: (from: CircuitState, to: CircuitState) => void;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.successThreshold = options.successThreshold ?? 2;
    this.halfOpenAfter = options.halfOpenAfter ?? 30_000;
    this.onStateChange = options.onStateChange;
  }

  get currentState(): CircuitState { return this.state; }
  get isOpen(): boolean { return this.state === "OPEN"; }
  get isClosed(): boolean { return this.state === "CLOSED"; }

  /** Execute a function through the circuit breaker. */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    this._maybeTransitionToHalfOpen();

    if (this.state === "OPEN") throw new CircuitOpenError();

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure();
      throw err;
    }
  }

  /** Manually reset to CLOSED state. */
  reset(): void {
    this._transition("CLOSED");
    this.failures = 0;
    this.successes = 0;
    this.openedAt = null;
  }

  private _maybeTransitionToHalfOpen(): void {
    if (this.state === "OPEN" && this.openedAt !== null) {
      if (Date.now() - this.openedAt >= this.halfOpenAfter) {
        this._transition("HALF_OPEN");
        this.successes = 0;
      }
    }
  }

  private _onSuccess(): void {
    if (this.state === "HALF_OPEN") {
      this.successes++;
      if (this.successes >= this.successThreshold) {
        this.failures = 0;
        this._transition("CLOSED");
      }
    } else {
      this.failures = 0;
    }
  }

  private _onFailure(): void {
    if (this.state === "HALF_OPEN") {
      this._transition("OPEN");
      this.openedAt = Date.now();
    } else {
      this.failures++;
      if (this.failures >= this.failureThreshold) {
        this._transition("OPEN");
        this.openedAt = Date.now();
      }
    }
  }

  private _transition(to: CircuitState): void {
    if (this.state === to) return;
    const from = this.state;
    this.state = to;
    this.onStateChange?.(from, to);
  }
}

/** Create a circuit breaker that wraps an async function. */
export function circuitBreaker<T extends (...args: never[]) => Promise<unknown>>(
  fn: T,
  options?: CircuitBreakerOptions
): T & { readonly state: CircuitState; reset(): void } {
  const cb = new CircuitBreaker(options);
  const wrapped = ((...args: Parameters<T>) => cb.call(() => fn(...args))) as T & { readonly state: CircuitState; reset(): void };
  Object.defineProperty(wrapped, "state", { get: () => cb.currentState });
  wrapped.reset = () => cb.reset();
  return wrapped;
}

export class RetryError extends Error {
  readonly attempts: number;
  readonly lastError: unknown;
  constructor(attempts: number, lastError: unknown) {
    const msg = lastError instanceof Error ? lastError.message : String(lastError);
    super(`Failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${msg}`);
    this.name = "RetryError";
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

export class TimeoutError extends Error {
  readonly ms: number;
  constructor(ms: number) {
    super(`Operation timed out after ${ms}ms`);
    this.name = "TimeoutError";
    this.ms = ms;
  }
}

export class CircuitOpenError extends Error {
  constructor() {
    super("Circuit breaker is OPEN — call rejected");
    this.name = "CircuitOpenError";
  }
}

export class BulkheadFullError extends Error {
  constructor() {
    super("Bulkhead queue is full — call rejected");
    this.name = "BulkheadFullError";
  }
}

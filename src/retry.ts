import { RetryError } from "./errors.js";
import { fixed, type BackoffFn } from "./backoff.js";

export interface RetryOptions {
  /** Maximum number of attempts (including the first). Default: 3. */
  maxAttempts?: number;
  /** Delay between attempts in ms, or a backoff function. Default: fixed(0). */
  delay?: number | BackoffFn;
  /** Return true to retry, false to rethrow immediately. Default: retry all errors. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Called before each retry (not before the first attempt). */
  onRetry?: (error: unknown, attempt: number) => void;
  /** AbortSignal to cancel retries. */
  signal?: AbortSignal;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(id); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); }, { once: true });
  });

/**
 * Retry an async function with configurable attempts, delay, and backoff.
 *
 * @example
 * // Retry 5 times with exponential backoff
 * const data = await retry(() => fetch(url).then(r => r.json()), {
 *   maxAttempts: 5,
 *   delay: exponential(200, 2, 10_000),
 *   shouldRetry: (err) => !(err instanceof AuthError),
 * });
 */
export async function retry<T>(
  fn: (attempt: number, signal: AbortSignal | undefined) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    delay = 0,
    shouldRetry = () => true,
    onRetry,
    signal,
  } = options;

  const backoff: BackoffFn = typeof delay === "number" ? fixed(delay) : delay;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    try {
      return await fn(attempt, signal);
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) break;
      if (!shouldRetry(err, attempt)) throw err;
      const ms = backoff(attempt, err);
      onRetry?.(err, attempt);
      if (ms > 0) await sleep(ms, signal);
    }
  }

  throw new RetryError(maxAttempts, lastError);
}

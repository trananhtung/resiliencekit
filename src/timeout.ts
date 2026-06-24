import { TimeoutError } from "./errors.js";

/**
 * Run an async function with a timeout. If it doesn't resolve in `ms` milliseconds,
 * the AbortSignal is fired and a TimeoutError is thrown.
 *
 * The function receives the AbortSignal so it can cancel in-flight work (e.g., fetch).
 *
 * @example
 * const data = await withTimeout(
 *   (signal) => fetch(url, { signal }).then(r => r.json()),
 *   5000
 * );
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new TimeoutError(ms));
      reject(new TimeoutError(ms));
    }, ms);
  });

  try {
    return await Promise.race([fn(controller.signal), timeoutPromise]);
  } catch (err) {
    if (err instanceof TimeoutError) throw err;
    // If fn threw because signal was aborted, surface the TimeoutError
    if (controller.signal.aborted && controller.signal.reason instanceof TimeoutError) {
      throw controller.signal.reason;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    // Abort to clean up if fn is still running but timeoutPromise resolved first
    if (!controller.signal.aborted) controller.abort();
  }
}

/** Create a pre-fired AbortSignal that fires after `ms` milliseconds. */
export function abortAfter(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new TimeoutError(ms)), ms);
  return controller.signal;
}

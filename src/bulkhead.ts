import { BulkheadFullError } from "./errors.js";

export interface BulkheadOptions {
  /** Maximum concurrent executions. Default: 10. */
  maxConcurrency?: number;
  /** Maximum queued waiting calls. Default: Infinity. */
  maxQueueLength?: number;
}

/**
 * Limit concurrent async calls. Excess calls queue; if the queue is full, throws BulkheadFullError.
 * Inspired by Polly Bulkhead isolation / Java Semaphore.
 *
 * @example
 * const limited = bulkhead(fetchUser, { maxConcurrency: 3, maxQueueLength: 10 });
 * // At most 3 fetchUser calls run simultaneously; up to 10 more can queue.
 */
export function bulkhead<T extends (...args: never[]) => Promise<unknown>>(
  fn: T,
  options: BulkheadOptions = {}
): T {
  const maxConcurrency = options.maxConcurrency ?? 10;
  const maxQueueLength = options.maxQueueLength ?? Infinity;

  let running = 0;
  const queue: Array<() => void> = [];

  const tryNext = () => {
    if (queue.length > 0 && running < maxConcurrency) {
      running++;
      queue.shift()!();
    }
  };

  const wrapped = (...args: Parameters<T>): ReturnType<T> => {
    return new Promise<unknown>((resolve, reject) => {
      if (running < maxConcurrency) {
        running++;
        fn(...args).then(resolve, reject).finally(() => { running--; tryNext(); });
      } else if (queue.length < maxQueueLength) {
        queue.push(() => { fn(...args).then(resolve, reject).finally(() => { running--; tryNext(); }); });
      } else {
        reject(new BulkheadFullError());
      }
    }) as ReturnType<T>;
  };
  return wrapped as unknown as T;
}

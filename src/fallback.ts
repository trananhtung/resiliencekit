/**
 * Wrap an async function with a fallback value or function invoked on any error.
 *
 * @example
 * const safeGet = withFallback(() => fetchUser(id), { id: "unknown", name: "Guest" });
 * const safeGet2 = withFallback(() => fetchUser(id), (err) => defaultUser(err));
 */
export function withFallback<T>(
  fn: () => Promise<T>,
  fallback: T | ((err: unknown) => T | Promise<T>)
): () => Promise<T> {
  return async () => {
    try {
      return await fn();
    } catch (err) {
      return typeof fallback === "function"
        ? (fallback as (err: unknown) => T | Promise<T>)(err)
        : fallback;
    }
  };
}

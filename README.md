# resiliencekit

[![All Contributors](https://img.shields.io/badge/all_contributors-1-orange.svg?style=flat-square)](#contributors-)

Composable resilience patterns for async TypeScript: `retry` (with exponential backoff, jitter, per-error control), `withTimeout` (AbortSignal propagation), `CircuitBreaker`, `withFallback`, and `bulkhead`. Zero dependencies.

[![npm](https://img.shields.io/npm/v/resiliencekit)](https://www.npmjs.com/package/resiliencekit)
[![npm downloads](https://img.shields.io/npm/dw/resiliencekit)](https://www.npmjs.com/package/resiliencekit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Why resiliencekit?

| Library | Problem |
|---------|---------|
| `cockatiel` | No composable stop/wait strategies, no Hedging/RateLimiter |
| `async-retry` | Retry only, no circuit breaker, no timeout |
| `p-retry` | Retry only; no TTL-based stopping |
| **resiliencekit** | Full suite: retry + circuit breaker + timeout + fallback + bulkhead |

Inspired by [Polly](https://github.com/App-vNext/Polly) (.NET, 14.2k★) and [Tenacity](https://github.com/jd/tenacity) (Python, 8.7k★).

## Install

```bash
npm install resiliencekit
```

## Quick start

```ts
import { retry, withTimeout, circuitBreaker, withFallback, exponential } from "resiliencekit";

// Retry with exponential backoff
const data = await retry(
  async () => fetch("/api/data").then(r => r.json()),
  { maxAttempts: 5, delay: exponential(200, 2, 10_000) }
);

// Timeout with AbortSignal propagation to fetch
const result = await withTimeout(
  (signal) => fetch("/api/data", { signal }).then(r => r.json()),
  5000
);

// Circuit breaker — auto-opens after 5 failures, tries again after 30s
const safeFetch = circuitBreaker(fetchUser, { failureThreshold: 5, halfOpenAfter: 30_000 });
const user = await safeFetch(id);

// Fallback on any error
const safeUser = withFallback(() => fetchUser(id), { id: "unknown", name: "Guest" });
const user = await safeUser();
```

## API

### `retry(fn, options?)`

Retry an async function. The function receives the attempt number and an optional AbortSignal.

```ts
import { retry, exponential, RetryError } from "resiliencekit";

const result = await retry(
  async (attempt, signal) => {
    console.log(`Attempt ${attempt}`);
    return fetch(url, { signal }).then(r => r.json());
  },
  {
    maxAttempts: 5,          // total attempts including first (default: 3)
    delay: exponential(200, 2, 10_000), // 200ms, 400ms, 800ms, …, max 10s
    shouldRetry: (err) => !(err instanceof AuthError), // don't retry auth errors
    onRetry: (err, attempt) => console.warn(`Retry ${attempt}:`, err),
    signal: controller.signal, // cancel via AbortController
  }
);
```

On exhaustion, throws `RetryError` with `.attempts` and `.lastError`.

### Backoff strategies

```ts
import { fixed, exponential, linear, jitter, withJitter } from "resiliencekit";

fixed(100)                    // always 100ms
exponential(100, 2)           // 100, 200, 400, 800, …
exponential(100, 2, 5_000)    // capped at 5s
linear(100, 50)               // 100, 150, 200, 250, …
jitter(100, 500)              // random between 100–500ms per retry
withJitter(exponential(100), 50)  // exponential ±50ms noise
```

### `withTimeout(fn, ms)`

Wrap an async function with a deadline. The function receives an `AbortSignal` — pass it to `fetch` or other cancellable APIs.

```ts
import { withTimeout, TimeoutError } from "resiliencekit";

const result = await withTimeout(
  (signal) => fetch("/api", { signal }).then(r => r.json()),
  5000 // 5 second deadline
);
// Throws TimeoutError (with .ms) if not resolved in time
```

### `CircuitBreaker`

Protects degraded services by failing fast once a threshold is reached, then probing recovery.

```ts
import { CircuitBreaker } from "resiliencekit";

const cb = new CircuitBreaker({
  failureThreshold: 5,   // open after 5 consecutive failures
  successThreshold: 2,   // close again after 2 consecutive successes in HALF_OPEN
  halfOpenAfter: 30_000, // try HALF_OPEN after 30s
  onStateChange: (from, to) => console.log(`Circuit: ${from} → ${to}`),
});

try {
  const result = await cb.call(() => fetchUser(id));
} catch (e) {
  if (e instanceof CircuitOpenError) {
    // fast fail — circuit is OPEN
  }
}

cb.currentState; // "CLOSED" | "OPEN" | "HALF_OPEN"
cb.reset();      // manually reset to CLOSED
```

**Function wrapper** — wraps a function directly:

```ts
import { circuitBreaker } from "resiliencekit";

const safeFetch = circuitBreaker(fetchUser, { failureThreshold: 3 });
await safeFetch(id);        // same signature as fetchUser
safeFetch.state;            // circuit state
safeFetch.reset();          // reset circuit
```

### `withFallback(fn, fallback)`

Catch all errors and return a fallback value or computed value.

```ts
import { withFallback } from "resiliencekit";

// Static fallback value
const safe = withFallback(() => fetchConfig(), defaultConfig);
const config = await safe();

// Dynamic fallback (with error)
const safe2 = withFallback(
  () => fetchUser(id),
  (err) => ({ id, name: "Guest", error: err })
);
```

### `bulkhead(fn, options)`

Limit concurrent executions, queuing excess calls. Throws `BulkheadFullError` if the queue is full.

```ts
import { bulkhead, BulkheadFullError } from "resiliencekit";

const limited = bulkhead(processImage, {
  maxConcurrency: 4,    // max 4 simultaneous calls
  maxQueueLength: 20,   // queue up to 20 more; beyond that → BulkheadFullError
});

// 100 calls → 4 run now, up to 20 queue, rest rejected
const results = await Promise.allSettled(images.map(img => limited(img)));
```

## Combining patterns

```ts
import { retry, withTimeout, circuitBreaker, withFallback, exponential } from "resiliencekit";

// Outer: circuit breaker → protects service from being hammered
// Middle: timeout → each attempt has 5s deadline
// Inner: retry → automatic retry with backoff

const cb = circuitBreaker(
  (id: string) => withTimeout(
    (signal) => fetch(`/api/users/${id}`, { signal }).then(r => r.json()),
    5000
  ),
  { failureThreshold: 10, halfOpenAfter: 60_000 }
);

const getUser = withFallback(
  (id: string) => retry(() => cb(id), { maxAttempts: 3, delay: exponential(500, 2) }),
  (err) => ({ error: String(err), id: "unknown" })
);

const user = await getUser("user-123");
```

## Errors

| Error | Thrown by |
|-------|-----------|
| `RetryError` | `retry()` — exhausted attempts |
| `TimeoutError` | `withTimeout()` — deadline exceeded |
| `CircuitOpenError` | `CircuitBreaker.call()` / `circuitBreaker()` — circuit is OPEN |
| `BulkheadFullError` | `bulkhead()` — queue is full |

## Contributors ✨

This project follows the [all-contributors](https://github.com/all-contributors/all-contributors) specification. Contributions of any kind are welcome — code, docs, bug reports, ideas, reviews! See the [emoji key](https://allcontributors.org/docs/en/emoji-key) for how each contribution is recognized, and open a PR or issue to get involved.

Thanks goes to these wonderful people:

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table>
  <tbody>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/trananhtung"><img src="https://avatars.githubusercontent.com/u/30992229?v=4?s=100" width="100px;" alt="Tung Tran"/><br /><sub><b>Tung Tran</b></sub></a><br /><a href="https://github.com/trananhtung/resiliencekit/commits?author=trananhtung" title="Code">💻</a> <a href="#maintenance-trananhtung" title="Maintenance">🚧</a></td>
    </tr>
  </tbody>
</table>

<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->

<!-- ALL-CONTRIBUTORS-LIST:END -->

## License

MIT

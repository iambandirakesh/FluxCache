# FluxCache

Predictable caching, request deduplication and explicit invalidation for React
data fetching. No API keys, no accounts, no telemetry, no persistence.

FluxCache is built on three rules:

1. **Fetch once.** Concurrent consumers of the same key share one request.
2. **Never let old data win.** Responses from superseded requests are discarded,
   not merged.
3. **Cache boundaries are explicit.** Freshness, invalidation and authentication
   scopes are configuration you can read and test, not hidden heuristics.

> **Status: Phase C.** The core cache engine, React `useQuery`, bounded
> prefetching, `usePrefetch`, `useMutation`, `useInvalidate`, prefetch
> effectiveness metrics and a reproducible benchmark harness are implemented
> and tested. Benchmarks are descriptive only; no performance claims are made.

## Install

```bash
npm install flux-cache
# or: pnpm add flux-cache / yarn add flux-cache
```

React 18.3 and 19 are supported. React is an optional peer dependency: the core
client works without it.

## Quick start

```tsx
import { createFluxCache } from 'flux-cache';
import { FluxCacheProvider } from 'flux-cache/react';
import { useQuery } from 'flux-cache/react';

type Product = { id: string; name: string };

const client = createFluxCache();

function App() {
  return (
    <FluxCacheProvider client={client}>
      <ProductList />
    </FluxCacheProvider>
  );
}

function ProductList() {
  const products = useQuery({
    queryKey: ['products'],
    queryFn: async ({ signal }) => {
      const response = await fetch('/api/products', { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as Product[];
    },
  });

  if (products.isLoading) return <p>Loading…</p>;
  if (products.isError) return <p role="alert">Could not load products</p>;
  return (
    <ul>
      {products.data?.map((product) => (
        <li key={product.id}>{product.name}</li>
      ))}
    </ul>
  );
}
```

Every `queryFn` receives `{ queryKey, signal }`. Always pass `signal` to
`fetch` so cancellation and supersession stop the request when possible.

## Runnable example

[`examples/react-demo`](examples/react-demo) is a Vite + React app that uses the
built package through its public entry points and a deterministic in-memory API.
It demonstrates loading/success/error states, hover/focus prefetching, cache
reuse across navigation, manual refetch, invalidation after a mutation,
query-key changes, authentication-scope switching and a live diagnostics panel
with prefetch consumption metrics.

```bash
pnpm install
pnpm build
pnpm example:dev       # http://localhost:5173
```

See [examples/react-demo/README.md](examples/react-demo/README.md) for the guided
tour. The project's `pnpm verify` also typechecks and builds the example.

## Cache semantics

| State            | Condition                              | What a read sees                                                  |
| ---------------- | -------------------------------------- | ----------------------------------------------------------------- |
| missing          | no entry                               | nothing; an observer mount starts a request                       |
| fresh            | not dirty and younger than `staleTime` | cached data, no request                                           |
| stale            | dirty or older than `staleTime`        | cached data immediately plus one background request when observed |
| expired          | idle longer than `gcTime`              | entry removed; behaves as missing                                 |
| error, with data | last refresh failed                    | last good data, `error` set, `status: 'success'`                  |
| error, no data   | first request failed                   | `status: 'error'`, `error` set                                    |

Rules that follow from this:

- Renders, cache reads and diagnostic subscriptions never fetch.
- Becoming stale does not poll or refetch; a mount, `refetch`, `invalidate` or
  prefetch is required.
- A failed background refresh never removes the last good data or moves
  `dataUpdatedAt`.
- `staleTime` and `gcTime` are independent. GC never removes an observed entry
  or one with a request in flight.

### Defaults

| Option       | Default          | Meaning                                                     |
| ------------ | ---------------- | ----------------------------------------------------------- |
| `staleTime`  | `30_000` ms      | Data is reused without a request for this long              |
| `gcTime`     | `300_000` ms     | Idle lifetime before an entry is removed                    |
| `retry`      | `2`              | Retries after the first attempt (3 attempts total)          |
| retry delay  | 1s, 2s (cap 30s) | Exponential, no jitter by default                           |
| `maxEntries` | `500`            | Idle entries kept; LRU eviction, observed entries protected |     | `retryOn` | network, 408, 429, 5xx | 4xx errors are not retried; errors without an HTTP status are treated as transient |

**The 30s default is a deliberate trade-off.** It makes cached data useful for
navigation and makes prefetching worthwhile. Data that changes quickly or is
sensitive should set `staleTime: 0` so every mount revalidates:

```ts
useQuery({ queryKey: ['balance'], queryFn, staleTime: 0 });
```

## Request lifecycle

- One request per entry is commit-eligible. Requests superseded by a newer
  generation continue at the transport level but can never write to the cache.
- A request starts only when data is missing or stale; consumers join the
  active request instead of starting another.
- `refetch()` and `refetchQueries()` always bypass freshness and start a new
  generation. Force semantics never join.
- Invalidation marks the entry dirty and discards the active response. A late
  response cannot make the entry fresh.
- Retries belong to the same logical request and stop on cancellation,
  supersession, scope change or a non-retryable error.

## Prefetching

Prefetching warms the cache for a key the user is likely to open next. It does
not subscribe to the key, render anything, or change observer state.

```tsx
import { usePrefetch } from 'flux-cache/react';

function ProductCard({ product }: { product: Product }) {
  const prefetch = usePrefetch({
    queryKey: ['product', product.id],
    queryFn: ({ signal }) =>
      fetch(`/api/products/${product.id}`, { signal }).then((response) => response.json()),
    delay: 120,
    priority: 'high',
  });

  return (
    <a
      href={`/products/${product.id}`}
      onPointerEnter={prefetch}
      onPointerLeave={prefetch.cancel}
      onFocus={prefetch}
      onBlur={prefetch.cancel}
    >
      {product.name}
    </a>
  );
}
```

`usePrefetch` waits `delay` milliseconds after a hover or focus, debounces
repeated triggers and ignores touch pointers. Leaving the element, blurring it,
or calling `cancel()` clears the delay and aborts queued or running work.
Unmounting alone only clears the delay, so a prefetch already started can
finish as cache warming and be joined by the next route. An observer that joins
the request with keep-alive semantics also keeps it alive; a prefetch never
aborts shared work.

The imperative form returns the same `QueryOutcome` contract as `fetchQuery`
and never rejects:

```ts
const controller = new AbortController();
const outcome = await client.prefetchQuery(['product', id], queryFn, {
  priority: 'high',
  signal: controller.signal,
});
```

### Scheduler

```ts
const client = createFluxCache({
  prefetch: {
    enabled: true, // global switch
    concurrency: 4, // running prefetch jobs
    queueLimit: 100, // queued jobs; running jobs do not count
    respectSaveData: true,
    respectSlowNetwork: true,
    slowConnections: ['slow-2g', '2g'],
  },
});
```

| Setting              | Default             | Behavior                                              |
| -------------------- | ------------------- | ----------------------------------------------------- |
| `enabled`            | `true`              | `false` resolves prefetches as `skipped` / `disabled` |
| `concurrency`        | `4`                 | Maximum jobs fetching at once                         |
| `queueLimit`         | `100`               | Maximum queued jobs; positive integer                 |
| `respectSaveData`    | `true`              | Skip when `navigator.connection.saveData` is on       |
| `respectSlowNetwork` | `true`              | Skip when `effectiveType` is in `slowConnections`     |
| `slowConnections`    | `['slow-2g', '2g']` | Values that count as slow                             |

Priorities are `high`, `normal` (default) and `low`. Jobs run highest priority
first, FIFO within a priority. Equivalent jobs in the same scope and key are
deduplicated, even when their options differ; the first queued job wins.

Queue behavior is deterministic:

- A job revalidates scope, cancellation, freshness and in-flight work when it
  leaves the queue. Fresh data skips the job (`fresh`); an active request is
  joined instead of duplicated.
- The global switch and network safeguards are checked before freshness, so a
  skipped prefetch reports `disabled`, `save-data` or `slow-network` even when
  matching data is already cached.
- When the queue is full, a new job evicts the lowest-priority queued job only
  if that job's priority is strictly lower than the new job's. Among equally
  low-priority candidates, the oldest queued job is evicted. Otherwise the new
  job resolves `skipped` / `queue-full`. Running jobs are never evicted.
- `cancelQueries` settles matching jobs as `cancelled`; `removeQueries` and
  `clear` settle them as `removed`; a scope change settles every job as
  `scope-changed` with no data.
- Queue capacity and concurrency are enforced without timers. Every job settles
  exactly once, including deduplicated, evicted, skipped, failed and aborted
  jobs.

### Scope, freshness and generation safety

A prefetch is only a speculative `fetchQuery`. It installs the job under the
current authentication scope, starts the current request generation, and obeys
the same commit rules as an observer. A queued job cannot start after a scope
switch, a removed entry cannot be revived by a queued job, and a response that
started before an invalidation or `setQueryData` cannot overwrite newer data.

### Prefetch effectiveness

A prefetch is only useful if a real consumer reads it while it is still fresh.
`getStats()` reports a privacy-safe account of that work:

| Counter                   | Meaning                                                                 |
| ------------------------- | ----------------------------------------------------------------------- |
| `prefetchProduced`        | Successful cache commits from requests started by a prefetch job.       |
| `prefetchConsumed`        | Produced prefetches claimed by an observer or a `fetchQuery` cache hit. |
| `prefetchWasted`          | Produced prefetches that expired, were replaced, or were removed first. |
| `prefetchPending`         | Produced minus consumed minus wasted.                                   |
| `prefetchConsumptionRate` | `consumed / (consumed + wasted)`, or `0` when nothing completed.        |

A prefetch that joins an existing observer request is not counted as produced:
it created no cache value of its own. A second prefetch reading a fresh value is
also not a consumer. The rate excludes pending work, so it only describes
prefetches that have already settled into consumed or wasted.

Waste is recorded when the freshness timer expires, a key is invalidated, a
newer request generation starts, `setQueryData` overwrites the value, or the
entry is removed, garbage-collected, evicted or dropped by a scope change. The
runnable example renders these counters in its diagnostics panel and shows only
event types and reasons, never keys, payloads or scope values.

Network hints are read lazily from `navigator.connection` when present. During
SSR, or where the API is unavailable, prefetches proceed normally. Tests and
non-browser runtimes can inject hints with `networkInfo`, and all safeguards can
be disabled through `prefetch`:

```ts
const client = createFluxCache({
  networkInfo: () => ({ saveData: false, effectiveType: '4g' }),
});
```

## Mutations

`useMutation` runs one latest-wins mutation per hook instance. A new mutation
aborts and settles the previous one as `superseded`; every caller receives an
outcome. Requests continue after unmount by default, while the unmounted hook
stops receiving state updates.

```tsx
import { useInvalidate, useMutation } from 'flux-cache/react';

function RenameProduct({ productId }: { productId: string }) {
  const invalidate = useInvalidate();
  const rename = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      const response = await fetch(`/api/products/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as { id: string; name: string };
    },
    onSuccess: async (_product, { id }) => {
      await invalidate(['product', id], { exact: true });
      await invalidate(['products']);
    },
  });

  return (
    <button
      type="button"
      disabled={rename.isPending}
      onClick={() => rename.mutate({ id: productId, name: 'New name' })}
    >
      {rename.isPending ? 'Saving…' : 'Rename'}
    </button>
  );
}
```

| Option            | Notes                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `mutationFn`      | Required. Receives `(variables, { signal })`.                                                     |
| `onMutate`        | Synchronous before the request; its return value is the callback context.                         |
| `onSuccess`       | `(data, variables, context)`, only for fulfilled mutations.                                       |
| `onError`         | `(error, variables, context)`, only for failed mutations.                                         |
| `onSettled`       | `(data, error, variables, context, outcome)` once per started generation, except `scope-changed`. |
| `cancelOnUnmount` | Default `false`; `true` aborts when the hook unmounts.                                            |

The snapshot exposes `status` (`idle`, `pending`, `success`, `error`), `data`,
`error`, `variables`, `failureCount`, `submittedAt`, `isIdle`, `isPending`,
`isSuccess` and `isError`, plus stable `mutate`, `mutateAsync`, `cancel` and
`reset` methods. `mutateAsync` always resolves and never rejects.

Outcomes have `settled: 'fulfilled' | 'failed' | 'cancelled' | 'superseded' |
'scope-changed'`, the submitted `variables`, `data` only when fulfilled, and
`error` only when failed. `cancel()` and a scope change return the hook to
`idle`. A scope change runs no callbacks, so old-scope code cannot invalidate
new-scope data. Callback exceptions are logged and never change the outcome.

### Optimistic updates are manual

FluxCache does not patch cache entries automatically. The supported pattern
writes through `setQueryData`, keeps the previous value and the exact optimistic
object, and rolls back only when the cache still contains that object. See
[Manual optimistic updates](docs/optimistic-updates.md) for the complete recipe
and the concurrency, scope and cancellation cautions.

## Invalidate after a mutation

`useInvalidate()` returns a stable function for mutation callbacks and effect
dependencies. The imperative form remains available on the client:

```tsx
import { useCacheClient } from 'flux-cache/react';

function RenameProduct({ productId }: { productId: string }) {
  const client = useCacheClient();

  async function rename(name: string) {
    await fetch(`/api/products/${productId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });

    // Exact entry, plus the list that contains it.
    await client.invalidateQueries(['product', productId], { exact: true });
    await client.invalidateQueries(['products']);
  }

  return <button onClick={() => rename('New name')}>Rename</button>;
}
```

`invalidateQueries` resolves as soon as refetches are scheduled. Pass
`{ awaitRefetch: true }` when a caller must wait:

```ts
const result = await client.invalidateQueries(['products'], {
  awaitRefetch: true,
  refetchActive: true,
});
// result.invalidated, result.refetching, result.outcomes
```

Writes can also update the cache directly; an active request is superseded and
can never overwrite the write:

```ts
client.setQueryData(['product', id], (current) =>
  current ? { ...current, name: 'New name' } : current,
);
```

## Authentication scope isolation

Cache data must never cross users or tenants. Call `setAuthScope` whenever the
signed-in identity changes, before fetching for the new identity:

```ts
useEffect(() => {
  client.setAuthScope(session?.user.id ?? null);
}, [client, session?.user.id]);
```

On a scope change the client:

- drops every cached entry from the previous scope,
- aborts active requests and settles their waiters with
  `{ settled: 'scope-changed', data: undefined }`,
- blocks late responses, late failures and retry timers from writing,
- leaves mounted observers on a pending snapshot without fetching.

It does not refetch automatically; the next mount, `refetch` or `invalidate`
runs under the new scope. A value that was already returned to your code before
the switch cannot be retroactively revoked — discard rendered state on account
change yourself (unmount the subtree or key it by user id).

Scope values are never used as query keys and never appear in events or
counters.

## Imperative API

```ts
const client = createFluxCache({
  staleTime,
  gcTime,
  retry,
  retryDelay,
  maxEntries,
  now,
});
```

| Method                                                              | Returns                     | Notes                                                        |
| ------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------ |
| `fetchQuery(key, queryFn, { staleTime, gcTime, retry, force })`     | `Promise<QueryOutcome<T>>`  | Joins active work; `force` always starts a new generation    |
| `prefetchQuery(key, queryFn, { priority, signal, ... })`            | `Promise<QueryOutcome<T>>`  | Bounded, deduplicated cache warming                          |
| `getQueryData<T>(key)`                                              | `T \| undefined`            | Synchronous read of the active scope                         |
| `getQueryState<T>(key)`                                             | `QueryState<T>`             | Data, error, timestamps, staleness                           |
| `setQueryData(key, value \| updater)`                               | `QueryState<T>`             | Supersedes active requests                                   |
| `invalidateQueries(filter, { refetchActive, awaitRefetch, exact })` | `Promise<InvalidateResult>` | Marks stale; does not wait by default                        |
| `refetchQueries(filter, { awaitSettled, exact })`                   | `Promise<RefetchResult>`    | New generation; awaits settlement by default                 |
| `cancelQueries(filter?)`                                            | `CancelResult`              | Synchronous; settles waiters immediately                     |
| `removeQueries(filter)`                                             | `RemoveResult`              | Explicit removal wins over queued work                       |
| `clear()`                                                           | `RemoveResult`              | Removes everything in the active scope                       |
| `setAuthScope(scope \| null)`                                       | `ScopeChangeResult`         | See isolation above                                          |
| `getAuthScope()`                                                    | `{ scopeTag, epoch }`       | Opaque tag only                                              |
| `getStats()`                                                        | `FluxCacheStats`            | Counters including prefetch consumption, no keys or payloads |
| `subscribe(listener)`                                               | `() => void`                | Diagnostic events                                            |

### `QueryOutcome`

Every fetch-shaped operation resolves (never rejects) with:

```ts
{
  settled: 'fulfilled' | 'superseded' | 'cancelled' | 'removed'
         | 'scope-changed' | 'failed' | 'skipped';
  source?: 'network' | 'cache';
  data: T | undefined;
  dataUpdatedAt: number | null;
  error?: unknown;
  skipReason?:
    | 'fresh'
    | 'no-query-fn'
    | 'removed'
    | 'cancelled'
    | 'save-data'
    | 'slow-network'
    | 'queue-full'
    | 'disabled';
}
```

`data` rules: `superseded` and `removed` return the current/last cached value;
`cancelled` and `scope-changed` always return `undefined`.

Invalid arguments throw synchronously; a `queryFn` that throws resolves
`{ settled: 'failed' }`.

### `useQuery`

| Option                 | Default         | Notes                                                            |
| ---------------------- | --------------- | ---------------------------------------------------------------- |
| `queryKey`             | required        | Serializable array; see [Query keys](#query-keys)                |
| `queryFn`              | —               | Required to fetch; optional for cache-only reads                 |
| `staleTime` / `gcTime` | client defaults | Per-query overrides                                              |
| `retry` / `retryDelay` | client defaults | —                                                                |
| `enabled`              | `true`          | `false` renders from cache without fetching                      |
| `initialData`          | —               | Seeds the cache; treated as fresh at seed time                   |
| `cancelOnUnmount`      | `false`         | Keep the request alive after the last observer leaves by default |

The snapshot exposes `data`, `error`, `status`, `fetchStatus`, `hasData`,
`isPending`, `isLoading`, `isSuccess`, `isError`, `isFetching`, `isStale`,
`failureCount`, `dataUpdatedAt`, `errorUpdatedAt` and `refetch()`.

`isLoading` means "no data yet and a request is running". A background refresh
keeps `hasData` and `isStale` true, so render cached data and an inline spinner
rather than a full-page loader.

### `usePrefetch`

| Option                 | Default  | Notes                                             |
| ---------------------- | -------- | ------------------------------------------------- |
| `queryKey`             | required | Same key the destination query will use           |
| `queryFn`              | required | Used only if the cache is missing or stale        |
| `delay`                | `120` ms | Debounce after hover/focus                        |
| `priority`             | `high`   | `high`, `normal` or `low`                         |
| `enabled`              | `true`   | `false` cancels pending work and ignores triggers |
| `staleTime` / `gcTime` | client   | Per-prefetch overrides, stored on the entry       |
| `retry` / `retryDelay` | client   | Retries belong to the prefetch request            |

The returned handler is callable (`onPointerEnter`, `onFocus`) and exposes
`cancel()` for `onPointerLeave`, `onBlur` or manual cleanup.

### Cancellation

- Default unmount behavior is cache-warming: the request completes and caches.
- `cancelOnUnmount: true` requests an abort when no keep-alive consumer remains.
  Any observer with `cancelOnUnmount: false`, an unsettled `fetchQuery` waiter,
  or a running prefetch keeps the request alive.
- `cancelQueries()` is unconditional: it aborts, settles waiters as `cancelled`,
  and revokes commit eligibility synchronously. It also cancels queued and
  running prefetch jobs.
- Aborting a prefetch `signal` settles queued work as `cancelled` and releases
  a running token; the request aborts only when no keep-alive consumer remains.
- A `queryFn` that ignores `AbortSignal` still cannot write to the cache after
  cancellation.

### Query keys

```ts
[
  'product',
  id,
] // array order matters
[
  ('products', { page: 1 })
] // plain-object property order does not
[('products', { page: 1, q: undefined })]; // === ['products', { page: 1 }]
```

Keys must be primitives, plain objects, arrays, `null` or `undefined`. Dates,
Maps, class instances, functions, symbols, BigInt, `NaN`/`Infinity` and cycles
throw `FluxCacheKeyError` synchronously. Convert dates to ISO strings. Never put
tokens, passwords or other credentials in a key — keys are hashed for
diagnostics, but they are still app-controlled data.

`invalidateQueries([...])` and `refetchQueries([...])` match by prefix; pass
`{ queryKey: [...], exact: true }` or the `exact` option for an exact match.

## Framework-free core

The cache engine does not import React. `QueryObserver` is usable on its own:

```ts
import { createFluxCache, QueryObserver } from 'flux-cache';

const client = createFluxCache();
const observer = new QueryObserver(client, {
  queryKey: ['products'],
  queryFn: ({ signal }) => fetch('/api/products', { signal }).then((r) => r.json()),
});

const unsubscribe = observer.subscribe(render);
observer.mount();
// later: observer.unmount(); unsubscribe();
```

## Testing helpers

```ts
import { deferred, flushMicrotasks } from 'flux-cache/testing';

const gate = deferred<string>();
const pending = client.fetchQuery(['key'], () => gate.promise);
gate.resolve('value');
await pending;
```

## Benchmarks

`bench/` contains a dependency-free, reproducible harness for core cache reads
and writes, query cache hits, mutation lifecycle, observer mount/unmount and
batched prefetch scheduling. It warms up first, uses fixed iteration counts,
reports median and p95 across samples, and includes Node, OS, CPU, package and
commit metadata in its JSON output.

```bash
pnpm bench
pnpm bench -- --json --out bench/results/local.json
pnpm bench:ci   # completion/shape check only; no latency thresholds
```

See [bench/README.md](bench/README.md) for methodology, options and the JSON
schema. Do not compare results across machines or Node versions, and treat small
differences as noise. CI runs `pnpm bench:ci` solely to prove the harness still
completes and produces well-formed samples.

## Privacy and diagnostics

- No telemetry is collected or transmitted.
- Events contain an event type, a key hash and a timestamp — never keys,
  payloads, headers, tokens or scope values. Prefetch events follow the same
  rule and report outcomes, not payloads.
- Prefetch counters (`prefetchQueued`, `prefetchDeduped`, `prefetchStarted`,
  `prefetchFulfilled`, `prefetchFailed`, `prefetchSkipped`, `prefetchCancelled`,
  `prefetchProduced`, `prefetchConsumed`, `prefetchWasted`, `prefetchPending`,
  `prefetchConsumptionRate`) are available through `getStats()`. Their
  denominators are documented in [Phase C contracts](docs/phase-c-contracts.md).
- The example diagnostics panel records event types and reasons only. It never
  renders key hashes, keys, payloads, credentials or scope values.
- Authenticated responses are partitioned by scope; nothing is persisted to
  `localStorage` or cookies in this release.
- Logging is limited to development warnings (clamped retry, invalid options).

## Scripts

```bash
pnpm typecheck      # tsc --noEmit
pnpm lint           # eslint
pnpm test           # vitest
pnpm coverage       # vitest with coverage
pnpm test:e2e       # Playwright smoke tests for the example (needs Chromium)
pnpm bench          # reproducible descriptive benchmark (builds first)
pnpm bench:ci       # benchmark completion/shape check for CI
pnpm build          # ESM + CJS + declarations
pnpm check:package  # publint + arethetypeswrong
pnpm verify         # all of the above
```

Development uses Node 22.12+ (see [.nvmrc](.nvmrc)); the published library
still declares Node 18+ support. The browser tests download Chromium once with
`pnpm exec playwright install chromium`.

Toolchain note: TypeScript is pinned to 5.9 because `typescript-eslint` 8 does
not support TypeScript 7 yet. Vitest 4, Vite 7, tsup 8 and jsdom 26 are pinned
to the versions verified by this project rather than floating to newer majors.

## Limitations

- Prefetching is explicit: there is no viewport observer, predictive scoring or
  automatic prefetch of unseen routes. Optimistic updates are manual; there is
  no automatic mutation cache or optimistic engine.
- Prefetches are bounded by `queueLimit`; under saturation some work is
  dropped on purpose and reported as `queue-full`.
- No persistence, offline cache, window-focus or reconnect refetch, pagination,
  infinite queries, `select`, or mutation cache.
- No automatic dependency graph between queries: connect mutations to affected
  keys explicitly.
- One set of options per entry: the most recent writer wins for `staleTime`,
  `gcTime` and retry settings of the same key.
- The benchmark harness is descriptive and single-process. It does not model
  network latency, browser rendering or multi-tab contention, and it makes no
  absolute performance claims.

## License

MIT

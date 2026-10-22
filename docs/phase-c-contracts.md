# Phase C contracts

This document freezes the Phase C semantics before implementation. Existing
Phase A/B contracts remain additive: `fetchQuery`, `prefetchQuery`,
`useQuery`, `usePrefetch`, invalidation, cancellation, scopes, outcome shapes
and diagnostics keep their current behavior unless a change is called out below.

## Scope decisions

- Mutation requests continue after component unmount by default. The hook
  unsubscribes from runner state, so late results, failures and callbacks can
  still run but cannot update the unmounted hook. `cancelOnUnmount: true` on a
  `useMutation` hook opts into aborting the request instead.
- A hook instance is latest-wins. Starting a second mutation aborts and settles
  the first as `superseded`; both callers receive an outcome and the old
  generation can never write current hook state.
- Automatic optimistic updates are not part of Phase C. The supported pattern
  is manual: the application owns the snapshot it wrote, the keys it patched and
  the rollback, and must coordinate concurrent writers itself.
- Diagnostics count consumed and wasted prefetch work. Counters and events do
  not contain keys, payloads, credentials or raw scope values.
- Benchmarks report descriptive timings only. They have no performance
  thresholds and never gate CI on latency.

## Mutation API

```ts
type MutationFn<TData, TVariables> = (
  variables: TVariables,
  context: { readonly signal: AbortSignal },
) => Promise<TData> | TData;

type MutationSettled = 'fulfilled' | 'failed' | 'cancelled' | 'superseded' | 'scope-changed';

interface MutationOutcome<TData, TVariables> {
  settled: MutationSettled;
  variables: TVariables;
  data: TData | undefined;
  error: unknown;
}

interface MutationOptions<TData, TVariables, TContext = undefined> {
  mutationFn: MutationFn<TData, TVariables>;
  onMutate?: (variables: TVariables) => TContext;
  onSuccess?: (data: TData, variables: TVariables, context: TContext | undefined) => void;
  onError?: (error: unknown, variables: TVariables, context: TContext | undefined) => void;
  onSettled?: (
    data: TData | undefined,
    error: unknown | undefined,
    variables: TVariables,
    context: TContext | undefined,
    outcome: MutationOutcome<TData, TVariables>,
  ) => void;
  cancelOnUnmount?: boolean; // React hook only; default false
}
```

`MutationOutcome.error` is `undefined` for every non-`failed` outcome.
`MutationOutcome.data` is the mutation result only for `fulfilled`; it is
`undefined` for failures, cancellation, supersession and scope changes. Every
outcome includes the variables that were submitted.

`MutationRunner.mutateAsync(variables)` always resolves with an outcome and
never rejects. Invalid `mutationFn`/callback types throw synchronously when the
runner or hook is created; there is no runtime variables validation. The runner
accepts the context `{ signal }`; aborting the signal is best-effort and does not
imply a server-side side effect was undone.

## Lifecycle and callback order

For an accepted generation:

1. Capture the current `{ scopeTag, epoch }`, create an abort controller and a
   fresh generation token. Any previous active generation is settled as
   `superseded` first (including its `onSettled` callback).
2. Call `onMutate(variables)` synchronously. Its return value is the context.
3. Call `mutationFn(variables, { signal })`.
4. On success, update the runner snapshot to `success`, then call `onSuccess`,
   then `onSettled`.
5. On failure, update the runner snapshot to `error`, then call `onError`, then
   `onSettled`.
6. On cancellation, supersession or scope change, update snapshot as described
   below, then call `onSettled` for cancellation and supersession. A
   `scope-changed` outcome calls no callbacks at all, because old-scope user
   callbacks could otherwise invalidate or write data in the new scope.

Callback failures are contained. A thrown `onMutate`, `onSuccess`, `onError` or
`onSettled` is reported with `console.warn` and does not change the mutation
outcome. A thrown `onMutate` leaves the context `undefined` and the mutation
continues. `onSuccess` and `onError` are called at most once. `onSettled` is
called exactly once for every started generation except `scope-changed`, which
is intentionally silent.

Cancellation and state:

- `cancel()` aborts the active request, settles it as `cancelled` (with
  `onSettled`), and returns the hook snapshot to `idle`.
- `reset()` behaves like `cancel()` when work is active, and always clears the
  snapshot to `idle`.
- A superseded generation never writes the current snapshot; the replacement is
  already `pending`. Its caller still receives `superseded` and its
  `onSettled` runs.
- A scope change aborts the request, settles it as `scope-changed` with no
  callbacks, and returns the snapshot to `idle`.
- Unmount does not settle or abort by default. With `cancelOnUnmount: true` the
  hook calls `cancel()` during cleanup.

Snapshot states:

| Status    | data        | error | variables   | failureCount |
| --------- | ----------- | ----- | ----------- | ------------ |
| `idle`    | `undefined` | null  | `undefined` | 0            |
| `pending` | `undefined` | null  | variables   | 0            |
| `success` | result      | null  | variables   | 0            |
| `error`   | `undefined` | error | variables   | 1            |

`submittedAt` is the client clock at start for pending/success/error and null in
`idle`. Starting a generation clears previous data and error. There are no
mutation retries in Phase C.

## React API

`useMutation(options)` returns the snapshot plus stable `mutate`,
`mutateAsync`, `cancel` and `reset` methods. `useInvalidate()` returns a stable
function with the same signature as `client.invalidateQueries(filter, options)`.

Options are refreshed every render; callbacks use the latest options when a
generation settles. The `mutationFn` is captured when a generation starts.

## Prefetch effectiveness metrics

These counters are added to `FluxCacheStats`:

- `prefetchProduced`: successful cache commits from a request started by a
  prefetch job. A prefetch that merely joins an existing observer request is
  not produced.
- `prefetchConsumed`: produced prefetches claimed by a real consumer before
  they become stale, are replaced, or are removed. A real consumer is an
  attached `QueryObserver` (including one that joins the in-flight prefetch) or
  a `fetchQuery` cache hit/joiner. A second prefetch is not a consumer.
- `prefetchWasted`: produced prefetches that end without a real consumer:
  stale timer fires, invalidation, a newer request generation starts,
  `setQueryData` overwrites, GC, LRU eviction, removal, `clear`, or scope
  change.
- `prefetchPending`: `prefetchProduced - prefetchConsumed - prefetchWasted`.
- `prefetchConsumptionRate`: `consumed / (consumed + wasted)`, or `0` when that
  denominator is zero. Pending work is excluded from the rate.

Each produced prefetch settles into exactly one of consumed or wasted. The
denominator for the rate is completed prefetches, not all prefetch outcomes
(skipped, failed, cancelled and deduped jobs never produced cache data).

## Benchmark rules

- Warm-up iterations run before measurement.
- Each scenario runs a fixed number of iterations per sample, with configurable
  samples.
- Report median and p95 of sample durations, never a single run.
- Include Node version, platform, architecture, CPU model, logical CPU count,
  package version, iterations, warm-up and samples in JSON.
- `--check` verifies the harness completed and produced finite, well-formed
  samples. CI uses it only as a completion check; it has no absolute latency
  thresholds.

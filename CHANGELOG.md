# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Core cache client with canonical query keys, freshness states, request
  deduplication, explicit invalidation, cancellation, retry, LRU eviction and
  garbage collection.
- Authentication scope partitioning so cached data cannot cross users or
  tenants.
- React `FluxCacheProvider` and `useQuery`.
- Deterministic lifecycle and race-condition test suite.
- Runnable Vite + React example (`examples/react-demo`) covering loading, error,
  cache reuse, refetch, invalidation, key changes and auth-scope switching.
- Bounded prefetch scheduler with `prefetchQuery`, configurable concurrency and
  queue capacity, priorities, queued-job deduplication and deterministic
  saturation behavior.
- React `usePrefetch` with debounced hover/focus triggers, touch-pointer
  filtering and cancellation that preserves shared keep-alive requests.
- Save-Data and slow-network prefetch safeguards with injectable `networkInfo`
  for tests and server rendering.
- Framework-independent `MutationRunner` with latest-wins generations,
  deterministic settlement, reference-count-free abort handling and
  auth-scope-safe callback suppression.
- React `useMutation` with serialized state, `cancel`/`reset`, optional
  `cancelOnUnmount`, and requests that continue after unmount by default.
- React `useInvalidate`, a stable helper for mutation callbacks.
- [Manual optimistic-update guidance](docs/optimistic-updates.md) with explicit
  cache-write ownership and rollback cautions.
- Prefetch effectiveness counters: `prefetchProduced`, `prefetchConsumed`,
  `prefetchWasted`, `prefetchPending` and `prefetchConsumptionRate`.
- Prefetch provenance events (`prefetch:produced`, `prefetch:consumed`,
  `prefetch:wasted`) and a live diagnostics panel in the runnable example.
- Playwright coverage proving a hover prefetch is reused by the subsequent
  navigation without an extra request, and that the diagnostics panel reports
  the prefetch as consumed.

### Changed

- Mutation outcomes and callback semantics are documented in
  [Phase C contracts](docs/phase-c-contracts.md). `useMutation` exposes a
  latest-wins snapshot; stale generations never overwrite current hook state.
- `cancelQueries`/`removeQueries`/`clear` now also settle matching prefetch
  jobs and report `jobsCancelled`; `setAuthScope` reports `jobsDropped`.
- `QueryOutcome` skip reasons now include `disabled` alongside `save-data`,
  `slow-network` and `queue-full`.
- Prefetch diagnostics add `prefetch:queued`, `prefetch:started`,
  `prefetch:skipped`, `prefetch:settled`, `prefetch:produced`,
  `prefetch:consumed` and `prefetch:wasted` events with key hashes only.
- `FluxCacheStats` gained required prefetch-effectiveness members. Code that
  constructs the object literally or compares it with exact deep equality must
  add the new fields; normal `getStats()` consumers are unaffected.

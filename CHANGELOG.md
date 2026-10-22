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

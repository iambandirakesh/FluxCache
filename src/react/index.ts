'use client';

export { FluxCacheProvider, useCacheClient, type FluxCacheProviderProps } from './context';
export { useQuery } from './useQuery';
export { cacheKeyHash, createFluxCache, FluxCacheClient } from '../core/client';
export type { CacheClient } from '../core/client';
export { FluxCacheKeyError } from '../core/errors';
export { QueryObserver } from '../core/observer';
export { canonicalizeQueryKey, isQueryKey, queryKeysEqual, queryKeyStartsWith } from '../core/key';
export type {
  CacheEvent,
  CancelResult,
  FetchQueryOptions,
  FetchStatus,
  FluxCacheConfig,
  FluxCacheStats,
  InvalidateOptions,
  InvalidateResult,
  QueryFilter,
  QueryFn,
  QueryFnContext,
  QueryKey,
  QueryKeyPart,
  QueryOptions,
  QueryOutcome,
  QuerySnapshot,
  QueryState,
  QueryStatus,
  RefetchOptions,
  RefetchResult,
  RemoveResult,
  ScopeChangeResult,
  Settled,
  SkipReason,
} from '../core/types';

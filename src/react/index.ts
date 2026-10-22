'use client';

export { FluxCacheProvider, useCacheClient, type FluxCacheProviderProps } from './context';
export { useQuery } from './useQuery';
export { usePrefetch, type PrefetchHandler, type UsePrefetchOptions } from './usePrefetch';
export { useMutation, type UseMutationResult } from './useMutation';
export { useInvalidate, type InvalidateQueries } from './useInvalidate';
export { cacheKeyHash, createFluxCache, FluxCacheClient } from '../core/client';
export type { CacheClient } from '../core/client';
export { FluxCacheKeyError } from '../core/errors';
export { QueryObserver } from '../core/observer';
export { MutationRunner } from '../core/mutation';
export type {
  MutationFn,
  MutationFnContext,
  MutationOptions,
  MutationOutcome,
  MutationSettled,
  MutationSnapshot,
  MutationStatus,
} from '../core/mutation';
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
  NetworkInfo,
  PrefetchConfig,
  PrefetchPriority,
  PrefetchQueryOptions,
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

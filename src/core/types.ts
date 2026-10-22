/**
 * Public types for the framework-independent cache core.
 *
 * Nothing in this module touches browser globals at import time, so it is safe
 * to import during server rendering.
 */

/** A serializable part of a query key. See {@link QueryKey}. */
export type QueryKeyPart =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly QueryKeyPart[]
  | { readonly [key: string]: QueryKeyPart };

/**
 * A query key is a serializable array. Elements are compared structurally after
 * canonicalization; object property order is irrelevant, array order is not.
 * `undefined` object properties are ignored, while `undefined` array elements
 * are distinct from `null`.
 */
export type QueryKey = readonly QueryKeyPart[];

/** Context passed to every `queryFn`. */
export interface QueryFnContext {
  readonly queryKey: QueryKey;
  readonly signal: AbortSignal;
}

/** A data fetcher. The returned promise is aborted through `signal`. */
export type QueryFn<T> = (context: QueryFnContext) => Promise<T> | T;

/** Query status derived from whether usable data or a terminal error exists. */
export type QueryStatus = 'pending' | 'success' | 'error';

/** Whether a request is currently in flight for the entry. */
export type FetchStatus = 'idle' | 'fetching';

/** Options accepted by `useQuery` and the imperative fetch helpers. */
export interface QueryOptions<T> {
  /** Stable, serializable key identifying the data. */
  queryKey: QueryKey;
  /** Fetches the data. Required for imperative fetching. */
  queryFn?: QueryFn<T> | undefined;
  /** Age in milliseconds after which data is considered stale. Default 30_000. */
  staleTime?: number | undefined;
  /** Idle time in milliseconds before an entry is garbage collected. Default 300_000. */
  gcTime?: number | undefined;
  /** Number of retries after the initial attempt. Default 2. */
  retry?: number | undefined;
  /** Delay before retry `attempt` (1-based). Default is exponential from 1s. */
  retryDelay?: ((attempt: number) => number) | undefined;
  /** When false, the observer does not fetch. Default true. */
  enabled?: boolean | undefined;
  /** Seeds the cache if no data exists yet. Treated as fresh at seed time. */
  initialData?: T | undefined;
  /**
   * For `useQuery`: abort the request when this observer unmounts and no
   * consumer that requested keep-alive is attached. Default false.
   */
  cancelOnUnmount?: boolean | undefined;
}

/** Options for imperative `fetchQuery`. */
export interface FetchQueryOptions {
  staleTime?: number | undefined;
  gcTime?: number | undefined;
  retry?: number | undefined;
  retryDelay?: ((attempt: number) => number) | undefined;
  /** Bypass freshness and always start a new request generation. */
  force?: boolean | undefined;
}

/** Resolved options with defaults applied. */
export interface ResolvedQueryOptions {
  staleTime: number;
  gcTime: number;
  retry: number;
  retryDelay: (attempt: number) => number;
  enabled: boolean;
}

/** Why a fetch-shaped operation finished the way it did. */
export type Settled =
  'fulfilled' | 'superseded' | 'cancelled' | 'removed' | 'scope-changed' | 'failed' | 'skipped';

/** Reason a fetch-shaped operation was skipped without doing work. */
export type SkipReason =
  'fresh' | 'no-query-fn' | 'removed' | 'cancelled' | 'save-data' | 'slow-network' | 'queue-full';

/**
 * Result of every fetch-shaped operation.
 *
 * `data` is the current entry value for `superseded` and `removed`, and is
 * always `undefined` for `cancelled` and `scope-changed`: a cancelled caller
 * revoked the work, and a scope change must never hand one tenant's payload to
 * another.
 */
export interface QueryOutcome<T> {
  settled: Settled;
  source?: 'network' | 'cache' | undefined;
  data: T | undefined;
  dataUpdatedAt: number | null;
  error?: unknown;
  skipReason?: SkipReason | undefined;
}

/** Data and status of one cache entry. */
export interface QueryState<T> {
  data: T | undefined;
  hasData: boolean;
  error: unknown;
  dataUpdatedAt: number | null;
  errorUpdatedAt: number | null;
  isStale: boolean;
  status: QueryStatus;
}

/** Reactive snapshot returned by `useQuery`. */
export interface QuerySnapshot<T> {
  data: T | undefined;
  error: unknown;
  status: QueryStatus;
  fetchStatus: FetchStatus;
  hasData: boolean;
  isPending: boolean;
  isLoading: boolean;
  isSuccess: boolean;
  isError: boolean;
  isFetching: boolean;
  isStale: boolean;
  failureCount: number;
  dataUpdatedAt: number | null;
  errorUpdatedAt: number | null;
  /** Forces a new request generation and resolves with its outcome. */
  refetch: () => Promise<QueryOutcome<T>>;
}

/** Selects which entries an operation applies to. */
export type QueryFilter =
  QueryKey | { queryKey: QueryKey; exact?: boolean } | ((key: QueryKey) => boolean);

/** Options for `invalidateQueries`. */
export interface InvalidateOptions {
  /** Refetch entries that currently have observers. Default true. */
  refetchActive?: boolean;
  /** Wait for triggered refetches to settle. Default false. */
  awaitRefetch?: boolean;
  /** Match the key exactly instead of by prefix (key filters only). */
  exact?: boolean;
}

/** Result of `invalidateQueries`. */
export interface InvalidateResult {
  invalidated: number;
  refetching: number;
  outcomes?: QueryOutcome<unknown>[];
}

/** Options for `refetchQueries`. */
export interface RefetchOptions {
  /** Wait for every triggered request to settle. Default true. */
  awaitSettled?: boolean;
  /** Match the key exactly instead of by prefix (key filters only). */
  exact?: boolean;
}

/** Result of `refetchQueries`. */
export interface RefetchResult {
  refetched: number;
  outcomes: QueryOutcome<unknown>[];
}

/** Result of `cancelQueries`. */
export interface CancelResult {
  cancelled: number;
  waitersSettled: number;
}

/** Result of `removeQueries` and `clear`. */
export interface RemoveResult {
  removed: number;
  waitersSettled: number;
}

/** Result of `setAuthScope`. */
export interface ScopeChangeResult {
  changed: boolean;
  scopeTag: string;
  epoch: number;
  entriesDropped: number;
  requestsCancelled: number;
  jobsDropped: number;
}

/** Operational counters. Never contains keys, payloads or scope values. */
export interface FluxCacheStats {
  size: number;
  inFlight: number;
  observers: number;
  hits: number;
  misses: number;
  dedupeJoins: number;
  fetchesStarted: number;
  fetchesSucceeded: number;
  fetchesFailed: number;
  discarded: number;
  superseded: number;
  cancelled: number;
  retries: number;
  invalidations: number;
  evictions: number;
  gcRuns: number;
  staleFlips: number;
  scopeChanges: number;
}

/** Diagnostic event. Contains no payloads, keys or credentials. */
export interface CacheEvent {
  type:
    | 'cache:hit'
    | 'cache:miss'
    | 'fetch:start'
    | 'fetch:success'
    | 'fetch:error'
    | 'fetch:superseded'
    | 'fetch:cancelled'
    | 'cache:evict'
    | 'cache:gc'
    | 'invalidate'
    | 'scope:change';
  keyHash?: string;
  at: number;
  reason?: string;
}

/** Client configuration. */
export interface FluxCacheConfig {
  /** Default freshness window in milliseconds. Default 30_000. */
  staleTime?: number;
  /** Default idle lifetime in milliseconds. Default 300_000. */
  gcTime?: number;
  /** Default retries after the initial attempt. Default 2. */
  retry?: number;
  /** Default retry delay function. */
  retryDelay?: (attempt: number) => number;
  /** Maximum idle entries retained per scope. Default 500. */
  maxEntries?: number;
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number;
}

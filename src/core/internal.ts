import type { QueryFn, QueryKey, QueryOutcome } from './types';

/** A consumer attached to an in-flight request. */
export interface FetchToken {
  readonly fetch: InFlightFetch;
  readonly keepAlive: boolean;
  released: boolean;
}

/** Minimal observer contract used by the client, keeping React out of core. */
export interface ObserverLike {
  readonly key: QueryKey;
  onEntryChange(): void;
  onScopeChange(): void;
}

/** Options stored per entry. Last writer wins; documented behavior. */
export interface EntryOptions {
  queryFn?: QueryFn<unknown> | undefined;
  staleTime: number;
  gcTime: number;
  retry: number;
  retryDelay: (attempt: number) => number;
}

/** A prefetch-produced value that has not yet been consumed or wasted. */
export interface PrefetchProvenance {
  generation: number;
}

/** One cache entry. */
export interface CacheEntry {
  key: QueryKey;
  keyHash: string;
  eventHash: string;
  scopeTag: string;
  data: unknown;
  hasData: boolean;
  dataUpdatedAt: number | null;
  error: unknown;
  errorUpdatedAt: number | null;
  generation: number;
  dirty: boolean;
  failureCount: number;
  inFlight: InFlightFetch | null;
  observers: Set<ObserverLike>;
  gcTimer: ReturnType<typeof setTimeout> | null;
  staleTimer: ReturnType<typeof setTimeout> | null;
  lastAccessAt: number;
  options: EntryOptions;
  prefetch: PrefetchProvenance | null;
}

/** The single commit-eligible request for an entry. */
export interface InFlightFetch {
  entry: CacheEntry;
  requestId: number;
  origin: 'query' | 'prefetch';
  generation: number;
  scopeTag: string;
  scopeEpoch: number;
  attempt: number;
  abort: AbortController;
  tokens: Set<FetchToken>;
  hasKeepAlive: boolean;
  settled: boolean;
  promise: Promise<QueryOutcome<unknown>>;
  resolve: (outcome: QueryOutcome<unknown>) => void;
  retryTimer: ReturnType<typeof setTimeout> | null;
  wake: (() => void) | null;
}

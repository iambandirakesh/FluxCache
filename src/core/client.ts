import { canonicalizeQueryKey, hashQueryKey, queryKeysEqual, queryKeyStartsWith } from './key';
import type { CacheEntry, EntryOptions, FetchToken, InFlightFetch, ObserverLike } from './internal';
import {
  isPrefetchPriority,
  prefetchNetworkSkip,
  PrefetchScheduler,
  readNetworkInfo,
  resolvePrefetchConfig,
  type PrefetchEntryOptions,
  type PrefetchHost,
  type PrefetchMetric,
  type ResolvedPrefetchConfig,
} from './prefetch';
import type {
  CacheEvent,
  CancelResult,
  FetchQueryOptions,
  FluxCacheConfig,
  FluxCacheStats,
  InvalidateOptions,
  InvalidateResult,
  NetworkInfo,
  PrefetchPriority,
  PrefetchQueryOptions,
  QueryFilter,
  QueryFn,
  QueryKey,
  QueryOptions,
  QueryOutcome,
  QueryState,
  RefetchOptions,
  RefetchResult,
  RemoveResult,
  ScopeChangeResult,
  Settled,
  SkipReason,
} from './types';

const DEFAULT_STALE_TIME = 30_000;
const DEFAULT_GC_TIME = 300_000;
const DEFAULT_RETRY = 2;
const DEFAULT_MAX_ENTRIES = 500;
const MAX_RETRY = 10;

function defaultRetryDelay(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 30_000);
}

function assertTime(value: unknown, name: string): void {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative number of milliseconds`);
  }
}

function assertRetry(value: unknown, warn: (message: string) => void): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new RangeError('retry must be a non-negative integer');
  }
  if (value > MAX_RETRY) {
    warn(`retry is clamped to ${MAX_RETRY}`);
    return MAX_RETRY;
  }
  return value;
}

function assertQueryFn(value: unknown): asserts value is QueryFn<unknown> {
  if (typeof value !== 'function') {
    throw new TypeError('queryFn must be a function');
  }
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AbortSignal).aborted === 'boolean' &&
    typeof (value as AbortSignal).addEventListener === 'function'
  );
}

function isObjectFilter(
  filter: QueryFilter,
): filter is { queryKey: QueryKey; exact?: boolean | undefined } {
  return !Array.isArray(filter) && typeof filter === 'object' && filter !== null;
}

function skippedOutcome<T>(
  reason: SkipReason,
  data?: T,
  dataUpdatedAt: number | null = null,
): QueryOutcome<T> {
  return {
    settled: 'skipped',
    skipReason: reason,
    data,
    dataUpdatedAt,
  };
}

/** Internal options resolved from config and call overrides. */
interface ResolvedFetchOptions {
  staleTime: number;
  gcTime: number;
  retry: number;
  retryDelay: (attempt: number) => number;
  force: boolean;
  initialData?: unknown;
  enabled: boolean;
  cancelOnUnmount: boolean;
}

/**
 * Framework-independent cache engine.
 *
 * Create one client per application (or per server request). The client owns
 * cache entries, request Lifecycle, retry timers and diagnostic counters.
 */
export class FluxCacheClient {
  private readonly staleTime: number;
  private readonly gcTime: number;
  private readonly retry: number;
  private readonly retryDelay: (attempt: number) => number;
  private readonly maxEntries: number;
  private readonly clock: () => number;
  private readonly prefetchConfig: ResolvedPrefetchConfig;
  private readonly networkInfo: () => NetworkInfo;
  private readonly prefetcher: PrefetchScheduler;

  private readonly entries = new Map<string, CacheEntry>();
  private readonly observers = new Set<ObserverLike>();
  private readonly listeners = new Set<(event: CacheEvent) => void>();

  private rawScope: string | null = null;
  private tag = 's0';
  private epoch = 0;
  private tagCounter = 0;
  private requestCounter = 0;

  private readonly counters = {
    hits: 0,
    misses: 0,
    dedupeJoins: 0,
    fetchesStarted: 0,
    fetchesSucceeded: 0,
    fetchesFailed: 0,
    discarded: 0,
    superseded: 0,
    cancelled: 0,
    retries: 0,
    invalidations: 0,
    evictions: 0,
    gcRuns: 0,
    staleFlips: 0,
    scopeChanges: 0,
    prefetchQueued: 0,
    prefetchDeduped: 0,
    prefetchStarted: 0,
    prefetchFulfilled: 0,
    prefetchFailed: 0,
    prefetchSkipped: 0,
    prefetchCancelled: 0,
  };

  constructor(config: FluxCacheConfig = {}) {
    if (config.staleTime !== undefined) assertTime(config.staleTime, 'staleTime');
    if (config.gcTime !== undefined) assertTime(config.gcTime, 'gcTime');
    if (config.retryDelay !== undefined && typeof config.retryDelay !== 'function') {
      throw new TypeError('retryDelay must be a function');
    }
    if (
      config.maxEntries !== undefined &&
      (!Number.isInteger(config.maxEntries) || config.maxEntries < 1)
    ) {
      throw new RangeError('maxEntries must be a positive integer');
    }
    if (config.now !== undefined && typeof config.now !== 'function') {
      throw new TypeError('now must be a function');
    }
    if (config.networkInfo !== undefined && typeof config.networkInfo !== 'function') {
      throw new TypeError('networkInfo must be a function');
    }

    this.staleTime = config.staleTime ?? DEFAULT_STALE_TIME;
    this.gcTime = config.gcTime ?? DEFAULT_GC_TIME;
    this.retry =
      config.retry === undefined
        ? DEFAULT_RETRY
        : assertRetry(config.retry, (message) => this.warn(message));
    this.retryDelay = config.retryDelay ?? defaultRetryDelay;
    this.maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.clock = config.now ?? (() => Date.now());
    this.prefetchConfig = resolvePrefetchConfig(config.prefetch);
    this.networkInfo = config.networkInfo ?? readNetworkInfo;
    this.prefetcher = new PrefetchScheduler(this.prefetchHost(), this.prefetchConfig);
  }

  /** Current time as seen by the client. */
  now(): number {
    return this.clock();
  }

  // ---------------------------------------------------------------------------
  // Imperative API
  // ---------------------------------------------------------------------------

  /**
   * Fetches a query, joining an eligible in-flight request or starting one.
   *
   * Throws synchronously for invalid arguments. Never rejects for lifecycle or
   * fetch failures: those resolve as an outcome.
   */
  fetchQuery<T>(
    key: QueryKey,
    queryFn: QueryFn<T>,
    options: FetchQueryOptions = {},
  ): Promise<QueryOutcome<T>> {
    canonicalizeQueryKey(key);
    assertQueryFn(queryFn);
    const resolved = this.resolveOptions(options);
    return this.runFetchQuery<T>(key, queryFn, resolved);
  }

  /**
   * Warms the cache for a query without subscribing to it.
   *
   * Never rejects: freshness, deduplication, network and queue decisions are
   * reported as outcomes. `signal` cancels queued work and releases a running
   * prefetch (aborting the request when no other consumer needs it).
   */
  prefetchQuery<T>(
    key: QueryKey,
    queryFn: QueryFn<T>,
    options: PrefetchQueryOptions = {},
  ): Promise<QueryOutcome<T>> {
    canonicalizeQueryKey(key);
    assertQueryFn(queryFn);
    const resolved = this.resolvePrefetchOptions(queryFn, options);

    if (!this.prefetchConfig.enabled) {
      return Promise.resolve(skippedOutcome<T>('disabled'));
    }
    if (resolved.signal?.aborted) {
      return Promise.resolve(skippedOutcome<T>('cancelled'));
    }
    const networkSkip = prefetchNetworkSkip(this.networkInfo(), this.prefetchConfig);
    if (networkSkip) {
      return Promise.resolve(skippedOutcome<T>(networkSkip));
    }
    return this.runPrefetchQuery<T>(key, resolved);
  }

  /** Reads the current value for a key in the active scope. */
  getQueryData<T>(key: QueryKey): T | undefined {
    const entry = this.peekByKey(key);
    if (!entry) return undefined;
    entry.lastAccessAt = this.now();
    return entry.hasData ? (entry.data as T) : undefined;
  }

  /** Reads the status of a key in the active scope without fetching. */
  getQueryState<T>(key: QueryKey): QueryState<T> {
    const entry = this.peekByKey(key);
    return this.stateOf<T>(entry);
  }

  /**
   * Writes data into the cache and supersedes any active request.
   *
   * A late response from the superseded request can never overwrite this write.
   */
  setQueryData<T>(key: QueryKey, updater: T | ((previous: T | undefined) => T)): QueryState<T> {
    canonicalizeQueryKey(key);
    const entry = this.ensureEntry(key, this.defaultEntryOptions());
    const next =
      typeof updater === 'function'
        ? (updater as (previous: T | undefined) => T)(entry.hasData ? (entry.data as T) : undefined)
        : updater;

    entry.data = next;
    entry.hasData = true;
    entry.dataUpdatedAt = this.now();
    entry.error = null;
    entry.errorUpdatedAt = null;
    entry.dirty = false;
    entry.failureCount = 0;

    this.detach(entry, 'superseded');
    entry.generation += 1;
    this.clearStaleTimer(entry);
    this.scheduleStaleTimer(entry);
    this.scheduleGcIfIdle(entry);
    this.notifyEntry(entry);
    return this.stateOf<T>(entry);
  }

  /**
   * Marks matching entries stale and detaches active requests.
   *
   * Does not wait for refetches unless `awaitRefetch` is true.
   */
  invalidateQueries(
    filter: QueryFilter,
    options: InvalidateOptions = {},
  ): Promise<InvalidateResult> {
    const entries = this.select(filter, options.exact);
    return this.runInvalidate(entries, options);
  }

  /** Starts a new request generation for every matching cached entry. */
  refetchQueries(filter: QueryFilter, options: RefetchOptions = {}): Promise<RefetchResult> {
    const entries = this.select(filter, options.exact);
    return this.runRefetch(entries, options.awaitSettled ?? true);
  }

  /** Cancels matching active requests. Resolves nobody: it settles them. */
  cancelQueries(filter?: QueryFilter): CancelResult {
    const entries = filter === undefined ? [...this.entries.values()] : this.select(filter);
    let waitersSettled = 0;
    for (const entry of entries) {
      const fetch = entry.inFlight;
      if (fetch) waitersSettled += fetch.tokens.size;
    }
    const jobsCancelled =
      filter === undefined
        ? this.prefetcher.cancelAll('cancelled')
        : this.prefetcher.cancelMatching((key) => this.keyMatches(key, filter), 'cancelled');

    let cancelled = 0;
    for (const entry of entries) {
      if (!entry.inFlight) continue;
      this.detach(entry, 'cancelled');
      entry.generation += 1;
      cancelled += 1;
      this.notifyEntry(entry);
    }
    return { cancelled, waitersSettled, jobsCancelled };
  }

  /** Removes matching entries. An explicit removal beats any queued work. */
  removeQueries(filter: QueryFilter): RemoveResult {
    const entries = this.select(filter);
    let waitersSettled = 0;
    for (const entry of entries) {
      const fetch = entry.inFlight;
      if (fetch) waitersSettled += fetch.tokens.size;
    }
    // Queued work must learn about the removal before its entry disappears.
    const jobsCancelled = this.prefetcher.cancelMatching(
      (key) => this.keyMatches(key, filter),
      'removed',
    );
    for (const entry of entries) {
      this.detach(entry, 'removed');
      this.clearTimers(entry);
      this.entries.delete(entry.keyHash);
      this.notifyEntry(entry);
    }
    return { removed: entries.length, waitersSettled, jobsCancelled };
  }

  /** Removes every entry in the active scope. */
  clear(): RemoveResult {
    const entries = [...this.entries.values()];
    let waitersSettled = 0;
    for (const entry of entries) {
      const fetch = entry.inFlight;
      if (fetch) waitersSettled += fetch.tokens.size;
    }
    const jobsCancelled = this.prefetcher.cancelAll('removed');
    for (const entry of entries) {
      this.detach(entry, 'removed');
      this.clearTimers(entry);
    }
    this.entries.clear();
    // Notify only after removal so observers rebuild as pending, not from data
    // that is about to disappear.
    for (const entry of entries) this.notifyEntry(entry);
    return { removed: entries.length, waitersSettled, jobsCancelled };
  }

  /**
   * Switches the authentication scope.
   *
   * Drops the previous scope's entries, settles their pending operations with
   * `scope-changed` and no data, aborts their requests, and never reuses the
   * old data. Already-returned values cannot be revoked; see README.
   */
  setAuthScope(scope: string | null): ScopeChangeResult {
    if (scope !== null && typeof scope !== 'string') {
      throw new TypeError('auth scope must be a string or null');
    }
    if (scope === this.rawScope) {
      return {
        changed: false,
        scopeTag: this.tag,
        epoch: this.epoch,
        entriesDropped: 0,
        requestsCancelled: 0,
        jobsDropped: 0,
      };
    }

    let requestsCancelled = 0;
    for (const entry of this.entries.values()) {
      if (entry.inFlight) requestsCancelled += 1;
      this.detach(entry, 'scope-changed');
      this.clearTimers(entry);
    }
    // Prefetch jobs are settled only after their requests are detached, so a
    // job can never start new work in the outgoing scope.
    const jobsDropped = this.prefetcher.cancelAll('scope-changed');

    const entriesDropped = this.entries.size;
    const hadObservers = new Set<ObserverLike>();
    for (const entry of this.entries.values()) {
      for (const observer of entry.observers) hadObservers.add(observer);
    }
    this.entries.clear();

    this.tagCounter += 1;
    this.tag = `s${this.tagCounter}`;
    this.epoch += 1;
    this.rawScope = scope;
    this.counters.scopeChanges += 1;

    for (const observer of hadObservers) observer.onScopeChange();
    this.emit({ type: 'scope:change', at: this.now() });

    return {
      changed: true,
      scopeTag: this.tag,
      epoch: this.epoch,
      entriesDropped,
      requestsCancelled,
      jobsDropped,
    };
  }

  /** Opaque scope credentials for diagnostics. Never exposes the raw scope. */
  getAuthScope(): { scopeTag: string; epoch: number } {
    return { scopeTag: this.tag, epoch: this.epoch };
  }

  /** Operational counters; contains no keys, payloads or credentials. */
  getStats(): FluxCacheStats {
    let inFlight = 0;
    for (const entry of this.entries.values()) if (entry.inFlight) inFlight += 1;
    return {
      size: this.entries.size,
      inFlight,
      observers: this.observers.size,
      ...this.counters,
    };
  }

  /** Subscribes to diagnostic events. Returns an unsubscribe function. */
  subscribe(listener: (event: CacheEvent) => void): () => void {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---------------------------------------------------------------------------
  // Observer support (used by the React adapter and framework-free observers)
  // ---------------------------------------------------------------------------

  /** @internal */
  attachObserver(observer: ObserverLike): void {
    this.observers.add(observer);
  }

  /** @internal */
  detachObserver(observer: ObserverLike): void {
    this.observers.delete(observer);
  }

  /** @internal */
  peek(keyHash: string): CacheEntry | undefined {
    return this.entries.get(keyHash);
  }

  private peekByKey(key: QueryKey): CacheEntry | undefined {
    return this.entries.get(canonicalizeQueryKey(key));
  }

  /** @internal */
  ensureEntryFor(key: QueryKey, options: QueryOptions<unknown>): CacheEntry {
    return this.ensureEntry(key, this.optionsFromQuery(key, options));
  }

  /** @internal */
  ensurePrefetchEntry(key: QueryKey, options: PrefetchEntryOptions): CacheEntry {
    return this.ensureEntry(key, options);
  }

  /** @internal Starts or joins the request a prefetch job will wait on. */
  startPrefetchFetch(entry: CacheEntry): {
    promise: Promise<QueryOutcome<unknown>>;
    token: FetchToken;
  } {
    if (entry.inFlight) {
      this.counters.dedupeJoins += 1;
      return {
        promise: entry.inFlight.promise,
        token: this.join(entry.inFlight, false),
      };
    }
    this.counters.misses += 1;
    const begun = this.beginFetch(entry, false);
    return { promise: begun.promise, token: begun.token };
  }

  /** @internal */
  addEntryObserver(entry: CacheEntry, observer: ObserverLike): void {
    entry.observers.add(observer);
    entry.lastAccessAt = this.now();
    this.clearGcTimer(entry);
  }

  /** @internal */
  removeEntryObserver(entry: CacheEntry, observer: ObserverLike): void {
    entry.observers.delete(observer);
    this.scheduleGcIfIdle(entry);
  }

  /** @internal */
  isEntryStale(entry: CacheEntry): boolean {
    if (!entry.hasData || entry.dirty || entry.dataUpdatedAt === null) return true;
    return this.now() - entry.dataUpdatedAt >= entry.options.staleTime;
  }

  /** @internal Starts or joins a request for an observer. */
  fetchForObserver(entry: CacheEntry, options: QueryOptions<unknown>): FetchToken | null {
    const keepAlive = options.cancelOnUnmount !== true;
    if (entry.inFlight) {
      if (options.queryFn) entry.options.queryFn = options.queryFn as QueryFn<unknown>;
      this.counters.dedupeJoins += 1;
      return this.join(entry.inFlight, keepAlive);
    }
    if (!entry.options.queryFn) return null;
    this.counters.misses += 1;
    return this.beginFetch(entry, keepAlive).token;
  }

  /** @internal Forces a new request generation for an entry. */
  refetchEntry(entry: CacheEntry): Promise<QueryOutcome<unknown>> {
    if (!entry.options.queryFn) {
      return Promise.resolve(skippedOutcome<unknown>('no-query-fn'));
    }
    this.detach(entry, 'superseded');
    entry.generation += 1;
    this.clearStaleTimer(entry);
    this.notifyEntry(entry);
    return this.beginFetch(entry, true).promise;
  }

  /** @internal Releases a consumer token; may abort a no-longer-needed request. */
  releaseToken(token: FetchToken): void {
    if (token.released) return;
    token.released = true;
    const fetch = token.fetch;
    fetch.tokens.delete(token);
    if (fetch.settled) return;
    if (fetch.tokens.size === 0 && !fetch.hasKeepAlive) {
      this.autoAbort(fetch);
    }
  }

  /** @internal */
  rescheduleTimers(entry: CacheEntry): void {
    this.scheduleStaleTimer(entry);
    this.scheduleGcIfIdle(entry);
  }

  /** @internal */
  stateOf<T>(entry: CacheEntry | undefined): QueryState<T> {
    if (!entry) {
      return {
        data: undefined,
        hasData: false,
        error: null,
        dataUpdatedAt: null,
        errorUpdatedAt: null,
        isStale: true,
        status: 'pending',
      };
    }
    const hasData = entry.hasData;
    return {
      data: hasData ? (entry.data as T) : undefined,
      hasData,
      error: entry.error,
      dataUpdatedAt: entry.dataUpdatedAt,
      errorUpdatedAt: entry.errorUpdatedAt,
      isStale: this.isEntryStale(entry),
      status: hasData ? 'success' : entry.error != null ? 'error' : 'pending',
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async runFetchQuery<T>(
    key: QueryKey,
    queryFn: QueryFn<T>,
    options: ResolvedFetchOptions,
  ): Promise<QueryOutcome<T>> {
    const entry = this.ensureEntry(key, {
      queryFn: queryFn as QueryFn<unknown>,
      staleTime: options.staleTime,
      gcTime: options.gcTime,
      retry: options.retry,
      retryDelay: options.retryDelay,
    });
    entry.lastAccessAt = this.now();

    if (options.force) {
      this.detach(entry, 'superseded');
      entry.generation += 1;
      this.clearStaleTimer(entry);
      this.notifyEntry(entry);
      this.counters.misses += 1;
      return this.beginFetch(entry, true).promise as Promise<QueryOutcome<T>>;
    }

    if (entry.hasData && !entry.dirty && !this.isEntryStale(entry)) {
      this.counters.hits += 1;
      this.emit({ type: 'cache:hit', keyHash: entry.eventHash, at: this.now() });
      return {
        settled: 'skipped',
        skipReason: 'fresh',
        source: 'cache',
        data: entry.data as T,
        dataUpdatedAt: entry.dataUpdatedAt,
      };
    }

    const running = entry.inFlight;
    if (running) {
      this.counters.dedupeJoins += 1;
      this.join(running, true);
      return running.promise as Promise<QueryOutcome<T>>;
    }

    this.counters.misses += 1;
    this.emit({ type: 'cache:miss', keyHash: entry.eventHash, at: this.now() });
    return this.beginFetch(entry, true).promise as Promise<QueryOutcome<T>>;
  }

  private async runInvalidate(
    entries: CacheEntry[],
    options: InvalidateOptions,
  ): Promise<InvalidateResult> {
    const refetchActive = options.refetchActive ?? true;
    const promises: Promise<QueryOutcome<unknown>>[] = [];

    for (const entry of entries) {
      this.detach(entry, 'superseded');
      entry.generation += 1;
      entry.dirty = true;
      this.clearStaleTimer(entry);
      this.counters.invalidations += 1;
      this.emit({ type: 'invalidate', keyHash: entry.eventHash, at: this.now() });
      this.notifyEntry(entry);

      if (refetchActive && entry.observers.size > 0 && entry.options.queryFn) {
        promises.push(this.beginFetch(entry, true).promise);
      }
    }

    const result: InvalidateResult = {
      invalidated: entries.length,
      refetching: promises.length,
    };
    if (options.awaitRefetch) {
      result.outcomes = await Promise.all(promises);
    }
    return result;
  }

  private async runRefetch(entries: CacheEntry[], awaitSettled: boolean): Promise<RefetchResult> {
    const promises: Promise<QueryOutcome<unknown>>[] = [];
    const skipped: QueryOutcome<unknown>[] = [];

    for (const entry of entries) {
      if (!entry.options.queryFn) {
        skipped.push(skippedOutcome<unknown>('no-query-fn', undefined, entry.dataUpdatedAt));
        continue;
      }
      this.detach(entry, 'superseded');
      entry.generation += 1;
      this.clearStaleTimer(entry);
      this.notifyEntry(entry);
      promises.push(this.beginFetch(entry, true).promise);
    }

    if (!awaitSettled) return { refetched: promises.length, outcomes: [] };
    const outcomes = await Promise.all(promises);
    return { refetched: promises.length, outcomes: [...skipped, ...outcomes] };
  }

  private resolvePrefetchOptions<T>(
    queryFn: QueryFn<T>,
    options: PrefetchQueryOptions,
  ): { entry: PrefetchEntryOptions; priority: PrefetchPriority; signal?: AbortSignal } {
    if (options.priority !== undefined && !isPrefetchPriority(options.priority)) {
      throw new TypeError('priority must be one of "high", "normal" or "low"');
    }
    if (options.staleTime !== undefined) assertTime(options.staleTime, 'staleTime');
    if (options.gcTime !== undefined) assertTime(options.gcTime, 'gcTime');
    if (options.retryDelay !== undefined && typeof options.retryDelay !== 'function') {
      throw new TypeError('retryDelay must be a function');
    }
    if (options.signal !== undefined && !isAbortSignal(options.signal)) {
      throw new TypeError('signal must be an AbortSignal');
    }
    return {
      entry: {
        queryFn: queryFn as QueryFn<unknown>,
        staleTime: options.staleTime ?? this.staleTime,
        gcTime: options.gcTime ?? this.gcTime,
        retry:
          options.retry === undefined
            ? this.retry
            : assertRetry(options.retry, (message) => this.warn(message)),
        retryDelay: options.retryDelay ?? this.retryDelay,
      },
      priority: options.priority ?? 'normal',
      signal: options.signal,
    };
  }

  private async runPrefetchQuery<T>(
    key: QueryKey,
    resolved: { entry: PrefetchEntryOptions; priority: PrefetchPriority; signal?: AbortSignal },
  ): Promise<QueryOutcome<T>> {
    const entry = this.ensureEntry(key, resolved.entry);
    entry.lastAccessAt = this.now();

    if (entry.hasData && !entry.dirty && !this.isEntryStale(entry)) {
      this.counters.hits += 1;
      this.emit({ type: 'cache:hit', keyHash: entry.eventHash, at: this.now() });
      return {
        settled: 'skipped',
        skipReason: 'fresh',
        source: 'cache',
        data: entry.data as T,
        dataUpdatedAt: entry.dataUpdatedAt,
      };
    }

    const running = entry.inFlight;
    if (running) {
      this.counters.dedupeJoins += 1;
      const token = this.join(running, false);
      const signal = resolved.signal;
      if (signal) {
        const onAbort = () => this.releaseToken(token);
        signal.addEventListener('abort', onAbort, { once: true });
        void running.promise.then(() => signal.removeEventListener('abort', onAbort));
      }
      return running.promise as Promise<QueryOutcome<T>>;
    }

    return this.prefetcher.enqueue(
      key,
      resolved.entry,
      resolved.priority,
      resolved.signal,
    ) as Promise<QueryOutcome<T>>;
  }

  private resolveOptions(options: FetchQueryOptions): ResolvedFetchOptions {
    if (options.staleTime !== undefined) assertTime(options.staleTime, 'staleTime');
    if (options.gcTime !== undefined) assertTime(options.gcTime, 'gcTime');
    if (options.retryDelay !== undefined && typeof options.retryDelay !== 'function') {
      throw new TypeError('retryDelay must be a function');
    }
    if (options.force !== undefined && typeof options.force !== 'boolean') {
      throw new TypeError('force must be a boolean');
    }
    return {
      staleTime: options.staleTime ?? this.staleTime,
      gcTime: options.gcTime ?? this.gcTime,
      retry:
        options.retry === undefined ? this.retry : assertRetry(options.retry, (m) => this.warn(m)),
      retryDelay: options.retryDelay ?? this.retryDelay,
      force: options.force === true,
      enabled: true,
      cancelOnUnmount: false,
    };
  }

  private optionsFromQuery(
    key: QueryKey,
    options: QueryOptions<unknown>,
  ): EntryOptions & { initialData?: unknown } {
    if (options.staleTime !== undefined) assertTime(options.staleTime, 'staleTime');
    if (options.gcTime !== undefined) assertTime(options.gcTime, 'gcTime');
    if (options.retryDelay !== undefined && typeof options.retryDelay !== 'function') {
      throw new TypeError('retryDelay must be a function');
    }
    void key;
    return {
      queryFn: options.queryFn,
      staleTime: options.staleTime ?? this.staleTime,
      gcTime: options.gcTime ?? this.gcTime,
      retry:
        options.retry === undefined ? this.retry : assertRetry(options.retry, (m) => this.warn(m)),
      retryDelay: options.retryDelay ?? this.retryDelay,
      initialData: options.initialData,
    };
  }

  private defaultEntryOptions(): EntryOptions {
    return {
      staleTime: this.staleTime,
      gcTime: this.gcTime,
      retry: this.retry,
      retryDelay: this.retryDelay,
    };
  }

  private ensureEntry(
    key: QueryKey,
    options: EntryOptions & { initialData?: unknown },
  ): CacheEntry {
    const keyHash = canonicalizeQueryKey(key);
    const existing = this.entries.get(keyHash);
    if (existing) {
      existing.options = {
        queryFn: options.queryFn ?? existing.options.queryFn,
        staleTime: options.staleTime,
        gcTime: options.gcTime,
        retry: options.retry,
        retryDelay: options.retryDelay,
      };
      existing.lastAccessAt = this.now();
      this.scheduleStaleTimer(existing);
      return existing;
    }

    const entry: CacheEntry = {
      key,
      keyHash,
      eventHash: hashQueryKey(keyHash),
      scopeTag: this.tag,
      data: undefined,
      hasData: false,
      dataUpdatedAt: null,
      error: null,
      errorUpdatedAt: null,
      generation: 0,
      dirty: false,
      failureCount: 0,
      inFlight: null,
      observers: new Set(),
      gcTimer: null,
      staleTimer: null,
      lastAccessAt: this.now(),
      options: {
        queryFn: options.queryFn,
        staleTime: options.staleTime,
        gcTime: options.gcTime,
        retry: options.retry,
        retryDelay: options.retryDelay,
      },
    };
    if (options.initialData !== undefined) {
      entry.data = options.initialData;
      entry.hasData = true;
      entry.dataUpdatedAt = this.now();
    }
    this.entries.set(keyHash, entry);
    this.enforceCapacity(entry);
    this.scheduleStaleTimer(entry);
    this.scheduleGcIfIdle(entry);
    return entry;
  }

  private beginFetch(
    entry: CacheEntry,
    keepAlive: boolean,
  ): { fetch: InFlightFetch; token: FetchToken; promise: Promise<QueryOutcome<unknown>> } {
    let resolve!: (outcome: QueryOutcome<unknown>) => void;
    const promise = new Promise<QueryOutcome<unknown>>((resolvePromise) => {
      resolve = resolvePromise;
    });

    this.requestCounter += 1;
    const fetch: InFlightFetch = {
      entry,
      requestId: this.requestCounter,
      generation: entry.generation,
      scopeTag: this.tag,
      scopeEpoch: this.epoch,
      attempt: 0,
      abort: new AbortController(),
      tokens: new Set(),
      hasKeepAlive: false,
      settled: false,
      promise,
      resolve,
      retryTimer: null,
      wake: null,
    };
    entry.inFlight = fetch;
    this.clearGcTimer(entry);
    const token = this.join(fetch, keepAlive);
    this.counters.fetchesStarted += 1;
    this.emit({ type: 'fetch:start', keyHash: entry.eventHash, at: this.now() });
    void this.runRequest(entry, fetch);
    return { fetch, token, promise };
  }

  private join(fetch: InFlightFetch, keepAlive: boolean): FetchToken {
    const token: FetchToken = { fetch, keepAlive, released: false };
    fetch.tokens.add(token);
    if (keepAlive) fetch.hasKeepAlive = true;
    return token;
  }

  private async runRequest(entry: CacheEntry, fetch: InFlightFetch): Promise<void> {
    const { retry, retryDelay } = entry.options;
    const queryFn = entry.options.queryFn;
    if (!queryFn) {
      this.fail(entry, fetch, new Error('No queryFn available for this query'));
      return;
    }

    while (!fetch.settled) {
      fetch.attempt += 1;
      try {
        const value = await queryFn({ queryKey: entry.key, signal: fetch.abort.signal });
        if (!this.isCurrent(entry, fetch)) {
          this.counters.discarded += 1;
          return;
        }
        this.commit(entry, fetch, value);
        return;
      } catch (error) {
        if (!this.isCurrent(entry, fetch)) {
          this.counters.discarded += 1;
          return;
        }
        if (fetch.attempt > retry || !this.isRetryable(error)) {
          this.fail(entry, fetch, error);
          return;
        }
        this.counters.retries += 1;
        this.emit({
          type: 'fetch:error',
          keyHash: entry.eventHash,
          at: this.now(),
          reason: 'retry',
        });
        await this.sleep(fetch, retryDelay(fetch.attempt));
      }
    }
  }

  private isCurrent(entry: CacheEntry, fetch: InFlightFetch): boolean {
    return (
      !fetch.settled &&
      entry.inFlight === fetch &&
      entry.generation === fetch.generation &&
      entry.scopeTag === this.tag &&
      fetch.scopeTag === this.tag &&
      fetch.scopeEpoch === this.epoch &&
      this.entries.get(entry.keyHash) === entry
    );
  }

  private isRetryable(error: unknown): boolean {
    if (error instanceof Error && error.name === 'AbortError') return false;
    if (typeof error === 'object' && error !== null && 'status' in error) {
      const status = (error as { status?: unknown }).status;
      if (typeof status === 'number') {
        return status === 408 || status === 429 || status >= 500;
      }
    }
    return true;
  }

  private sleep(fetch: InFlightFetch, delay: number): Promise<void> {
    return new Promise<void>((resolve) => {
      fetch.wake = () => {
        if (fetch.retryTimer !== null) clearTimeout(fetch.retryTimer);
        fetch.retryTimer = null;
        fetch.wake = null;
        resolve();
      };
      fetch.retryTimer = setTimeout(() => fetch.wake?.(), delay);
      this.unrefTimer(fetch.retryTimer);
    });
  }

  private commit(entry: CacheEntry, fetch: InFlightFetch, value: unknown): void {
    entry.data = value;
    entry.hasData = true;
    entry.dataUpdatedAt = this.now();
    entry.error = null;
    entry.errorUpdatedAt = null;
    entry.dirty = false;
    entry.failureCount = 0;
    entry.inFlight = null;
    this.counters.fetchesSucceeded += 1;
    this.settle(fetch, {
      settled: 'fulfilled',
      source: 'network',
      data: value as never,
      dataUpdatedAt: entry.dataUpdatedAt,
    });
    this.emit({ type: 'fetch:success', keyHash: entry.eventHash, at: this.now() });
    this.scheduleStaleTimer(entry);
    this.scheduleGcIfIdle(entry);
    this.notifyEntry(entry);
  }

  private fail(entry: CacheEntry, fetch: InFlightFetch, error: unknown): void {
    entry.error = error;
    entry.errorUpdatedAt = this.now();
    entry.failureCount = Math.max(0, fetch.attempt - 1);
    entry.inFlight = null;
    this.counters.fetchesFailed += 1;
    this.settle(fetch, {
      settled: 'failed',
      data: entry.hasData ? (entry.data as never) : undefined,
      dataUpdatedAt: entry.dataUpdatedAt,
      error,
    });
    this.emit({ type: 'fetch:error', keyHash: entry.eventHash, at: this.now(), reason: 'failed' });
    this.scheduleGcIfIdle(entry);
    this.notifyEntry(entry);
  }

  private settle(fetch: InFlightFetch, outcome: QueryOutcome<unknown>): void {
    if (fetch.settled) return;
    fetch.settled = true;
    if (fetch.retryTimer !== null) {
      clearTimeout(fetch.retryTimer);
      fetch.retryTimer = null;
    }
    fetch.wake = null;
    for (const token of fetch.tokens) token.released = true;
    fetch.tokens.clear();
    fetch.resolve(outcome);
  }

  private detach(entry: CacheEntry, reason: Settled): void {
    const fetch = entry.inFlight;
    if (!fetch) return;
    entry.inFlight = null;
    fetch.abort.abort();
    const outcome: QueryOutcome<unknown> = {
      settled: reason,
      data:
        reason === 'superseded' || reason === 'removed'
          ? entry.hasData
            ? (entry.data as never)
            : undefined
          : undefined,
      dataUpdatedAt: reason === 'superseded' || reason === 'removed' ? entry.dataUpdatedAt : null,
    };
    if (reason === 'superseded') this.counters.superseded += 1;
    if (reason === 'cancelled') this.counters.cancelled += 1;
    this.settle(fetch, outcome);
  }

  private autoAbort(fetch: InFlightFetch): void {
    const entry = fetch.entry;
    if (entry.inFlight !== fetch) return;
    entry.inFlight = null;
    fetch.abort.abort();
    this.counters.cancelled += 1;
    this.settle(fetch, {
      settled: 'cancelled',
      data: undefined,
      dataUpdatedAt: null,
    });
    this.emit({
      type: 'fetch:cancelled',
      keyHash: entry.eventHash,
      at: this.now(),
      reason: 'unmount',
    });
  }

  private select(filter: QueryFilter, exactOverride?: boolean): CacheEntry[] {
    return [...this.entries.values()].filter((entry) =>
      this.keyMatches(entry.key, filter, exactOverride),
    );
  }

  private keyMatches(key: QueryKey, filter: QueryFilter, exactOverride?: boolean): boolean {
    if (typeof filter === 'function') return filter(key);

    const isKeyed = isObjectFilter(filter);
    const target = isKeyed ? filter.queryKey : filter;
    canonicalizeQueryKey(target);
    const exact = exactOverride ?? (isKeyed ? filter.exact === true : false);
    return exact ? queryKeysEqual(key, target) : queryKeyStartsWith(key, target);
  }

  private scheduleStaleTimer(entry: CacheEntry): void {
    this.clearStaleTimer(entry);
    if (!entry.hasData || entry.dataUpdatedAt === null || entry.dirty) return;
    if (entry.options.staleTime === Infinity) return;
    const delay = entry.dataUpdatedAt + entry.options.staleTime - this.now();
    if (delay <= 0) return;
    entry.staleTimer = setTimeout(() => {
      entry.staleTimer = null;
      this.counters.staleFlips += 1;
      this.notifyEntry(entry);
    }, delay);
    this.unrefTimer(entry.staleTimer);
  }

  private clearStaleTimer(entry: CacheEntry): void {
    if (entry.staleTimer !== null) {
      clearTimeout(entry.staleTimer);
      entry.staleTimer = null;
    }
  }

  private scheduleGcIfIdle(entry: CacheEntry): void {
    if (entry.observers.size > 0 || entry.inFlight) {
      this.clearGcTimer(entry);
      return;
    }
    this.clearGcTimer(entry);
    if (entry.options.gcTime === Infinity) return;
    entry.gcTimer = setTimeout(() => {
      entry.gcTimer = null;
      if (entry.observers.size > 0 || entry.inFlight) return;
      if (this.entries.get(entry.keyHash) !== entry) return;
      this.entries.delete(entry.keyHash);
      this.clearTimers(entry);
      this.counters.gcRuns += 1;
      this.emit({ type: 'cache:gc', keyHash: entry.eventHash, at: this.now() });
    }, entry.options.gcTime);
    this.unrefTimer(entry.gcTimer);
  }

  private clearGcTimer(entry: CacheEntry): void {
    if (entry.gcTimer !== null) {
      clearTimeout(entry.gcTimer);
      entry.gcTimer = null;
    }
  }

  private clearTimers(entry: CacheEntry): void {
    this.clearGcTimer(entry);
    this.clearStaleTimer(entry);
  }

  private enforceCapacity(protectedEntry?: CacheEntry): void {
    if (this.entries.size <= this.maxEntries) return;
    const candidates = [...this.entries.values()]
      .filter(
        (entry) =>
          entry !== protectedEntry && entry.observers.size === 0 && entry.inFlight === null,
      )
      .sort((left, right) => left.lastAccessAt - right.lastAccessAt);

    while (this.entries.size > this.maxEntries && candidates.length > 0) {
      const victim = candidates.shift() as CacheEntry;
      this.entries.delete(victim.keyHash);
      this.clearTimers(victim);
      this.counters.evictions += 1;
      this.emit({ type: 'cache:evict', keyHash: victim.eventHash, at: this.now() });
    }
  }

  private prefetchHost(): PrefetchHost {
    return {
      getAuthScope: () => this.getAuthScope(),
      ensurePrefetchEntry: (key, options) => this.ensurePrefetchEntry(key, options),
      isEntryStale: (entry) => this.isEntryStale(entry),
      startPrefetchFetch: (entry) => this.startPrefetchFetch(entry),
      releasePrefetchToken: (token) => this.releaseToken(token),
      recordPrefetch: (metric) => this.recordPrefetchMetric(metric),
      emitPrefetch: (type, keyHash, reason) =>
        this.emit({
          type,
          keyHash,
          at: this.now(),
          ...(reason === undefined ? {} : { reason }),
        }),
    };
  }

  private recordPrefetchMetric(metric: PrefetchMetric): void {
    switch (metric) {
      case 'queued':
        this.counters.prefetchQueued += 1;
        break;
      case 'deduped':
        this.counters.prefetchDeduped += 1;
        break;
      case 'started':
        this.counters.prefetchStarted += 1;
        break;
      case 'fulfilled':
        this.counters.prefetchFulfilled += 1;
        break;
      case 'failed':
        this.counters.prefetchFailed += 1;
        break;
      case 'skipped':
        this.counters.prefetchSkipped += 1;
        break;
      case 'cancelled':
        this.counters.prefetchCancelled += 1;
        break;
    }
  }

  private notifyEntry(entry: CacheEntry): void {
    for (const observer of [...entry.observers]) {
      if (entry.observers.has(observer)) observer.onEntryChange();
    }
  }

  private emit(event: CacheEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A faulty diagnostics listener must never break cache behavior.
      }
    }
  }

  private warn(message: string): void {
    if (typeof console !== 'undefined') console.warn(`[flux-cache] ${message}`);
  }

  private unrefTimer(timer: ReturnType<typeof setTimeout>): void {
    const candidate = timer as unknown as { unref?: () => void };
    candidate.unref?.();
  }
}

/**
 * Structural view of a client.
 *
 * `flux-cache` and `flux-cache/react` are built as separate declaration
 * bundles, so each one declares `FluxCacheClient` with private fields. Using
 * this mapped type at package boundaries keeps those declarations structurally
 * compatible instead of nominally incompatible.
 */
export type CacheClient = Pick<FluxCacheClient, keyof FluxCacheClient>;

/** Creates a cache client. */
export function createFluxCache(config: FluxCacheConfig = {}): FluxCacheClient {
  return new FluxCacheClient(config);
}

/** Hashes a key for diagnostics without exposing its value. */
export function cacheKeyHash(key: QueryKey): string {
  return hashQueryKey(canonicalizeQueryKey(key));
}

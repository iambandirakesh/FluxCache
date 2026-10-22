import type { CacheClient } from './client';
import type { FetchToken } from './internal';
import { canonicalizeQueryKey } from './key';
import type { QueryKey, QueryOptions, QueryOutcome, QuerySnapshot } from './types';

/**
 * Observes one cache entry and exposes a stable snapshot.
 *
 * Framework independent: the React adapter feeds it to `useSyncExternalStore`.
 * Observers are cheap; create one per hook instance.
 */
export class QueryObserver<T> {
  private client: CacheClient;
  private options: QueryOptions<T>;
  key: QueryKey;
  private keyHash: string;
  private listeners = new Set<() => void>();
  private snapshot: QuerySnapshot<T>;
  private dirty = false;
  private mounted = false;
  private token: FetchToken | null = null;

  constructor(client: CacheClient, options: QueryOptions<T>) {
    this.client = client;
    this.options = options;
    this.key = options.queryKey;
    this.keyHash = canonicalizeQueryKey(options.queryKey);
    if (options.initialData !== undefined) {
      // Seed before the first render so SSR and hydration see data immediately.
      client.ensureEntryFor(this.key, options as QueryOptions<unknown>);
    }
    this.snapshot = this.build();
  }

  /** Stable snapshot getter for `useSyncExternalStore`. */
  readonly getSnapshot = (): QuerySnapshot<T> => {
    if (this.dirty) {
      this.dirty = false;
      this.snapshot = this.build();
    }
    return this.snapshot;
  };

  /** Server snapshot: identical shape, never triggers work. */
  readonly getServerSnapshot = (): QuerySnapshot<T> => this.getSnapshot();

  /** Stable subscribe function for `useSyncExternalStore`. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Forces a new request generation. Never rejects. */
  readonly refetch = (): Promise<QueryOutcome<T>> => {
    this.releaseToken();
    return this.client.refetchEntry(this.entryForWork()) as Promise<QueryOutcome<T>>;
  };

  /** Updates options passively. Only a key change does cache work here. */
  setOptions(options: QueryOptions<T>): void {
    const nextHash = canonicalizeQueryKey(options.queryKey);
    this.options = options;
    if (nextHash !== this.keyHash) {
      if (this.mounted) {
        const oldEntry = this.client.peek(this.keyHash);
        this.releaseToken();
        if (oldEntry) this.client.removeEntryObserver(oldEntry, this);
      }
      this.key = options.queryKey;
      this.keyHash = nextHash;
      if (this.mounted) {
        const nextEntry = this.client.ensureEntryFor(this.key, options as QueryOptions<unknown>);
        this.client.addEntryObserver(nextEntry, this);
        this.maybeFetch();
      }
      this.dirty = true;
    }
  }

  /** Registers with the cache and starts a fetch when the data is missing or stale. */
  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    this.client.attachObserver(this);
    const entry = this.client.ensureEntryFor(this.key, this.options as QueryOptions<unknown>);
    this.client.addEntryObserver(entry, this);
    this.refresh();
    this.maybeFetch();
  }

  /** Releases the consumer token and detaches from the cache. */
  unmount(): void {
    if (!this.mounted) return;
    this.mounted = false;
    const entry = this.client.peek(this.keyHash);
    this.releaseToken();
    if (entry) this.client.removeEntryObserver(entry, this);
    this.client.detachObserver(this);
  }

  /** Starts a fetch when enabled and the data is missing or stale. */
  maybeFetch(): void {
    if (!this.mounted || this.options.enabled === false) return;
    const entry = this.entryForWork();
    if (this.token && !this.token.fetch.settled && this.token.fetch === entry.inFlight) return;
    if (!entry.inFlight && !this.client.isEntryStale(entry)) return;
    this.releaseToken();
    this.token = this.client.fetchForObserver(entry, this.options as QueryOptions<unknown>);
    this.refresh();
  }

  /** Called by the client whenever the entry changed. */
  onEntryChange(): void {
    if (this.token?.fetch.settled) this.token = null;
    this.refresh();
  }

  /**
   * Called by the client on authentication scope change.
   * Re-attaches to the new scope's (empty) entry without fetching; the app
   * decides when to request data for the new account.
   */
  onScopeChange(): void {
    this.token = null;
    if (this.mounted) this.entryForWork();
    this.refresh();
  }

  private entryForWork(): ReturnType<CacheClient['ensureEntryFor']> {
    const entry = this.client.ensureEntryFor(this.key, this.options as QueryOptions<unknown>);
    if (this.mounted) this.client.addEntryObserver(entry, this);
    return entry;
  }

  private refresh(): void {
    this.dirty = true;
    for (const listener of [...this.listeners]) listener();
  }

  private releaseToken(): void {
    if (this.token) {
      this.client.releaseToken(this.token);
      this.token = null;
    }
  }

  private build(): QuerySnapshot<T> {
    const entry = this.client.peek(this.keyHash);
    const state = this.client.stateOf<T>(entry);
    const isFetching = entry?.inFlight != null;
    const hasData = state.hasData;
    const error = state.error ?? null;
    return {
      data: state.data,
      error,
      status: state.status,
      fetchStatus: isFetching ? 'fetching' : 'idle',
      hasData,
      isPending: !hasData && error == null,
      isLoading: !hasData && isFetching,
      isSuccess: hasData,
      isError: !hasData && error != null,
      isFetching,
      isStale: state.isStale,
      failureCount: entry?.failureCount ?? 0,
      dataUpdatedAt: state.dataUpdatedAt,
      errorUpdatedAt: state.errorUpdatedAt,
      refetch: this.refetch,
    };
  }
}

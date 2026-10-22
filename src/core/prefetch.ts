import type { CacheEntry, FetchToken } from './internal';
import { canonicalizeQueryKey, hashQueryKey } from './key';
import type {
  CacheEvent,
  NetworkInfo,
  PrefetchConfig,
  PrefetchPriority,
  QueryFn,
  QueryKey,
  QueryOutcome,
  SkipReason,
} from './types';

/** Fully resolved prefetch configuration. */
export interface ResolvedPrefetchConfig {
  enabled: boolean;
  concurrency: number;
  queueLimit: number;
  respectSaveData: boolean;
  respectSlowNetwork: boolean;
  slowConnections: readonly string[];
}

/** Entry options a prefetch job installs before it starts. */
export interface PrefetchEntryOptions {
  queryFn: QueryFn<unknown>;
  staleTime: number;
  gcTime: number;
  retry: number;
  retryDelay: (attempt: number) => number;
}

/** Counters the scheduler reports to the client. */
export type PrefetchMetric =
  'queued' | 'deduped' | 'started' | 'fulfilled' | 'failed' | 'skipped' | 'cancelled';

/** The small surface the scheduler needs from the cache client. */
export interface PrefetchHost {
  getAuthScope(): { scopeTag: string; epoch: number };
  ensurePrefetchEntry(key: QueryKey, options: PrefetchEntryOptions): CacheEntry;
  isEntryStale(entry: CacheEntry): boolean;
  startPrefetchFetch(entry: CacheEntry): {
    promise: Promise<QueryOutcome<unknown>>;
    token: FetchToken;
  };
  releasePrefetchToken(token: FetchToken): void;
  recordPrefetch(metric: PrefetchMetric): void;
  emitPrefetch(type: CacheEvent['type'], keyHash: string, reason?: string): void;
}

const DEFAULT_PREFETCH: ResolvedPrefetchConfig = {
  enabled: true,
  concurrency: 4,
  queueLimit: 100,
  respectSaveData: true,
  respectSlowNetwork: true,
  slowConnections: ['slow-2g', '2g'],
};

const PRIORITY_RANK: Record<PrefetchPriority, number> = { low: 0, normal: 1, high: 2 };

/** Narrowing guard for the public priority values. */
export function isPrefetchPriority(value: unknown): value is PrefetchPriority {
  return value === 'high' || value === 'normal' || value === 'low';
}

/** Applies defaults and validates scheduler configuration synchronously. */
export function resolvePrefetchConfig(config: PrefetchConfig | undefined): ResolvedPrefetchConfig {
  if (config === undefined) return { ...DEFAULT_PREFETCH };
  if (typeof config !== 'object' || config === null) {
    throw new TypeError('prefetch must be an object');
  }
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
    throw new TypeError('prefetch.enabled must be a boolean');
  }
  if (
    config.concurrency !== undefined &&
    (!Number.isInteger(config.concurrency) || config.concurrency < 1)
  ) {
    throw new RangeError('prefetch.concurrency must be a positive integer');
  }
  if (
    config.queueLimit !== undefined &&
    (!Number.isInteger(config.queueLimit) || config.queueLimit < 1)
  ) {
    throw new RangeError('prefetch.queueLimit must be a positive integer');
  }
  if (config.respectSaveData !== undefined && typeof config.respectSaveData !== 'boolean') {
    throw new TypeError('prefetch.respectSaveData must be a boolean');
  }
  if (config.respectSlowNetwork !== undefined && typeof config.respectSlowNetwork !== 'boolean') {
    throw new TypeError('prefetch.respectSlowNetwork must be a boolean');
  }
  if (config.slowConnections !== undefined) {
    if (
      !Array.isArray(config.slowConnections) ||
      !config.slowConnections.every((value) => typeof value === 'string')
    ) {
      throw new TypeError('prefetch.slowConnections must be an array of strings');
    }
  }

  return {
    enabled: config.enabled ?? DEFAULT_PREFETCH.enabled,
    concurrency: config.concurrency ?? DEFAULT_PREFETCH.concurrency,
    queueLimit: config.queueLimit ?? DEFAULT_PREFETCH.queueLimit,
    respectSaveData: config.respectSaveData ?? DEFAULT_PREFETCH.respectSaveData,
    respectSlowNetwork: config.respectSlowNetwork ?? DEFAULT_PREFETCH.respectSlowNetwork,
    slowConnections: config.slowConnections
      ? [...config.slowConnections]
      : [...DEFAULT_PREFETCH.slowConnections],
  };
}

interface ConnectionLike {
  saveData?: boolean;
  effectiveType?: string;
}

/** Reads browser network hints; returns nothing during SSR or without support. */
export function readNetworkInfo(): NetworkInfo {
  if (typeof navigator === 'undefined') return {};
  const connection = (navigator as Navigator & { connection?: ConnectionLike }).connection;
  if (!connection) return {};
  return {
    saveData: connection.saveData === true,
    effectiveType: connection.effectiveType,
  };
}

/** Returns the reason a prefetch must not use the network, if any. */
export function prefetchNetworkSkip(
  network: NetworkInfo,
  config: ResolvedPrefetchConfig,
): SkipReason | null {
  if (config.respectSaveData && network.saveData === true) return 'save-data';
  if (
    config.respectSlowNetwork &&
    network.effectiveType !== undefined &&
    config.slowConnections.includes(network.effectiveType)
  ) {
    return 'slow-network';
  }
  return null;
}

function skippedOutcome(reason: SkipReason, data?: unknown, dataUpdatedAt: number | null = null) {
  return {
    settled: 'skipped' as const,
    skipReason: reason,
    data,
    dataUpdatedAt,
  };
}

type CancelReason = 'cancelled' | 'removed' | 'scope-changed';

function cancelOutcome(reason: CancelReason): QueryOutcome<unknown> {
  if (reason === 'removed') return skippedOutcome('removed');
  return { settled: reason, data: undefined, dataUpdatedAt: null };
}

interface PrefetchJob {
  dedupeKey: string;
  key: QueryKey;
  eventHash: string;
  options: PrefetchEntryOptions;
  priority: number;
  sequence: number;
  scopeTag: string;
  scopeEpoch: number;
  promise: Promise<QueryOutcome<unknown>>;
  resolve: (outcome: QueryOutcome<unknown>) => void;
  settled: boolean;
  token: FetchToken | null;
  signal?: AbortSignal | undefined;
  onAbort?: (() => void) | undefined;
}

/**
 * Bounded, priority-aware prefetch scheduler.
 *
 * Jobs are deduplicated per scope and key. A job revalidates freshness, scope
 * and removal when it leaves the queue, so work queued before an invalidation
 * or scope switch cannot commit stale or foreign data.
 */
export class PrefetchScheduler {
  private readonly queue: PrefetchJob[] = [];
  private readonly running = new Set<PrefetchJob>();
  private readonly queuedByKey = new Map<string, PrefetchJob>();
  private readonly concurrency: number;
  private readonly queueLimit: number;
  private sequence = 0;
  private pumping = false;

  constructor(
    private readonly host: PrefetchHost,
    config: ResolvedPrefetchConfig,
  ) {
    this.concurrency = config.concurrency;
    this.queueLimit = config.queueLimit;
  }

  /**
   * Queues a prefetch job, joins an equivalent queued job, or resolves a
   * skipped outcome when the queue is saturated.
   */
  enqueue(
    key: QueryKey,
    options: PrefetchEntryOptions,
    priority: PrefetchPriority,
    signal?: AbortSignal,
  ): Promise<QueryOutcome<unknown>> {
    const keyHash = canonicalizeQueryKey(key);
    const eventHash = hashQueryKey(keyHash);
    const scope = this.host.getAuthScope();
    const dedupeKey = `${scope.scopeTag}:${keyHash}`;

    if (signal?.aborted) return Promise.resolve(skippedOutcome('cancelled'));

    const existing = this.queuedByKey.get(dedupeKey);
    if (existing) {
      this.host.recordPrefetch('deduped');
      return existing.promise;
    }

    let resolve!: (outcome: QueryOutcome<unknown>) => void;
    const promise = new Promise<QueryOutcome<unknown>>((resolvePromise) => {
      resolve = resolvePromise;
    });
    this.sequence += 1;
    const job: PrefetchJob = {
      dedupeKey,
      key,
      eventHash,
      options,
      priority: PRIORITY_RANK[priority],
      sequence: this.sequence,
      scopeTag: scope.scopeTag,
      scopeEpoch: scope.epoch,
      promise,
      resolve,
      settled: false,
      token: null,
      signal,
    };

    if (signal) {
      const onAbort = () => {
        if (job.settled) return;
        this.finish(job, cancelOutcome('cancelled'));
      };
      job.onAbort = onAbort;
      signal.addEventListener('abort', onAbort, { once: true });
    }

    if (this.queue.length >= this.queueLimit) {
      const lowest = this.lowestPriorityJob();
      if (lowest && lowest.priority < job.priority) {
        // Deterministic eviction: the new, more urgent job wins; the evicted
        // caller learns why its work was dropped.
        this.finish(lowest, skippedOutcome('queue-full'));
      } else {
        this.finish(job, skippedOutcome('queue-full'));
        return promise;
      }
    }

    this.queue.push(job);
    this.queuedByKey.set(dedupeKey, job);
    this.host.recordPrefetch('queued');
    this.host.emitPrefetch('prefetch:queued', eventHash, priority);
    this.pump();
    return promise;
  }

  /** Cancels every queued and running job. Returns how many were settled. */
  cancelAll(reason: CancelReason): number {
    const jobs = new Set<PrefetchJob>([...this.queue, ...this.running]);
    for (const job of jobs) this.finish(job, cancelOutcome(reason));
    this.pump();
    return jobs.size;
  }

  /** Cancels jobs whose key matches. Returns how many were settled. */
  cancelMatching(predicate: (key: QueryKey) => boolean, reason: CancelReason): number {
    const jobs = new Set<PrefetchJob>([...this.queue, ...this.running]);
    let count = 0;
    for (const job of jobs) {
      if (!predicate(job.key)) continue;
      this.finish(job, cancelOutcome(reason));
      count += 1;
    }
    this.pump();
    return count;
  }

  private lowestPriorityJob(): PrefetchJob | undefined {
    let lowest: PrefetchJob | undefined;
    for (const job of this.queue) {
      if (
        !lowest ||
        job.priority < lowest.priority ||
        (job.priority === lowest.priority && job.sequence < lowest.sequence)
      ) {
        lowest = job;
      }
    }
    return lowest;
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.running.size < this.concurrency && this.queue.length > 0) {
        const next = this.takeNext();
        if (!next) break;
        this.running.add(next);
        this.queuedByKey.delete(next.dedupeKey);
        void this.run(next);
      }
    } finally {
      this.pumping = false;
    }
  }

  private takeNext(): PrefetchJob | undefined {
    let bestIndex = -1;
    for (let index = 0; index < this.queue.length; index += 1) {
      const candidate = this.queue[index] as PrefetchJob;
      const best = bestIndex >= 0 ? (this.queue[bestIndex] as PrefetchJob) : undefined;
      if (
        !best ||
        candidate.priority > best.priority ||
        (candidate.priority === best.priority && candidate.sequence < best.sequence)
      ) {
        bestIndex = index;
      }
    }
    if (bestIndex < 0) return undefined;
    return this.queue.splice(bestIndex, 1)[0];
  }

  private async run(job: PrefetchJob): Promise<void> {
    try {
      if (job.settled) return;
      if (!this.scopeMatches(job)) {
        this.finish(job, cancelOutcome('scope-changed'));
        return;
      }
      if (job.signal?.aborted) {
        this.finish(job, cancelOutcome('cancelled'));
        return;
      }

      const entry = this.host.ensurePrefetchEntry(job.key, job.options);
      if (job.settled) return;
      if (!this.scopeMatches(job)) {
        this.finish(job, cancelOutcome('scope-changed'));
        return;
      }
      if (!this.host.isEntryStale(entry)) {
        this.finish(
          job,
          skippedOutcome('fresh', entry.hasData ? entry.data : undefined, entry.dataUpdatedAt),
        );
        return;
      }

      this.host.recordPrefetch('started');
      this.host.emitPrefetch('prefetch:started', entry.eventHash);
      // Diagnostics listeners are arbitrary user code and may cancel the job or
      // change scope synchronously. Recheck before starting any work.
      if (job.settled) return;
      if (!this.scopeMatches(job)) {
        this.finish(job, cancelOutcome('scope-changed'));
        return;
      }

      const started = this.host.startPrefetchFetch(entry);
      job.token = started.token;
      // The fetch may have been cancelled while it was starting (for example
      // from a `fetch:start` listener). Release the token we just acquired so
      // the abandoned request aborts instead of leaking and committing later.
      if (job.settled) {
        job.token = null;
        this.host.releasePrefetchToken(started.token);
        return;
      }
      const outcome = await started.promise;
      this.finish(job, outcome);
    } catch (error) {
      this.finish(job, {
        settled: 'failed',
        data: undefined,
        dataUpdatedAt: null,
        error,
      });
    } finally {
      this.running.delete(job);
      this.pump();
    }
  }

  private scopeMatches(job: PrefetchJob): boolean {
    const scope = this.host.getAuthScope();
    return scope.scopeTag === job.scopeTag && scope.epoch === job.scopeEpoch;
  }

  private finish(job: PrefetchJob, outcome: QueryOutcome<unknown>): void {
    if (job.settled) return;
    job.settled = true;

    const index = this.queue.indexOf(job);
    if (index >= 0) this.queue.splice(index, 1);
    if (this.queuedByKey.get(job.dedupeKey) === job) {
      this.queuedByKey.delete(job.dedupeKey);
    }
    this.running.delete(job);

    if (job.signal && job.onAbort) {
      job.signal.removeEventListener('abort', job.onAbort);
    }
    job.onAbort = undefined;

    const token = job.token;
    job.token = null;
    if (token) this.host.releasePrefetchToken(token);

    this.recordOutcome(outcome);
    if (outcome.settled === 'skipped') {
      this.host.emitPrefetch('prefetch:skipped', job.eventHash, outcome.skipReason ?? 'skipped');
    }
    this.host.emitPrefetch(
      'prefetch:settled',
      job.eventHash,
      outcome.settled === 'skipped' ? (outcome.skipReason ?? 'skipped') : outcome.settled,
    );
    job.resolve(outcome);
  }

  private recordOutcome(outcome: QueryOutcome<unknown>): void {
    switch (outcome.settled) {
      case 'fulfilled':
        this.host.recordPrefetch('fulfilled');
        break;
      case 'failed':
        this.host.recordPrefetch('failed');
        break;
      case 'skipped':
        this.host.recordPrefetch('skipped');
        break;
      default:
        this.host.recordPrefetch('cancelled');
        break;
    }
  }
}

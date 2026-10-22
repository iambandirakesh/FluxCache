import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheKeyHash, createFluxCache, type FluxCacheClient } from '../../src/core/client';
import type { PrefetchPriority, QueryFn, QueryKey, QueryOutcome } from '../../src/core/types';
import { deferred, flushMicrotasks, type Deferred } from '../../src/testing';

const CONCURRENCY = 3;
const QUEUE_LIMIT = 4;
const SEED = 0x51ce_5eed;
const STEPS = 80;

interface SchedulerSnapshot {
  queued: number;
  running: number;
  concurrency: number;
  queueLimit: number;
}

function schedulerProbe(client: FluxCacheClient): { snapshot(): SchedulerSnapshot } {
  return (client as unknown as { prefetcher: { snapshot(): SchedulerSnapshot } }).prefetcher;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

interface StressJob {
  id: number;
  key: QueryKey;
  gate: Deferred<string>;
  controller: AbortController;
  scopeTag: string;
  scopeEpoch: number;
  respectAbort: boolean;
  started: boolean;
  promise: Promise<QueryOutcome<string>> | null;
  outcome: QueryOutcome<string> | undefined;
  settlements: number;
  rejection: unknown;
}

interface StressSummary {
  launches: number;
  outcomes: string[];
  skipReasons: Array<string | undefined>;
  scopeSwitches: number;
  maxQueue: number;
  maxRunning: number;
  successEvents: number;
  stats: ReturnType<FluxCacheClient['getStats']>;
}

function priorityFor(roll: number): PrefetchPriority {
  if (roll < 0.2) return 'high';
  if (roll < 0.8) return 'normal';
  return 'low';
}

async function runStress(seed: number): Promise<StressSummary> {
  vi.setSystemTime(0);
  expect(vi.getTimerCount()).toBe(0);

  const rng = mulberry32(seed);
  const client = createFluxCache({
    staleTime: 1000,
    gcTime: 2000,
    retry: 0,
    networkInfo: () => ({}),
    prefetch: { concurrency: CONCURRENCY, queueLimit: QUEUE_LIMIT },
  });
  const probe = schedulerProbe(client);
  const jobs: StressJob[] = [];
  let active = 0;
  let maxQueue = 0;
  let maxRunning = 0;
  let scopeSwitches = 0;

  const successScopes: Array<{ keyHash: string; scopeTag: string }> = [];
  client.subscribe((event) => {
    if (event.type === 'fetch:success' && event.keyHash) {
      successScopes.push({
        keyHash: event.keyHash,
        scopeTag: client.getAuthScope().scopeTag,
      });
    }
  });

  function assertPressure(label: string): void {
    const snapshot = probe.snapshot();
    maxQueue = Math.max(maxQueue, snapshot.queued);
    maxRunning = Math.max(maxRunning, snapshot.running);
    expect(snapshot.concurrency, label).toBe(CONCURRENCY);
    expect(snapshot.queueLimit, label).toBe(QUEUE_LIMIT);
    expect(snapshot.running, label).toBeLessThanOrEqual(CONCURRENCY);
    expect(snapshot.queued, label).toBeLessThanOrEqual(QUEUE_LIMIT);
  }

  function launch(priority: PrefetchPriority): StressJob {
    const id = jobs.length;
    const key: QueryKey = ['stress', String(seed), id];
    const scope = client.getAuthScope();
    const gate = deferred<string>();
    const controller = new AbortController();
    const job: StressJob = {
      id,
      key,
      gate,
      controller,
      scopeTag: scope.scopeTag,
      scopeEpoch: scope.epoch,
      respectAbort: rng() < 0.5,
      started: false,
      promise: null,
      outcome: undefined,
      settlements: 0,
      rejection: undefined,
    };

    const queryFn: QueryFn<string> = ({ signal }) => {
      job.started = true;
      active += 1;
      void job.gate.promise.then(
        () => {
          active -= 1;
        },
        () => {
          active -= 1;
        },
      );
      if (job.respectAbort) {
        signal.addEventListener(
          'abort',
          () => {
            job.gate.reject(new DOMException('Aborted by stress test', 'AbortError'));
          },
          { once: true },
        );
      }
      return job.gate.promise;
    };

    const promise = client.prefetchQuery(key, queryFn, {
      priority,
      signal: controller.signal,
      retry: 0,
    });
    job.promise = promise;
    void promise.then(
      (outcome) => {
        job.outcome = outcome;
        job.settlements += 1;
      },
      (error: unknown) => {
        job.rejection = error;
        job.settlements += 1;
      },
    );
    jobs.push(job);
    return job;
  }

  function assertNoSchedulerWork(): void {
    const snapshot = probe.snapshot();
    expect(snapshot.running).toBe(0);
    expect(snapshot.queued).toBe(0);
    expect(client.getStats().inFlight).toBe(0);
  }

  // Saturate deterministically: 3 running, 4 queued, then reject two more.
  for (let index = 0; index < CONCURRENCY + QUEUE_LIMIT; index += 1) launch('normal');
  const rejected = [launch('normal'), launch('normal')];
  await flushMicrotasks(4);

  for (const job of rejected) {
    expect(job.outcome?.settled).toBe('skipped');
    expect(job.outcome?.skipReason).toBe('queue-full');
  }
  assertPressure('initial saturation');
  expect(active).toBe(CONCURRENCY);
  expect(probe.snapshot().queued).toBe(QUEUE_LIMIT);

  // Complete one request before the random interleaving so the success-scope
  // assertion is guaranteed to exercise this seed.
  jobs[0]?.gate.resolve('initial');
  await flushMicrotasks(4);

  for (let step = 0; step < STEPS; step += 1) {
    const roll = rng();

    if (roll < 0.36) {
      launch(priorityFor(rng()));
    } else if (roll < 0.48) {
      const candidates = jobs.filter(
        (job) => job.outcome === undefined && !job.controller.signal.aborted,
      );
      const target = candidates[Math.floor(rng() * candidates.length)];
      if (target) {
        const before = client.getStats().inFlight;
        target.controller.abort();
        await flushMicrotasks(2);
        // Aborting a started prefetch must release its token and abort the
        // request when no other consumer needs it. A queued job owns no token.
        if (target.started) expect(client.getStats().inFlight).toBe(before - 1);
        else expect(client.getStats().inFlight).toBe(before);
      }
    } else if (roll < 0.58) {
      const candidates = jobs.filter((job) => !job.gate.settled);
      const target = candidates[Math.floor(rng() * candidates.length)];
      target?.gate.resolve(`${target.scopeTag}:${target.id}`);
    } else if (roll < 0.66) {
      if (rng() < 0.5) {
        client.cancelQueries();
      } else {
        const target = jobs[Math.floor(rng() * jobs.length)];
        if (target) client.cancelQueries(target.key);
      }
    } else if (roll < 0.74) {
      const target = jobs[Math.floor(rng() * jobs.length)];
      if (target) client.removeQueries(target.key);
    } else if (roll < 0.86) {
      const result = client.setAuthScope(`stress-${seed}-${step}`);
      scopeSwitches += 1;
      expect(result.changed).toBe(true);
      await flushMicrotasks(2);
      assertNoSchedulerWork();
      expect(vi.getTimerCount()).toBe(0);
    } else if (roll < 0.94) {
      await vi.advanceTimersByTimeAsync(7);
    } else {
      launch('high');
    }

    await flushMicrotasks(3);
    assertPressure(`step ${step}`);
  }

  // Make the final phase exercise both cancellation and a scope boundary with
  // jobs that are deliberately still running.
  client.cancelQueries();
  launch('normal');
  launch('high');
  await flushMicrotasks(2);
  client.cancelQueries();
  await flushMicrotasks(2);
  launch('normal');
  launch('high');
  await flushMicrotasks(2);

  const finalChange = client.setAuthScope(`stress-${seed}-final`);
  scopeSwitches += 1;
  expect(finalChange.changed).toBe(true);
  await flushMicrotasks(2);
  assertNoSchedulerWork();
  expect(vi.getTimerCount()).toBe(0);

  for (const job of jobs) {
    if (!job.gate.settled) job.gate.resolve(`${job.scopeTag}:${job.id}`);
  }
  await flushMicrotasks(8);

  const promises = jobs.map((job) => {
    if (!job.promise) throw new Error(`stress job ${job.id} was never launched`);
    return job.promise;
  });
  await Promise.all(promises);
  await flushMicrotasks(4);

  expect(jobs.every((job) => job.settlements === 1)).toBe(true);
  expect(jobs.every((job) => job.rejection === undefined)).toBe(true);
  expect(active).toBe(0);
  assertNoSchedulerWork();
  expect(vi.getTimerCount()).toBe(0);

  for (const job of jobs) {
    expect(client.getQueryData(job.key), `job ${job.id} leaked old-scope data`).toBeUndefined();
  }

  const jobByHash = new Map(jobs.map((job) => [cacheKeyHash(job.key), job]));
  for (const success of successScopes) {
    const job = jobByHash.get(success.keyHash);
    expect(job).toBeDefined();
    expect(success.scopeTag).toBe(job?.scopeTag);
  }

  const stats = client.getStats();
  const summary: StressSummary = {
    launches: jobs.length,
    outcomes: jobs.map((job) => job.outcome?.settled ?? 'unsettled'),
    skipReasons: jobs.map((job) => job.outcome?.skipReason),
    scopeSwitches,
    maxQueue,
    maxRunning,
    successEvents: successScopes.length,
    stats,
  };

  client.clear();
  await flushMicrotasks(2);
  expect(vi.getTimerCount()).toBe(0);
  expect(client.getStats().inFlight).toBe(0);

  return summary;
}

describe('prefetch scheduler stress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('survives seeded interleavings without leaks or limit violations', async () => {
    const first = await runStress(SEED);
    const second = await runStress(SEED);

    expect(second).toEqual(first);
    expect(first.scopeSwitches).toBeGreaterThan(0);
    expect(first.successEvents).toBeGreaterThan(0);
    expect(first.maxQueue).toBe(QUEUE_LIMIT);
    expect(first.maxRunning).toBe(CONCURRENCY);
    expect(first.outcomes).toContain('fulfilled');
    expect(first.outcomes).toContain('cancelled');
    expect(first.outcomes).toContain('scope-changed');
    expect(first.outcomes).toContain('skipped');
    expect(first.stats.prefetchQueued).toBeGreaterThan(0);
    expect(first.stats.prefetchCancelled).toBeGreaterThan(0);
    expect(first.stats.prefetchFulfilled).toBeGreaterThan(0);
    expect(first.stats.prefetchSkipped).toBeGreaterThan(0);
  });
});

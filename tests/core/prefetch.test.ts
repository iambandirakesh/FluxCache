import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFluxCache, type FluxCacheClient } from '../../src/core/client';
import type { NetworkInfo } from '../../src/core/types';
import { deferred, flushMicrotasks } from '../../src/testing';

function fastClient(
  options: {
    concurrency?: number;
    queueLimit?: number;
    networkInfo?: () => NetworkInfo;
    prefetchEnabled?: boolean;
  } = {},
): FluxCacheClient {
  return createFluxCache({
    staleTime: Infinity,
    gcTime: Infinity,
    prefetch: {
      concurrency: options.concurrency ?? 2,
      queueLimit: options.queueLimit ?? 10,
      enabled: options.prefetchEnabled ?? true,
    },
    networkInfo: options.networkInfo,
  });
}

describe('prefetchQuery', () => {
  it('warms the cache and reuses it without another request', async () => {
    const client = fastClient();
    const fn = vi.fn(async () => 'warm');

    const first = await client.prefetchQuery(['product', 1], fn);
    expect(first.settled).toBe('fulfilled');
    expect(first.data).toBe('warm');
    expect(client.getQueryData(['product', 1])).toBe('warm');

    const second = await client.prefetchQuery(['product', 1], fn);
    expect(second.settled).toBe('skipped');
    expect(second.skipReason).toBe('fresh');
    expect(second.data).toBe('warm');
    expect(second.source).toBe('cache');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(client.getStats()).toMatchObject({
      prefetchQueued: 1,
      prefetchStarted: 1,
      prefetchFulfilled: 1,
      hits: 1,
    });
  });

  it('joins an in-flight request instead of starting another', async () => {
    const client = fastClient();
    const gate = deferred<string>();
    const prefetchFn = vi.fn(async () => 'prefetch');
    const pending = client.fetchQuery(['product', 1], () => gate.promise);

    const prefetched = client.prefetchQuery(['product', 1], prefetchFn);
    expect(prefetchFn).not.toHaveBeenCalled();
    expect(client.getStats().dedupeJoins).toBe(1);

    gate.resolve('observer');
    const [observerOutcome, prefetchOutcome] = await Promise.all([pending, prefetched]);
    expect(observerOutcome.data).toBe('observer');
    expect(prefetchOutcome.data).toBe('observer');
    expect(client.getStats().fetchesStarted).toBe(1);
  });

  it('deduplicates equivalent queued jobs', async () => {
    const client = fastClient({ concurrency: 1 });
    const gate = deferred<string>();
    const running = client.prefetchQuery(['block'], () => gate.promise);
    const fn = vi.fn(async () => 'shared');

    const left = client.prefetchQuery(['queued'], fn);
    const right = client.prefetchQuery(['queued'], fn, { priority: 'high' });

    expect(client.getStats().prefetchQueued).toBe(2);
    expect(client.getStats().prefetchDeduped).toBe(1);

    gate.resolve('block');
    const [first, second] = await Promise.all([left, right, running]);
    expect(first.settled).toBe('fulfilled');
    expect(first.data).toBe('shared');
    expect(second.data).toBe('shared');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite newer data written while the job was queued', async () => {
    const client = fastClient({ concurrency: 1 });
    const gate = deferred<string>();
    const running = client.prefetchQuery(['block'], () => gate.promise);
    const fn = vi.fn(async () => 'prefetched');
    const queued = client.prefetchQuery(['later'], fn);

    client.setQueryData(['later'], 'newer');
    gate.resolve('block');

    const outcome = await queued;
    await running;
    expect(outcome.settled).toBe('skipped');
    expect(outcome.skipReason).toBe('fresh');
    expect(outcome.data).toBe('newer');
    expect(fn).not.toHaveBeenCalled();
    expect(client.getQueryData(['later'])).toBe('newer');
  });

  it('cannot overwrite data written after the request started', async () => {
    const client = fastClient();
    const gate = deferred<string>();
    let signal: AbortSignal | undefined;
    const pending = client.prefetchQuery(['product', 2], ({ signal: requestSignal }) => {
      signal = requestSignal;
      return gate.promise;
    });

    client.setQueryData(['product', 2], 'newer');
    expect(signal?.aborted).toBe(true);
    expect((await pending).settled).toBe('superseded');

    gate.resolve('late');
    await flushMicrotasks();
    expect(client.getQueryData(['product', 2])).toBe('newer');
  });

  it('reports a failed prefetch without caching an error-only entry as data', async () => {
    const client = fastClient();
    const fn = vi.fn(async () => {
      throw new Error('boom');
    });

    const outcome = await client.prefetchQuery(['failure'], fn, { retry: 0 });
    expect(outcome.settled).toBe('failed');
    expect(outcome.data).toBeUndefined();
    expect((outcome.error as Error).message).toBe('boom');
    expect(client.getQueryData(['failure'])).toBeUndefined();
    expect(client.getQueryState(['failure']).status).toBe('error');
    expect(client.getStats().prefetchFailed).toBe(1);
  });

  it('refetches stale prefetched data', async () => {
    const client = createFluxCache({ staleTime: 0, gcTime: Infinity });
    const fn = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('v1')
      .mockResolvedValueOnce('v2');

    expect((await client.prefetchQuery(['stale'], fn)).data).toBe('v1');
    const second = await client.prefetchQuery(['stale'], fn);
    expect(second.settled).toBe('fulfilled');
    expect(second.data).toBe('v2');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries transient failures before fulfilling', async () => {
    vi.useFakeTimers();
    const client = fastClient();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('recovered');

    const pending = client.prefetchQuery(['retry'], fn, {
      retry: 1,
      retryDelay: () => 20,
    });
    await flushMicrotasks();
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20);
    const outcome = await pending;
    expect(outcome.settled).toBe('fulfilled');
    expect(outcome.data).toBe('recovered');
    expect(client.getStats().retries).toBe(1);
  });
});

describe('prefetch scheduler', () => {
  it('respects concurrency and starts queued work as capacity frees up', async () => {
    const client = fastClient({ concurrency: 2 });
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const calls: string[] = [];
    const make = (name: string, index: number) =>
      vi.fn(() => {
        calls.push(name);
        return gates[index]?.promise ?? Promise.resolve(name);
      });

    const a = client.prefetchQuery(['a'], make('a', 0));
    const b = client.prefetchQuery(['b'], make('b', 1));
    const c = client.prefetchQuery(['c'], make('c', 2));

    expect(calls).toEqual(['a', 'b']);
    expect(client.getStats().prefetchStarted).toBe(2);

    gates[0]?.resolve('a');
    await a;
    await flushMicrotasks(4);
    expect(calls).toEqual(['a', 'b', 'c']);

    gates[1]?.resolve('b');
    gates[2]?.resolve('c');
    await Promise.all([b, c]);
  });

  it('runs higher priorities first with FIFO ordering inside a priority', async () => {
    const client = fastClient({ concurrency: 1 });
    const gate = deferred<string>();
    const calls: string[] = [];
    const make = (name: string) =>
      vi.fn(() => {
        calls.push(name);
        return Promise.resolve(name);
      });

    const running = client.prefetchQuery(['block'], () => {
      calls.push('block');
      return gate.promise;
    });
    const normal = client.prefetchQuery(['normal'], make('normal'), { priority: 'normal' });
    const high = client.prefetchQuery(['high'], make('high'), { priority: 'high' });
    const alsoNormal = client.prefetchQuery(['normal-2'], make('normal-2'));

    expect(calls).toEqual(['block']);
    gate.resolve('block');
    await Promise.all([running, normal, high, alsoNormal]);
    expect(calls).toEqual(['block', 'high', 'normal', 'normal-2']);
  });

  it('evicts a lower-priority queued job when the queue is full', async () => {
    const client = fastClient({ concurrency: 1, queueLimit: 1 });
    const gate = deferred<string>();
    const running = client.prefetchQuery(['block'], () => gate.promise);
    const lowFn = vi.fn(async () => 'low');
    const highFn = vi.fn(async () => 'high');

    const low = client.prefetchQuery(['low'], lowFn, { priority: 'normal' });
    const high = client.prefetchQuery(['high'], highFn, { priority: 'high' });

    const evicted = await low;
    expect(evicted.settled).toBe('skipped');
    expect(evicted.skipReason).toBe('queue-full');
    expect(lowFn).not.toHaveBeenCalled();

    gate.resolve('block');
    await running;
    expect((await high).data).toBe('high');
    expect(highFn).toHaveBeenCalledTimes(1);
  });

  it('rejects a new job when nothing lower-priority can be evicted', async () => {
    const client = fastClient({ concurrency: 1, queueLimit: 1 });
    const gate = deferred<string>();
    const queuedFn = vi.fn(async () => 'queued');
    const running = client.prefetchQuery(['block'], () => gate.promise);
    const queued = client.prefetchQuery(['queued'], queuedFn, { priority: 'normal' });
    const rejected = client.prefetchQuery(['rejected'], async () => 'nope', {
      priority: 'low',
    });

    expect((await rejected).skipReason).toBe('queue-full');
    expect(queuedFn).not.toHaveBeenCalled();

    gate.resolve('block');
    await running;
    expect((await queued).data).toBe('queued');
  });

  it('cancels only the matching queued jobs', async () => {
    const client = fastClient({ concurrency: 1 });
    const gate = deferred<string>();
    const aFn = vi.fn(async () => 'a');
    const bFn = vi.fn(async () => 'b');
    const running = client.prefetchQuery(['block'], () => gate.promise);
    const a = client.prefetchQuery(['a'], aFn);
    const b = client.prefetchQuery(['b'], bFn);

    const result = client.cancelQueries(['a']);
    expect(result.jobsCancelled).toBe(1);
    expect((await a).settled).toBe('cancelled');
    expect((await a).data).toBeUndefined();
    expect(aFn).not.toHaveBeenCalled();

    gate.resolve('block');
    await running;
    expect((await b).data).toBe('b');
    expect(bFn).toHaveBeenCalledTimes(1);
  });

  it('does not start a fetch when a diagnostics listener cancels before start', async () => {
    const client = fastClient();
    const fn = vi.fn(async () => 'value');
    client.subscribe((event) => {
      if (event.type === 'prefetch:started') client.cancelQueries(['raced']);
    });

    const outcome = await client.prefetchQuery(['raced'], fn);
    expect(outcome.settled).toBe('cancelled');
    expect(outcome.data).toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
  });

  it('aborts and discards a request cancelled while it is starting', async () => {
    const client = fastClient();
    const gate = deferred<string>();
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    client.subscribe((event) => {
      if (event.type === 'fetch:start') controller.abort();
    });

    const pending = client.prefetchQuery(
      ['raced-start'],
      ({ signal }) => {
        requestSignal = signal;
        return gate.promise;
      },
      { signal: controller.signal },
    );

    const outcome = await pending;
    expect(outcome.settled).toBe('cancelled');
    expect(outcome.data).toBeUndefined();
    expect(requestSignal?.aborted).toBe(true);

    gate.resolve('late');
    await flushMicrotasks();
    expect(client.getQueryData(['raced-start'])).toBeUndefined();
  });

  it('cancels a running prefetch through its consumer signal', async () => {
    const client = fastClient();
    const gate = deferred<string>();
    let requestSignal: AbortSignal | undefined;
    const controller = new AbortController();
    const pending = client.prefetchQuery(
      ['slow'],
      ({ signal }) => {
        requestSignal = signal;
        return gate.promise;
      },
      { signal: controller.signal },
    );

    controller.abort();
    const outcome = await pending;
    expect(outcome.settled).toBe('cancelled');
    expect(outcome.data).toBeUndefined();
    expect(requestSignal?.aborted).toBe(true);

    gate.resolve('late');
    await flushMicrotasks();
    expect(client.getQueryData(['slow'])).toBeUndefined();
    expect(client.getStats().prefetchCancelled).toBe(1);
  });

  it('cancels a queued prefetch through its consumer signal', async () => {
    const client = fastClient({ concurrency: 1 });
    const gate = deferred<string>();
    const queuedFn = vi.fn(async () => 'queued');
    const controller = new AbortController();
    const running = client.prefetchQuery(['block'], () => gate.promise);
    const queued = client.prefetchQuery(['queued'], queuedFn, { signal: controller.signal });

    controller.abort();
    expect((await queued).settled).toBe('cancelled');
    expect((await queued).data).toBeUndefined();

    gate.resolve('block');
    await running;
    await flushMicrotasks();
    expect(queuedFn).not.toHaveBeenCalled();
  });

  it('settles every job on a scope change and never starts old-scope work', async () => {
    const client = fastClient({ concurrency: 1 });
    const gate = deferred<string>();
    const queuedFn = vi.fn(async () => 'old-queued');
    const running = client.prefetchQuery(['old', 'running'], () => gate.promise);
    const queued = client.prefetchQuery(['old', 'queued'], queuedFn);

    const result = client.setAuthScope('bob');
    expect(result.jobsDropped).toBe(2);
    expect(result.requestsCancelled).toBe(1);

    const [runningOutcome, queuedOutcome] = await Promise.all([running, queued]);
    expect(runningOutcome.settled).toBe('scope-changed');
    expect(runningOutcome.data).toBeUndefined();
    expect(queuedOutcome.settled).toBe('scope-changed');
    expect(queuedOutcome.data).toBeUndefined();

    gate.resolve('old-data');
    await flushMicrotasks();
    expect(queuedFn).not.toHaveBeenCalled();
    expect(client.getQueryData(['old', 'running'])).toBeUndefined();

    expect((await client.prefetchQuery(['new'], async () => 'bob-data')).data).toBe('bob-data');
  });

  it('removes queued jobs with explicit removal', async () => {
    const client = fastClient({ concurrency: 1 });
    const gate = deferred<string>();
    const queuedFn = vi.fn(async () => 'queued');
    const running = client.prefetchQuery(['block'], () => gate.promise);
    const queued = client.prefetchQuery(['product', 9], queuedFn);

    const removed = client.removeQueries(['product', 9]);
    expect(removed.jobsCancelled).toBe(1);
    expect((await queued).settled).toBe('skipped');
    expect((await queued).skipReason).toBe('removed');
    expect(client.getQueryData(['product', 9])).toBeUndefined();

    gate.resolve('block');
    await running;
    await flushMicrotasks();
    expect(queuedFn).not.toHaveBeenCalled();
  });

  it('removes a running prefetch and aborts its request', async () => {
    const client = fastClient();
    const gate = deferred<string>();
    let signal: AbortSignal | undefined;
    const pending = client.prefetchQuery(['product', 10], ({ signal: requestSignal }) => {
      signal = requestSignal;
      return gate.promise;
    });

    const removed = client.removeQueries(['product', 10]);
    expect(removed.jobsCancelled).toBe(1);
    expect((await pending).skipReason).toBe('removed');
    expect(signal?.aborted).toBe(true);

    gate.resolve('late');
    await flushMicrotasks();
    expect(client.getQueryData(['product', 10])).toBeUndefined();
  });

  it('drops all prefetches on clear()', async () => {
    const client = fastClient({ concurrency: 1 });
    const gate = deferred<string>();
    const running = client.prefetchQuery(['block'], () => gate.promise);
    const queued = client.prefetchQuery(['queued'], async () => 'never');

    const result = client.clear();
    expect(result.jobsCancelled).toBe(2);
    expect((await queued).skipReason).toBe('removed');
    expect((await running).skipReason).toBe('removed');
    gate.resolve('late');
    await flushMicrotasks();
    expect(client.getQueryData(['block'])).toBeUndefined();
  });

  it('revalidates freshness when a job leaves the queue', async () => {
    const client = fastClient({ concurrency: 1 });
    const gate = deferred<string>();
    const staleFn = vi.fn(async () => 'stale-prefetch');
    const running = client.prefetchQuery(['block'], () => gate.promise);
    const queued = client.prefetchQuery(['fresh'], staleFn);

    const direct = client.fetchQuery(['fresh'], async () => 'direct');
    await direct;
    gate.resolve('block');
    await running;

    const outcome = await queued;
    expect(outcome.settled).toBe('skipped');
    expect(outcome.skipReason).toBe('fresh');
    expect(outcome.data).toBe('direct');
    expect(staleFn).not.toHaveBeenCalled();
  });

  it('drops jobs and entries without leaving work behind', async () => {
    const client = fastClient({ concurrency: 1 });
    const gate = deferred<string>();
    const controller = new AbortController();
    const running = client.prefetchQuery(['block'], () => gate.promise);
    const queued = client.prefetchQuery(['queued'], async () => 'queued', {
      signal: controller.signal,
    });

    controller.abort();
    expect((await queued).settled).toBe('cancelled');
    gate.resolve('block');
    await running;

    expect(client.getStats().size).toBeGreaterThan(0);
    client.clear();
    expect(client.getStats().size).toBe(0);
  });
});

describe('prefetch safeguards', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips on Save-Data when enabled', async () => {
    const client = fastClient({ networkInfo: () => ({ saveData: true }) });
    const fn = vi.fn(async () => 'value');
    const outcome = await client.prefetchQuery(['save-data'], fn);
    expect(outcome.settled).toBe('skipped');
    expect(outcome.skipReason).toBe('save-data');
    expect(fn).not.toHaveBeenCalled();
  });

  it('skips slow connections and honors custom slow lists', async () => {
    const slow = fastClient({ networkInfo: () => ({ effectiveType: '2g' }) });
    expect((await slow.prefetchQuery(['slow'], async () => 'v')).skipReason).toBe('slow-network');

    const custom = createFluxCache({
      staleTime: Infinity,
      gcTime: Infinity,
      networkInfo: () => ({ effectiveType: '3g' }),
      prefetch: { slowConnections: ['3g'], respectSlowNetwork: true },
    });
    expect((await custom.prefetchQuery(['custom'], async () => 'v')).skipReason).toBe(
      'slow-network',
    );

    const ignored = createFluxCache({
      staleTime: Infinity,
      gcTime: Infinity,
      networkInfo: () => ({ effectiveType: '2g', saveData: true }),
      prefetch: { respectSlowNetwork: false, respectSaveData: false },
    });
    expect((await ignored.prefetchQuery(['ignored'], async () => 'v')).settled).toBe('fulfilled');
  });

  it('can disable prefetching globally', async () => {
    const client = fastClient({ prefetchEnabled: false });
    const fn = vi.fn(async () => 'value');
    const outcome = await client.prefetchQuery(['disabled'], fn);
    expect(outcome.skipReason).toBe('disabled');
    expect(fn).not.toHaveBeenCalled();
  });

  it('works without browser network APIs', async () => {
    const client = fastClient();
    const outcome = await client.prefetchQuery(['plain'], async () => 'ok');
    expect(outcome.settled).toBe('fulfilled');
  });
});

describe('prefetch validation and diagnostics', () => {
  it('rejects invalid arguments synchronously', () => {
    const client = fastClient();
    expect(() => client.prefetchQuery(['x'], undefined as never)).toThrow(TypeError);
    expect(() => client.prefetchQuery(['x'], async () => 1, { retry: -1 })).toThrow(RangeError);
    expect(() =>
      client.prefetchQuery(['x'], async () => 1, { priority: 'urgent' as never }),
    ).toThrow(TypeError);
    expect(() => client.prefetchQuery(['x'], async () => 1, { staleTime: -1 })).toThrow(RangeError);
    expect(() => client.prefetchQuery(['x'], async () => 1, { signal: {} as never })).toThrow(
      TypeError,
    );
  });

  it('rejects invalid scheduler configuration', () => {
    expect(() => createFluxCache({ prefetch: { concurrency: 0 } })).toThrow(RangeError);
    expect(() => createFluxCache({ prefetch: { queueLimit: 0 } })).toThrow(RangeError);
    expect(() => createFluxCache({ prefetch: { slowConnections: [42] as never } })).toThrow(
      TypeError,
    );
    expect(() => createFluxCache({ networkInfo: 42 as never })).toThrow(TypeError);
  });

  it('reports counters and emits key-less diagnostics', async () => {
    const client = fastClient();
    const events: unknown[] = [];
    client.subscribe((event) => events.push(event));
    await client.prefetchQuery(['private', 'key'], async () => 'value');

    const stats = client.getStats();
    expect(stats.prefetchQueued).toBe(1);
    expect(stats.prefetchStarted).toBe(1);
    expect(stats.prefetchFulfilled).toBe(1);
    expect(JSON.stringify(events)).not.toContain('private');
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'prefetch:queued' }),
        expect.objectContaining({ type: 'prefetch:started' }),
        expect.objectContaining({ type: 'prefetch:settled' }),
      ]),
    );
  });
});

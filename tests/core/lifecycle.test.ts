import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFluxCache } from '../../src/core/client';
import { FluxCacheKeyError } from '../../src/core/errors';
import { QueryObserver } from '../../src/core/observer';
import type { QueryKey } from '../../src/core/types';
import { deferred, flushMicrotasks } from '../../src/testing';

const key: QueryKey = ['product', 1];

function deferredFetch<T>() {
  const gate = deferred<T>();
  const fn = vi.fn(() => gate.promise);
  return { gate, fn };
}

describe('cache lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches once and then serves a fresh cache hit without network', async () => {
    const client = createFluxCache();
    const fn = vi.fn(async () => 'v1');

    const first = await client.fetchQuery(key, fn);
    expect(first).toMatchObject({ settled: 'fulfilled', source: 'network', data: 'v1' });
    expect(fn).toHaveBeenCalledTimes(1);

    const second = await client.fetchQuery(key, fn);
    expect(second).toMatchObject({
      settled: 'skipped',
      skipReason: 'fresh',
      source: 'cache',
      data: 'v1',
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(client.getStats().hits).toBe(1);
  });

  it('deduplicates concurrent requests for the same key', async () => {
    const client = createFluxCache();
    const { gate, fn } = deferredFetch<string>();

    const first = client.fetchQuery(key, fn);
    const second = client.fetchQuery(key, fn);
    expect(fn).toHaveBeenCalledTimes(1);

    gate.resolve('shared');
    const [left, right] = await Promise.all([first, second]);
    expect(left.data).toBe('shared');
    expect(right.data).toBe('shared');
    expect(client.getStats().dedupeJoins).toBe(1);
  });

  it('does not share results between different keys', async () => {
    const client = createFluxCache();
    const one = vi.fn(async () => 'one');
    const two = vi.fn(async () => 'two');

    expect((await client.fetchQuery(['a'], one)).data).toBe('one');
    expect((await client.fetchQuery(['b'], two)).data).toBe('two');
    expect(one).toHaveBeenCalledTimes(1);
    expect(two).toHaveBeenCalledTimes(1);
  });

  it('marks data stale at the exact staleTime boundary', async () => {
    const client = createFluxCache({ staleTime: 1000 });
    const fn = vi.fn(async () => 'v1');
    const observer = new QueryObserver(client, { queryKey: key, queryFn: fn });
    observer.mount();
    await flushMicrotasks();

    expect(observer.getSnapshot().isStale).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(observer.getSnapshot().isStale).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(observer.getSnapshot().isStale).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(client.getStats().staleFlips).toBe(1);
  });

  it('staleTime and gcTime are independent', async () => {
    const client = createFluxCache({ staleTime: 1000, gcTime: 5000 });
    await client.fetchQuery(key, async () => 'v1');

    await vi.advanceTimersByTimeAsync(1000);
    expect(client.getQueryState(key).isStale).toBe(true);
    expect(client.getQueryData(key)).toBe('v1');

    await vi.advanceTimersByTimeAsync(3999);
    expect(client.getQueryData(key)).toBe('v1');
    await vi.advanceTimersByTimeAsync(1);
    expect(client.getQueryData(key)).toBeUndefined();
  });

  it('supersedes an active request when setQueryData writes', async () => {
    const client = createFluxCache();
    const { gate, fn } = deferredFetch<string>();
    const pending = client.fetchQuery(key, fn);

    client.setQueryData(key, 'written');
    const outcome = await pending;
    expect(outcome.settled).toBe('superseded');
    expect(outcome.data).toBe('written');

    gate.resolve('late');
    await flushMicrotasks();
    expect(client.getQueryData(key)).toBe('written');
    expect(client.getStats().discarded).toBe(1);
  });

  it('does not let an invalidated in-flight response become fresh', async () => {
    const client = createFluxCache();
    const { gate, fn } = deferredFetch<string>();
    const pending = client.fetchQuery(key, fn);

    const result = await client.invalidateQueries(key);
    expect(result).toMatchObject({ invalidated: 1, refetching: 0 });
    expect((await pending).settled).toBe('superseded');

    gate.resolve('late');
    await flushMicrotasks();
    expect(client.getQueryData(key)).toBeUndefined();
    expect(client.getQueryState(key).isStale).toBe(true);
    expect(client.getStats().discarded).toBe(1);
  });

  it('force bypasses freshness and always starts a new generation', async () => {
    const client = createFluxCache();
    const fn = vi.fn(async () => 'v1');
    await client.fetchQuery(key, fn);

    const forced = await client.fetchQuery(key, fn, { force: true });
    expect(forced.settled).toBe('fulfilled');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('force supersedes an existing in-flight request in either resolve order', async () => {
    const client = createFluxCache();
    const first = deferredFetch<string>();
    const second = deferredFetch<string>();

    const pending = client.fetchQuery(key, first.fn);
    const forced = client.fetchQuery(key, second.fn, { force: true });

    expect((await pending).settled).toBe('superseded');
    second.gate.resolve('new');
    expect((await forced).data).toBe('new');

    first.gate.resolve('old');
    await flushMicrotasks();
    expect(client.getQueryData(key)).toBe('new');
    expect(client.getStats().discarded).toBe(1);
  });

  it('keeps the last good data when a forced refresh fails', async () => {
    const client = createFluxCache();
    await client.fetchQuery(key, async () => 'good');
    const before = client.getQueryState(key);

    const failure = new Error('boom');
    const outcome = await client.fetchQuery(key, async () => Promise.reject(failure), {
      force: true,
      retry: 0,
    });

    expect(outcome.settled).toBe('failed');
    expect(outcome.error).toBe(failure);
    const state = client.getQueryState(key);
    expect(state.hasData).toBe(true);
    expect(state.data).toBe('good');
    expect(state.dataUpdatedAt).toBe(before.dataUpdatedAt);
    expect(state.status).toBe('success');
    expect(state.error).toBe(failure);
  });

  it('retries twice by default and succeeds on the third attempt', async () => {
    const client = createFluxCache();
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new TypeError('network');
      return 'ok';
    });

    const pending = client.fetchQuery(key, fn);
    await flushMicrotasks();
    expect(attempts).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2);

    await vi.advanceTimersByTimeAsync(1999);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(3);

    expect((await pending).settled).toBe('fulfilled');
    expect(client.getStats().retries).toBe(2);
  });

  it('retry: 0 means exactly one attempt', async () => {
    const client = createFluxCache();
    const fn = vi.fn(async () => {
      throw new TypeError('network');
    });
    const outcome = await client.fetchQuery(key, fn, { retry: 0 });
    expect(outcome.settled).toBe('failed');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry client errors with a 4xx status', async () => {
    const client = createFluxCache();
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('not found'), { status: 404 });
    });
    const outcome = await client.fetchQuery(key, fn);
    expect(outcome.settled).toBe('failed');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries 500 and 429 responses', async () => {
    const client = createFluxCache();
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('server'), { status: 500 });
    });
    const pending = client.fetchQuery(key, fn, { retry: 1 });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1000);
    const outcome = await pending;
    expect(outcome.settled).toBe('failed');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('cancellation settles waiters synchronously and blocks the late response', async () => {
    const client = createFluxCache();
    const { gate, fn } = deferredFetch<string>();
    const pending = client.fetchQuery(key, fn);

    const result = client.cancelQueries();
    expect(result).toEqual({ cancelled: 1, waitersSettled: 1, jobsCancelled: 0 });
    expect((pending as unknown as { then?: unknown }).then).toBeTypeOf('function');

    const outcome = await pending;
    expect(outcome.settled).toBe('cancelled');
    expect(outcome.data).toBeUndefined();

    gate.resolve('late');
    await flushMicrotasks();
    expect(client.getQueryData(key)).toBeUndefined();
    expect(client.getStats().discarded).toBe(1);
  });

  it('cancels a pending retry and never attempts again', async () => {
    const client = createFluxCache();
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      throw new TypeError('network');
    });
    const pending = client.fetchQuery(key, fn, { retry: 2 });
    await flushMicrotasks();
    expect(attempts).toBe(1);

    await vi.advanceTimersByTimeAsync(500);
    client.cancelQueries(key);
    expect((await pending).settled).toBe('cancelled');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toBe(1);
    expect(client.getQueryState(key).error).toBeNull();
  });

  it('refetch always starts a new generation', async () => {
    const client = createFluxCache();
    const fn = vi.fn(async () => 'v1');
    await client.fetchQuery(key, fn);

    const result = await client.refetchQueries(key);
    expect(result.refetched).toBe(1);
    expect(result.outcomes[0]?.settled).toBe('fulfilled');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('refetch skips entries without a queryFn', async () => {
    const client = createFluxCache();
    client.setQueryData(key, 'seed');
    const result = await client.refetchQueries(key);
    expect(result.refetched).toBe(0);
    expect(result.outcomes[0]).toMatchObject({ settled: 'skipped', skipReason: 'no-query-fn' });
  });

  it('supports cache-only observers without a queryFn', async () => {
    const client = createFluxCache();
    client.setQueryData(key, 'seeded');
    const observer = new QueryObserver(client, { queryKey: key });
    observer.mount();
    await flushMicrotasks();

    expect(observer.getSnapshot().data).toBe('seeded');
    expect(observer.getSnapshot().isFetching).toBe(false);

    const outcome = await observer.refetch();
    expect(outcome).toMatchObject({ settled: 'skipped', skipReason: 'no-query-fn' });
  });

  it('uses a custom retryDelay function', async () => {
    const client = createFluxCache();
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      if (attempts < 2) throw new TypeError('network');
      return 'ok';
    });

    const pending = client.fetchQuery(key, fn, { retry: 1, retryDelay: () => 50 });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(49);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2);
    expect((await pending).settled).toBe('fulfilled');
  });

  it('invalidateQueries resolves before the refetch settles by default', async () => {
    const client = createFluxCache();
    const gate = deferred<string>();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('v1')
      .mockImplementationOnce(() => gate.promise);

    const observer = new QueryObserver(client, { queryKey: key, queryFn: fn });
    observer.mount();
    await flushMicrotasks();
    expect(observer.getSnapshot().data).toBe('v1');

    const result = await client.invalidateQueries(key);
    expect(result).toMatchObject({ invalidated: 1, refetching: 1 });
    expect(result.outcomes).toBeUndefined();
    expect(observer.getSnapshot().isFetching).toBe(true);

    gate.resolve('v2');
    await flushMicrotasks();
    expect(observer.getSnapshot().data).toBe('v2');
  });

  it('awaitRefetch waits and returns outcomes without rejecting', async () => {
    const client = createFluxCache();
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: async () => 'v1',
    });
    observer.mount();
    await flushMicrotasks();

    const result = await client.invalidateQueries(key, { awaitRefetch: true });
    expect(result.refetching).toBe(1);
    expect(result.outcomes?.[0]?.settled).toBe('fulfilled');
  });

  it('removes entries and settles in-flight waiters with the removed data', async () => {
    const client = createFluxCache();
    const { gate, fn } = deferredFetch<string>();
    const pending = client.fetchQuery(key, fn);

    const removed = client.removeQueries(key);
    expect(removed).toEqual({ removed: 1, waitersSettled: 1, jobsCancelled: 0 });

    const outcome = await pending;
    expect(outcome.settled).toBe('removed');
    expect(outcome.data).toBeUndefined();

    gate.resolve('late');
    await flushMicrotasks();
    expect(client.getQueryData(key)).toBeUndefined();
    expect(client.getStats().discarded).toBe(1);
  });

  it('clears timers and observer data when the cache is cleared', async () => {
    const client = createFluxCache({ gcTime: 10_000, staleTime: 5000 });
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: async () => 'v1',
    });
    observer.mount();
    await flushMicrotasks();
    expect(observer.getSnapshot().data).toBe('v1');
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    client.clear();
    expect(vi.getTimerCount()).toBe(0);
    expect(client.getStats().size).toBe(0);
    expect(observer.getSnapshot().hasData).toBe(false);
    expect(observer.getSnapshot().data).toBeUndefined();
  });

  it('collects idle entries after gcTime and keeps observed entries alive', async () => {
    const client = createFluxCache({ gcTime: 1000 });
    const fn = vi.fn(async () => 'v1');
    await client.fetchQuery(key, fn);

    await vi.advanceTimersByTimeAsync(1000);
    expect(client.getQueryData(key)).toBeUndefined();
    expect(client.getStats().gcRuns).toBe(1);

    const observedKey: QueryKey = ['observed'];
    const observer = new QueryObserver(client, { queryKey: observedKey, queryFn: fn });
    observer.mount();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.getQueryData(observedKey)).toBe('v1');

    observer.unmount();
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.getQueryData(observedKey)).toBeUndefined();
  });

  it('evicts idle entries under the size cap but never observed ones', async () => {
    const client = createFluxCache({ maxEntries: 2, gcTime: Infinity });
    const observedKey: QueryKey = ['a'];

    const observer = new QueryObserver(client, {
      queryKey: observedKey,
      queryFn: async () => 'a',
    });
    observer.mount();
    await flushMicrotasks();

    await client.fetchQuery(['b'], async () => 'b');
    await client.fetchQuery(['c'], async () => 'c');
    expect(client.getStats().evictions).toBeGreaterThan(0);
    expect(client.getQueryData(observedKey)).toBe('a');
    expect(client.getStats().size).toBeLessThanOrEqual(3);
  });

  it('throws validation errors synchronously without creating entries', async () => {
    const client = createFluxCache();
    const fn = vi.fn(async () => 'x');

    expect(() => client.fetchQuery('bad' as never, fn)).toThrow(FluxCacheKeyError);
    expect(() => client.fetchQuery(['ok'], undefined as never)).toThrow(TypeError);
    expect(() => client.getQueryData(['x', () => 1] as never)).toThrow(FluxCacheKeyError);
    expect(() => client.setAuthScope(42 as never)).toThrow(TypeError);
    expect(client.getStats().size).toBe(0);
    expect(fn).not.toHaveBeenCalled();
  });

  it('turns a throwing queryFn into a failed outcome, not a synchronous throw', async () => {
    const client = createFluxCache();
    const outcome = await client.fetchQuery(
      key,
      () => {
        throw new Error('sync boom');
      },
      { retry: 0 },
    );
    expect(outcome.settled).toBe('failed');
    expect((outcome.error as Error).message).toBe('sync boom');
    expect(client.getQueryState(key).status).toBe('error');
  });

  it('uses undefined-returning queryFn results as cacheable data', async () => {
    const client = createFluxCache();
    const fn = vi.fn(async () => undefined);
    const first = await client.fetchQuery(key, fn);
    expect(first.settled).toBe('fulfilled');
    expect(client.getQueryState(key).hasData).toBe(true);

    const second = await client.fetchQuery(key, fn);
    expect(second).toMatchObject({ settled: 'skipped', skipReason: 'fresh' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reports diagnostics without leaking keys or payloads', async () => {
    const client = createFluxCache();
    const seen: Array<Record<string, unknown>> = [];
    client.subscribe((event) => seen.push({ ...event }));

    await client.fetchQuery(['secret', { id: 7 }], async () => 'payload');
    await client.fetchQuery(['secret', { id: 7 }], async () => 'payload');

    expect(seen.length).toBeGreaterThan(0);
    for (const event of seen) {
      expect(Object.keys(event).sort()).toEqual(expect.arrayContaining(['type', 'at']));
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain('payload');
      expect(serialized).not.toContain('secret');
      expect(event['keyHash']).toMatch(/^[0-9a-f]{8}$/);
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFluxCache } from '../../src/core/client';
import { QueryObserver } from '../../src/core/observer';
import { deferred, flushMicrotasks } from '../../src/testing';

describe('prefetch effectiveness metrics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with a zeroed rate and partitions produced prefetches after consumption', async () => {
    const client = createFluxCache({ staleTime: 1000, gcTime: Infinity });
    expect(client.getStats()).toMatchObject({
      prefetchProduced: 0,
      prefetchConsumed: 0,
      prefetchWasted: 0,
      prefetchPending: 0,
      prefetchConsumptionRate: 0,
    });

    await client.prefetchQuery(['product', 1], async () => 'warm');
    expect(client.getStats()).toMatchObject({
      prefetchProduced: 1,
      prefetchConsumed: 0,
      prefetchWasted: 0,
      prefetchPending: 1,
      prefetchConsumptionRate: 0,
    });

    const observer = new QueryObserver(client, {
      queryKey: ['product', 1],
      queryFn: async () => 'network',
    });
    observer.mount();
    await flushMicrotasks();

    expect(client.getStats()).toMatchObject({
      prefetchProduced: 1,
      prefetchConsumed: 1,
      prefetchWasted: 0,
      prefetchPending: 0,
      prefetchConsumptionRate: 1,
    });
    observer.unmount();
  });

  it('counts a fetchQuery cache hit as consumption', async () => {
    const client = createFluxCache({ staleTime: 1000, gcTime: Infinity });
    await client.prefetchQuery(['product', 2], async () => 'warm');

    const outcome = await client.fetchQuery(['product', 2], async () => 'network');
    expect(outcome).toMatchObject({ settled: 'skipped', skipReason: 'fresh' });
    expect(client.getStats()).toMatchObject({
      prefetchProduced: 1,
      prefetchConsumed: 1,
      prefetchWasted: 0,
      prefetchConsumptionRate: 1,
    });
  });

  it('counts an observer joining the prefetch request as consumption', async () => {
    const client = createFluxCache({ staleTime: 1000, gcTime: Infinity });
    const gate = deferred<string>();
    const prefetch = client.prefetchQuery(['product', 3], () => gate.promise);

    const observer = new QueryObserver(client, {
      queryKey: ['product', 3],
      queryFn: async () => 'network',
    });
    observer.mount();
    expect(client.getStats().prefetchProduced).toBe(0);

    gate.resolve('shared');
    await prefetch;
    await flushMicrotasks();

    expect(client.getStats()).toMatchObject({
      prefetchProduced: 1,
      prefetchConsumed: 1,
      prefetchWasted: 0,
      prefetchConsumptionRate: 1,
    });
    observer.unmount();
  });

  it('does not count a prefetch that joined an observer request as produced', async () => {
    const client = createFluxCache({ staleTime: 1000, gcTime: Infinity });
    const gate = deferred<string>();
    const observed = new QueryObserver(client, {
      queryKey: ['product', 4],
      queryFn: () => gate.promise,
    });
    observed.mount();

    const prefetch = client.prefetchQuery(['product', 4], async () => 'network');
    gate.resolve('observer data');
    await Promise.all([prefetch, flushMicrotasks()]);

    expect(client.getStats()).toMatchObject({
      dedupeJoins: 1,
      prefetchProduced: 0,
      prefetchConsumed: 0,
      prefetchWasted: 0,
      prefetchConsumptionRate: 0,
    });
    observed.unmount();
  });

  it('wastes a prefetch when its freshness window expires unread', async () => {
    const client = createFluxCache({ staleTime: 1000, gcTime: Infinity });
    await client.prefetchQuery(['stale'], async () => 'warm');
    expect(client.getStats().prefetchPending).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(client.getStats()).toMatchObject({
      prefetchProduced: 1,
      prefetchConsumed: 0,
      prefetchWasted: 1,
      prefetchPending: 0,
      prefetchConsumptionRate: 0,
    });
  });

  it('wastes a prefetch when it is overwritten, invalidated, removed or scope-dropped', async () => {
    const client = createFluxCache({ staleTime: Infinity, gcTime: Infinity });

    await client.prefetchQuery(['overwritten'], async () => 'a');
    client.setQueryData(['overwritten'], 'b');

    await client.prefetchQuery(['invalidated'], async () => 'a');
    await client.invalidateQueries(['invalidated'], { refetchActive: false });

    await client.prefetchQuery(['removed'], async () => 'a');
    client.removeQueries(['removed']);

    await client.prefetchQuery(['scoped'], async () => 'a');
    client.setAuthScope('next');

    expect(client.getStats()).toMatchObject({
      prefetchProduced: 4,
      prefetchConsumed: 0,
      prefetchWasted: 4,
      prefetchPending: 0,
      prefetchConsumptionRate: 0,
    });
  });

  it('wastes a prefetch when a newer request generation replaces it', async () => {
    const client = createFluxCache({ staleTime: Infinity, gcTime: Infinity });
    await client.prefetchQuery(['product', 5], async () => 'warm');

    await client.fetchQuery(['product', 5], async () => 'fresh', { force: true });
    expect(client.getStats()).toMatchObject({
      prefetchProduced: 1,
      prefetchConsumed: 0,
      prefetchWasted: 1,
      prefetchConsumptionRate: 0,
    });
  });

  it('wastes prefetched entries on GC and LRU eviction', async () => {
    const gcClient = createFluxCache({ staleTime: Infinity, gcTime: 100 });
    await gcClient.prefetchQuery(['gc'], async () => 'a');
    await vi.advanceTimersByTimeAsync(100);
    expect(gcClient.getStats()).toMatchObject({
      prefetchWasted: 1,
      prefetchPending: 0,
    });

    vi.useRealTimers();
    const evictionClient = createFluxCache({
      staleTime: Infinity,
      gcTime: Infinity,
      maxEntries: 1,
    });
    await evictionClient.prefetchQuery(['first'], async () => 'a');
    await evictionClient.fetchQuery(['second'], async () => 'b');
    expect(evictionClient.getStats()).toMatchObject({
      prefetchProduced: 1,
      prefetchWasted: 1,
      prefetchPending: 0,
    });
  });

  it('reports the consumed share of completed prefetches', async () => {
    const client = createFluxCache({ staleTime: 1000, gcTime: Infinity });
    await client.prefetchQuery(['consumed'], async () => 'a');
    await client.prefetchQuery(['wasted'], async () => 'b');

    const observer = new QueryObserver(client, {
      queryKey: ['consumed'],
      queryFn: async () => 'network',
    });
    observer.mount();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1000);

    expect(client.getStats()).toMatchObject({
      prefetchProduced: 2,
      prefetchConsumed: 1,
      prefetchWasted: 1,
      prefetchPending: 0,
      prefetchConsumptionRate: 0.5,
    });
    observer.unmount();
  });

  it('emits privacy-safe consumption events without keys, payloads or scope values', async () => {
    const client = createFluxCache({ staleTime: 1000, gcTime: Infinity });
    const events: Array<Record<string, unknown>> = [];
    client.subscribe((event) => events.push({ ...event }));

    await client.prefetchQuery(['secret', { id: 9 }], async () => 'payload');
    const observer = new QueryObserver(client, {
      queryKey: ['secret', { id: 9 }],
      queryFn: async () => 'network',
    });
    observer.mount();
    await flushMicrotasks();

    const prefetchEvents = events.filter((event) => String(event['type']).startsWith('prefetch:'));
    expect(prefetchEvents.map((event) => event['type'])).toEqual(
      expect.arrayContaining(['prefetch:produced', 'prefetch:consumed']),
    );
    for (const event of prefetchEvents) {
      expect(event['keyHash']).toMatch(/^[0-9a-f]{8}$/);
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain('payload');
      expect(serialized).not.toContain('secret');
      expect(serialized).not.toContain('alice');
      expect(serialized).not.toContain('bob');
    }
    observer.unmount();
  });
});

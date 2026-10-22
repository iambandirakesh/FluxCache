import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFluxCache } from '../../src/core/client';
import { QueryObserver } from '../../src/core/observer';
import type { QueryFn, QueryKey, QueryOptions } from '../../src/core/types';
import { deferred, flushMicrotasks } from '../../src/testing';

const key: QueryKey = ['items', 1];

interface Harness {
  fn: QueryFn<string>;
  gate: ReturnType<typeof deferred<string>>;
  signal: () => AbortSignal | undefined;
  calls: () => number;
}

function harness(): Harness {
  const gate = deferred<string>();
  let captured: AbortSignal | undefined;
  let count = 0;
  const fn: QueryFn<string> = ({ signal }) => {
    count += 1;
    captured = signal;
    return gate.promise;
  };
  return { fn, gate, signal: () => captured, calls: () => count };
}

function observerFor(
  client: ReturnType<typeof createFluxCache>,
  fn: QueryFn<string>,
  options: Partial<QueryOptions<string>> = {},
): QueryObserver<string> {
  return new QueryObserver(client, { queryKey: key, queryFn: fn, ...options });
}

describe('query observer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a stable snapshot until something changes', async () => {
    const client = createFluxCache();
    const { fn, gate } = harness();
    const observer = observerFor(client, fn);
    observer.mount();
    await flushMicrotasks();

    const first = observer.getSnapshot();
    expect(observer.getSnapshot()).toBe(first);
    expect(first.isLoading).toBe(true);

    gate.resolve('v1');
    await flushMicrotasks();

    const second = observer.getSnapshot();
    expect(second).not.toBe(first);
    expect(second.data).toBe('v1');
    expect(second.isSuccess).toBe(true);
    expect(second.isFetching).toBe(false);
  });

  it('serves fresh data on mount without a request', async () => {
    const client = createFluxCache();
    const fn = vi.fn(async () => 'v1');
    await client.fetchQuery(key, fn);

    const observer = observerFor(client, fn);
    observer.mount();
    await flushMicrotasks();

    expect(fn).toHaveBeenCalledTimes(1);
    expect(observer.getSnapshot().data).toBe('v1');
  });

  it('does not refetch when a cached entry is remounted', async () => {
    const client = createFluxCache();
    const fn = vi.fn(async () => 'v1');
    const first = observerFor(client, fn);
    first.mount();
    await flushMicrotasks();
    first.unmount();

    const second = observerFor(client, fn);
    second.mount();
    await flushMicrotasks();

    expect(fn).toHaveBeenCalledTimes(1);
    expect(second.getSnapshot().data).toBe('v1');
    expect(second.getSnapshot().isFetching).toBe(false);
  });

  it('revalidates in the background when mounting on stale data', async () => {
    const client = createFluxCache({ staleTime: 1000 });
    const fn = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('v1')
      .mockImplementationOnce(() => deferred<string>().promise);
    await client.fetchQuery(key, fn);

    await vi.advanceTimersByTimeAsync(1000);
    const observer = observerFor(client, fn);
    observer.mount();
    await flushMicrotasks();

    const snapshot = observer.getSnapshot();
    expect(snapshot.data).toBe('v1');
    expect(snapshot.isFetching).toBe(true);
    expect(snapshot.isStale).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('shares one request between observers and unmounts cleanly', async () => {
    const client = createFluxCache();
    const { fn, gate, calls, signal } = harness();
    const first = observerFor(client, fn);
    const second = observerFor(client, fn);
    first.mount();
    second.mount();
    await flushMicrotasks();

    expect(calls()).toBe(1);
    expect(client.getStats().dedupeJoins).toBe(1);

    first.unmount();
    second.unmount();
    expect(signal()?.aborted).toBe(false);

    gate.resolve('shared');
    await flushMicrotasks();
    expect(client.getQueryData(key)).toBe('shared');
  });

  it('aborts on unmount only when the only consumer asked for cancellation', async () => {
    const client = createFluxCache();
    const { fn, gate, signal } = harness();
    const observer = observerFor(client, fn, { cancelOnUnmount: true });
    observer.mount();
    await flushMicrotasks();
    expect(signal()?.aborted).toBe(false);

    observer.unmount();
    expect(signal()?.aborted).toBe(true);
    expect(client.getStats().cancelled).toBe(1);

    gate.resolve('late');
    await flushMicrotasks();
    expect(client.getQueryData(key)).toBeUndefined();
    expect(client.getStats().discarded).toBe(1);
  });

  it('does not abort while a keep-alive consumer is attached (both release orders)', async () => {
    for (const order of ['cancel-first', 'keep-first'] as const) {
      const client = createFluxCache();
      const { fn, gate, signal } = harness();
      const cancelling = observerFor(client, fn, { cancelOnUnmount: true });
      const keepAlive = observerFor(client, fn, { cancelOnUnmount: false });
      cancelling.mount();
      keepAlive.mount();
      await flushMicrotasks();

      if (order === 'cancel-first') {
        cancelling.unmount();
        expect(signal()?.aborted).toBe(false);
        keepAlive.unmount();
      } else {
        keepAlive.unmount();
        expect(signal()?.aborted).toBe(false);
        cancelling.unmount();
      }

      expect(signal()?.aborted).toBe(false);
      gate.resolve('kept');
      await flushMicrotasks();
      expect(client.getQueryData(key)).toBe('kept');
      expect(client.getStats().cancelled).toBe(0);
    }
  });

  it('aborts only at the last release when every consumer requests cancellation', async () => {
    for (const order of ['first-then-second', 'second-then-first'] as const) {
      const client = createFluxCache();
      const { fn, gate, signal } = harness();
      const left = observerFor(client, fn, { cancelOnUnmount: true });
      const right = observerFor(client, fn, { cancelOnUnmount: true });
      left.mount();
      right.mount();
      await flushMicrotasks();

      if (order === 'first-then-second') {
        left.unmount();
        expect(signal()?.aborted).toBe(false);
        right.unmount();
      } else {
        right.unmount();
        expect(signal()?.aborted).toBe(false);
        left.unmount();
      }

      expect(signal()?.aborted).toBe(true);
      gate.resolve('late');
      await flushMicrotasks();
      expect(client.getQueryData(key)).toBeUndefined();
      expect(client.getStats().cancelled).toBe(1);
    }
  });

  it('never aborts while a fetchQuery waiter still needs the data', async () => {
    const client = createFluxCache();
    const { fn, gate, signal } = harness();
    const waiter = client.fetchQuery(key, fn);
    const observer = observerFor(client, fn, { cancelOnUnmount: true });
    observer.mount();
    await flushMicrotasks();

    observer.unmount();
    expect(signal()?.aborted).toBe(false);
    expect(client.getStats().cancelled).toBe(0);

    gate.resolve('needed');
    expect((await waiter).data).toBe('needed');
  });

  it('does not commit a signal-ignoring response after cancellation', async () => {
    const client = createFluxCache();
    const gate = deferred<string>();
    const fn = vi.fn(() => gate.promise);
    const observer = observerFor(client, fn, { cancelOnUnmount: true });
    observer.mount();
    await flushMicrotasks();

    observer.unmount();
    expect(client.getStats().cancelled).toBe(1);

    gate.resolve('ignored');
    await flushMicrotasks();
    expect(client.getQueryData(key)).toBeUndefined();
    expect(client.getStats().discarded).toBe(1);
  });

  it('does not fetch when disabled, and fetches when enabled later', async () => {
    const client = createFluxCache();
    const fn = vi.fn(async () => 'v1');
    const observer = observerFor(client, fn, { enabled: false });
    observer.mount();
    await flushMicrotasks();
    expect(fn).not.toHaveBeenCalled();
    expect(observer.getSnapshot().isPending).toBe(true);

    observer.setOptions({ queryKey: key, queryFn: fn, enabled: true });
    observer.maybeFetch();
    await flushMicrotasks();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(observer.getSnapshot().data).toBe('v1');
  });

  it('refetches imperatively, bypassing freshness', async () => {
    const client = createFluxCache();
    const fn = vi.fn(async () => 'v1');
    const observer = observerFor(client, fn);
    observer.mount();
    await flushMicrotasks();

    const outcome = await observer.refetch();
    expect(outcome.settled).toBe('fulfilled');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('switches entries when the key changes', async () => {
    const client = createFluxCache();
    const fn = vi.fn(async () => 'value');
    const observer = observerFor(client, fn);
    observer.mount();
    await flushMicrotasks();
    expect(observer.getSnapshot().data).toBe('value');

    observer.setOptions({ queryKey: ['other'], queryFn: fn });
    observer.maybeFetch();
    await flushMicrotasks();
    expect(observer.getSnapshot().data).toBe('value');
    expect(client.getQueryData(['other'])).toBe('value');
  });

  it('seeds pending queries with initialData and treats it as fresh', async () => {
    const client = createFluxCache();
    const fn = vi.fn(async () => 'network');
    const observer = observerFor(client, fn, { initialData: 'seed' });
    observer.mount();
    await flushMicrotasks();

    expect(observer.getSnapshot().data).toBe('seed');
    expect(observer.getSnapshot().isStale).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
});

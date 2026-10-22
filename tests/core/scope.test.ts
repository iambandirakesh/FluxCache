import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFluxCache } from '../../src/core/client';
import { QueryObserver } from '../../src/core/observer';
import type { QueryKey } from '../../src/core/types';
import { deferred, flushMicrotasks } from '../../src/testing';

const key: QueryKey = ['account', 'profile'];

describe('authentication scope isolation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops cached data and is idempotent for the same scope', async () => {
    const client = createFluxCache();
    await client.fetchQuery(key, async () => 'alice');
    expect(client.getQueryData(key)).toBe('alice');

    const first = client.setAuthScope('alice');
    expect(first.changed).toBe(true);
    expect(first.entriesDropped).toBe(1);
    expect(client.getQueryData(key)).toBeUndefined();

    const second = client.setAuthScope('alice');
    expect(second.changed).toBe(false);
    expect(client.getAuthScope().scopeTag).toBe(first.scopeTag);
  });

  it('settles pending operations with scope-changed and no data', async () => {
    const client = createFluxCache();
    const gate = deferred<string>();
    const fn = vi.fn(() => gate.promise);
    const pending = client.fetchQuery(key, fn);

    const result = client.setAuthScope('bob');
    expect(result.requestsCancelled).toBe(1);

    const outcome = await pending;
    expect(outcome.settled).toBe('scope-changed');
    expect(outcome.data).toBeUndefined();
    expect(outcome.dataUpdatedAt).toBeNull();

    gate.resolve('alice-data');
    await flushMicrotasks();
    expect(client.getQueryData(key)).toBeUndefined();
    expect(client.getStats().discarded).toBe(1);
  });

  it('does not let a late failure write an error into the new scope', async () => {
    const client = createFluxCache();
    const gate = deferred<string>();
    const pending = client.fetchQuery(key, () => gate.promise, { retry: 2 });

    client.setAuthScope('bob');
    expect((await pending).settled).toBe('scope-changed');

    gate.reject(new Error('late failure'));
    await flushMicrotasks();
    expect(client.getQueryState(key).error).toBeNull();
  });

  it('cancels retry backoff for the old scope', async () => {
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
    client.setAuthScope('bob');
    expect((await pending).settled).toBe('scope-changed');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toBe(1);
  });

  it('never serves one account data to another account', async () => {
    const client = createFluxCache();
    await client.fetchQuery(key, async () => 'alice');
    client.setAuthScope('bob');

    const bobValue = await client.fetchQuery(key, async () => 'bob');
    expect(bobValue.data).toBe('bob');
    expect(client.getQueryData(key)).toBe('bob');

    client.setAuthScope('alice');
    expect(client.getQueryData(key)).toBeUndefined();
    const aliceAgain = await client.fetchQuery(key, async () => 'alice-2');
    expect(aliceAgain.data).toBe('alice-2');
  });

  it('notifies mounted observers with a pending snapshot and does not auto-fetch', async () => {
    const client = createFluxCache();
    const fn = vi.fn(async () => 'alice');
    const observer = new QueryObserver(client, { queryKey: key, queryFn: fn });
    observer.mount();
    await flushMicrotasks();
    expect(observer.getSnapshot().data).toBe('alice');

    client.setAuthScope('bob');
    const snapshot = observer.getSnapshot();
    expect(snapshot.hasData).toBe(false);
    expect(snapshot.data).toBeUndefined();
    expect(snapshot.isPending).toBe(true);
    expect(snapshot.isFetching).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);

    const refetched = await observer.refetch();
    expect(refetched.settled).toBe('fulfilled');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(observer.getSnapshot().data).toBe('alice');
  });

  it('clears timers and keeps diagnostics free of scope values', async () => {
    const client = createFluxCache({ staleTime: 1000, gcTime: 5000 });
    const events: unknown[] = [];
    client.subscribe((event) => events.push(event));
    await client.fetchQuery(key, async () => 'alice');
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    client.setAuthScope('alice@example.com');
    expect(client.getAuthScope().scopeTag).toMatch(/^s\d+$/);
    expect(JSON.stringify(events)).not.toContain('alice@example.com');
    expect(JSON.stringify(events)).not.toContain('alice');
  });

  it('rejects invalid scope values synchronously', () => {
    const client = createFluxCache();
    expect(() => client.setAuthScope(42 as never)).toThrow(TypeError);
  });

  it('a released old token cannot abort work in the new scope', async () => {
    const client = createFluxCache();
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: async () => 'alice',
      cancelOnUnmount: true,
    });
    observer.mount();
    await flushMicrotasks();

    client.setAuthScope('bob');
    const gate = deferred<string>();
    const pending = client.fetchQuery(key, () => gate.promise);
    observer.unmount();

    expect(client.getStats().cancelled).toBe(0);
    gate.resolve('bob');
    expect((await pending).data).toBe('bob');
  });
});

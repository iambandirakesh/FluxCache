import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFluxCache, type FluxCacheClient } from '../../src/core/client';
import type { QueryKey } from '../../src/core/types';
import { deferred } from '../../src/testing';
import { FluxCacheProvider } from '../../src/react/context';
import { usePrefetch, type UsePrefetchOptions } from '../../src/react/usePrefetch';

function wrapperFor(client: FluxCacheClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <FluxCacheProvider client={client}>{children}</FluxCacheProvider>;
  };
}

const key: QueryKey = ['product', 1];

function testClient(): FluxCacheClient {
  return createFluxCache({ staleTime: Infinity, gcTime: Infinity });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('usePrefetch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('prefetches after the hover delay, not before', async () => {
    const client = testClient();
    const fn = vi.fn(async () => 'value');
    const { result } = renderHook(() => usePrefetch({ queryKey: key, queryFn: fn, delay: 100 }), {
      wrapper: wrapperFor(client),
    });

    act(() => result.current({ pointerType: 'mouse' }));
    await advance(99);
    expect(fn).not.toHaveBeenCalled();

    await advance(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(key)).toBe('value');
  });

  it('uses a 120 ms default delay', async () => {
    const client = testClient();
    const fn = vi.fn(async () => 'value');
    const { result } = renderHook(() => usePrefetch({ queryKey: key, queryFn: fn }), {
      wrapper: wrapperFor(client),
    });

    act(() => result.current({ pointerType: 'mouse' }));
    await advance(119);
    expect(fn).not.toHaveBeenCalled();
    await advance(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid delay and priority synchronously', () => {
    const client = testClient();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() =>
      renderHook(() => usePrefetch({ queryKey: key, queryFn: async () => 'v', delay: -1 }), {
        wrapper: wrapperFor(client),
      }),
    ).toThrow(RangeError);
    expect(() =>
      renderHook(
        () =>
          usePrefetch({
            queryKey: key,
            queryFn: async () => 'v',
            priority: 'urgent' as never,
          }),
        { wrapper: wrapperFor(client) },
      ),
    ).toThrow(TypeError);
    expect(() =>
      renderHook(() => usePrefetch({ queryKey: key, queryFn: undefined as never }), {
        wrapper: wrapperFor(client),
      }),
    ).toThrow(TypeError);

    error.mockRestore();
  });

  it('prefetches on focus without pointer-type checks', async () => {
    const client = testClient();
    const fn = vi.fn(async () => 'value');
    const { result } = renderHook(() => usePrefetch({ queryKey: key, queryFn: fn, delay: 0 }), {
      wrapper: wrapperFor(client),
    });

    act(() => result.current());
    await advance(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('ignores touch pointers so scrolling does not trigger requests', async () => {
    const client = testClient();
    const fn = vi.fn(async () => 'value');
    const { result } = renderHook(() => usePrefetch({ queryKey: key, queryFn: fn, delay: 10 }), {
      wrapper: wrapperFor(client),
    });

    act(() => result.current({ pointerType: 'touch' }));
    await advance(20);
    expect(fn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('debounces repeated triggers into one prefetch', async () => {
    const client = testClient();
    const fn = vi.fn(async () => 'value');
    const { result } = renderHook(() => usePrefetch({ queryKey: key, queryFn: fn, delay: 100 }), {
      wrapper: wrapperFor(client),
    });

    act(() => result.current({ pointerType: 'mouse' }));
    await advance(60);
    act(() => result.current({ pointerType: 'mouse' }));
    await advance(99);
    expect(fn).not.toHaveBeenCalled();
    await advance(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending prefetch when the pointer leaves', async () => {
    const client = testClient();
    const fn = vi.fn(async () => 'value');
    const { result } = renderHook(() => usePrefetch({ queryKey: key, queryFn: fn, delay: 100 }), {
      wrapper: wrapperFor(client),
    });

    act(() => result.current({ pointerType: 'mouse' }));
    act(() => result.current.cancel());
    await advance(200);
    expect(fn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a running prefetch on cancel', async () => {
    const client = testClient();
    const gate = deferred<string>();
    let signal: AbortSignal | undefined;
    const fn = vi.fn(({ signal: requestSignal }: { signal: AbortSignal }) => {
      signal = requestSignal;
      return gate.promise;
    });
    const { result } = renderHook(() => usePrefetch({ queryKey: key, queryFn: fn, delay: 10 }), {
      wrapper: wrapperFor(client),
    });

    act(() => result.current({ pointerType: 'mouse' }));
    await advance(10);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);

    act(() => result.current.cancel());
    expect(signal?.aborted).toBe(true);
    expect(client.getQueryData(key)).toBeUndefined();

    gate.resolve('late');
    await advance(0);
    expect(client.getQueryData(key)).toBeUndefined();
  });

  it('cancels pending work on unmount', async () => {
    const client = testClient();
    const fn = vi.fn(async () => 'value');
    const { result, unmount } = renderHook(
      () => usePrefetch({ queryKey: key, queryFn: fn, delay: 100 }),
      { wrapper: wrapperFor(client) },
    );

    act(() => result.current({ pointerType: 'mouse' }));
    unmount();
    await advance(200);
    expect(fn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets a started prefetch finish after unmount to warm the cache', async () => {
    const client = testClient();
    const gate = deferred<string>();
    const fn = vi.fn(() => gate.promise);
    const { result, unmount } = renderHook(
      () => usePrefetch({ queryKey: key, queryFn: fn, delay: 10 }),
      { wrapper: wrapperFor(client) },
    );

    act(() => result.current({ pointerType: 'mouse' }));
    await advance(10);
    expect(fn).toHaveBeenCalledTimes(1);
    unmount();

    gate.resolve('warm');
    await advance(0);
    expect(client.getQueryData(key)).toBe('warm');
  });

  it('never exposes a running prefetch after unmount and a scope switch', async () => {
    const client = testClient();
    const gate = deferred<string>();
    let requestSignal: AbortSignal | undefined;
    const fn = vi.fn(({ signal }: { signal: AbortSignal }) => {
      requestSignal = signal;
      return gate.promise;
    });
    const { result, unmount } = renderHook(
      () => usePrefetch({ queryKey: key, queryFn: fn, delay: 10 }),
      { wrapper: wrapperFor(client) },
    );

    act(() => result.current({ pointerType: 'mouse' }));
    await advance(10);
    expect(fn).toHaveBeenCalledTimes(1);
    unmount();

    const change = client.setAuthScope('bob');
    expect(change.changed).toBe(true);
    expect(requestSignal?.aborted).toBe(true);

    gate.resolve('alice-data');
    await advance(0);
    expect(client.getQueryData(key)).toBeUndefined();
    expect(client.getAuthScope().scopeTag).toBe(change.scopeTag);

    const fresh = await client.prefetchQuery(key, async () => 'bob-data');
    expect(fresh.data).toBe('bob-data');
  });

  it('cancels pending work when the key changes', async () => {
    const client = testClient();
    const first = vi.fn(async () => 'first');
    const second = vi.fn(async () => 'second');
    const { result, rerender } = renderHook(
      ({ id }: { id: number }) =>
        usePrefetch({
          queryKey: ['product', id],
          queryFn: id === 1 ? first : second,
          delay: 100,
        }),
      { wrapper: wrapperFor(client), initialProps: { id: 1 } },
    );

    act(() => result.current({ pointerType: 'mouse' }));
    rerender({ id: 2 });
    await advance(200);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it('does nothing while disabled and cleans up when disabled', async () => {
    const client = testClient();
    const fn = vi.fn(async () => 'value');
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        usePrefetch({ queryKey: key, queryFn: fn, delay: 50, enabled }),
      { wrapper: wrapperFor(client), initialProps: { enabled: false } },
    );

    act(() => result.current({ pointerType: 'mouse' }));
    await advance(100);
    expect(fn).not.toHaveBeenCalled();

    rerender({ enabled: true });
    act(() => result.current({ pointerType: 'mouse' }));
    await advance(25);
    rerender({ enabled: false });
    await advance(100);
    expect(fn).not.toHaveBeenCalled();
  });

  it('joins an in-flight prefetch instead of starting another', async () => {
    const client = testClient();
    const gate = deferred<string>();
    const fn = vi.fn(() => gate.promise);
    const { result } = renderHook(() => usePrefetch({ queryKey: key, queryFn: fn, delay: 10 }), {
      wrapper: wrapperFor(client),
    });

    act(() => result.current({ pointerType: 'mouse' }));
    await advance(10);
    act(() => result.current({ pointerType: 'mouse' }));
    await advance(10);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(client.getStats().dedupeJoins).toBe(1);

    gate.resolve('value');
    await advance(0);
    expect(client.getQueryData(key)).toBe('value');
  });

  it('forwards priority and an abort signal to the client', async () => {
    const client = testClient();
    const fn = vi.fn(async () => 'value');
    const spy = vi.spyOn(client, 'prefetchQuery').mockResolvedValue({
      settled: 'skipped',
      skipReason: 'fresh',
      data: undefined,
      dataUpdatedAt: null,
    });
    const options: UsePrefetchOptions<string> = {
      queryKey: key,
      queryFn: fn,
      delay: 5,
    };
    const { result } = renderHook(() => usePrefetch(options), {
      wrapper: wrapperFor(client),
    });

    act(() => result.current({ pointerType: 'mouse' }));
    await advance(5);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[2]).toMatchObject({
      priority: 'high',
      signal: expect.any(AbortSignal),
    });
  });
});

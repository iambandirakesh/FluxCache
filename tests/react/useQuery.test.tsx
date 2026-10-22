import { StrictMode, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFluxCache, type FluxCacheClient } from '../../src/core/client';
import { FluxCacheProvider, useCacheClient } from '../../src/react/context';
import { useQuery } from '../../src/react/useQuery';
import type { QueryKey } from '../../src/core/types';
import { deferred, flushMicrotasks } from '../../src/testing';

function wrapperFor(client: FluxCacheClient, strict = false) {
  return function Wrapper({ children }: { children: ReactNode }) {
    const tree = <FluxCacheProvider client={client}>{children}</FluxCacheProvider>;
    return strict ? <StrictMode>{tree}</StrictMode> : tree;
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await flushMicrotasks(3);
  });
}

const key: QueryKey = ['todos'];

describe('useQuery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches on mount and exposes loading then success', async () => {
    const client = createFluxCache();
    const gate = deferred<string[]>();
    const fn = vi.fn(() => gate.promise);

    const { result } = renderHook(() => useQuery({ queryKey: key, queryFn: fn }), {
      wrapper: wrapperFor(client),
    });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.current.isLoading).toBe(true);
    expect(result.current.status).toBe('pending');

    gate.resolve(['write tests']);
    await flush();

    expect(result.current.data).toEqual(['write tests']);
    expect(result.current.isSuccess).toBe(true);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('requires a provider with a clear error', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => renderHook(() => useCacheClient())).toThrow(
      /must be used inside <FluxCacheProvider>/,
    );
    error.mockRestore();
  });

  it('issues a single request under StrictMode', async () => {
    const client = createFluxCache();
    const gate = deferred<string>();
    const fn = vi.fn(() => gate.promise);

    const { result } = renderHook(() => useQuery({ queryKey: key, queryFn: fn }), {
      wrapper: wrapperFor(client, true),
    });

    expect(fn).toHaveBeenCalledTimes(1);
    gate.resolve('ok');
    await flush();
    expect(result.current.data).toBe('ok');
  });

  it('shares one request between two hooks with the same key', async () => {
    const client = createFluxCache();
    const gate = deferred<string>();
    const fn = vi.fn(() => gate.promise);

    const { result } = renderHook(
      () => ({
        left: useQuery({ queryKey: key, queryFn: fn }),
        right: useQuery({ queryKey: key, queryFn: fn }),
      }),
      { wrapper: wrapperFor(client) },
    );

    expect(fn).toHaveBeenCalledTimes(1);
    gate.resolve('shared');
    await flush();
    expect(result.current.left.data).toBe('shared');
    expect(result.current.right.data).toBe('shared');
  });

  it('fetches a new key without showing the previous key data', async () => {
    const client = createFluxCache();
    const { result, rerender } = renderHook(
      ({ id }: { id: number }) =>
        useQuery({
          queryKey: ['todo', id],
          queryFn: async () => `todo-${id}`,
        }),
      { wrapper: wrapperFor(client), initialProps: { id: 1 } },
    );

    await flush();
    expect(result.current.data).toBe('todo-1');

    rerender({ id: 2 });
    expect(result.current.hasData).toBe(false);
    await flush();
    expect(result.current.data).toBe('todo-2');
  });

  it('does not fetch while disabled, then fetches when enabled', async () => {
    const client = createFluxCache();
    const fn = vi.fn(async () => 'value');

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useQuery({ queryKey: key, queryFn: fn, enabled }),
      { wrapper: wrapperFor(client), initialProps: { enabled: false } },
    );

    expect(fn).not.toHaveBeenCalled();
    expect(result.current.isPending).toBe(true);

    rerender({ enabled: true });
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(result.current.data).toBe('value');
  });

  it('completes requests after unmount by default', async () => {
    const client = createFluxCache();
    const gate = deferred<string>();
    let signal: AbortSignal | undefined;
    const fn = vi.fn(({ signal: requestSignal }: { signal: AbortSignal }) => {
      signal = requestSignal;
      return gate.promise;
    });

    const { unmount } = renderHook(() => useQuery({ queryKey: key, queryFn: fn }), {
      wrapper: wrapperFor(client),
    });

    unmount();
    expect(signal?.aborted).toBe(false);

    gate.resolve('cached');
    await flush();
    expect(client.getQueryData(key)).toBe('cached');
  });

  it('aborts on unmount with cancelOnUnmount', async () => {
    const client = createFluxCache();
    const gate = deferred<string>();
    let signal: AbortSignal | undefined;
    const fn = vi.fn(({ signal: requestSignal }: { signal: AbortSignal }) => {
      signal = requestSignal;
      return gate.promise;
    });

    const { unmount } = renderHook(
      () => useQuery({ queryKey: key, queryFn: fn, cancelOnUnmount: true }),
      { wrapper: wrapperFor(client) },
    );

    unmount();
    expect(signal?.aborted).toBe(true);
    expect(client.getStats().cancelled).toBe(1);
  });

  it('refetches through the snapshot bypassing freshness', async () => {
    const client = createFluxCache();
    const fn = vi.fn(async () => 'v1');
    const { result } = renderHook(() => useQuery({ queryKey: key, queryFn: fn }), {
      wrapper: wrapperFor(client),
    });
    await flush();
    expect(result.current.data).toBe('v1');

    await act(async () => {
      await result.current.refetch();
    });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('exposes errors and recovers on refetch', async () => {
    const client = createFluxCache();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('recovered');

    const { result } = renderHook(() => useQuery({ queryKey: key, queryFn: fn, retry: 0 }), {
      wrapper: wrapperFor(client),
    });
    await flush();

    expect(result.current.isError).toBe(true);
    expect(result.current.status).toBe('error');
    expect((result.current.error as Error).message).toBe('boom');

    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.isError).toBe(false);
    expect(result.current.data).toBe('recovered');
    expect(result.current.error).toBeNull();
  });

  it('keeps stale data visible during a background refetch', async () => {
    const client = createFluxCache({ staleTime: 1000 });
    const gate = deferred<string>();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('v1')
      .mockImplementationOnce(() => gate.promise);

    const first = renderHook(() => useQuery({ queryKey: key, queryFn: fn }), {
      wrapper: wrapperFor(client),
    });
    await flush();
    expect(first.result.current.data).toBe('v1');
    first.unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    const second = renderHook(() => useQuery({ queryKey: key, queryFn: fn }), {
      wrapper: wrapperFor(client),
    });
    await flush();

    expect(second.result.current.data).toBe('v1');
    expect(second.result.current.isFetching).toBe(true);
    expect(second.result.current.isStale).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);

    gate.resolve('v2');
    await flush();
    expect(second.result.current.data).toBe('v2');
    expect(second.result.current.isFetching).toBe(false);
  });

  it('flips isStale by timer without a new request', async () => {
    const client = createFluxCache({ staleTime: 1000 });
    const fn = vi.fn(async () => 'v1');
    const { result } = renderHook(() => useQuery({ queryKey: key, queryFn: fn }), {
      wrapper: wrapperFor(client),
    });
    await flush();
    expect(result.current.isStale).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(result.current.isStale).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses initialData immediately without fetching', async () => {
    const client = createFluxCache();
    const fn = vi.fn(async () => 'network');
    const { result } = renderHook(
      () => useQuery({ queryKey: key, queryFn: fn, initialData: 'seed' }),
      { wrapper: wrapperFor(client) },
    );

    expect(result.current.data).toBe('seed');
    expect(result.current.isStale).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
});

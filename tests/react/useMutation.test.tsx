import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createFluxCache, type FluxCacheClient } from '../../src/core/client';
import type { MutationOutcome } from '../../src/core/mutation';
import { FluxCacheProvider } from '../../src/react/context';
import { useInvalidate } from '../../src/react/useInvalidate';
import { useMutation } from '../../src/react/useMutation';
import { deferred, flushMicrotasks } from '../../src/testing';

function wrapperFor(client: FluxCacheClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <FluxCacheProvider client={client}>{children}</FluxCacheProvider>;
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await flushMicrotasks(3);
  });
}

describe('useMutation', () => {
  it('renders pending and success snapshots and calls callbacks once', async () => {
    const client = createFluxCache();
    const gate = deferred<string>();
    const onSuccess = vi.fn();
    const onSettled = vi.fn();
    const { result } = renderHook(
      () =>
        useMutation({
          mutationFn: () => gate.promise,
          onSuccess,
          onSettled,
        }),
      { wrapper: wrapperFor(client) },
    );

    expect(result.current.status).toBe('idle');

    act(() => result.current.mutate('value'));
    expect(result.current).toMatchObject({
      status: 'pending',
      variables: 'value',
      isPending: true,
    });

    gate.resolve('saved');
    await flush();
    expect(result.current).toMatchObject({
      status: 'success',
      data: 'saved',
      error: null,
      isSuccess: true,
    });
    expect(onSuccess).toHaveBeenCalledWith('saved', 'value', undefined);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('settles both callers when a newer mutation supersedes the first', async () => {
    const client = createFluxCache();
    const firstGate = deferred<string>();
    const secondGate = deferred<string>();
    const { result } = renderHook(
      () =>
        useMutation({
          mutationFn: (variables: string) =>
            variables === 'first' ? firstGate.promise : secondGate.promise,
        }),
      { wrapper: wrapperFor(client) },
    );

    let first!: Promise<MutationOutcome<string, string>>;
    let second!: Promise<MutationOutcome<string, string>>;
    act(() => {
      first = result.current.mutateAsync('first');
    });
    act(() => {
      second = result.current.mutateAsync('second');
    });

    expect((await first).settled).toBe('superseded');
    expect(result.current).toMatchObject({ status: 'pending', variables: 'second' });

    secondGate.resolve('second result');
    expect((await second).settled).toBe('fulfilled');
    await flush();
    expect(result.current).toMatchObject({ status: 'success', data: 'second result' });
  });

  it('continues after unmount by default and ignores late hook state', async () => {
    const client = createFluxCache();
    const gate = deferred<string>();
    const onSuccess = vi.fn();
    const { result, unmount } = renderHook(
      () => useMutation({ mutationFn: () => gate.promise, onSuccess }),
      { wrapper: wrapperFor(client) },
    );

    let pending!: Promise<MutationOutcome<string, string>>;
    act(() => {
      pending = result.current.mutateAsync('value');
    });
    unmount();

    gate.resolve('cached after unmount');
    const outcome = await pending;
    expect(outcome.settled).toBe('fulfilled');
    expect(onSuccess).toHaveBeenCalledWith('cached after unmount', 'value', undefined);
  });

  it('cancels on unmount only when requested', async () => {
    const client = createFluxCache();
    const gate = deferred<string>();
    let signal: AbortSignal | undefined;
    const onSettled = vi.fn();
    const { result, unmount } = renderHook(
      () =>
        useMutation({
          mutationFn: (_variables: string, context) => {
            signal = context.signal;
            return gate.promise;
          },
          cancelOnUnmount: true,
          onSettled,
        }),
      { wrapper: wrapperFor(client) },
    );

    let pending!: Promise<MutationOutcome<string, string>>;
    act(() => {
      pending = result.current.mutateAsync('value');
    });
    unmount();

    const outcome = await pending;
    expect(outcome.settled).toBe('cancelled');
    expect(signal?.aborted).toBe(true);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('resets silently on a scope change and never calls old-scope callbacks', async () => {
    const client = createFluxCache();
    const gate = deferred<string>();
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const onSettled = vi.fn();
    const { result } = renderHook(
      () =>
        useMutation({
          mutationFn: () => gate.promise,
          onSuccess,
          onError,
          onSettled,
        }),
      { wrapper: wrapperFor(client) },
    );

    let pending!: Promise<MutationOutcome<string, string>>;
    act(() => {
      pending = result.current.mutateAsync('alice');
    });
    act(() => {
      client.setAuthScope('bob');
    });

    expect((await pending).settled).toBe('scope-changed');
    await flush();
    expect(result.current).toMatchObject({ status: 'idle', data: undefined });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('cancel resets the hook snapshot to idle', async () => {
    const client = createFluxCache();
    const gate = deferred<string>();
    const { result } = renderHook(
      () => useMutation<string, string>({ mutationFn: () => gate.promise }),
      {
        wrapper: wrapperFor(client),
      },
    );

    let pending!: Promise<MutationOutcome<string, string>>;
    act(() => {
      pending = result.current.mutateAsync('value');
    });
    act(() => result.current.cancel());

    expect((await pending).settled).toBe('cancelled');
    expect(result.current).toMatchObject({ status: 'idle', isIdle: true });
  });

  it('requires a provider', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => renderHook(() => useMutation({ mutationFn: async () => 'value' }))).toThrow(
      /must be used inside <FluxCacheProvider>/,
    );
    error.mockRestore();
  });
});

describe('useInvalidate', () => {
  it('returns a stable function that delegates filter and options', async () => {
    const client = createFluxCache();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result, rerender } = renderHook(() => useInvalidate(), {
      wrapper: wrapperFor(client),
    });

    const first = result.current;
    rerender();
    expect(result.current).toBe(first);

    await act(async () => {
      await result.current(['products'], { exact: true, awaitRefetch: true });
    });
    expect(spy).toHaveBeenCalledWith(['products'], { exact: true, awaitRefetch: true });
  });
});

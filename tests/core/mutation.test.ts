import { describe, expect, it, vi } from 'vitest';
import { createFluxCache } from '../../src/core/client';
import { MutationRunner, type MutationOptions } from '../../src/core/mutation';
import { deferred, flushMicrotasks } from '../../src/testing';

function runnerFor<TData, TVariables, TContext = undefined>(
  options: MutationOptions<TData, TVariables, TContext>,
  client = createFluxCache({ now: () => 1000 }),
) {
  return { client, runner: new MutationRunner<TData, TVariables, TContext>(client, options) };
}

describe('MutationRunner', () => {
  it('runs onMutate, the request, onSuccess and onSettled in order', async () => {
    const calls: string[] = [];
    const { runner } = runnerFor<string, { id: number }, { optimistic: boolean }>({
      mutationFn: async (variables) => {
        calls.push(`fn:${variables.id}`);
        return 'saved';
      },
      onMutate: (variables) => {
        calls.push(`mutate:${variables.id}`);
        return { optimistic: true };
      },
      onSuccess: (data, variables, context) => {
        calls.push(`success:${data}:${variables.id}:${context?.optimistic}`);
      },
      onSettled: (data, error, variables, context, outcome) => {
        calls.push(
          `settled:${String(data)}:${String(error)}:${variables.id}:${context?.optimistic}:${outcome.settled}`,
        );
      },
    });

    expect(runner.getSnapshot()).toMatchObject({ status: 'idle', isIdle: true });
    const outcome = await runner.mutateAsync({ id: 7 });

    expect(outcome).toEqual({
      settled: 'fulfilled',
      variables: { id: 7 },
      data: 'saved',
      error: undefined,
    });
    expect(calls).toEqual([
      'mutate:7',
      'fn:7',
      'success:saved:7:true',
      'settled:saved:undefined:7:true:fulfilled',
    ]);
    expect(runner.getSnapshot()).toMatchObject({
      status: 'success',
      data: 'saved',
      error: null,
      variables: { id: 7 },
      failureCount: 0,
      submittedAt: 1000,
      isSuccess: true,
    });
  });

  it('exposes pending state while the request is running and passes an abort signal', async () => {
    const gate = deferred<string>();
    let signal: AbortSignal | undefined;
    const { runner } = runnerFor<string, string>({
      mutationFn: (_variables, context) => {
        signal = context.signal;
        return gate.promise;
      },
    });

    const pending = runner.mutateAsync('value');
    expect(runner.getSnapshot()).toMatchObject({
      status: 'pending',
      data: undefined,
      error: null,
      variables: 'value',
      isPending: true,
      submittedAt: 1000,
    });
    expect(signal?.aborted).toBe(false);

    gate.resolve('done');
    expect((await pending).settled).toBe('fulfilled');
    expect(signal?.aborted).toBe(false);
  });

  it('settles failures as outcomes and reports the error exactly once', async () => {
    const error = new Error('failed');
    const onError = vi.fn();
    const onSettled = vi.fn();
    const { runner } = runnerFor<string, number>({
      mutationFn: async () => {
        throw error;
      },
      onError,
      onSettled,
    });

    const outcome = await runner.mutateAsync(4);
    expect(outcome).toMatchObject({ settled: 'failed', variables: 4, data: undefined, error });
    expect(onError).toHaveBeenCalledWith(error, 4, undefined);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0]?.[4]).toMatchObject({ settled: 'failed', error });
    expect(runner.getSnapshot()).toMatchObject({
      status: 'error',
      data: undefined,
      error,
      failureCount: 1,
      isError: true,
    });
  });

  it('is latest-wins: the old caller settles as superseded and cannot update state', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const onSettled = vi.fn();
    let signal: AbortSignal | undefined;
    const { runner } = runnerFor<string, string>({
      mutationFn: (variables, context) => {
        if (variables === 'first') {
          signal = context.signal;
          return first.promise;
        }
        return second.promise;
      },
      onSettled,
    });

    const firstOutcome = runner.mutateAsync('first');
    const secondOutcome = runner.mutateAsync('second');

    expect(signal?.aborted).toBe(true);
    expect((await firstOutcome).settled).toBe('superseded');
    expect(runner.getSnapshot()).toMatchObject({
      status: 'pending',
      variables: 'second',
      isPending: true,
    });
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0]?.[4]).toMatchObject({ settled: 'superseded' });

    first.resolve('late first');
    await flushMicrotasks();
    expect(runner.getSnapshot()).toMatchObject({ status: 'pending', variables: 'second' });

    second.resolve('second result');
    expect((await secondOutcome).settled).toBe('fulfilled');
    expect(runner.getSnapshot()).toMatchObject({ status: 'success', data: 'second result' });
    expect(onSettled).toHaveBeenCalledTimes(2);
  });

  it('cancels with an outcome, abort signal, onSettled and an idle snapshot', async () => {
    const gate = deferred<string>();
    let signal: AbortSignal | undefined;
    const onError = vi.fn();
    const onSettled = vi.fn();
    const { runner } = runnerFor<string, string>({
      mutationFn: (_variables, context) => {
        signal = context.signal;
        return gate.promise;
      },
      onError,
      onSettled,
    });

    const pending = runner.mutateAsync('cancel me');
    runner.cancel();

    const outcome = await pending;
    expect(outcome).toMatchObject({
      settled: 'cancelled',
      variables: 'cancel me',
      data: undefined,
      error: undefined,
    });
    expect(signal?.aborted).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(runner.getSnapshot()).toMatchObject({ status: 'idle', isIdle: true });

    gate.resolve('late');
    await flushMicrotasks();
    expect(runner.getSnapshot()).toMatchObject({ status: 'idle' });
  });

  it('settles scope changes silently and never leaks old-scope data or callbacks', async () => {
    const gate = deferred<string>();
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const onSettled = vi.fn();
    let signal: AbortSignal | undefined;
    const { client, runner } = runnerFor<string, string>({
      mutationFn: (_variables, context) => {
        signal = context.signal;
        return gate.promise;
      },
      onSuccess,
      onError,
      onSettled,
    });

    const pending = runner.mutateAsync('alice');
    client.setAuthScope('bob');

    expect(signal?.aborted).toBe(true);
    const outcome = await pending;
    expect(outcome).toMatchObject({
      settled: 'scope-changed',
      variables: 'alice',
      data: undefined,
      error: undefined,
    });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
    expect(runner.getSnapshot()).toMatchObject({ status: 'idle', isIdle: true });

    gate.resolve('late alice response');
    await flushMicrotasks();
    expect(runner.getSnapshot()).toMatchObject({ status: 'idle', data: undefined });
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('does not let a late rejection after cancellation change state or callbacks', async () => {
    const gate = deferred<string>();
    const onError = vi.fn();
    const { runner } = runnerFor<string, string>({
      mutationFn: () => gate.promise,
      onError,
    });

    const pending = runner.mutateAsync('value');
    runner.cancel();
    await pending;

    gate.reject(new Error('late failure'));
    await flushMicrotasks();
    expect(onError).not.toHaveBeenCalled();
    expect(runner.getSnapshot()).toMatchObject({ status: 'idle' });
  });

  it('contains callback failures without changing the outcome', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onSettled = vi.fn();
    const { runner } = runnerFor<string, string, undefined>({
      mutationFn: async () => 'ok',
      onMutate: () => {
        throw new Error('mutate failed');
      },
      onSuccess: () => {
        throw new Error('success failed');
      },
      onSettled,
    });

    const outcome = await runner.mutateAsync('value');
    expect(outcome.settled).toBe('fulfilled');
    expect(onSettled).toHaveBeenCalledWith(
      'ok',
      undefined,
      'value',
      undefined,
      expect.objectContaining({ settled: 'fulfilled' }),
    );
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('reset cancels active work and clears the snapshot', async () => {
    const gate = deferred<string>();
    const { runner } = runnerFor<string, string>({ mutationFn: () => gate.promise });
    const pending = runner.mutateAsync('value');

    runner.reset();
    expect((await pending).settled).toBe('cancelled');
    expect(runner.getSnapshot()).toMatchObject({ status: 'idle', variables: undefined });
  });

  it('notifies subscribers and exposes stable methods', async () => {
    const { runner } = runnerFor<string, string>({ mutationFn: async () => 'value' });
    const listener = vi.fn();
    const unsubscribe = runner.subscribe(listener);

    await runner.mutateAsync('value');
    expect(listener).toHaveBeenCalled();
    expect(runner.mutate).toBe(runner.mutate);
    expect(runner.cancel).toBe(runner.cancel);

    unsubscribe();
    const calls = listener.mock.calls.length;
    runner.reset();
    expect(listener).toHaveBeenCalledTimes(calls);
  });

  it('validates the client and options', () => {
    expect(
      () =>
        new MutationRunner({} as never, {
          mutationFn: async () => 'x',
        }),
    ).toThrow(/requires a client/);
    expect(() => new MutationRunner(createFluxCache(), { mutationFn: 'nope' as never })).toThrow(
      /mutationFn/,
    );
  });
});

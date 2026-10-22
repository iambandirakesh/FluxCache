'use client';

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  MutationRunner,
  type MutationOptions,
  type MutationOutcome,
  type MutationSnapshot,
} from '../core/mutation';
import { useCacheClient } from './context';

/** Reactive mutation state plus stable lifecycle methods. */
export interface UseMutationResult<TData, TVariables> extends MutationSnapshot<TData, TVariables> {
  /** Starts a mutation without observing its promise. */
  mutate: (variables: TVariables) => void;
  /** Starts a mutation; always resolves with an outcome and never rejects. */
  mutateAsync: (variables: TVariables) => Promise<MutationOutcome<TData, TVariables>>;
  /** Cancels active work and returns the snapshot to idle. */
  cancel: () => void;
  /** Cancels active work and clears the snapshot. */
  reset: () => void;
}

/**
 * Runs one latest-wins mutation per hook instance.
 *
 * Requests continue after unmount by default; the hook only stops receiving
 * state updates. Pass `cancelOnUnmount: true` to abort instead. A new mutation
 * settles the previous one as `superseded`, and auth-scope changes settle the
 * active mutation silently so old-scope callbacks cannot touch new-scope data.
 */
export function useMutation<TData, TVariables, TContext = undefined>(
  options: MutationOptions<TData, TVariables, TContext>,
): UseMutationResult<TData, TVariables> {
  const client = useCacheClient();
  const runner = useMemo(
    () => new MutationRunner<TData, TVariables, TContext>(client, options),
    // Options are refreshed on every render; only the client rebinds the runner.
    [client],
  );
  runner.setOptions(options);

  const snapshot = useSyncExternalStore(runner.subscribe, runner.getSnapshot, runner.getSnapshot);

  const cancelOnUnmount = useRef(options.cancelOnUnmount);
  cancelOnUnmount.current = options.cancelOnUnmount;
  useEffect(
    () => () => {
      // Read at unmount so changing the option never cancels active work by
      // itself; only leaving the component does.
      if (cancelOnUnmount.current === true) runner.cancel();
    },
    [runner],
  );

  return {
    ...snapshot,
    mutate: runner.mutate,
    mutateAsync: runner.mutateAsync,
    cancel: runner.cancel,
    reset: runner.reset,
  };
}

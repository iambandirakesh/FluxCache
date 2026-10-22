import type { CacheClient } from './client';

/** Lifecycle state of the latest mutation generation. */
export type MutationStatus = 'idle' | 'pending' | 'success' | 'error';

/** How a mutation generation ended. */
export type MutationSettled = 'fulfilled' | 'failed' | 'cancelled' | 'superseded' | 'scope-changed';

/** Context passed to a mutation function. */
export interface MutationFnContext {
  readonly signal: AbortSignal;
}

/** A side-effecting request. The signal is best-effort cancellation only. */
export type MutationFn<TData, TVariables> = (
  variables: TVariables,
  context: MutationFnContext,
) => Promise<TData> | TData;

/**
 * Result of one mutation generation.
 *
 * `data` is set only for `fulfilled`; `error` only for `failed`. Every outcome
 * carries the submitted variables, and every caller settles exactly once.
 */
export interface MutationOutcome<TData, TVariables> {
  settled: MutationSettled;
  variables: TVariables;
  data: TData | undefined;
  error: unknown;
}

/** Options for a mutation runner or `useMutation`. */
export interface MutationOptions<TData, TVariables, TContext = undefined> {
  mutationFn: MutationFn<TData, TVariables>;
  /** Runs synchronously before the request. A throw leaves context undefined. */
  onMutate?: ((variables: TVariables) => TContext) | undefined;
  onSuccess?:
    ((data: TData, variables: TVariables, context: TContext | undefined) => void) | undefined;
  onError?:
    ((error: unknown, variables: TVariables, context: TContext | undefined) => void) | undefined;
  /** Runs once for fulfilled, failed, cancelled and superseded generations. */
  onSettled?:
    | ((
        data: TData | undefined,
        error: unknown | undefined,
        variables: TVariables,
        context: TContext | undefined,
        outcome: MutationOutcome<TData, TVariables>,
      ) => void)
    | undefined;
  /** React hook behavior only. Default false: the request continues on unmount. */
  cancelOnUnmount?: boolean | undefined;
}

/** Reactive mutation state for a hook or framework adapter. */
export interface MutationSnapshot<TData, TVariables> {
  status: MutationStatus;
  data: TData | undefined;
  error: unknown;
  variables: TVariables | undefined;
  failureCount: number;
  submittedAt: number | null;
  isIdle: boolean;
  isPending: boolean;
  isSuccess: boolean;
  isError: boolean;
}

interface Generation<TData, TVariables, TContext> {
  id: number;
  variables: TVariables;
  controller: AbortController;
  scopeTag: string;
  scopeEpoch: number;
  context: TContext | undefined;
  started: boolean;
  settled: boolean;
  unsubscribe: (() => void) | null;
  promise: Promise<MutationOutcome<TData, TVariables>>;
  resolve: (outcome: MutationOutcome<TData, TVariables>) => void;
}

function idleSnapshot<TData, TVariables>(): MutationSnapshot<TData, TVariables> {
  return {
    status: 'idle',
    data: undefined,
    error: null,
    variables: undefined,
    failureCount: 0,
    submittedAt: null,
    isIdle: true,
    isPending: false,
    isSuccess: false,
    isError: false,
  };
}

function validateOptions<TData, TVariables, TContext>(
  options: MutationOptions<TData, TVariables, TContext>,
): void {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('mutation options must be an object');
  }
  if (typeof options.mutationFn !== 'function') {
    throw new TypeError('mutationFn must be a function');
  }
  for (const name of ['onMutate', 'onSuccess', 'onError', 'onSettled'] as const) {
    const callback = options[name];
    if (callback !== undefined && typeof callback !== 'function') {
      throw new TypeError(`${name} must be a function`);
    }
  }
  if (options.cancelOnUnmount !== undefined && typeof options.cancelOnUnmount !== 'boolean') {
    throw new TypeError('cancelOnUnmount must be a boolean');
  }
}

/**
 * Framework-independent mutation lifecycle.
 *
 * One runner is latest-wins: starting a new generation aborts and settles the
 * previous one as `superseded`. The runner never rejects `mutateAsync`, and a
 * scope change silences callbacks so old-scope code cannot touch new-scope data.
 */
export class MutationRunner<TData, TVariables, TContext = undefined> {
  private options: MutationOptions<TData, TVariables, TContext>;
  private readonly client: CacheClient;
  private readonly listeners = new Set<() => void>();
  private snapshot: MutationSnapshot<TData, TVariables> = idleSnapshot();
  private active: Generation<TData, TVariables, TContext> | null = null;
  private sequence = 0;

  constructor(client: CacheClient, options: MutationOptions<TData, TVariables, TContext>) {
    if (!client || typeof client.getAuthScope !== 'function') {
      throw new TypeError('MutationRunner requires a client created with createFluxCache()');
    }
    validateOptions(options);
    this.client = client;
    this.options = options;
  }

  /** Stable snapshot for `useSyncExternalStore` and framework adapters. */
  readonly getSnapshot = (): MutationSnapshot<TData, TVariables> => this.snapshot;

  /** Subscribes to snapshot changes. Returns an unsubscribe function. */
  readonly subscribe = (listener: () => void): (() => void) => {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Updates options for future generations and settlement callbacks. */
  setOptions(options: MutationOptions<TData, TVariables, TContext>): void {
    validateOptions(options);
    this.options = options;
  }

  /** Starts a mutation without observing its promise. */
  readonly mutate = (variables: TVariables): void => {
    void this.mutateAsync(variables);
  };

  /**
   * Starts a mutation and resolves with its outcome. Never rejects.
   *
   * Starting while another generation is active settles the previous one as
   * `superseded` before this generation's `onMutate` runs.
   */
  readonly mutateAsync = (variables: TVariables): Promise<MutationOutcome<TData, TVariables>> => {
    let resolve!: (outcome: MutationOutcome<TData, TVariables>) => void;
    const promise = new Promise<MutationOutcome<TData, TVariables>>((resolvePromise) => {
      resolve = resolvePromise;
    });
    const scope = this.client.getAuthScope();
    this.sequence += 1;
    const generation: Generation<TData, TVariables, TContext> = {
      id: this.sequence,
      variables,
      controller: new AbortController(),
      scopeTag: scope.scopeTag,
      scopeEpoch: scope.epoch,
      context: undefined,
      started: false,
      settled: false,
      unsubscribe: null,
      promise,
      resolve,
    };

    const previous = this.active;
    this.active = generation;
    generation.unsubscribe = this.client.subscribe((event) => {
      if (event.type !== 'scope:change' || this.active !== generation) return;
      if (generation.settled) return;
      const current = this.client.getAuthScope();
      if (current.scopeTag !== generation.scopeTag || current.epoch !== generation.scopeEpoch) {
        this.complete(generation, 'scope-changed');
      }
    });

    if (previous) this.complete(previous, 'superseded');
    // A synchronous onSettled callback may have started another generation.
    if (this.active !== generation) {
      this.complete(generation, 'superseded');
      return promise;
    }

    let context: TContext | undefined;
    try {
      context = this.options.onMutate?.(variables);
    } catch (error) {
      this.warn('onMutate threw; continuing without a mutation context', error);
    }
    generation.context = context;

    if (this.active !== generation) {
      this.complete(generation, 'superseded');
      return promise;
    }

    generation.started = true;
    this.setState({
      status: 'pending',
      data: undefined,
      error: null,
      variables,
      failureCount: 0,
      submittedAt: this.client.now(),
      isIdle: false,
      isPending: true,
      isSuccess: false,
      isError: false,
    });
    void this.execute(generation);
    return promise;
  };

  /** Cancels the active generation, settling it as `cancelled`. */
  readonly cancel = (): void => {
    if (this.active) this.complete(this.active, 'cancelled');
  };

  /** Cancels active work and clears the snapshot. */
  readonly reset = (): void => {
    this.cancel();
    if (!this.active) this.setState(idleSnapshot());
  };

  private async execute(generation: Generation<TData, TVariables, TContext>): Promise<void> {
    try {
      const data = await this.options.mutationFn(generation.variables, {
        signal: generation.controller.signal,
      });
      if (this.active !== generation || generation.settled) return;
      this.complete(generation, 'fulfilled', data);
    } catch (error) {
      if (this.active !== generation || generation.settled) return;
      this.complete(generation, 'failed', undefined, error);
    }
  }

  private complete(
    generation: Generation<TData, TVariables, TContext>,
    settled: MutationSettled,
    data?: TData,
    error?: unknown,
  ): void {
    if (generation.settled) return;
    generation.settled = true;
    generation.unsubscribe?.();
    generation.unsubscribe = null;
    if (settled !== 'fulfilled' && settled !== 'failed') generation.controller.abort();

    const outcome: MutationOutcome<TData, TVariables> = {
      settled,
      variables: generation.variables,
      data: settled === 'fulfilled' ? data : undefined,
      error: error ?? undefined,
    };

    if (this.active === generation) {
      this.active = null;
      if (generation.started) {
        if (settled === 'fulfilled') {
          this.setState({
            status: 'success',
            data,
            error: null,
            variables: generation.variables,
            failureCount: 0,
            submittedAt: this.snapshot.submittedAt,
            isIdle: false,
            isPending: false,
            isSuccess: true,
            isError: false,
          });
        } else if (settled === 'failed') {
          this.setState({
            status: 'error',
            data: undefined,
            error,
            variables: generation.variables,
            failureCount: 1,
            submittedAt: this.snapshot.submittedAt,
            isIdle: false,
            isPending: false,
            isSuccess: false,
            isError: true,
          });
        } else {
          this.setState(idleSnapshot());
        }
      }
    }

    if (generation.started) {
      if (settled === 'fulfilled') {
        this.invoke('onSuccess', data, generation.variables, generation.context);
      } else if (settled === 'failed') {
        this.invoke('onError', error, generation.variables, generation.context);
      }
      if (settled !== 'scope-changed') {
        this.invoke(
          'onSettled',
          settled === 'fulfilled' ? data : undefined,
          settled === 'failed' ? error : undefined,
          generation.variables,
          generation.context,
          outcome,
        );
      }
    }

    generation.resolve(outcome);
  }

  private invoke(
    name: keyof MutationOptions<TData, TVariables, TContext>,
    ...args: unknown[]
  ): void {
    const callback = this.options[name] as ((...callbackArgs: unknown[]) => void) | undefined;
    if (typeof callback !== 'function') return;
    try {
      callback(...args);
    } catch (error) {
      this.warn(`${String(name)} threw; the mutation outcome is unchanged`, error);
    }
  }

  private setState(next: MutationSnapshot<TData, TVariables>): void {
    this.snapshot = next;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A faulty state listener must not break mutation settlement.
      }
    }
  }

  private warn(message: string, error: unknown): void {
    if (typeof console !== 'undefined') console.warn(`[flux-cache] ${message}`, error);
  }
}

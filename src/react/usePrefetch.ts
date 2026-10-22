'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { canonicalizeQueryKey } from '../core/key';
import { isPrefetchPriority } from '../core/prefetch';
import type { PrefetchPriority, QueryFn, QueryKey, QueryOutcome } from '../core/types';
import { useCacheClient } from './context';

/** Hover/focus handler with an explicit cancel for leave/blur/unmount. */
export interface PrefetchHandler {
  /** Accepts any event; only `pointerType` is inspected to ignore touch. */
  (event?: unknown): void;
  cancel(): void;
}

function isTouchPointer(event: unknown): boolean {
  if (typeof event !== 'object' || event === null) return false;
  return (event as { pointerType?: unknown }).pointerType === 'touch';
}

/** Options for `usePrefetch`. */
export interface UsePrefetchOptions<T> {
  queryKey: QueryKey;
  queryFn: QueryFn<T>;
  staleTime?: number | undefined;
  gcTime?: number | undefined;
  retry?: number | undefined;
  retryDelay?: ((attempt: number) => number) | undefined;
  /** When false, triggers are ignored and pending work is cancelled. */
  enabled?: boolean | undefined;
  /** Delay after a trigger before prefetching. Default 120 ms. */
  delay?: number | undefined;
  /** Queue priority. Default `high`, because the user is about to navigate. */
  priority?: PrefetchPriority | undefined;
}

const DEFAULT_DELAY = 120;

/**
 * Prefetches a query after a hover or focus delay.
 *
 * Touch pointers are ignored. Repeated triggers debounce; cancel (wire it to
 * pointer leave and blur) clears the timer and aborts work that is still
 * queued or running. Unmounting alone only clears the timer, so a prefetch
 * that already started can warm the cache for the next route. Work already
 * shared with an observer is never aborted by this hook.
 */
export function usePrefetch<T>(options: UsePrefetchOptions<T>): PrefetchHandler {
  const client = useCacheClient();
  const keyHash = useMemo(() => canonicalizeQueryKey(options.queryKey), [options.queryKey]);

  if (typeof options.queryFn !== 'function') {
    throw new TypeError('usePrefetch requires a queryFn');
  }
  const delay = options.delay ?? DEFAULT_DELAY;
  if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0) {
    throw new RangeError('usePrefetch delay must be a non-negative number of milliseconds');
  }
  if (options.priority !== undefined && !isPrefetchPriority(options.priority)) {
    throw new TypeError('usePrefetch priority must be one of "high", "normal" or "low"');
  }

  const latest = useRef(options);
  latest.current = options;

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controllers = useRef(new Set<AbortController>());

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    clearTimer();
    const active = [...controllers.current];
    controllers.current.clear();
    for (const controller of active) controller.abort();
  }, [clearTimer]);

  useEffect(() => {
    if (options.enabled === false) cancel();
    // Delayed work is cancelled when the key changes or the hook unmounts. A
    // prefetch that already started keeps running as cache warming, so a click
    // that unmounts this link can still join it.
    return clearTimer;
  }, [cancel, clearTimer, keyHash, options.enabled]);

  return useMemo(() => {
    const handler = (event?: unknown): void => {
      const current = latest.current;
      if (current.enabled === false) return;
      if (isTouchPointer(event)) return;

      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        const run = latest.current;
        if (run.enabled === false) return;

        const controller = new AbortController();
        controllers.current.add(controller);
        const done = (): void => {
          controllers.current.delete(controller);
        };
        try {
          const pending: Promise<QueryOutcome<T>> = client.prefetchQuery(
            run.queryKey,
            run.queryFn,
            {
              priority: run.priority ?? 'high',
              staleTime: run.staleTime,
              gcTime: run.gcTime,
              retry: run.retry,
              retryDelay: run.retryDelay,
              signal: controller.signal,
            },
          );
          void pending.then(done, done);
        } catch {
          // Prefetching is best-effort; invalid late options must not throw
          // from a timer. Drop the controller instead of leaking it.
          controllers.current.delete(controller);
        }
      }, current.delay ?? DEFAULT_DELAY);
    };

    handler.cancel = cancel;
    return handler as PrefetchHandler;
  }, [client, keyHash, cancel]);
}

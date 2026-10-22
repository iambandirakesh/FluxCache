'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { canonicalizeQueryKey } from '../core/key';
import { QueryObserver } from '../core/observer';
import type { QueryOptions, QuerySnapshot } from '../core/types';
import { useCacheClient } from './context';

/**
 * Subscribes to a query and fetches it when missing or stale.
 *
 * One observer per hook instance; all observers of the same key share a single
 * in-flight request. State updates go through `useSyncExternalStore`, so the
 * component re-renders only when its snapshot actually changes.
 */
export function useQuery<T>(options: QueryOptions<T>): QuerySnapshot<T> {
  const client = useCacheClient();
  const keyHash = useMemo(() => canonicalizeQueryKey(options.queryKey), [options.queryKey]);
  const observer = useMemo(
    () => new QueryObserver<T>(client, options),
    // Options are refreshed on every render below; only the key rebinds.
    [client, keyHash],
  );

  observer.setOptions(options);

  const snapshot = useSyncExternalStore(
    observer.subscribe,
    observer.getSnapshot,
    observer.getServerSnapshot,
  );

  useEffect(() => {
    observer.mount();
    return () => observer.unmount();
  }, [observer]);

  useEffect(() => {
    if (options.enabled !== false) observer.maybeFetch();
  }, [observer, options.enabled]);

  return snapshot;
}

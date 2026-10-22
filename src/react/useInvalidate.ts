'use client';

import { useCallback } from 'react';
import type { InvalidateOptions, InvalidateResult, QueryFilter } from '../core/types';
import { useCacheClient } from './context';

/** Stable invalidation function returned by `useInvalidate`. */
export interface InvalidateQueries {
  (filter: QueryFilter, options?: InvalidateOptions): Promise<InvalidateResult>;
}

/**
 * Returns a stable function that invalidates queries through the nearest
 * client. It is safe to use directly in mutation callbacks and effect deps.
 */
export function useInvalidate(): InvalidateQueries {
  const client = useCacheClient();
  return useCallback(
    (filter: QueryFilter, options?: InvalidateOptions) => client.invalidateQueries(filter, options),
    [client],
  );
}

'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { CacheClient } from '../core/client';

const FluxCacheContext = createContext<CacheClient | null>(null);

export interface FluxCacheProviderProps {
  /** A client created with `createFluxCache()`. */
  client: CacheClient;
  children?: ReactNode;
}

/** Provides a cache client to the React tree. */
export function FluxCacheProvider({ client, children }: FluxCacheProviderProps) {
  if (!client || typeof client.ensureEntryFor !== 'function') {
    throw new TypeError(
      'FluxCacheProvider requires a client created with createFluxCache() as its `client` prop',
    );
  }
  return <FluxCacheContext.Provider value={client}>{children}</FluxCacheContext.Provider>;
}

/** Returns the client from the nearest provider. */
export function useCacheClient(): CacheClient {
  const client = useContext(FluxCacheContext);
  if (!client) {
    throw new Error('useCacheClient must be used inside <FluxCacheProvider>');
  }
  return client;
}

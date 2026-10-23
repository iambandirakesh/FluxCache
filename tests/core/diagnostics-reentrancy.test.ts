import { describe, expect, it } from 'vitest';
import { createFluxCache } from '../../src/core/client';
import { QueryObserver } from '../../src/core/observer';
import { deferred, flushMicrotasks } from '../../src/testing';

describe('diagnostics listener reentrancy', () => {
  it('settles a refetch when a prefetch:wasted listener changes scope', async () => {
    const client = createFluxCache({ staleTime: Infinity, gcTime: Infinity, retry: 0 });
    await client.prefetchQuery(['product'], async () => 'old-scope data');

    client.subscribe((event) => {
      if (event.type === 'prefetch:wasted') client.setAuthScope('new-user');
    });

    const result = await client.refetchQueries(['product']);
    expect(result.outcomes[0]?.settled).toBe('scope-changed');
    expect(result.outcomes[0]?.data).toBeUndefined();
    expect(client.getQueryData(['product'])).toBeUndefined();
    expect(client.getStats().inFlight).toBe(0);
  });

  it('does not render an old-scope prefetch when consumption reenters the scope', async () => {
    const client = createFluxCache({ staleTime: Infinity, gcTime: Infinity, retry: 0 });
    await client.prefetchQuery(['product'], async () => 'old-scope data');

    client.subscribe((event) => {
      if (event.type === 'prefetch:consumed') client.setAuthScope('new-user');
    });

    const observer = new QueryObserver(client, {
      queryKey: ['product'],
      queryFn: async () => 'new-scope data',
    });
    observer.mount();
    await flushMicrotasks(3);

    expect(observer.getSnapshot().data).toBe('new-scope data');
    expect(observer.getSnapshot().data).not.toBe('old-scope data');
    observer.unmount();
  });

  it('does not return a fresh cache value after consumption reenters the scope', async () => {
    const client = createFluxCache({ staleTime: Infinity, gcTime: Infinity, retry: 0 });
    await client.prefetchQuery(['product'], async () => 'old-scope data');

    client.subscribe((event) => {
      if (event.type === 'prefetch:consumed') client.setAuthScope('new-user');
    });

    const outcome = await client.fetchQuery(['product'], async () => 'new-scope data');

    expect(outcome).toMatchObject({ settled: 'scope-changed', data: undefined });
    expect(client.getQueryData(['product'])).toBeUndefined();
    expect(client.getStats().inFlight).toBe(0);
  });

  it('does not resolve a joined query with old-scope data when production reenters the scope', async () => {
    const client = createFluxCache({ staleTime: Infinity, gcTime: Infinity, retry: 0 });
    const gate = deferred<string>();
    const prefetching = client.prefetchQuery(['product'], () => gate.promise);
    await flushMicrotasks();
    const fetching = client.fetchQuery(['product'], async () => 'new-scope data');

    client.subscribe((event) => {
      if (event.type === 'prefetch:produced') client.setAuthScope('new-user');
    });

    gate.resolve('old-scope data');
    const [prefetched, fetched] = await Promise.all([prefetching, fetching]);

    expect(prefetched.settled).toBe('scope-changed');
    expect(fetched).toMatchObject({ settled: 'scope-changed', data: undefined });
    expect(client.getQueryData(['product'])).toBeUndefined();
    expect(client.getStats().inFlight).toBe(0);
  });
});

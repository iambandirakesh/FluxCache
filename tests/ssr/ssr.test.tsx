// @vitest-environment node

import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createFluxCache } from '../../src/core/client';
import { FluxCacheProvider } from '../../src/react/context';
import { useQuery } from '../../src/react/useQuery';

describe('server rendering', () => {
  it('does not access browser globals at import or render time', () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
  });

  it('renders a pending snapshot without fetching', () => {
    const client = createFluxCache();
    const fn = vi.fn(async () => 'server-data');

    function Page() {
      const query = useQuery({ queryKey: ['page'], queryFn: fn });
      return <main>{query.isPending ? 'loading' : String(query.data)}</main>;
    }

    const html = renderToString(
      <FluxCacheProvider client={client}>
        <Page />
      </FluxCacheProvider>,
    );

    expect(html).toContain('loading');
    expect(fn).not.toHaveBeenCalled();
    expect(client.getStats().size).toBe(0);
  });

  it('renders initialData on the server without fetching', () => {
    const client = createFluxCache();
    const fn = vi.fn(async () => 'server-data');

    function Page() {
      const query = useQuery({ queryKey: ['page'], queryFn: fn, initialData: 'seeded' });
      return <main>{String(query.data)}</main>;
    }

    const html = renderToString(
      <FluxCacheProvider client={client}>
        <Page />
      </FluxCacheProvider>,
    );

    expect(html).toContain('seeded');
    expect(fn).not.toHaveBeenCalled();
  });

  it('keeps clients isolated per server request', async () => {
    const first = createFluxCache();
    const second = createFluxCache();
    await first.fetchQuery(['user'], async () => 'alice');

    expect(first.getQueryData(['user'])).toBe('alice');
    expect(second.getQueryData(['user'])).toBeUndefined();
  });
});

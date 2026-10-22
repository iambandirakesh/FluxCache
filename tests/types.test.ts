import { describe, expect, expectTypeOf, it } from 'vitest';
import { createFluxCache, type FluxCacheClient } from '../src/core/client';
import { QueryObserver } from '../src/core/observer';
import type { QueryFn, QueryOptions, QueryOutcome } from '../src/core/types';

describe('public type inference', () => {
  it('infers data from the query function', async () => {
    const client = createFluxCache();
    const queryFn: QueryFn<{ id: number }> = async () => ({ id: 1 });
    const outcome = await client.fetchQuery(['item', 1], queryFn);

    expectTypeOf(outcome).toEqualTypeOf<QueryOutcome<{ id: number }>>();
    expectTypeOf(outcome.data).toEqualTypeOf<{ id: number } | undefined>();
    expect(outcome.data?.id).toBe(1);
  });

  it('types cache reads and writes explicitly', () => {
    const client = createFluxCache();
    const state = client.setQueryData<{ name: string }>(['me'], { name: 'Ada' });
    expectTypeOf(state).toEqualTypeOf<{
      data: { name: string } | undefined;
      hasData: boolean;
      error: unknown;
      dataUpdatedAt: number | null;
      errorUpdatedAt: number | null;
      isStale: boolean;
      status: 'pending' | 'success' | 'error';
    }>();

    const cached = client.getQueryData<{ name: string }>(['me']);
    expectTypeOf(cached).toEqualTypeOf<{ name: string } | undefined>();
    expect(cached?.name).toBe('Ada');
  });

  it('exposes a typed snapshot from the observer', () => {
    const client = createFluxCache();
    const options: QueryOptions<string[]> = {
      queryKey: ['list'],
      queryFn: async () => ['a'],
    };
    const observer = new QueryObserver<string[]>(client, options);
    expectTypeOf(observer.getSnapshot().data).toEqualTypeOf<string[] | undefined>();
    expectTypeOf(client).toMatchTypeOf<FluxCacheClient>();
    expect(observer.getSnapshot().isPending).toBe(true);
    expect(options.queryFn).toBeTypeOf('function');
  });
});

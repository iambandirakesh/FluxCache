# Manual optimistic updates

FluxCache does not ship an automatic optimistic-mutation engine. Phase C
provides the primitives — `useMutation`, `setQueryData`, `invalidateQueries` and
`useInvalidate` — and the application owns the optimistic write, its snapshot,
the keys it patched and the rollback.

The recipe below is deliberately conservative. It only rolls back when the cache
still contains the exact object this mutation wrote. That identity check is the
ownership guard: if another writer replaced the entry, the old rollback does
nothing.

## Rename one cached product

```tsx
import type { QueryKey } from 'flux-cache';
import { useCacheClient, useInvalidate, useMutation } from 'flux-cache/react';

interface Product {
  id: string;
  name: string;
  description: string;
}

interface RenameVariables {
  id: string;
  name: string;
}

interface OptimisticContext {
  key: QueryKey;
  previous: Product;
  optimistic: Product;
}

function useRenameProduct() {
  const client = useCacheClient();
  const invalidate = useInvalidate();

  return useMutation<Product, RenameVariables, OptimisticContext | undefined>({
    mutationFn: async ({ id, name }) => {
      const response = await fetch(`/api/products/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as Product;
    },

    onMutate: ({ id, name }) => {
      const key: QueryKey = ['product', id];
      const previous = client.getQueryData<Product>(key);
      // Do not invent a cache entry for data that was never loaded.
      if (previous === undefined) return undefined;

      const optimistic: Product = { ...previous, name };
      client.setQueryData(key, optimistic);
      return { key, previous, optimistic };
    },

    onSuccess: async (product, { id }) => {
      // The server response is authoritative; replace the optimistic preview.
      client.setQueryData(['product', id], product);
      await invalidate(['product', id], { exact: true });
      await invalidate(['products']);
    },

    onSettled: (data, error, variables, context, outcome) => {
      // Failed, cancelled and superseded mutations may need rollback.
      // Successful ones already have authoritative server data.
      if (outcome.settled === 'fulfilled' || !context) return;

      const current = client.getQueryData<Product>(context.key);
      if (current !== context.optimistic) return; // someone newer owns the key
      client.setQueryData(context.key, context.previous);
    },
  });
}
```

Call it from an event handler:

```tsx
function RenameButton({ product }: { product: Product }) {
  const rename = useRenameProduct();
  return (
    <button
      type="button"
      disabled={rename.isPending}
      onClick={() => void rename.mutateAsync({ id: product.id, name: 'New name' })}
    >
      {rename.isPending ? 'Saving…' : 'Rename'}
    </button>
  );
}
```

## Why this guard is required

`setQueryData` does not merge or tag writes. It stores the value and supersedes
any active request for that key. If two mutations edit the same key, the later
write wins, and the earlier mutation must not restore its old snapshot over the
newer value.

Comparing object identity (`current === context.optimistic`) works because
`setQueryData` stores the exact object reference passed to it. It is stronger
than comparing a field such as the new name, which can be identical in two
concurrent writes.

The guard is per key. For a list and a detail view, keep a separate context for
each key; rolling back one key must not overwrite an unrelated key.

## Scope and cancellation cautions

- An authentication-scope change drops all old-scope entries and settles the
  active mutation as `scope-changed` **without callbacks**. Any optimistic write
  made in the old scope disappears with those entries; do not try to restore it
  across scopes.
- A superseded generation settles with `onSettled` and no `onError`. The new
  generation normally owns the key, so the identity guard prevents the old
  generation from rolling it back.
- `cancel()` settles the active mutation as `cancelled` and runs `onSettled`.
  Decide whether cancellation should keep or roll back the preview; the recipe
  above rolls back when it still owns the entry.
- `onMutate` runs synchronously. If it writes and then throws, the mutation
  continues with no context, so there is nothing to roll back. Keep the write
  and context creation in that callback simple, or catch inside it.
- The mutation promise never rejects. Handle failures through `onError` /
  `onSettled` or inspect the returned outcome; `mutate` ignores the outcome.
- A request that continues after component unmount can still call callbacks and
  invalidate cache entries. Do not capture unmounted component state in those
  callbacks. Callbacks use the latest options passed to the hook.

## When not to use an optimistic update

Skip it when the server may reject or transform the value in ways the UI cannot
predict, when the operation is not reversible, or when the key is not already
cached. An optimistic patch is a rendering shortcut, not a transaction: aborting
the request cannot undo a server-side side effect, and only a later refetch or
authoritative response can reconcile the cache.

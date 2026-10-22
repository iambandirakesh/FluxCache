import { useEffect, useState, useSyncExternalStore } from 'react';
import { useCacheClient, usePrefetch, useQuery } from 'flux-cache/react';
import * as api from './api';
import type { Account } from './api';

type Route = 'catalog' | 'detail';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function App() {
  const client = useCacheClient();
  const [account, setAccount] = useState<Account>(() => api.getAccount());
  const [route, setRoute] = useState<Route>('catalog');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadingNotice, setLoadingNotice] = useState(false);

  function switchAccount(next: Account): void {
    if (next === account) return;
    // Credentials are switched before the cache scope, as real auth flows do.
    api.setAccount(next);
    const result = client.setAuthScope(next);
    setAccount(next);
    setRoute('catalog');
    setSelectedId(null);
    setNotice(
      `Signed in as ${next}. Cached data for ${account} was discarded (new scope ${result.scopeTag}); nothing from the old account is shown.`,
    );
  }

  async function loadForAccount(): Promise<void> {
    setLoadingNotice(true);
    try {
      await client.refetchQueries(() => true, { awaitSettled: true });
      setNotice(null);
    } finally {
      setLoadingNotice(false);
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>FluxCache</h1>
          <p className="subtitle">Cached product catalog with a deterministic mock API</p>
        </div>
        <div className="account-switcher" aria-label="Account">
          <span className="label">Acting as</span>
          {(['alice', 'bob'] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              className={candidate === account ? 'chip chip-active' : 'chip'}
              onClick={() => switchAccount(candidate)}
            >
              {candidate}
            </button>
          ))}
        </div>
      </header>

      {notice ? (
        <div className="banner" role="status">
          <span>{notice}</span>
          <button type="button" onClick={loadForAccount} disabled={loadingNotice}>
            {loadingNotice ? 'Loading…' : 'Load data for this account'}
          </button>
        </div>
      ) : null}

      <main>
        {route === 'catalog' ? (
          <Catalog
            onOpen={(id) => {
              setSelectedId(id);
              setRoute('detail');
            }}
          />
        ) : selectedId ? (
          <Detail id={selectedId} onSelect={setSelectedId} onBack={() => setRoute('catalog')} />
        ) : null}
      </main>

      <DiagnosticsPanel />
      <StatsPanel />
    </div>
  );
}

function Catalog({ onOpen }: { onOpen: (id: string) => void }) {
  const client = useCacheClient();
  const query = useQuery({
    queryKey: ['products'],
    queryFn: api.fetchProducts,
    retry: 0,
  });
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  function renameFirst(): Promise<void> {
    const first = query.data?.[0];
    if (!first) return Promise.resolve();
    api.renameProduct(first.id, `${first.name.replace(' (renamed)', '')} (renamed)`);
    return run(async () => {
      // The mutation is applied first, then the affected keys are invalidated.
      await client.invalidateQueries(['product', first.id], { exact: true, awaitRefetch: true });
      await client.invalidateQueries(['products'], { exact: true, awaitRefetch: true });
    });
  }

  function reloadWithFailure(): Promise<void> {
    api.setFailNextRequest(true);
    client.removeQueries(['products']);
    return run(() => query.refetch());
  }

  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2>Catalog</h2>
          <p className="hint">
            Query key <code>{`['products']`}</code> · scope partition keeps accounts apart
          </p>
        </div>
        <div className="badges">
          {query.isFetching ? <span className="badge badge-busy">fetching</span> : null}
          {query.hasData && query.isStale ? <span className="badge">stale</span> : null}
          {query.hasData ? <span className="badge badge-ok">cached</span> : null}
        </div>
      </div>

      {query.isError && !query.hasData ? (
        <ErrorPanel
          message={messageOf(query.error)}
          onRetry={() => void run(() => query.refetch())}
          busy={busy}
        />
      ) : !query.hasData ? (
        <p className="loading">
          {query.isFetching
            ? 'Loading the catalog…'
            : 'No catalog data for this account yet. Use “Load data for this account” above, or press Refetch.'}
        </p>
      ) : (
        <>
          {query.isError ? (
            <p className="inline-error" role="alert">
              Refresh failed: {messageOf(query.error)}. Showing the last good data.
            </p>
          ) : null}
          <ul className="product-list" data-testid="product-list">
            {query.data?.map((product) => (
              <li key={product.id}>
                <ProductLink product={product} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="actions">
        <button type="button" onClick={() => void run(() => query.refetch())} disabled={busy}>
          Refetch
        </button>
        <button
          type="button"
          onClick={() =>
            void run(() => client.invalidateQueries(['products'], { awaitRefetch: true }))
          }
          disabled={busy}
        >
          Invalidate
        </button>
        <button
          type="button"
          onClick={() => void renameFirst()}
          disabled={busy || !query.data?.length}
        >
          Rename first product
        </button>
        <button
          type="button"
          className="danger"
          onClick={() => void reloadWithFailure()}
          disabled={busy}
        >
          Fail next load
        </button>
      </div>
      <p className="hint">
        Hover or focus a product to prefetch its detail; opening it should not add another API
        request. Navigating back and reopening a cached product stays request-free while fresh.
      </p>
    </section>
  );
}

function ProductLink({ product, onOpen }: { product: api.Product; onOpen: (id: string) => void }) {
  const prefetch = usePrefetch({
    queryKey: ['product', product.id],
    queryFn: ({ signal }) => api.fetchProduct(product.id, { signal }),
  });

  return (
    <button
      type="button"
      className="product"
      onPointerEnter={prefetch}
      onPointerLeave={prefetch.cancel}
      onFocus={prefetch}
      onBlur={prefetch.cancel}
      onClick={() => onOpen(product.id)}
    >
      <span className="product-name">{product.name}</span>
      <span className="product-price">${product.price}</span>
    </button>
  );
}

interface DetailProps {
  id: string;
  onSelect: (id: string) => void;
  onBack: () => void;
}

function Detail({ id, onSelect, onBack }: DetailProps) {
  const client = useCacheClient();
  const query = useQuery({
    queryKey: ['product', id],
    queryFn: ({ signal }) => api.fetchProduct(id, { signal }),
    retry: 0,
  });
  const [busy, setBusy] = useState(false);
  const ids = api.getProductIds();
  const index = ids.indexOf(id);
  const previousId = index > 0 ? ids[index - 1] : undefined;
  const nextId = index >= 0 && index < ids.length - 1 ? ids[index + 1] : undefined;

  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="card-header">
        <div>
          <button type="button" className="link" onClick={onBack}>
            ← Back to catalog
          </button>
          <h2>{query.data?.name ?? 'Product'}</h2>
          <p className="hint">
            Query key <code>{`['product', '${id}']`}</code> · changing the key starts a new query
          </p>
        </div>
        <div className="badges">
          {query.isFetching ? <span className="badge badge-busy">fetching</span> : null}
          {query.hasData && query.isStale ? <span className="badge">stale</span> : null}
        </div>
      </div>

      {query.isError && !query.hasData ? (
        <ErrorPanel
          message={messageOf(query.error)}
          onRetry={() => void run(() => query.refetch())}
          busy={busy}
        />
      ) : !query.hasData ? (
        <p className="loading">
          {query.isFetching
            ? `Loading product ${id}…`
            : 'No data for this key in the current scope.'}
        </p>
      ) : (
        <>
          {query.isError ? (
            <p className="inline-error" role="alert">
              Refresh failed: {messageOf(query.error)}. Showing the last good data.
            </p>
          ) : null}
          <p className="price">${query.data?.price}</p>
          <p>{query.data?.description}</p>
        </>
      )}

      <div className="actions">
        <button type="button" onClick={() => void run(() => query.refetch())} disabled={busy}>
          Refetch
        </button>
        <button
          type="button"
          onClick={() =>
            void run(() =>
              client.invalidateQueries(['product', id], { exact: true, awaitRefetch: true }),
            )
          }
          disabled={busy}
        >
          Invalidate this product
        </button>
        <button
          type="button"
          onClick={() => previousId && onSelect(previousId)}
          disabled={!previousId}
        >
          ← Previous key
        </button>
        <button type="button" onClick={() => nextId && onSelect(nextId)} disabled={!nextId}>
          Next key →
        </button>
      </div>
      <p className="hint">
        Revisiting a product you already opened renders from cache. A key you have not opened yet
        shows a loading state and no data from the previous key.
      </p>
    </section>
  );
}

function ErrorPanel({
  message,
  onRetry,
  busy,
}: {
  message: string;
  onRetry: () => void;
  busy: boolean;
}) {
  return (
    <div className="error" role="alert">
      <strong>Request failed</strong>
      <p>{message}</p>
      <button type="button" onClick={onRetry} disabled={busy}>
        Retry
      </button>
    </div>
  );
}

function DiagnosticsPanel() {
  const client = useCacheClient();
  const [stats, setStats] = useState(() => client.getStats());
  const [events, setEvents] = useState<Array<{ type: string; reason?: string }>>([]);

  useEffect(() => {
    setStats(client.getStats());
    return client.subscribe((event) => {
      setStats(client.getStats());
      if (!event.type.startsWith('prefetch:')) return;
      const entry = { type: event.type, ...(event.reason ? { reason: event.reason } : {}) };
      setEvents((previous) => [entry, ...previous].slice(0, 6));
    });
  }, [client]);

  const rate =
    stats.prefetchConsumed + stats.prefetchWasted === 0
      ? '—'
      : `${Math.round(stats.prefetchConsumptionRate * 100)}%`;

  return (
    <section className="diagnostics" aria-label="Cache diagnostics">
      <div className="card-header">
        <div>
          <h2>Diagnostics</h2>
          <p className="hint">
            Prefetch effectiveness uses produced cache commits as its denominator; the rate excludes
            pending work. Counters only: no keys, payloads or scope values.
          </p>
        </div>
      </div>
      <dl className="metrics">
        <div>
          <dt>Produced</dt>
          <dd data-testid="diag-produced">{stats.prefetchProduced}</dd>
        </div>
        <div>
          <dt>Consumed</dt>
          <dd data-testid="diag-consumed">{stats.prefetchConsumed}</dd>
        </div>
        <div>
          <dt>Wasted</dt>
          <dd data-testid="diag-wasted">{stats.prefetchWasted}</dd>
        </div>
        <div>
          <dt>Pending</dt>
          <dd data-testid="diag-pending">{stats.prefetchPending}</dd>
        </div>
        <div>
          <dt>Consumption rate</dt>
          <dd data-testid="diag-rate">{rate}</dd>
        </div>
        <div>
          <dt>Cache hits / misses</dt>
          <dd>
            {stats.hits} / {stats.misses}
          </dd>
        </div>
      </dl>
      <ol className="event-log" data-testid="diag-events" aria-label="Recent prefetch events">
        {events.length === 0 ? (
          <li className="hint">No prefetch events yet.</li>
        ) : (
          events.map((event, index) => (
            <li key={`${event.type}-${index}`}>
              <code>{event.type}</code>
              {event.reason ? <span> · {event.reason}</span> : null}
            </li>
          ))
        )}
      </ol>
    </section>
  );
}

function StatsPanel() {
  const client = useCacheClient();
  const [stats, setStats] = useState(() => client.getStats());
  const requests = useSyncExternalStore(
    api.subscribeToRequestCount,
    api.getRequestCount,
    api.getRequestCount,
  );

  useEffect(() => {
    setStats(client.getStats());
    return client.subscribe(() => setStats(client.getStats()));
  }, [client]);

  const scope = client.getAuthScope();

  return (
    <footer className="stats" aria-label="Cache statistics">
      <div>
        <span className="stat-label">API requests</span>
        <strong data-testid="stat-requests">{requests}</strong>
      </div>
      <div>
        <span className="stat-label">Cache hits</span>
        <strong data-testid="stat-hits">{stats.hits}</strong>
      </div>
      <div>
        <span className="stat-label">Network fetches</span>
        <strong>{stats.fetchesStarted}</strong>
      </div>
      <div>
        <span className="stat-label">Prefetched</span>
        <strong data-testid="stat-prefetch">{stats.prefetchFulfilled}</strong>
      </div>
      <div>
        <span className="stat-label">Deduped joins</span>
        <strong>{stats.dedupeJoins}</strong>
      </div>
      <div>
        <span className="stat-label">Entries</span>
        <strong>{stats.size}</strong>
      </div>
      <div>
        <span className="stat-label">Scope</span>
        <strong data-testid="stat-scope">{scope.scopeTag}</strong>
      </div>
    </footer>
  );
}

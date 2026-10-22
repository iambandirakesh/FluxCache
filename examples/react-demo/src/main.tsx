import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createFluxCache } from 'flux-cache';
import { FluxCacheProvider } from 'flux-cache/react';
import { App } from './App';
import { setAccount } from './api';
import './styles.css';

// `staleTime` keeps navigation instant; `retry: 0` keeps the failure demo quick.
const client = createFluxCache({ staleTime: 30_000, gcTime: 5 * 60_000, retry: 0 });

// Start signed in as alice, with credentials already available to the mock API.
setAccount('alice');
client.setAuthScope('alice');

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing #root element');

createRoot(rootElement).render(
  <StrictMode>
    <FluxCacheProvider client={client}>
      <App />
    </FluxCacheProvider>
  </StrictMode>,
);

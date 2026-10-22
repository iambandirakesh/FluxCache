# FluxCache example — cached product catalog

A small Vite + React app that consumes the published-style package through
`flux-cache` and `flux-cache/react` only. It never imports `src/` from the SDK.

The API is an in-memory mock with a fixed 320 ms delay, so everything works
offline and deterministically:

- Alice sees four products, Bob sees three different products.
- A "fail next request" switch makes exactly the next request throw a 500.
- A request counter proves when the network was actually used.

## Setup

Node 20.19+ or 22.12+ is recommended (Vite prints a warning on older Node
versions, though the production build still works here on Node 22.4).

From the repository root:

```bash
pnpm install     # installs the workspace, including this example
pnpm build       # builds flux-cache (dist/) — the example imports the package entry points
```

## Run

```bash
pnpm example:dev
```

Then open <http://localhost:5173>.

Equivalent commands from this folder:

```bash
pnpm dev
pnpm typecheck
pnpm build
pnpm preview
```

## What to try

| Scenario          | Steps                                         | What it shows                                                                                           |
| ----------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Loading → success | Open the app                                  | The catalog renders a loading state, then products; the footer shows one API request                    |
| Cache reuse       | Open a product, go back, open it again        | Instant render, no new request while `staleTime` (30 s) is valid                                        |
| Manual refetch    | Press **Refetch**                             | One new request; data updates without a loading state                                                   |
| Invalidation      | Press **Rename first product**                | The mock mutation runs, then the catalog and product keys are invalidated and refetched                 |
| Error state       | Press **Fail next load**                      | The entry is removed and reloaded; the request fails and an error panel offers **Retry**                |
| Key change        | On a product, use **Next key / Previous key** | A new query key starts loading with no data from the previous key; returning to a cached key is instant |
| Scope switch      | Switch from `alice` to `bob`                  | Cached data is discarded, the notice explains the new scope, and nothing from Alice is displayed        |
| Explicit reload   | Press **Load data for this account**          | New requests run under Bob's scope; the scope tag in the footer changes                                 |

The footer shows API requests, cache hits, network fetches, deduplicated joins,
entry count and the opaque scope tag.

## Public API used

| Feature             | API                                                                        |
| ------------------- | -------------------------------------------------------------------------- |
| Provider            | `FluxCacheProvider` from `flux-cache/react`                                |
| Fetching            | `useQuery({ queryKey, queryFn, retry })`                                   |
| Refetch             | `query.refetch()`                                                          |
| Invalidation        | `client.invalidateQueries(keys, { awaitRefetch })`, `client.removeQueries` |
| Scope switch        | `client.setAuthScope(account)`                                             |
| Reload after switch | `client.refetchQueries(() => true, { awaitSettled })`                      |
| Diagnostics         | `client.getStats()`, `client.getAuthScope()`, `client.subscribe()`         |

## Why the package resolves to `dist`

`flux-cache` is linked through the pnpm workspace. Its `exports` map points at
`dist/`, so the example exercises the real ESM build, declarations and React
entry point (`'use client'` included) rather than TypeScript sources. Run
`pnpm build` at the repository root after changing the SDK; Vite's dev server
picks up the rebuilt files.

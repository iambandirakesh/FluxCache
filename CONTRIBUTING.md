# Contributing to FluxCache

## Setup

Use Node 22.12 or newer (`.nvmrc` is provided):

```bash
nvm use
pnpm install
pnpm typecheck
pnpm test
```

Browser tests for the example run against a production build:

```bash
pnpm exec playwright install chromium
pnpm test:e2e
```

## Workflow

1. Add or update a failing test first. Behavior changes are not accepted
   without a test that pins the new behavior.
2. Keep the core (`src/core`) free of React and browser globals at module scope.
3. Run `pnpm verify` before opening a pull request.

## Testing rules

- No real network calls. Use deferred promises and fake timers.
- Never assert wall-clock performance in the unit suite; assertions on request
  counts and state transitions are preferred.
- Race-condition tests must control resolution order explicitly.

## Releasing

Releasing is a manual, reviewed step. Do not publish from a branch build. See
[RELEASING.md](RELEASING.md) for the complete gate, package-content checks,
version/changelog steps, metadata requirements and publication/rollback
procedure.

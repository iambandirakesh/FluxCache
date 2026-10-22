# Contributing to FluxCache

## Setup

```bash
pnpm install
pnpm typecheck
pnpm test
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

Releasing is a manual, reviewed step. Do not publish from a branch build.

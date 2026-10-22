# FluxCache benchmarks

This harness measures core cache, query, mutation, observer and prefetch
operations. It is descriptive: it reports timings, not pass/fail performance
thresholds. CI checks only that the harness completes and emits well-formed
samples.

## Run

Build the package first, then run the harness:

```bash
pnpm bench
```

`pnpm bench` builds `dist/` and prints a human-readable table plus environment
metadata. To capture JSON:

```bash
pnpm bench -- --json
pnpm bench -- --json --out bench/results/local.json
```

The generated `bench/results/` directory is ignored by Git.

Useful options:

| Option           | Default | Meaning                                   |
| ---------------- | ------- | ----------------------------------------- |
| `--iterations N` | 2000    | Operations in each measured sample        |
| `--warmup N`     | 200     | Warm-up operations before measuring       |
| `--samples N`    | 7       | Number of measured samples per scenario   |
| `--json`         | off     | Print the full JSON report to stdout      |
| `--out PATH`     | none    | Write the JSON report to a path           |
| `--check`        | off     | Validate completion and sample shape only |

CI runs:

```bash
pnpm bench:ci
```

That command uses 500 iterations, 50 warm-up operations and 3 samples, writes
`bench/results/ci.json`, and checks the report shape. It does not compare
latency against any threshold, and a slow machine still passes.

## Method

For every scenario:

1. Create a fresh client/context.
2. Run `--warmup` operations without recording.
3. For each sample, create a fresh context and run exactly `--iterations`
   operations, timing the whole loop.
4. Report the median and p95 of the per-sample durations using nearest-rank
   percentiles, plus nanoseconds per operation.

Scenarios:

| Scenario                 | What it measures                                           |
| ------------------------ | ---------------------------------------------------------- |
| `cache-read`             | Synchronous `getQueryData` on a seeded entry               |
| `cache-write`            | `setQueryData` with stale/GC timers disabled               |
| `query-cache-hit`        | A `fetchQuery` fresh-cache outcome, including its promise  |
| `mutation-fulfilled`     | `MutationRunner.mutateAsync` through success and callbacks |
| `observer-mount-unmount` | Attaching and detaching a `QueryObserver` on cached data   |
| `prefetch-batch`         | Scheduling and settling batches of prefetch jobs           |

Timers are effectively disabled in the synchronous scenarios (`staleTime` and
`gcTime` are `Infinity`), so the numbers describe cache bookkeeping rather than
network or timer behavior.

## JSON report

```json
{
  "schemaVersion": 1,
  "environment": {
    "node": "v22.12.0",
    "platform": "darwin",
    "arch": "arm64",
    "osRelease": "24.x",
    "cpuModel": "Apple M1 Pro",
    "cpuCount": 8,
    "packageVersion": "0.1.0",
    "gitCommit": "abc123",
    "generatedAt": "2026-...",
    "iterations": 2000,
    "warmup": 200,
    "samples": 7
  },
  "scenarios": [
    {
      "name": "cache-read",
      "iterations": 2000,
      "samples": [{ "durationMs": 0.5, "nsPerOp": 250 }],
      "medianMs": 0.5,
      "p95Ms": 0.7,
      "medianNsPerOp": 250,
      "p95NsPerOp": 350
    }
  ]
}
```

The report contains no keys, payloads, credentials or scope values.

## Reproducibility rules

- Compare runs on the same machine, Node version, package version and CPU
  governor state. Record the metadata block with every result.
- Keep the same `iterations`, `warmup` and `samples` values across comparisons.
- Do not run other CPU-heavy work during a measurement.
- Treat differences smaller than the p95 spread as noise.
- Do not add latency assertions to CI. The repository accepts a benchmark only
  as a reproducible measurement, never as a release gate.

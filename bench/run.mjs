#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, arch, release } from 'node:os';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createFluxCache, MutationRunner, QueryObserver } from '../dist/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DEFAULT_ITERATIONS = 2000;
const DEFAULT_WARMUP = 200;
const DEFAULT_SAMPLES = 7;

function parseArgs(argv) {
  const options = {
    iterations: DEFAULT_ITERATIONS,
    warmup: DEFAULT_WARMUP,
    samples: DEFAULT_SAMPLES,
    json: false,
    check: false,
    out: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--out') {
      index += 1;
      options.out = argv[index] ?? null;
    } else if (arg === '--iterations' || arg === '--warmup' || arg === '--samples') {
      index += 1;
      const value = Number(argv[index]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${arg} requires a non-negative integer`);
      }
      options[arg.slice(2)] = value;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.iterations < 1) throw new Error('--iterations must be at least 1');
  if (options.samples < 1) throw new Error('--samples must be at least 1');
  return options;
}

function printHelp() {
  console.log(`Usage: node bench/run.mjs [options]

  --iterations N   Operations per measured sample (default ${DEFAULT_ITERATIONS})
  --warmup N       Warm-up operations before samples (default ${DEFAULT_WARMUP})
  --samples N      Measured samples per scenario (default ${DEFAULT_SAMPLES})
  --json           Print the complete JSON report to stdout
  --out PATH       Write the JSON report to PATH
  --check          Validate harness completion only; no latency thresholds
`);
}

function isThenable(value) {
  return value !== null && typeof value === 'object' && typeof value.then === 'function';
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function environment(options) {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  const cpuList = cpus();
  return {
    node: process.version,
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    cpuModel: cpuList[0]?.model ?? 'unknown',
    cpuCount: cpuList.length,
    packageVersion: pkg.version,
    gitCommit: gitCommit(),
    generatedAt: new Date().toISOString(),
    iterations: options.iterations,
    warmup: options.warmup,
    samples: options.samples,
  };
}

function queryKey(name, sample, index) {
  return ['bench', name, sample, index];
}

function createScenarios() {
  return [
    {
      name: 'cache-read',
      setup() {
        const client = createFluxCache({ staleTime: Infinity, gcTime: Infinity });
        client.setQueryData(['bench', 'read'], 1);
        return { client };
      },
      run({ client }) {
        client.getQueryData(['bench', 'read']);
      },
    },
    {
      name: 'cache-write',
      setup() {
        const client = createFluxCache({ staleTime: Infinity, gcTime: Infinity });
        return { client };
      },
      run({ client }, index) {
        client.setQueryData(['bench', 'write'], index);
      },
    },
    {
      name: 'query-cache-hit',
      setup() {
        const client = createFluxCache({ staleTime: Infinity, gcTime: Infinity });
        client.setQueryData(['bench', 'hit'], 1);
        return { client };
      },
      async run({ client }) {
        await client.fetchQuery(['bench', 'hit'], async () => 2);
      },
    },
    {
      name: 'mutation-fulfilled',
      setup() {
        const client = createFluxCache({ staleTime: Infinity, gcTime: Infinity });
        const runner = new MutationRunner(client, {
          mutationFn: async (values) => values,
        });
        return { runner };
      },
      async run({ runner }, index) {
        await runner.mutateAsync(index);
      },
    },
    {
      name: 'observer-mount-unmount',
      setup() {
        const client = createFluxCache({ staleTime: Infinity, gcTime: Infinity });
        client.setQueryData(['bench', 'observe'], 1);
        return { client };
      },
      run({ client }) {
        const observer = new QueryObserver(client, {
          queryKey: ['bench', 'observe'],
          queryFn: async () => 2,
        });
        observer.mount();
        observer.unmount();
      },
    },
    {
      name: 'prefetch-batch',
      setup(sample) {
        const client = createFluxCache({
          staleTime: Infinity,
          gcTime: Infinity,
          maxEntries: 100_000,
          prefetch: { concurrency: 4, queueLimit: 100_000 },
        });
        return { client, sample, pending: [] };
      },
      run(context, index) {
        context.pending.push(
          context.client.prefetchQuery(
            queryKey('prefetch', context.sample, index),
            async () => index,
          ),
        );
        if (context.pending.length < 16) return undefined;
        const batch = context.pending;
        context.pending = [];
        return Promise.all(batch);
      },
      async finish(context) {
        if (context.pending.length > 0) await Promise.all(context.pending);
      },
    },
  ];
}

async function measureScenario(scenario, options) {
  const warmupContext = await scenario.setup(0);
  for (let index = 0; index < options.warmup; index += 1) {
    const result = scenario.run(warmupContext, index);
    if (isThenable(result)) await result;
  }
  if (scenario.finish) await scenario.finish(warmupContext);
  scenario.dispose?.(warmupContext);

  const samples = [];
  for (let sample = 0; sample < options.samples; sample += 1) {
    const context = await scenario.setup(sample + 1);
    const started = performance.now();
    for (let index = 0; index < options.iterations; index += 1) {
      const result = scenario.run(context, index);
      if (isThenable(result)) await result;
    }
    if (scenario.finish) await scenario.finish(context);
    const durationMs = performance.now() - started;
    samples.push({
      durationMs,
      nsPerOp: (durationMs * 1_000_000) / options.iterations,
    });
    scenario.dispose?.(context);
  }

  const durations = samples.map((sample) => sample.durationMs).sort((left, right) => left - right);
  const medianMs = percentile(durations, 0.5);
  const p95Ms = percentile(durations, 0.95);
  return {
    name: scenario.name,
    iterations: options.iterations,
    samples,
    medianMs,
    p95Ms,
    medianNsPerOp: (medianMs * 1_000_000) / options.iterations,
    p95NsPerOp: (p95Ms * 1_000_000) / options.iterations,
  };
}

function validate(report, options) {
  const errors = [];
  if (!report.environment || report.environment.node !== process.version) {
    errors.push('environment metadata is missing or inconsistent');
  }
  if (!Array.isArray(report.scenarios) || report.scenarios.length === 0) {
    errors.push('no scenarios were measured');
    return errors;
  }
  for (const scenario of report.scenarios) {
    if (scenario.iterations !== options.iterations) {
      errors.push(`${scenario.name}: wrong iteration count`);
    }
    if (!Array.isArray(scenario.samples) || scenario.samples.length !== options.samples) {
      errors.push(`${scenario.name}: wrong sample count`);
      continue;
    }
    for (const sample of scenario.samples) {
      if (!Number.isFinite(sample.durationMs) || sample.durationMs <= 0) {
        errors.push(`${scenario.name}: non-finite sample duration`);
      }
      if (!Number.isFinite(sample.nsPerOp) || sample.nsPerOp <= 0) {
        errors.push(`${scenario.name}: non-finite ns/op`);
      }
    }
    if (!Number.isFinite(scenario.medianMs) || scenario.medianMs < 0) {
      errors.push(`${scenario.name}: invalid median`);
    }
    if (!Number.isFinite(scenario.p95Ms) || scenario.p95Ms < 0) {
      errors.push(`${scenario.name}: invalid p95`);
    }
  }
  return errors;
}

function humanReport(report) {
  const rows = report.scenarios.map((scenario) => [
    scenario.name,
    scenario.medianMs.toFixed(3),
    scenario.p95Ms.toFixed(3),
    scenario.medianNsPerOp.toFixed(1),
  ]);
  const widths = [28, 12, 12, 14];
  const header = ['scenario', 'median ms', 'p95 ms', 'median ns/op'];
  const line = (cells) =>
    cells.map((cell, index) => String(cell).padEnd(widths[index] ?? 12)).join('  ');
  console.log('FluxCache benchmark (descriptive only; no thresholds)');
  console.log(
    `Node ${report.environment.node} · ${report.environment.platform}/${report.environment.arch} · ${report.environment.cpuModel} · ${report.environment.cpuCount} CPUs`,
  );
  console.log(
    `package ${report.environment.packageVersion} · commit ${report.environment.gitCommit ?? 'unknown'} · ${report.environment.iterations} iterations/sample · ${report.environment.warmup} warm-up · ${report.environment.samples} samples`,
  );
  console.log('');
  console.log(line(header));
  console.log(line(widths.map((width) => '-'.repeat(width))));
  for (const row of rows) console.log(line(row));
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`benchmark: ${error.message}`);
    console.error('Run with --help for usage.');
    process.exitCode = 1;
    return;
  }

  const scenarios = createScenarios();
  const results = [];
  for (const scenario of scenarios) {
    results.push(await measureScenario(scenario, options));
  }
  const report = {
    schemaVersion: 1,
    environment: environment(options),
    scenarios: results,
  };

  const errors = validate(report, options);
  if (options.out) {
    const outputPath = resolve(ROOT, options.out);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else humanReport(report);

  if (errors.length > 0) {
    for (const error of errors) console.error(`benchmark check: ${error}`);
    process.exitCode = 1;
    return;
  }
  if (options.check) {
    console.error('Benchmark harness completed and produced well-formed samples.');
  }
}

await main();

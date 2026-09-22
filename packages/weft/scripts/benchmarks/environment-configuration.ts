import type { Environment } from '@lostgradient/environmentalist';
import { environmentalist } from '@lostgradient/environmentalist';
import { z } from 'zod';

const schema = z.object({
  codexCi: z
    .string()
    .optional()
    .transform((value) => value === '1')
    .meta({ env: 'CODEX_CI' }),
  githubActions: z
    .string()
    .optional()
    .transform((value) => value === 'true')
    .meta({ env: 'GITHUB_ACTIONS' }),
  ci: z
    .string()
    .optional()
    .transform((value) => Boolean(value))
    .meta({ env: 'CI' }),
  sqliteArchitectureBenchmark: z
    .string()
    .optional()
    .transform((value) => value === '1')
    .meta({ env: 'WEFT_SQLITE_ARCHITECTURE_BENCHMARK' }),
  searchAttributesArchitectureBenchmark: z
    .string()
    .optional()
    .transform((value) => value === '1')
    .meta({ env: 'WEFT_SEARCH_ATTRIBUTES_ARCHITECTURE_BENCHMARK' }),
  eventDispatchArchitectureBenchmark: z
    .string()
    .optional()
    .transform((value) => value === '1')
    .meta({ env: 'WEFT_EVENT_DISPATCH_ARCHITECTURE_BENCHMARK' }),
  speculationBenchLatencyMs: z
    .string()
    .optional()
    .transform((value) => Number(value ?? 5))
    .meta({ env: 'WEFT_SPECULATION_BENCH_LATENCY_MS' }),
  coverageMode: z
    .string()
    .optional()
    .transform((value) => value === '1')
    .meta({ env: 'WEFT_COVERAGE_MODE' }),
  nodeV8Coverage: z.string().optional().meta({ env: 'NODE_V8_COVERAGE' }),
});

export type BenchmarkEnvironment = Environment<typeof schema>;

/** Resolve benchmark switches and conversions at their original read boundary. */
export function resolveBenchmarkEnvironment(): BenchmarkEnvironment {
  const env: Record<string, string> = {};
  for (const name of [
    'CODEX_CI',
    'GITHUB_ACTIONS',
    'CI',
    'WEFT_SQLITE_ARCHITECTURE_BENCHMARK',
    'WEFT_SEARCH_ATTRIBUTES_ARCHITECTURE_BENCHMARK',
    'WEFT_EVENT_DISPATCH_ARCHITECTURE_BENCHMARK',
    'WEFT_SPECULATION_BENCH_LATENCY_MS',
    'WEFT_COVERAGE_MODE',
    'NODE_V8_COVERAGE',
  ]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return environmentalist.sync({
    name: 'weft-benchmarks',
    schema,
    env,
    sources: ['env', 'defaults'],
    argv: [],
    coerce: false,
  });
}

/** Forward only the existing allowlisted subprocess environment without converting values. */
export function createBenchmarkSubprocessEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of [
    'HOME',
    'NODE_V8_COVERAGE',
    'TEMP',
    'TMP',
    'TMPDIR',
    'USERPROFILE',
    'WEFT_COVERAGE_MODE',
  ]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

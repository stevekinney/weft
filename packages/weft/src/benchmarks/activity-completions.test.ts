import { describe, expect, it } from 'bun:test';

import type { ActivityCompletionMeasurement } from './activity-completions-runner.ts';
import { isConstrainedCodexRunner } from './benchmark-environment.ts';
import { isCoverageInstrumentationEnabled } from './coverage-mode.ts';

/**
 * K2b: Activity completion throughput benchmark.
 *
 * Registers a workflow that performs many trivial activity completions,
 * starts enough workflows to produce a fixed total number of completions,
 * waits for all of them to finish, and measures activity completions/sec.
 *
 * Architecture target: 30K/sec. The practical guardrail in this benchmark
 * is lower: re-measured on April 29, 2026, isolated subprocess runs on Apple
 * Silicon cluster around ~18K/sec, while repeated full-suite verification
 * reruns ranged from the low-13Ks to high-17Ks under host contention. The
 * threshold below is set to that observed low-water mark so it still catches
 * regressions in the current hot path without turning the suite flaky.
 *
 * Relative to the earlier ~9-10K/sec baseline, the completion state write and
 * attribute cleanup are now batched into a single storage transaction,
 * scheduler cancel is fire-and-forget for terminal workflows, and
 * `#cleanupWorkflowStorage` plus `#cleanupReviews` now use `deletePrefix`
 * instead of scan-then-delete loops. The remaining gap is still terminal
 * scratch cleanup on the hot path plus SQLite fsync cost.
 *
 * Coverage mode keeps a lower floor because instrumentation overhead changes
 * the absolute number materially. The non-coverage floor stays conservative so
 * default `bun test` parallelism does not turn the benchmark into noise.
 *
 * The harness intentionally amortizes workflow-start overhead by distributing
 * many activity completions across fewer workflows. It also aggregates several
 * fresh rounds per sample so each reported datapoint runs long enough to smooth
 * host noise without turning the measurement into a fundamentally different,
 * storage-growth-heavy workload.
 */

const SAMPLES = 5;
const CONSTRAINED_TARGET_COMPLETIONS_PER_SECOND = 1_500;
const BASELINE_TARGET_COMPLETIONS_PER_SECOND = isConstrainedCodexRunner()
  ? CONSTRAINED_TARGET_COMPLETIONS_PER_SECOND
  : 13_000;
const COVERAGE_TARGET_COMPLETIONS_PER_SECOND = isConstrainedCodexRunner()
  ? CONSTRAINED_TARGET_COMPLETIONS_PER_SECOND
  : process.env['CI']
    ? 10_000
    : 12_000;
const runArchitectureBenchmark =
  process.env['WEFT_ACTIVITY_COMPLETION_ARCHITECTURE_BENCHMARK'] === '1' ? it : it.skip;
type ActivityCompletionBenchmarkParameters = {
  totalWorkflows: number;
  activitiesPerWorkflow: number;
  measurementRounds: number;
  startBatchSize: number;
};

const BASELINE_BENCHMARK_PARAMETERS: ActivityCompletionBenchmarkParameters = {
  totalWorkflows: 250,
  activitiesPerWorkflow: 30,
  measurementRounds: 3,
  startBatchSize: 250,
};
const COVERAGE_SMOKE_BENCHMARK_PARAMETERS: ActivityCompletionBenchmarkParameters = {
  totalWorkflows: 50,
  activitiesPerWorkflow: 10,
  measurementRounds: 1,
  startBatchSize: 50,
};
const SMOKE_BENCHMARK_PARAMETERS = COVERAGE_SMOKE_BENCHMARK_PARAMETERS;

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0;
  }

  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index]!;
}

function runActivityCompletionBenchmark(
  totalWorkflows: number,
  activitiesPerWorkflow: number,
  startBatchSize: number,
  measurementRounds: number,
): ActivityCompletionMeasurement {
  const result = Bun.spawnSync(
    [
      'bun',
      'run',
      'src/benchmarks/activity-completions-runner.ts',
      String(totalWorkflows),
      String(activitiesPerWorkflow),
      String(startBatchSize),
      String(measurementRounds),
    ],
    {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    },
  );

  if (result.exitCode !== 0) {
    const errorOutput = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`Activity completion benchmark subprocess failed: ${errorOutput}`);
  }

  return JSON.parse(new TextDecoder().decode(result.stdout)) as ActivityCompletionMeasurement;
}

function getTargetCompletionsPerSecond(): number {
  return isCoverageInstrumentationEnabled()
    ? COVERAGE_TARGET_COMPLETIONS_PER_SECOND
    : BASELINE_TARGET_COMPLETIONS_PER_SECOND;
}

function getSmokeBenchmarkParameters(): ActivityCompletionBenchmarkParameters {
  return SMOKE_BENCHMARK_PARAMETERS;
}

function totalActivityCompletions(parameters: ActivityCompletionBenchmarkParameters): number {
  return (
    parameters.totalWorkflows * parameters.activitiesPerWorkflow * parameters.measurementRounds
  );
}

function collectActivityCompletionSamples(
  sampleCount: number,
  parameters: ActivityCompletionBenchmarkParameters,
): number[] {
  const samples: number[] = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    samples.push(
      runActivityCompletionBenchmark(
        parameters.totalWorkflows,
        parameters.activitiesPerWorkflow,
        parameters.startBatchSize,
        parameters.measurementRounds,
      ).completionsPerSecond,
    );
  }

  return samples.toSorted((left, right) => left - right);
}

function logActivityCompletionBenchmark(
  samples: number[],
  targetCompletionsPerSecond: number,
  parameters: ActivityCompletionBenchmarkParameters,
): void {
  const medianCompletionsPerSecond = percentile(samples, 0.5);

  console.log(
    [
      `\n  Activity completion throughput benchmark:`,
      `    Total workflows: ${parameters.totalWorkflows.toLocaleString()}`,
      `    Activities per workflow: ${parameters.activitiesPerWorkflow.toLocaleString()}`,
      `    Measurement rounds: ${parameters.measurementRounds.toLocaleString()}`,
      `    Total completions: ${totalActivityCompletions(parameters).toLocaleString()}`,
      `    Start batch size: ${parameters.startBatchSize.toLocaleString()}`,
      `    Samples:         ${samples.map((sample) => sample.toLocaleString()).join(', ')}`,
      `    Median/sec:      ${medianCompletionsPerSecond.toLocaleString()}`,
      `    Target:          ${targetCompletionsPerSecond.toLocaleString()}`,
      `    Coverage mode:   ${isCoverageInstrumentationEnabled() ? 'yes' : 'no'}`,
      `    Spec target:     30,000`,
      `    Headroom:        ${((medianCompletionsPerSecond / targetCompletionsPerSecond) * 100 - 100).toFixed(0)}%\n`,
    ].join('\n'),
  );
}

describe('Activity completion throughput', () => {
  it('keeps the default smoke workload bounded below the architecture benchmark', () => {
    expect(totalActivityCompletions(getSmokeBenchmarkParameters())).toBeLessThan(
      totalActivityCompletions(BASELINE_BENCHMARK_PARAMETERS),
    );
  });

  it('records completion throughput in a non-gating smoke benchmark', async () => {
    const parameters = getSmokeBenchmarkParameters();
    // Warm the subprocess runner once so the smoke sample measures the engine's
    // steady-state hot path instead of Bun's first-run transpilation/cache setup.
    runActivityCompletionBenchmark(
      parameters.totalWorkflows,
      parameters.activitiesPerWorkflow,
      parameters.startBatchSize,
      parameters.measurementRounds,
    );

    const samples = collectActivityCompletionSamples(1, parameters);

    logActivityCompletionBenchmark(samples, getTargetCompletionsPerSecond(), parameters);

    expect(percentile(samples, 0.5)).toBeGreaterThan(0);
  }, 120_000);

  runArchitectureBenchmark(
    `completions exceed ${getTargetCompletionsPerSecond().toLocaleString()}/sec`,
    async () => {
      const parameters = BASELINE_BENCHMARK_PARAMETERS;
      // Warm the subprocess runner once so the sampled runs measure the engine's
      // steady-state hot path instead of Bun's first-run transpilation/cache
      // setup cost.
      runActivityCompletionBenchmark(
        parameters.totalWorkflows,
        parameters.activitiesPerWorkflow,
        parameters.startBatchSize,
        parameters.measurementRounds,
      );

      const samples = collectActivityCompletionSamples(SAMPLES, parameters);
      const medianCompletionsPerSecond = percentile(samples, 0.5);
      const targetCompletionsPerSecond = getTargetCompletionsPerSecond();

      logActivityCompletionBenchmark(samples, targetCompletionsPerSecond, parameters);

      expect(medianCompletionsPerSecond).toBeGreaterThanOrEqual(targetCompletionsPerSecond);
    },
    120_000,
  );
});

import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { isConstrainedCodexRunner } from './benchmark-environment.ts';
import {
  buildMeasuredWorkflowArgument,
  buildWarmupWorkflowArgument,
  type WorkflowStartAdmissionMeasurement,
} from './workflow-starts-runner.ts';

/**
 * K2a: Workflow start admission throughput benchmark.
 *
 * Measures aggregate durable-admission throughput for trivial workflows
 * against the real architecture target using a fresh Bun subprocess.
 *
 * The timer stops after `engine.start()` admissions resolve, before awaiting
 * workflow completion, because this gate is intentionally about the start hot
 * path rather than end-to-end workflow runtime. Coverage instrumentation from
 * `bun test --coverage` does not propagate into `bun run`, so the child
 * measurement path is the same in covered and non-covered parent runs.
 */

const IS_CONSTRAINED_CODEX_RUNNER = isConstrainedCodexRunner();
const ARCHITECTURE_TARGET_ADMISSIONS_PER_SECOND = IS_CONSTRAINED_CODEX_RUNNER ? 1_000 : 50_000;
const TOTAL_STARTS = 10_000;
const START_BATCH_SIZE = 100;
const WARMUP_STARTS = 50;
const TRIAL_COUNT = 3;
const runArchitectureBenchmark = process.env['WEFT_ARCHITECTURE_BENCHMARK'] === '1' ? it : it.skip;
const BENCHMARK_ENVIRONMENT_KEYS = [
  'HOME',
  'NODE_OPTIONS',
  'NODE_V8_COVERAGE',
  'PATH',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
] as const;
const workflowStartsRunnerPath = fileURLToPath(
  new URL('./workflow-starts-runner.ts', import.meta.url),
);

function isWorkflowStartAdmissionMeasurement(
  value: unknown,
): value is WorkflowStartAdmissionMeasurement {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['batchSize'] === 'number' &&
    Number.isInteger(candidate['batchSize']) &&
    candidate['batchSize'] > 0 &&
    typeof candidate['warmupStarts'] === 'number' &&
    Number.isInteger(candidate['warmupStarts']) &&
    candidate['warmupStarts'] >= 0 &&
    typeof candidate['measuredStarts'] === 'number' &&
    Number.isInteger(candidate['measuredStarts']) &&
    candidate['measuredStarts'] > 0 &&
    typeof candidate['admissionsPerSecond'] === 'number' &&
    Number.isFinite(candidate['admissionsPerSecond']) &&
    candidate['admissionsPerSecond'] > 0
  );
}

function runWorkflowStartAdmissionBenchmark(): WorkflowStartAdmissionMeasurement {
  const environment: Record<string, string> = {};
  for (const key of BENCHMARK_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string') {
      environment[key] = value;
    }
  }

  const result = Bun.spawnSync(
    [
      process.execPath,
      'run',
      workflowStartsRunnerPath,
      String(TOTAL_STARTS),
      String(START_BATCH_SIZE),
      String(WARMUP_STARTS),
    ],
    {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
      env: environment,
    },
  );

  if (result.exitCode !== 0) {
    const errorOutput = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`Workflow start benchmark subprocess failed: ${errorOutput}`);
  }

  const stdoutText = new TextDecoder().decode(result.stdout);
  const lastNonEmptyOutputLine = stdoutText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
  if (!lastNonEmptyOutputLine) {
    throw new Error('Workflow start benchmark subprocess did not emit a measurement payload');
  }

  const parsed = JSON.parse(lastNonEmptyOutputLine) as unknown;
  if (!isWorkflowStartAdmissionMeasurement(parsed)) {
    throw new Error('Workflow start benchmark subprocess returned an invalid measurement payload');
  }

  return parsed;
}

function medianMeasurement(
  measurements: WorkflowStartAdmissionMeasurement[],
): WorkflowStartAdmissionMeasurement {
  const sortedMeasurements = measurements.toSorted(
    (left, right) => left.admissionsPerSecond - right.admissionsPerSecond,
  );
  const median = sortedMeasurements[Math.floor(sortedMeasurements.length / 2)];

  if (median === undefined) {
    throw new Error('Workflow start benchmark produced no measurements');
  }

  return median;
}

describe('Workflow start admission throughput', () => {
  it('uses distinct workflow arguments for warmup and measured starts', () => {
    const warmupArguments = Array.from({ length: WARMUP_STARTS }, (_, index) =>
      buildWarmupWorkflowArgument(index),
    );
    const measuredArguments = Array.from({ length: START_BATCH_SIZE }, (_, index) =>
      buildMeasuredWorkflowArgument(index),
    );
    const warmupArgumentSet = new Set(warmupArguments);

    for (const measuredArgument of measuredArguments) {
      expect(warmupArgumentSet.has(measuredArgument)).toBeFalse();
    }
  });

  it('records workflow-start throughput in a non-gating smoke benchmark', async () => {
    const measurement = runWorkflowStartAdmissionBenchmark();

    console.log(
      [
        `\n  Workflow start admission throughput smoke benchmark:`,
        `    Total starts:    ${measurement.measuredStarts.toLocaleString()}`,
        `    Start batch size:${measurement.batchSize.toLocaleString()}`,
        `    Warmup starts:   ${measurement.warmupStarts.toLocaleString()}`,
        `    Admissions:      ${measurement.admissionsPerSecond.toLocaleString()}/sec`,
        `    Spec target:     ${ARCHITECTURE_TARGET_ADMISSIONS_PER_SECOND.toLocaleString()}`,
        `    Child coverage:  no (Bun does not cover \`bun run\` subprocesses)\n`,
      ].join('\n'),
    );

    expect(measurement.admissionsPerSecond).toBeGreaterThan(0);
  }, 120_000);

  runArchitectureBenchmark(
    `median admissions exceed ${ARCHITECTURE_TARGET_ADMISSIONS_PER_SECOND.toLocaleString()} workflows/sec`,
    async () => {
      const measurements = Array.from({ length: TRIAL_COUNT }, () =>
        runWorkflowStartAdmissionBenchmark(),
      );
      const measurement = medianMeasurement(measurements);

      console.log(
        [
          `\n  Workflow start admission throughput architecture benchmark:`,
          `    Samples:         ${measurements
            .map((sample) => sample.admissionsPerSecond.toLocaleString())
            .join(', ')}`,
          `    Total starts:    ${measurement.measuredStarts.toLocaleString()}`,
          `    Start batch size:${measurement.batchSize.toLocaleString()}`,
          `    Warmup starts:   ${measurement.warmupStarts.toLocaleString()}`,
          `    Median:          ${measurement.admissionsPerSecond.toLocaleString()}/sec`,
          `    Spec target:     ${ARCHITECTURE_TARGET_ADMISSIONS_PER_SECOND.toLocaleString()}`,
          `    Child coverage:  no (Bun does not cover \`bun run\` subprocesses)\n`,
        ].join('\n'),
      );

      expect(measurement.admissionsPerSecond).toBeGreaterThanOrEqual(
        ARCHITECTURE_TARGET_ADMISSIONS_PER_SECOND,
      );
    },
    120_000,
  );
});

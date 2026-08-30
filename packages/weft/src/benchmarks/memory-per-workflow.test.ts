import { describe, expect, it } from 'bun:test';

import { isConstrainedCodexRunner } from './benchmark-environment.ts';
import type { MemoryPerWorkflowMeasurement } from './memory-per-workflow-runner.ts';

/**
 * K2d: Memory per workflow benchmark.
 *
 * Starts many idle workflows (each waiting on a signal) and measures the
 * durable bytes persisted per workflow after each one has parked.
 *
 * The architecture target is <=2KB for idle workflow durable state and
 * checkpoint footprint. The benchmark runs in a fresh Bun subprocess and uses
 * a 100K parked-workflow population so the measured value is not polluted by
 * unrelated full-suite memory retention.
 */

const TARGET_BYTES_PER_WORKFLOW = 2 * 1024;
const SMOKE_WORKFLOW_COUNT = 1_000;
const ARCHITECTURE_WORKFLOW_COUNT = 100_000;
const TEST_TIMEOUT_MILLISECONDS = isConstrainedCodexRunner() ? 240_000 : 120_000;
const runArchitectureBenchmark =
  process.env['WEFT_MEMORY_PER_WORKFLOW_ARCHITECTURE_BENCHMARK'] === '1' ? it : it.skip;

function runMemoryPerWorkflowBenchmark(totalWorkflows: number): MemoryPerWorkflowMeasurement {
  const result = Bun.spawnSync(
    ['bun', 'run', 'src/benchmarks/memory-per-workflow-runner.ts', String(totalWorkflows)],
    {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    },
  );

  if (result.exitCode !== 0) {
    const errorOutput = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`Memory benchmark subprocess failed: ${errorOutput}`);
  }

  return JSON.parse(new TextDecoder().decode(result.stdout)) as MemoryPerWorkflowMeasurement;
}

describe('Memory per workflow', () => {
  function logMemoryPerWorkflowBenchmark(measurement: MemoryPerWorkflowMeasurement): void {
    console.log(
      [
        `\n  Memory per workflow benchmark:`,
        `    Workflows:       ${measurement.totalWorkflows.toLocaleString()}`,
        `    Counted:         ${measurement.countedWorkflows.toLocaleString()}`,
        `    Checkpoint total:${measurement.checkpointBytesTotal.toLocaleString()} bytes`,
        `    Durable total:   ${measurement.durableBytesTotal.toLocaleString()} bytes`,
        `    Checkpoint avg:  ${measurement.averageCheckpointBytesPerWorkflow.toLocaleString()} bytes (${(measurement.averageCheckpointBytesPerWorkflow / 1024).toFixed(2)}KB)`,
        `    Checkpoint max:  ${measurement.maxCheckpointBytesPerWorkflow.toLocaleString()} bytes (${(measurement.maxCheckpointBytesPerWorkflow / 1024).toFixed(2)}KB)`,
        `    Durable avg:     ${measurement.averageDurableBytesPerWorkflow.toLocaleString()} bytes (${(measurement.averageDurableBytesPerWorkflow / 1024).toFixed(2)}KB)`,
        `    Durable max:     ${measurement.maxDurableBytesPerWorkflow.toLocaleString()} bytes (${(measurement.maxDurableBytesPerWorkflow / 1024).toFixed(2)}KB)`,
        `    Workflow state:  ${measurement.workflowStateBytesTotal.toLocaleString()} bytes`,
        `    Checkpoint hist: ${measurement.checkpointHistoryBytesTotal.toLocaleString()} bytes`,
        `    Timeline bytes:  ${measurement.timelineBytesTotal.toLocaleString()} bytes`,
        `    Event bytes:     ${measurement.eventBytesTotal.toLocaleString()} bytes`,
        `    Other bytes:     ${measurement.otherBytesTotal.toLocaleString()} bytes`,
        `    Target:          <=${(TARGET_BYTES_PER_WORKFLOW / 1024).toFixed(0)}KB\n`,
      ].join('\n'),
    );
  }

  it(
    'records idle workflow durable footprint in a non-gating smoke benchmark',
    async () => {
      const measurement = runMemoryPerWorkflowBenchmark(SMOKE_WORKFLOW_COUNT);

      logMemoryPerWorkflowBenchmark(measurement);

      expect(measurement.countedWorkflows).toBe(SMOKE_WORKFLOW_COUNT);
      expect(measurement.maxCheckpointBytesPerWorkflow).toBeGreaterThan(0);
      expect(measurement.maxDurableBytesPerWorkflow).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MILLISECONDS,
  );

  runArchitectureBenchmark(
    `idle workflow durable footprint stays <=${(TARGET_BYTES_PER_WORKFLOW / 1024).toFixed(0)}KB`,
    async () => {
      const measurement = runMemoryPerWorkflowBenchmark(ARCHITECTURE_WORKFLOW_COUNT);

      logMemoryPerWorkflowBenchmark(measurement);

      expect(measurement.countedWorkflows).toBe(ARCHITECTURE_WORKFLOW_COUNT);
      expect(measurement.maxCheckpointBytesPerWorkflow).toBeLessThanOrEqual(
        TARGET_BYTES_PER_WORKFLOW,
      );
      expect(measurement.maxDurableBytesPerWorkflow).toBeLessThanOrEqual(TARGET_BYTES_PER_WORKFLOW);
    },
    TEST_TIMEOUT_MILLISECONDS,
  );
});

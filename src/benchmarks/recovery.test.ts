import { describe, expect, it } from 'bun:test';
import { waitForRealTimersForTesting } from '../testing/fake-timers.test-support.ts';

import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types.ts';
import { BunSQLiteStorage } from '../storage/bun-sql.ts';

/**
 * K2c: Workflow recovery benchmark.
 *
 * Starts workflows that checkpoint, disposes the engine, creates a new
 * engine on the same storage, and measures per-workflow recovery time.
 * Architecture target is <1ms (O(1) checkpoint load); relaxed to <5ms
 * to absorb CI variance. Also verifies that recovery time is constant
 * regardless of workflow history size.
 */

const TARGET_RECOVERY_MS = process.env['CI'] ? 10 : 5;
const RECOVERY_SAMPLE_SIZE = 5;
const runArchitectureBenchmark =
  process.env['WEFT_RECOVERY_ARCHITECTURE_BENCHMARK'] === '1' ? it : it.skip;

type RecoveryMeasurement = {
  workflowCount: number;
  elapsedMilliseconds: number;
  millisecondsPerWorkflow: number;
};

function median(values: number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted[middle]!;
}

async function measureRecoverAll(totalWorkflows: number): Promise<RecoveryMeasurement> {
  const storage = new BunSQLiteStorage(':memory:');
  let creationEngine: Engine | undefined = new Engine({ storage });
  let recoveryEngine: Engine | undefined;

  try {
    // A workflow that waits for a signal so it stays in 'running' state
    // after checkpointing.
    const waiterWorkflow = workflow({ name: 'waiter' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.waitForSignal('go');
      return 'done';
    });
    creationEngine.register(waiterWorkflow);

    // Start workflows — they'll checkpoint at the signal-wait yield point.
    for (let i = 0; i < totalWorkflows; i++) {
      await creationEngine.start('waiter', i);
    }

    // Allow microtasks to settle so checkpoints are written.
    await waitForRealTimersForTesting(10);

    // Dispose the engine (simulates process crash / restart).
    creationEngine[Symbol.dispose]();
    creationEngine = undefined;

    // Create a new engine on the same storage.
    recoveryEngine = new Engine({ storage });

    const waiterWorkflow2 = workflow({ name: 'waiter' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.waitForSignal('go');
      return 'done';
    });
    recoveryEngine.register(waiterWorkflow2);

    // Measure recovery time for all workflows via recoverAll().
    const start = performance.now();
    const handles = await recoveryEngine.recoverAll();
    const elapsed = performance.now() - start;

    return {
      workflowCount: handles.length,
      elapsedMilliseconds: elapsed,
      millisecondsPerWorkflow: elapsed / handles.length,
    };
  } finally {
    creationEngine?.[Symbol.dispose]();
    recoveryEngine?.[Symbol.dispose]();
    storage[Symbol.dispose]();
  }
}

function logRecoveryMeasurement(measurement: RecoveryMeasurement): void {
  console.log(
    [
      `\n  Workflow recovery benchmark:`,
      `    Workflows:       ${measurement.workflowCount}`,
      `    Total elapsed:   ${measurement.elapsedMilliseconds.toFixed(2)}ms`,
      `    Per workflow:    ${measurement.millisecondsPerWorkflow.toFixed(3)}ms`,
      `    Target:          <${TARGET_RECOVERY_MS}ms per workflow\n`,
    ].join('\n'),
  );
}

describe('Workflow recovery', () => {
  it('recovers workflows in a non-gating smoke benchmark', async () => {
    const measurement = await measureRecoverAll(10);

    logRecoveryMeasurement(measurement);

    expect(measurement.workflowCount).toBe(10);
    expect(measurement.millisecondsPerWorkflow).toBeGreaterThan(0);
  }, 30_000);

  runArchitectureBenchmark(
    `recovers a single workflow in <${TARGET_RECOVERY_MS}ms`,
    async () => {
      const measurement = await measureRecoverAll(100);

      logRecoveryMeasurement(measurement);

      expect(measurement.workflowCount).toBe(100);
      expect(measurement.millisecondsPerWorkflow).toBeLessThan(TARGET_RECOVERY_MS);
    },
    30_000,
  );

  runArchitectureBenchmark(
    'recovery time is O(1) — constant regardless of history depth',
    async () => {
      const storage = new BunSQLiteStorage(':memory:');

      // Phase 1: create a workflow with shallow history.
      const engine1 = new Engine({ storage });

      const waiterWorkflow3 = workflow({ name: 'waiter' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        yield* ctx.waitForSignal('go');
        return 'done';
      });
      engine1.register(waiterWorkflow3);

      for (let index = 0; index < RECOVERY_SAMPLE_SIZE; index++) {
        await engine1.start('waiter', `shallow-${index}`, {
          id: `shallow-history-${index}`,
        });
      }
      await waitForRealTimersForTesting(5);
      engine1[Symbol.dispose]();

      // Measure shallow recovery.
      const engine2 = new Engine({ storage });
      const waiterWorkflow4 = workflow({ name: 'waiter' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        yield* ctx.waitForSignal('go');
        return 'done';
      });
      engine2.register(waiterWorkflow4);

      const shallowTimes: number[] = [];
      for (let index = 0; index < RECOVERY_SAMPLE_SIZE; index++) {
        const shallowStart = performance.now();
        await engine2.resume(`shallow-history-${index}`);
        shallowTimes.push(performance.now() - shallowStart);
      }
      const shallowMedian = median(shallowTimes);
      engine2[Symbol.dispose]();

      // Phase 2: create a workflow with deeper history (more checkpoint data
      // in storage via many completed workflows to fill the store).
      const engine3 = new Engine({ storage });

      const waiterWorkflow5 = workflow({ name: 'waiter' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        yield* ctx.waitForSignal('go');
        return 'done';
      });
      engine3.register(waiterWorkflow5);

      // Add 500 completed workflows to increase overall storage volume.
      const fillerWorkflow = workflow({ name: 'filler' }).execute(async function* (
        _ctx: WorkflowContext,
      ) {
        return 'filler';
      });
      engine3.register(fillerWorkflow);
      for (let i = 0; i < 500; i++) {
        const handle = await engine3.start('filler', i);
        await handle.result();
      }

      // Start a new 'waiter' workflow that will be recovered.
      for (let index = 0; index < RECOVERY_SAMPLE_SIZE; index++) {
        await engine3.start('waiter', `deep-${index}`, {
          id: `deep-history-${index}`,
        });
      }
      await waitForRealTimersForTesting(5);
      engine3[Symbol.dispose]();

      // Measure deep recovery.
      const engine4 = new Engine({ storage });
      const waiterWorkflow6 = workflow({ name: 'waiter' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        yield* ctx.waitForSignal('go');
        return 'done';
      });
      engine4.register(waiterWorkflow6);

      const deepTimes: number[] = [];
      for (let index = 0; index < RECOVERY_SAMPLE_SIZE; index++) {
        const deepStart = performance.now();
        await engine4.resume(`deep-history-${index}`);
        deepTimes.push(performance.now() - deepStart);
      }
      const deepMedian = median(deepTimes);
      engine4[Symbol.dispose]();
      storage[Symbol.dispose]();

      console.log(
        [
          `\n  Recovery O(1) verification:`,
          `    Shallow median:          ${shallowMedian.toFixed(3)}ms`,
          `    Deep median:             ${deepMedian.toFixed(3)}ms`,
          `    Ratio:                   ${(deepMedian / shallowMedian).toFixed(2)}x`,
          `    Shallow samples:         ${shallowTimes.map((time) => time.toFixed(3)).join(', ')}`,
          `    Deep samples:            ${deepTimes.map((time) => time.toFixed(3)).join(', ')}\n`,
        ].join('\n'),
      );

      // Deep recovery should be at most 5x the shallow time. In a true O(1)
      // system they'd be nearly identical; the generous factor accounts for
      // cache effects and GC jitter.
      expect(deepMedian).toBeLessThan(shallowMedian * 5 + 2);
    },
    60_000,
  );
});

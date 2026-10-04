/**
 * Two live engines over one store under `ownership: 'none'`: the engine that
 * loses a checkpoint compare-and-swap must settle its own handle with a typed
 * error and stop driving the run, and must write nothing durable — the
 * winning engine owns the workflow's checkpoint, terminal state, and record.
 *
 * The race is forced deterministically by gating storage writes, never by
 * timing: engine A's third checkpoint write is held until engine B has read
 * the checkpoint A is about to supersede, and B's first checkpoint write is
 * held until A's lands, so B's write is conditioned on bytes that are stale.
 */
import { describe, expect, it } from 'bun:test';

import { KEYS, type BatchOperation, type Storage } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { createDeferred, waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { rejectionOf } from '../../testing/promise-outcome.test-support.ts';
import { decode } from '../codec/api.ts';
import { Engine } from '../engine.ts';
import { workflow, type WorkflowContext, type WorkflowState } from '../types.ts';
import { WorkflowCheckpointConflictError } from './checkpoint-conflict-error.ts';
import {
  collectConflictWarnings,
  interceptConflictWarnings,
} from './checkpoint-conflict.test-support.ts';
import { abandonedExecutionAttemptCount } from './execution-attempts.ts';
import { WorkflowHandle } from './handles.ts';
import { getInternals } from './internals.ts';

const workflowId = 'conflict-workflow';
const checkpointKey = KEYS.checkpoint(workflowId);
const workflowRecordKey = KEYS.workflow(workflowId);
const heldCheckpointWrite = 3;

const conflictWorkflow = workflow({ name: 'conflict-workflow' }).execute(async function* (
  context: WorkflowContext,
) {
  const first = yield* context.run(() => 's1');
  const second = yield* context.run(() => 's2');
  const third = yield* context.run(() => 's3');
  const signal = yield* context.waitForSignal<string>('go');
  return [first, second, third, signal].join(':');
});
const workflows = { 'conflict-workflow': conflictWorkflow };

type EngineLabel = 'A' | 'B';

function writeOperations(
  name: string,
  argumentsList: readonly unknown[],
): readonly BatchOperation[] | null {
  if (name === 'batch') return argumentsList[0] as BatchOperation[];
  if (name === 'conditionalBatch') return argumentsList[1] as BatchOperation[];
  return null;
}

function touchesCheckpoint(operations: readonly BatchOperation[]): boolean {
  return operations.some(
    (operation) => operation.type === 'put' && operation.key === checkpointKey,
  );
}

function createRace(base: Storage) {
  const heldWriteReached = createDeferred();
  const releaseHeldWrite = createDeferred();
  const heldWriteLanded = createDeferred();
  let engineAWrites = 0;
  let engineBHasReadCheckpoint = false;
  let engineBFirstCheckpointWrite = true;
  const lostByB = { value: false };
  const writesByBAfterLoss: string[] = [];
  const landedCheckpointWritesByLabel: EngineLabel[] = [];

  const gate = (label: EngineLabel): Storage =>
    new Proxy(base, {
      get(target, property) {
        if (property === 'get') {
          return async (key: string) => {
            if (label === 'B' && key === checkpointKey && !engineBHasReadCheckpoint) {
              engineBHasReadCheckpoint = true;
              releaseHeldWrite.resolve();
            }
            return target.get(key);
          };
        }
        const name = String(property);
        const original: unknown = Reflect.get(target, property, target);
        if (typeof original !== 'function') return original;
        const isWrite = ['put', 'delete', 'batch', 'conditionalBatch'].includes(name);
        if (!isWrite) return original.bind(target);
        return async (...argumentsList: unknown[]) => {
          if (label === 'B' && lostByB.value) writesByBAfterLoss.push(name);
          const operations = writeOperations(name, argumentsList);
          const isCheckpointWrite = operations !== null && touchesCheckpoint(operations);
          let wasHeld = false;
          if (isCheckpointWrite && label === 'A') {
            engineAWrites += 1;
            if (engineAWrites === heldCheckpointWrite) {
              wasHeld = true;
              heldWriteReached.resolve();
              await releaseHeldWrite.promise;
            }
          }
          if (isCheckpointWrite && label === 'B' && engineBFirstCheckpointWrite) {
            engineBFirstCheckpointWrite = false;
            await heldWriteLanded.promise;
          }
          const result: unknown = await original.apply(target, argumentsList);
          if (isCheckpointWrite && result !== false) landedCheckpointWritesByLabel.push(label);
          if (label === 'B' && isCheckpointWrite && result === false) lostByB.value = true;
          if (wasHeld) heldWriteLanded.resolve();
          return result;
        };
      },
    });

  return {
    storageForA: gate('A'),
    storageForB: gate('B'),
    heldWriteReached,
    lostByB,
    writesByBAfterLoss,
    landedCheckpointWritesByLabel,
  };
}

async function readState(base: Storage): Promise<WorkflowState> {
  const bytes = await base.get(workflowRecordKey);
  return decode(bytes!) as WorkflowState;
}

async function runRace(
  base: Storage,
  scenario: 'winner-completes' | 'resume-after-loss' = 'winner-completes',
): Promise<void> {
  const race = createRace(base);
  const warning = collectConflictWarnings();
  const engineA = await Engine.create({
    storage: race.storageForA,
    workflows,
    ownership: 'none',
  } as never);
  let engineB: Engine | undefined;
  try {
    await engineA.start('conflict-workflow', null, { id: workflowId });
    await race.heldWriteReached.promise;
    const checkpointBeforeRace = await base.get(checkpointKey);
    const recordBeforeRace = await base.get(workflowRecordKey);

    engineB = await Engine.create({
      storage: race.storageForB,
      workflows,
      ownership: 'none',
    } as never);

    const loser = engineB.getHandle(workflowId);
    const reason = await rejectionOf(loser.result());
    expect(reason).toBeInstanceOf(WorkflowCheckpointConflictError);
    expect((reason as WorkflowCheckpointConflictError).workflowId).toBe(workflowId);
    // A result() requested after the loss must not wait on a generator that is gone.
    // A handle caches its first result promise, so ask through a fresh handle.
    const freshHandleAfterLoss = new WorkflowHandle(workflowId, getInternals(engineB).engine);
    expect(await rejectionOf(freshHandleAfterLoss.result())).toBeInstanceOf(
      WorkflowCheckpointConflictError,
    );
    await warning.received;
    expect(warning.warnings.map((emitted) => emitted.workflowId)).toEqual([workflowId]);

    // The loser stopped driving the workflow and remembers the generation it lost.
    const internals = getInternals(engineB);
    expect(internals.inlineStrategy?.hasGenerator(workflowId)).toBe(false);
    expect(internals.resultResolvers.has(workflowId)).toBe(false);
    expect(abandonedExecutionAttemptCount(internals)).toBe(1);

    // The held write was A's, it landed over what B read, and B wrote nothing.
    expect(race.lostByB.value).toBe(true);
    expect(await base.get(checkpointKey)).not.toEqual(checkpointBeforeRace);
    const stateDuringRace = await readState(base);
    expect(stateDuringRace.status).toBe('running');
    expect(race.landedCheckpointWritesByLabel).not.toContain('B');
    expect(race.writesByBAfterLoss).toEqual([]);
    expect(await base.get(workflowRecordKey)).toEqual(recordBeforeRace);

    if (scenario === 'winner-completes') {
      // The winner is unharmed: it still takes the signal and completes the run.
      await engineA.signal(workflowId, 'go', 'X');
      expect(await engineA.getHandle(workflowId).result()).toBe('s1:s2:s3:X');
      const stateAfterCompletion = await readState(base);
      expect(stateAfterCompletion.status).toBe('completed');
      expect(race.writesByBAfterLoss).toEqual([]);
      return;
    }

    // The loser later takes the run over for real: the winner pauses it, this
    // engine resumes it from the winner's checkpoint and drives it to completion
    // without anyone asking for result() mid-run. The marker for the lost
    // generation must not outlive that local launch of the same generation, or
    // the run's real outcome would be masked by the old conflict.
    await engineA.suspend(workflowId);
    const resumedHandle = await engineB.resume(workflowId);
    expect(abandonedExecutionAttemptCount(internals)).toBe(0);
    // The handle that observed the loss keeps reporting it; resume() hands back
    // a different handle that observes the resumed run.
    expect(resumedHandle).not.toBe(loser);
    expect(await rejectionOf(loser.result())).toBeInstanceOf(WorkflowCheckpointConflictError);
    await engineB.signal(workflowId, 'go', 'Y');
    await waitForCondition(
      async () => {
        const state = await readState(base);
        return state.status === 'completed';
      },
      { label: 'resumed run completed on the former loser' },
    );
    expect(internals.checkpoints.has(workflowId)).toBe(false);
    expect(await resumedHandle.result()).toBe('s1:s2:s3:Y');
    expect(engineB.getHandle(workflowId)).toBe(resumedHandle);
  } finally {
    warning.stop();
    await engineB?.[Symbol.asyncDispose]();
    await engineA[Symbol.asyncDispose]();
  }
}

interceptConflictWarnings();

describe('checkpoint compare-and-swap loss under ownership none', () => {
  it('settles the loser with a typed error and writes nothing (MemoryStorage)', async () => {
    await runRace(new MemoryStorage());
  });

  it('settles the loser with a typed error and writes nothing (BunSQLiteStorage)', async () => {
    const { BunSQLiteStorage } = await import('../../storage/bun-sql.ts');
    using storage = new BunSQLiteStorage(':memory:');
    await runRace(storage);
  });

  it('does not reject a later local run of the workflow with the old loss (resume after loss)', async () => {
    await runRace(new MemoryStorage(), 'resume-after-loss');
  });
});

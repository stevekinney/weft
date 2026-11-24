/**
 * COR-1626: the worker strategy shares `handleStrategyMessage` with the inline strategy and the
 * retry sits below it in `commitCheckpoint`, so a run whose checkpoint storage keeps refusing
 * ends the same way on an engine that runs its workflows in a worker.
 */
import { expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { rejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { KEYS } from '../../storage/keys.ts';
import { decode } from '../codec/api.ts';
import { Engine } from '../engine.ts';
import type { WorkflowContext, WorkflowState } from '../types.ts';
import { workflow } from '../types.ts';
import { CheckpointCommitFailedError } from './checkpoint-commit-failed-error.ts';
import { getInternals } from './internals.ts';
import { createRefusingStorage, putsCheckpoint } from './storage-write-refusal.test-support.ts';

const workerUrl = new URL('../../workers/test-browser-worker.ts', import.meta.url);

const waitSignalThenComplete = workflow({ name: 'wait-signal-then-complete' }).execute(
  async function* (_ctx: WorkflowContext) {
    return undefined;
  },
);

it('ends a worker-run workflow with CheckpointCommitFailedError when its checkpoint is refused', async () => {
  const refusing = createRefusingStorage(new MemoryStorage());
  await using engine = new Engine({
    storage: refusing.storage,
    workflowExecutionMode: 'worker',
    workerExecution: { workerUrl, poolSize: 1, workflowTurnTimeoutMs: 30_000 },
  });
  engine.register(waitSignalThenComplete);
  getInternals(engine).storageWriteRetryDelaysForTesting = [0, 0, 0, 0];

  // The run exists once start() resolves; its first checkpoint is the worker's, which comes later.
  const handle = await engine.start(
    'wait-signal-then-complete',
    { signalName: 'resume' },
    { id: 'worker-refused' },
  );
  refusing.arm();
  refusing.refuse({ matches: putsCheckpoint('worker-refused') });

  const reason = await rejectionOf(handle.result());

  expect(reason).toBeInstanceOf(CheckpointCommitFailedError);
  expect((reason as CheckpointCommitFailedError).write).toBe('checkpoint');
  expect((reason as CheckpointCommitFailedError).attempts).toBe(5);
  expect(refusing.attemptsMatching(putsCheckpoint('worker-refused'))).toHaveLength(5);
  const state = decode(
    (await refusing.base.get(KEYS.workflow('worker-refused')))!,
  ) as WorkflowState;
  expect(state.status).toBe('failed');
  expect(state.failureCategory).toBe('system');
});

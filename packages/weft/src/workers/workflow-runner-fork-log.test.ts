import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { deserializeCheckpoint, serializeCheckpoint } from '../core/checkpoint.ts';
import { buildForkCheckpoint } from '../core/engine/lifecycle/fork-helpers.ts';
import type { OperationRequest, WorkflowState } from '../core/types.ts';
import { captureWorkflowLogConsole } from '../testing/workflow-log-capture.test-support.ts';
import {
  createWorkflowRunnerContext,
  handleResumeMessage,
  handleRunMessage,
  type WorkerWorkflowContext,
} from './workflow-runner.ts';

/**
 * COR-1924. A fork copies the checkpoint of the run it forks, including the signature of the
 * operation that run was parked on. That signature is evidence that the SOURCE's execution reached
 * the operation, not that the fork's own did, so the fork's first turn must deliver the lines in
 * front of that operation as new work. Once the fork has taken a turn, a recovery of the fork
 * repeats its own execution and marks them `replayed`.
 */

const parkedOperation: OperationRequest = {
  id: 'wf-source:step1',
  workflowId: 'wf-source',
  kind: 'activity',
  queue: 'default',
  activityName: 'step1',
  input: 'one',
  attempt: 1,
  retryPolicy: { maxAttempts: 3, initialBackoff: 1000, backoffMultiplier: 2, maxBackoff: 30_000 },
  scheduledAt: 0,
};

async function* loggingWorkflow(ctx: WorkerWorkflowContext) {
  ctx.log.info('before-1');
  const first: unknown = yield parkedOperation;
  ctx.log.info('after-1');
  return first;
}

describe('worker ctx.log in a forked run', () => {
  let captured: ReturnType<typeof captureWorkflowLogConsole>;
  beforeEach(() => {
    captured = captureWorkflowLogConsole();
  });
  afterEach(() => {
    captured.restore();
  });

  it('delivers the lines in front of the copied pending operation as new work, until the fork has taken a turn', async () => {
    const sourceResult = await handleRunMessage(
      createWorkflowRunnerContext(),
      { workflowId: 'wf-source', workflowType: 'forked', input: null },
      () => loggingWorkflow,
    );
    expect(sourceResult.type).toBe('checkpoint');
    if (sourceResult.type !== 'checkpoint') return;
    const sourceCheckpoint = deserializeCheckpoint(new Uint8Array(sourceResult.checkpoint));
    const forkCheckpoint = buildForkCheckpoint(
      {} as Parameters<typeof buildForkCheckpoint>[0],
      'wf-fork',
      1,
      sourceCheckpoint,
      {} as WorkflowState,
      { workflowId: 'wf-source', step: sourceCheckpoint.step },
      {} as Parameters<typeof buildForkCheckpoint>[6],
    );

    captured.restore();
    captured = captureWorkflowLogConsole();
    const forkContext = createWorkflowRunnerContext();
    const forkFirstTurn = await handleRunMessage(
      forkContext,
      {
        workflowId: 'wf-fork',
        workflowType: 'forked',
        input: null,
        checkpoint: serializeCheckpoint(forkCheckpoint).buffer as ArrayBuffer,
      },
      () => loggingWorkflow,
    );
    expect(forkFirstTurn.type).toBe('checkpoint');
    if (forkFirstTurn.type !== 'checkpoint') return;
    expect(captured.records.map((r) => [r.message, r.replayed])).toEqual([['before-1', undefined]]);

    // A recovery of the fork, now that it took a turn of its own, repeats what that turn logged.
    captured.restore();
    captured = captureWorkflowLogConsole();
    const recovered = await handleRunMessage(
      createWorkflowRunnerContext(),
      {
        workflowId: 'wf-fork',
        workflowType: 'forked',
        input: null,
        checkpoint: forkFirstTurn.checkpoint,
      },
      () => loggingWorkflow,
    );
    expect(recovered.type).toBe('checkpoint');
    expect(captured.records.map((r) => [r.message, r.replayed])).toEqual([['before-1', true]]);

    const resumed = await handleResumeMessage(forkContext, {
      workflowId: 'wf-fork',
      result: 'one-result',
    });
    expect(resumed.type).toBe('completed');
  });

  it('pins only the yielded operation as the fork’s own and keeps the other copied steps', async () => {
    const sourceResult = await handleRunMessage(
      createWorkflowRunnerContext(),
      { workflowId: 'wf-source', workflowType: 'forked', input: null },
      () => loggingWorkflow,
    );
    expect(sourceResult.type).toBe('checkpoint');
    if (sourceResult.type !== 'checkpoint') return;
    const sourceCheckpoint = deserializeCheckpoint(new Uint8Array(sourceResult.checkpoint));
    const forkCheckpoint = buildForkCheckpoint(
      {} as Parameters<typeof buildForkCheckpoint>[0],
      'wf-fork',
      1,
      sourceCheckpoint,
      {} as WorkflowState,
      { workflowId: 'wf-source', step: sourceCheckpoint.step },
      {} as Parameters<typeof buildForkCheckpoint>[6],
    );
    const parkedStep = forkCheckpoint.forkCopiedSignatureSteps;
    expect(parkedStep).toHaveLength(1);
    const otherStep = parkedStep![0]! + 7;

    const forkFirstTurn = await handleRunMessage(
      createWorkflowRunnerContext(),
      {
        workflowId: 'wf-fork',
        workflowType: 'forked',
        input: null,
        checkpoint: serializeCheckpoint({
          ...forkCheckpoint,
          forkCopiedSignatureSteps: [...parkedStep!, otherStep],
        }).buffer as ArrayBuffer,
      },
      () => loggingWorkflow,
    );
    expect(forkFirstTurn.type).toBe('checkpoint');
    if (forkFirstTurn.type !== 'checkpoint') return;

    const takenTurn = deserializeCheckpoint(new Uint8Array(forkFirstTurn.checkpoint));
    expect(takenTurn.forkCopiedSignatureSteps).toEqual([otherStep]);
  });
});

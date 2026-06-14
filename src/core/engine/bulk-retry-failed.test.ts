import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { decode } from '../codec.ts';
import type { WorkflowContext, WorkflowState } from '../types.ts';
import { workflow } from '../types.ts';
import { Engine } from './index.ts';

async function waitForWorkflowStatus(
  engine: Engine,
  workflowId: string,
  status: WorkflowState['status'],
): Promise<WorkflowState> {
  let matchingState: WorkflowState | null = null;
  await waitForCondition(
    async () => {
      const state = await engine.get(workflowId);
      if (state?.status === status) {
        matchingState = state;
        return true;
      }
      return state?.status === status;
    },
    { label: `workflow "${workflowId}" to reach ${status}`, intervalMs: 5 },
  );
  if (matchingState === null) {
    throw new Error(`Workflow "${workflowId}" did not reach ${status}`);
  }
  return matchingState;
}

describe('bulk failed-workflow retry', () => {
  it('resumes a failed workflow from its checkpoint without re-running completed work', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    let activityRuns = 0;
    let shouldFailAfterCheckpoint = true;
    const checkpointRetryWorkflow = workflow({ name: 'checkpoint-retry' }).execute(async function* (
      ctx: WorkflowContext,
      input: { value: string },
    ) {
      const checkpointedValue = yield* ctx.run(async () => {
        activityRuns += 1;
        return input.value;
      });
      yield* ctx.run(async () => 'checkpoint-barrier');
      if (shouldFailAfterCheckpoint) {
        throw new Error('first attempt failed after checkpoint');
      }
      return `retried:${checkpointedValue}`;
    });
    engine.register(checkpointRetryWorkflow);

    const handle = await engine.start(
      'checkpoint-retry',
      { value: 'from-checkpoint' },
      {
        id: 'bulk-retry-checkpoint',
        tags: ['retry-checkpoint'],
      },
    );
    await waitForWorkflowStatus(engine, handle.id, 'failed');
    expect(await storage.get(KEYS.checkpoint(handle.id))).not.toBeNull();
    expect(activityRuns).toBe(1);

    shouldFailAfterCheckpoint = false;
    const result = await engine.retryFailedAll({ tags: ['retry-checkpoint'] });

    expect(result).toEqual({ retried: 1, failed: 0, errors: [] });
    const retriedState = await waitForWorkflowStatus(engine, handle.id, 'completed');
    expect(retriedState.result).toBe('retried:from-checkpoint');
    expect(activityRuns).toBe(1);
  });

  it('restarts a failed workflow from persisted input when no checkpoint exists', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    let shouldFailBeforeCheckpoint = true;
    const noCheckpointWorkflow = workflow({ name: 'no-checkpoint-retry' }).execute(async function* (
      _ctx: WorkflowContext,
      input: { value: string },
    ) {
      if (shouldFailBeforeCheckpoint) {
        throw new Error('first attempt failed before checkpoint');
      }
      return `restarted:${input.value}`;
    });
    engine.register(noCheckpointWorkflow);

    const handle = await engine.start(
      'no-checkpoint-retry',
      { value: 'from-input' },
      {
        id: 'bulk-retry-no-checkpoint',
        tags: ['retry-no-checkpoint'],
      },
    );
    await waitForWorkflowStatus(engine, handle.id, 'failed');
    await storage.delete(KEYS.checkpoint(handle.id));
    expect(await storage.get(KEYS.checkpoint(handle.id))).toBeNull();

    shouldFailBeforeCheckpoint = false;
    const result = await engine.retryFailedAll({ tags: ['retry-no-checkpoint'] });

    expect(result).toEqual({ retried: 1, failed: 0, errors: [] });
    const retriedState = await waitForWorkflowStatus(engine, handle.id, 'completed');
    expect(retriedState.result).toBe('restarted:from-input');
  });

  it('only retries failed workflows that match the supplied filter', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const workflowAttempts = new Map<string, number>();
    const selectiveRetryWorkflow = workflow({ name: 'selective-retry' }).execute(async function* (
      _ctx: WorkflowContext,
      input: { workflowId: string },
    ) {
      const attempts = workflowAttempts.get(input.workflowId) ?? 0;
      workflowAttempts.set(input.workflowId, attempts + 1);
      if (attempts === 0) {
        throw new Error(`fail ${input.workflowId}`);
      }
      return `ok:${input.workflowId}`;
    });
    engine.register(selectiveRetryWorkflow);

    await engine.start(
      'selective-retry',
      { workflowId: 'selected' },
      {
        id: 'bulk-retry-selected',
        tags: ['retry-selected'],
      },
    );
    await engine.start(
      'selective-retry',
      { workflowId: 'other' },
      {
        id: 'bulk-retry-other',
        tags: ['retry-other'],
      },
    );
    await Promise.all([
      waitForWorkflowStatus(engine, 'bulk-retry-selected', 'failed'),
      waitForWorkflowStatus(engine, 'bulk-retry-other', 'failed'),
    ]);

    const result = await engine.retryFailedAll({ tags: ['retry-selected'] });

    expect(result).toEqual({ retried: 1, failed: 0, errors: [] });
    const selectedState = await waitForWorkflowStatus(engine, 'bulk-retry-selected', 'completed');
    expect(selectedState.result).toBe('ok:selected');
    const otherState = await engine.get('bulk-retry-other');
    expect(otherState?.status).toBe('failed');
  });

  it('previews and confirms retry-failed operations with durable audit records', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    let shouldFail = true;
    const auditableRetryWorkflow = workflow({ name: 'auditable-retry' }).execute(async function* (
      _ctx: WorkflowContext,
    ) {
      if (shouldFail) {
        throw new Error('previewed failure');
      }
      return 'retried';
    });
    engine.register(auditableRetryWorkflow);

    const handle = await engine.start('auditable-retry', null, {
      id: 'bulk-retry-audit',
      tags: ['retry-audit'],
    });
    await waitForWorkflowStatus(engine, handle.id, 'failed');

    const preview = await engine.retryFailedAll(
      { tags: ['retry-audit'] },
      { dryRun: true, requestId: 'bulk-retry-audit-request' },
    );

    expect(preview).toEqual(
      expect.objectContaining({
        dryRun: true,
        action: 'retry-failed',
        matched: 1,
        requestId: 'bulk-retry-audit-request',
        sampleWorkflowIds: ['bulk-retry-audit'],
      }),
    );
    const previewedState = await engine.get(handle.id);
    expect(previewedState?.status).toBe('failed');

    shouldFail = false;
    const result = await engine.retryFailedAll(
      { tags: ['retry-audit'] },
      {
        confirmationToken: preview.confirmationToken,
        principal: { method: 'api-key', subject: 'operator-1' },
        requestId: 'bulk-retry-audit-request',
      },
    );

    expect(result.retried).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.auditEvent).toEqual(
      expect.objectContaining({
        type: 'bulk-operation:audit',
        action: 'retry-failed',
        affectedCount: 1,
        requestId: 'bulk-retry-audit-request',
        principal: { method: 'api-key', subject: 'operator-1' },
      }),
    );

    const storedAuditRecords = [];
    for await (const [, value] of storage.scan(KEYS.bulkOperationAuditPrefix())) {
      storedAuditRecords.push(decode(value));
    }
    expect(storedAuditRecords).toEqual([
      expect.objectContaining({
        type: 'bulk-operation:audit',
        action: 'retry-failed',
        affectedCount: 1,
        requestId: 'bulk-retry-audit-request',
      }),
    ]);
  });
});

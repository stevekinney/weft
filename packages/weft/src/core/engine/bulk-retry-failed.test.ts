import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { ActivityRegistry } from '../activity-registry.ts';
import { decode, encode } from '../codec.ts';
import { buildWorkflowManifestFromDefinition } from '../registry-workflow-manifest.ts';
import { workflowSource } from '../source/index.ts';
import type { WorkflowContext, WorkflowDefinition, WorkflowState } from '../types.ts';
import { workflow } from '../types.ts';
import { copyWorkflowDefinition } from './construction.ts';
import { Engine } from './index.ts';
import { buildRegistrationEntry } from './registration.ts';

/** Real, content-derived revision for a definition — mirrors `dynamic-source-recovery.test.ts`'s helper of the same name. */
async function revisionFor(definition: WorkflowDefinition): Promise<string> {
  const entry = buildRegistrationEntry(definition.name, definition);
  const registered = copyWorkflowDefinition(definition.name, entry);
  const manifest = await buildWorkflowManifestFromDefinition(
    registered,
    new ActivityRegistry().listDefinitions(),
  );
  return manifest.revision;
}

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

  it('restarts a failed workflow from persisted input for a legacy "." id when no checkpoint exists (WFT-95)', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    let shouldFailBeforeCheckpoint = true;
    const legacyDotRetryWorkflow = workflow({ name: 'legacy-dot-retry' }).execute(async function* (
      _ctx: WorkflowContext,
      input: { value: string },
    ) {
      if (shouldFailBeforeCheckpoint) {
        throw new Error('first attempt failed before checkpoint');
      }
      return `restarted:${input.value}`;
    });
    engine.register(legacyDotRetryWorkflow);

    // Seed a failed run persisted under the reserved id "." directly (not
    // through `engine.start()`, which now rejects "." at strict admission) —
    // standing in for a pre-WFT-95 workflow that failed before its first
    // checkpoint. `retryFailedWorkflow()`'s checkpoint-absent fallback must
    // still be able to rebuild and restart it via the internal
    // `skipAdmissionIdCheck: true` replay path (issue 2 of the WFT-95 TOCTOU
    // follow-up), not just the checkpoint-backed reactivation path.
    const failedLegacyState: WorkflowState = {
      createdAt: 1,
      error: 'first attempt failed before checkpoint',
      id: '.',
      input: { value: 'from-legacy-dot' },
      startedAt: 1,
      status: 'failed',
      type: 'legacy-dot-retry',
      updatedAt: 1,
      versionTuple: { workflowVersion: '1' },
    };
    await storage.put(KEYS.workflow('.'), encode(failedLegacyState));
    expect(await storage.get(KEYS.checkpoint('.'))).toBeNull();

    shouldFailBeforeCheckpoint = false;
    const result = await engine.retryFailedAll({ status: 'failed' });

    expect(result).toEqual({ retried: 1, failed: 0, errors: [] });
    const retriedState = await waitForWorkflowStatus(engine, '.', 'completed');
    expect(retriedState.result).toBe('restarted:from-legacy-dot');
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

  it("a checkpoint-backed retry resolves against the failed run's own pinned revision, not the active pointer — leaving the workflow FAILED, not stranded RUNNING, when that revision is unavailable", async () => {
    // The bug this test guards against: the pre-reactivation concurrency-
    // admission lookup used to resolve the dynamic source's ACTIVE
    // candidate (whatever this process happens to have registered),
    // commit the failed -> running reactivation batch against it, and only
    // discover — inside the SUBSEQUENT `engine.resume()`, which correctly
    // resolves the run's own exact pin — that the pinned revision doesn't
    // match. By then the reactivation had already committed, so the
    // workflow was left stranded `running` forever with no generator ever
    // advancing, even though the bulk-retry result reported it as failed.
    const storage = new MemoryStorage();

    const originalDefinition = workflow({
      name: 'retry-dynamic-pin',
      description: 'original candidate',
    }).execute(async function* (ctx: WorkflowContext) {
      yield* ctx.run(async () => 'checkpoint-marker');
      throw new Error('always fails after the checkpoint');
    });
    const originalRevision = await revisionFor(originalDefinition);

    await using engineA = new Engine({ storage });
    engineA.registerSource(
      workflowSource(
        {
          name: 'retry-dynamic-pin',
          location: './original.ts',
          exportName: 'a',
          revision: originalRevision,
        },
        async () => ({ a: originalDefinition }),
      ),
    );

    const handle = await engineA.start(
      'retry-dynamic-pin',
      {},
      { id: 'bulk-retry-pin-target', tags: ['retry-pin-target'] },
    );
    const failedState = await waitForWorkflowStatus(engineA, handle.id, 'failed');
    expect(failedState.revision).toBe(originalRevision);
    expect(await storage.get(KEYS.checkpoint(handle.id))).not.toBeNull();

    // A different process (fresh engine, same durable storage) that only
    // registers a DIFFERENT revision of the SAME type — simulating a
    // redeploy that rotated the candidate set without the exact revision
    // this run started on.
    const replacementDefinition = workflow({
      name: 'retry-dynamic-pin',
      description: 'replacement candidate',
    }).execute(async function* (ctx: WorkflowContext) {
      yield* ctx.run(async () => 'unused');
      return 'unused';
    });
    const replacementRevision = await revisionFor(replacementDefinition);
    expect(replacementRevision).not.toBe(originalRevision);

    await using engineB = new Engine({ storage });
    engineB.registerSource(
      workflowSource(
        {
          name: 'retry-dynamic-pin',
          location: './replacement.ts',
          exportName: 'b',
          revision: replacementRevision,
        },
        async () => ({ b: replacementDefinition }),
      ),
    );

    const result = await engineB.retryFailedAll({ tags: ['retry-pin-target'] });

    expect(result.retried).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.id).toBe(handle.id);

    // The critical regression assertion: the workflow must still be
    // `failed`, never `running` — the exact-revision resolve now happens
    // BEFORE the reactivation batch commits, so a retry that cannot honor
    // the pin never touches the persisted state at all.
    const stateAfterFailedRetry = await engineB.get(handle.id);
    expect(stateAfterFailedRetry?.status).toBe('failed');
  });
});

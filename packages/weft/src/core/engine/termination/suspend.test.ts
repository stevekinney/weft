/**
 * ADR 0002 § "External terminal transitions must rotate the epoch":
 * `engine.suspend()` is classified "intentionally external (rotates the
 * epoch)" in the entry-point table. This file proves `suspendWorkflow`'s
 * durable commit — routed through `callbacks.commitExternalTerminalWorkflowStateOperations`
 * (`callback-creators-core.ts`) — actually rotates `wf-owner-epoch:<id>` and
 * deletes `wf-owner-holder:<id>` under `ownership: 'workflow-lease'`, and
 * leaves both untouched under `ownership: 'none'`.
 *
 * The workflow record is seeded directly into storage (never started via
 * `engine.start()`) because `Engine.create({ ownership: 'workflow-lease' })`
 * with no `WorkflowClaimRegistry` wired yet (a later stage) fails closed on
 * any workflow-scoped SELF-transition — but `suspendWorkflow`'s commit is
 * EXTERNAL and never consults the registry, so it works standalone against a
 * `running` record recovery never touched (`recover: false`).
 */
import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../../storage/interface.ts';
import { MemoryStorage } from '../../../storage/memory.ts';
import { encode } from '../../codec.ts';
import type { WorkflowState } from '../../types.ts';
import { Engine } from '../index.ts';
import { decodeWorkflowState } from '../validation.ts';
import { decodeEpoch, encodeEpoch, encodeWorkflowClaimHolder } from '../workflow-claim-codec.ts';

function createRunningWorkflowState(workflowId: string): WorkflowState {
  return {
    createdAt: 1_000,
    id: workflowId,
    input: null,
    startedAt: 1_000,
    status: 'running',
    type: 'suspend-rotation-noop',
    updatedAt: 1_000,
    versionTuple: { workflowVersion: '1' },
  };
}

describe('suspendWorkflow: ADR 0002 external-terminal rotation', () => {
  it('rotates wf-owner-epoch and deletes wf-owner-holder under ownership: "workflow-lease"', async () => {
    const storage = new MemoryStorage();
    // Construct against a genuinely empty store first — this stamps the
    // persisted-data-version sentinel. Seeding the workflow/claim records
    // BEFORE construction would trip `assertCompatiblePersistedDataVersion`'s
    // unversioned-user-data guard, which is unrelated to what this test covers.
    await using engine = await Engine.create({
      storage,
      ownership: 'workflow-lease',
      recover: false,
    });
    const workflowId = 'suspend-rotation-claimed';
    await storage.put(KEYS.workflow(workflowId), encode(createRunningWorkflowState(workflowId)));
    await storage.put(KEYS.workflowOwnerEpoch(workflowId), encodeEpoch(3));
    await storage.put(
      KEYS.workflowOwnerHolder(workflowId),
      encodeWorkflowClaimHolder({
        engineId: 'stale-owner',
        epoch: 3,
        expiresAt: 999_999,
        claimedAt: 1_000,
      }),
    );

    await engine.suspend(workflowId);

    const rotatedEpoch = decodeEpoch((await storage.get(KEYS.workflowOwnerEpoch(workflowId)))!);
    expect(rotatedEpoch).toBe(4);
    expect(await storage.get(KEYS.workflowOwnerHolder(workflowId))).toBeNull();

    const persisted = decodeWorkflowState((await storage.get(KEYS.workflow(workflowId)))!);
    expect(persisted.status).toBe('suspended');
  });

  it('leaves wf-owner-epoch untouched under ownership: "none" (byte-for-byte unchanged)', async () => {
    const storage = new MemoryStorage();
    await using engine = await Engine.create({ storage, recover: false });
    const workflowId = 'suspend-no-rotation';
    await storage.put(KEYS.workflow(workflowId), encode(createRunningWorkflowState(workflowId)));

    await engine.suspend(workflowId);

    expect(await storage.get(KEYS.workflowOwnerEpoch(workflowId))).toBeNull();
    const persisted = decodeWorkflowState((await storage.get(KEYS.workflow(workflowId)))!);
    expect(persisted.status).toBe('suspended');
  });
});

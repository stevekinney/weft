import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import type { EmitWorkflowLeaseWarning, WorkflowWakeKind } from './lease-deposition.ts';
import { WeftWorkflowWakeDiscardedWarning } from './lease-deposition.ts';
import { wakeOwnershipCheck } from './wake-ownership-check.ts';
import { encodeWorkflowClaimHolder } from './workflow-claim-codec.ts';

const WORKFLOW_ID = 'wf-1';
const ENGINE_ID = 'engine-a';

function createWarningSpy(): {
  warn: EmitWorkflowLeaseWarning;
  warnings: WeftWorkflowWakeDiscardedWarning[];
} {
  const warnings: WeftWorkflowWakeDiscardedWarning[] = [];
  return {
    warnings,
    warn: (warning) => {
      // This module only ever emits WeftWorkflowWakeDiscardedWarning; narrow
      // with a real type guard rather than an assertion so the spy's
      // recorded type stays sound.
      if (!(warning instanceof WeftWorkflowWakeDiscardedWarning)) {
        throw new Error(`unexpected warning type emitted: ${warning.name}`);
      }
      warnings.push(warning);
    },
  };
}

async function putHolder(
  storage: MemoryStorage,
  fields: { engineId: string; epoch: number; expiresAt?: number; claimedAt?: number },
): Promise<void> {
  await storage.put(
    KEYS.workflowOwnerHolder(WORKFLOW_ID),
    encodeWorkflowClaimHolder({
      engineId: fields.engineId,
      epoch: fields.epoch,
      expiresAt: fields.expiresAt ?? 10_000,
      claimedAt: fields.claimedAt ?? 1_000,
    }),
  );
}

describe('wakeOwnershipCheck', () => {
  it('matches when the re-read holder has the exact expected engineId and epoch', async () => {
    const storage = new MemoryStorage();
    await putHolder(storage, { engineId: ENGINE_ID, epoch: 5 });

    const { warn, warnings } = createWarningSpy();
    const result = await wakeOwnershipCheck({
      storage,
      workflowId: WORKFLOW_ID,
      wakeKind: 'sleep',
      expectedEngineId: ENGINE_ID,
      expectedEpoch: 5,
      warn,
    });

    expect(result).toEqual({ status: 'match' });
    expect(warnings).toHaveLength(0);
  });

  it('discards on holder-absent when wf-owner-holder was never written', async () => {
    const storage = new MemoryStorage();

    const { warn, warnings } = createWarningSpy();
    const result = await wakeOwnershipCheck({
      storage,
      workflowId: WORKFLOW_ID,
      wakeKind: 'signal',
      expectedEngineId: ENGINE_ID,
      expectedEpoch: 5,
      warn,
    });

    expect(result).toEqual({
      status: 'discarded',
      reason: 'holder-absent',
      observedEngineId: null,
      observedEpoch: null,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.workflowId).toBe(WORKFLOW_ID);
    expect(warnings[0]?.wakeKind).toBe('signal');
  });

  it('discards on holder-undecodable when the stored bytes are not a valid holder record', async () => {
    const storage = new MemoryStorage();
    await storage.put(KEYS.workflowOwnerHolder(WORKFLOW_ID), new TextEncoder().encode('not json'));

    const { warn, warnings } = createWarningSpy();
    const result = await wakeOwnershipCheck({
      storage,
      workflowId: WORKFLOW_ID,
      wakeKind: 'async-activity',
      expectedEngineId: ENGINE_ID,
      expectedEpoch: 5,
      warn,
    });

    expect(result).toEqual({
      status: 'discarded',
      reason: 'holder-undecodable',
      observedEngineId: null,
      observedEpoch: null,
    });
    expect(warnings).toHaveLength(1);
  });

  it('discards on generation-mismatch when a different engine holds the workflow', async () => {
    const storage = new MemoryStorage();
    await putHolder(storage, { engineId: 'engine-b', epoch: 5 });

    const { warn, warnings } = createWarningSpy();
    const result = await wakeOwnershipCheck({
      storage,
      workflowId: WORKFLOW_ID,
      wakeKind: 'wait-condition',
      expectedEngineId: ENGINE_ID,
      expectedEpoch: 5,
      warn,
    });

    expect(result).toEqual({
      status: 'discarded',
      reason: 'generation-mismatch',
      observedEngineId: 'engine-b',
      observedEpoch: 5,
    });
    expect(warnings).toHaveLength(1);
  });

  it('discards on generation-mismatch for the stale-generation case: same engineId, different epoch (the reason this check exists)', async () => {
    // A release-then-reacquire by the SAME engine keeps engineId unchanged
    // while epoch names a new generation. An engineId-only check would wrongly
    // match here and let a stale resolver from the prior generation drive the
    // new one — this is the exact case the ADR calls out.
    const storage = new MemoryStorage();
    await putHolder(storage, { engineId: ENGINE_ID, epoch: 7 });

    const { warn, warnings } = createWarningSpy();
    const result = await wakeOwnershipCheck({
      storage,
      workflowId: WORKFLOW_ID,
      wakeKind: 'child-completion',
      expectedEngineId: ENGINE_ID,
      expectedEpoch: 5,
      warn,
    });

    expect(result).toEqual({
      status: 'discarded',
      reason: 'generation-mismatch',
      observedEngineId: ENGINE_ID,
      observedEpoch: 7,
    });
    expect(warnings).toHaveLength(1);
  });

  it('folds the given wakeKind into the emitted warning for every wake kind', async () => {
    const wakeKinds: WorkflowWakeKind[] = [
      'sleep',
      'wait-condition',
      'signal',
      'async-activity',
      'child-completion',
      'inline-macrotask-drive',
    ];

    for (const wakeKind of wakeKinds) {
      const storage = new MemoryStorage();
      const { warn, warnings } = createWarningSpy();
      const result = await wakeOwnershipCheck({
        storage,
        workflowId: WORKFLOW_ID,
        wakeKind,
        expectedEngineId: ENGINE_ID,
        expectedEpoch: 1,
        warn,
      });

      expect(result.status).toBe('discarded');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toBeInstanceOf(WeftWorkflowWakeDiscardedWarning);
      expect(warnings[0]?.wakeKind).toBe(wakeKind);
    }
  });

  it('falls back to the default process.emitWarning seam when warn is omitted', async () => {
    const storage = new MemoryStorage();
    const originalEmitWarning = process.emitWarning;
    const captured: unknown[] = [];
    process.emitWarning = (warning: unknown) => {
      captured.push(warning);
    };

    try {
      const result = await wakeOwnershipCheck({
        storage,
        workflowId: WORKFLOW_ID,
        wakeKind: 'sleep',
        expectedEngineId: ENGINE_ID,
        expectedEpoch: 1,
      });
      expect(result.status).toBe('discarded');
      expect(captured).toHaveLength(1);
      expect(captured[0]).toBeInstanceOf(WeftWorkflowWakeDiscardedWarning);
    } finally {
      process.emitWarning = originalEmitWarning;
    }
  });
});

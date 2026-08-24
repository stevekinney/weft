import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { encode } from '../codec.ts';
import type { WorkflowState } from '../types.ts';
import { encodeWorkflowClaimHolder } from './workflow-claim-codec.ts';
import { listWorkflowClaimReclaimCandidates } from './workflow-claim-reclaim-scan.ts';

async function putHolder(storage: MemoryStorage, workflowId: string): Promise<void> {
  await storage.put(
    KEYS.workflowOwnerHolder(workflowId),
    encodeWorkflowClaimHolder({
      engineId: 'some-engine',
      epoch: 1,
      expiresAt: 1_000,
      claimedAt: 500,
    }),
  );
}

function createWorkflowState(
  workflowId: string,
  overrides: Partial<WorkflowState> = {},
): WorkflowState {
  return {
    createdAt: 1_000,
    id: workflowId,
    input: null,
    startedAt: 1_000,
    status: 'running',
    type: 'workflow',
    updatedAt: 1_000,
    versionTuple: { workflowVersion: '1' },
    ...overrides,
  };
}

/** Writes both the workflow-state record AND its `running`-status visibility index entry, mirroring what a real start/checkpoint commit does. */
async function putRunningWorkflow(
  storage: MemoryStorage,
  workflowId: string,
  overrides: Partial<WorkflowState> = {},
): Promise<void> {
  const state = createWorkflowState(workflowId, overrides);
  await storage.put(KEYS.workflow(workflowId), encode(state));
  await storage.put(KEYS.workflowVisibilityStatus(state.status, workflowId), new Uint8Array(0));
}

describe('listWorkflowClaimReclaimCandidates', () => {
  it('returns an empty list when no holder records exist', async () => {
    const storage = new MemoryStorage();

    const candidates = await listWorkflowClaimReclaimCandidates(storage, new Set());

    expect(candidates).toEqual([]);
  });

  it('lists every workflow id with a currently-persisted holder record', async () => {
    const storage = new MemoryStorage();
    await putHolder(storage, 'wf-1');
    await putHolder(storage, 'wf-2');

    const candidates = await listWorkflowClaimReclaimCandidates(storage, new Set());

    expect(new Set(candidates)).toEqual(new Set(['wf-1', 'wf-2']));
  });

  it('excludes ids already in excludeWorkflowIds', async () => {
    const storage = new MemoryStorage();
    await putHolder(storage, 'wf-1');
    await putHolder(storage, 'wf-2');

    const candidates = await listWorkflowClaimReclaimCandidates(storage, new Set(['wf-1']));

    expect(candidates).toEqual(['wf-2']);
  });

  it('round-trips a workflow id containing storage-key separator characters', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'workflow:with:colons/and%percent';
    await putHolder(storage, workflowId);

    const candidates = await listWorkflowClaimReclaimCandidates(storage, new Set());

    expect(candidates).toEqual([workflowId]);
  });

  it('skips an entry whose key component is malformed percent-encoding', async () => {
    const storage = new MemoryStorage();
    await storage.put(
      `${KEYS.workflowOwnerHolder('')}%E0%A4%A`,
      encodeWorkflowClaimHolder({
        engineId: 'some-engine',
        epoch: 1,
        expiresAt: 1_000,
        claimedAt: 500,
      }),
    );
    await putHolder(storage, 'wf-good');

    const candidates = await listWorkflowClaimReclaimCandidates(storage, new Set());

    expect(candidates).toEqual(['wf-good']);
  });

  it('does not scan keys outside the holder prefix', async () => {
    const storage = new MemoryStorage();
    await storage.put(KEYS.workflowOwnerEpoch('wf-1'), new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]));
    await putHolder(storage, 'wf-2');

    const candidates = await listWorkflowClaimReclaimCandidates(storage, new Set());

    expect(candidates).toEqual(['wf-2']);
  });

  describe('ownerless-but-running discovery (WFT-79 Finding 3)', () => {
    it('includes a running workflow with NO holder record at all — the rolling-handoff gap the holder-keyed scan alone misses', async () => {
      const storage = new MemoryStorage();
      await putRunningWorkflow(storage, 'wf-ownerless');

      const candidates = await listWorkflowClaimReclaimCandidates(storage, new Set());

      expect(candidates).toEqual(['wf-ownerless']);
    });

    it('does not include a running workflow that already has a holder record — the holder scan already covers it', async () => {
      const storage = new MemoryStorage();
      await putRunningWorkflow(storage, 'wf-owned');
      await putHolder(storage, 'wf-owned');

      const candidates = await listWorkflowClaimReclaimCandidates(storage, new Set());

      // Exactly once, not duplicated across the two scans.
      expect(candidates).toEqual(['wf-owned']);
    });

    it('does not include a non-running workflow, even with no holder record', async () => {
      const storage = new MemoryStorage();
      await putRunningWorkflow(storage, 'wf-done', { status: 'completed' });

      const candidates = await listWorkflowClaimReclaimCandidates(storage, new Set());

      expect(candidates).toEqual([]);
    });

    it('excludes an ownerless-running id already in excludeWorkflowIds', async () => {
      const storage = new MemoryStorage();
      await putRunningWorkflow(storage, 'wf-ownerless');

      const candidates = await listWorkflowClaimReclaimCandidates(
        storage,
        new Set(['wf-ownerless']),
      );

      expect(candidates).toEqual([]);
    });

    it('combines holder-keyed candidates with ownerless-but-running candidates in one pass', async () => {
      const storage = new MemoryStorage();
      await putHolder(storage, 'wf-stranded');
      await putRunningWorkflow(storage, 'wf-ownerless');

      const candidates = await listWorkflowClaimReclaimCandidates(storage, new Set());

      expect(new Set(candidates)).toEqual(new Set(['wf-stranded', 'wf-ownerless']));
    });

    it('the exact rolling-handoff sequence: outgoing engine releases while incoming engine is already running, then a later scan finds the now-ownerless workflow', async () => {
      const storage = new MemoryStorage();
      // Incoming engine boots and starts a workflow WHILE some OTHER, still-live
      // engine holds a DIFFERENT workflow's claim — modeled directly as two
      // independent running workflows, one with a holder (the "still overlapping"
      // outgoing engine) and one already reclaimed by the incoming engine.
      await putRunningWorkflow(storage, 'wf-handoff');
      await putHolder(storage, 'wf-handoff'); // outgoing engine's live holder.

      // A first scan, while the outgoing engine is still live, correctly finds
      // it only via the holder-keyed path (not yet ownerless).
      const whileLive = await listWorkflowClaimReclaimCandidates(storage, new Set());
      expect(whileLive).toEqual(['wf-handoff']);

      // Outgoing engine disposes gracefully: `releaseAll()` deletes the holder
      // record WITHOUT rotating the epoch (ADR 0002's `release` row) — the
      // workflow stays `running` with no holder at all.
      await storage.delete(KEYS.workflowOwnerHolder('wf-handoff'));

      // The already-running incoming engine's NEXT recurring scan must still
      // find it — via the ownerless-but-running path this time, since the
      // holder-keyed scan alone has nothing left to enumerate.
      const afterRelease = await listWorkflowClaimReclaimCandidates(storage, new Set());
      expect(afterRelease).toEqual(['wf-handoff']);
    });
  });
});

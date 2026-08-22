import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
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
});

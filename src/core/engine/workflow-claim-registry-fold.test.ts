/**
 * Coverage for {@link WorkflowClaimRegistry.prepareAcquireFragment} and
 * {@link WorkflowClaimRegistry.recordFoldedAcquire} — the two-step seam that
 * lets a caller fold `acquire` into ITS OWN atomic enabling write instead of
 * letting `acquire()` commit the fragment alone (ADR 0002 § Ownership
 * transitions). `workflow-claim-registry.test.ts` covers the pre-existing
 * `acquire`/`renew`/`release`/`takeover`/`releaseAll` surface and stays
 * untouched by this file.
 */
import { describe, expect, it } from 'bun:test';

import { KEYS, storageConditionalBatch, type Storage } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { decodeEpoch, encodeEpoch } from './workflow-claim-codec.ts';
import {
  WorkflowClaimRegistry,
  type WorkflowClaimRegistryOptions,
} from './workflow-claim-registry.ts';
import type { WorkflowClaimTransitionFragment } from './workflow-claim-transitions.ts';

const TTL_MS = 30_000;
const RENEW_MS = 5_000;

function registryOptions(
  overrides: Partial<WorkflowClaimRegistryOptions> &
    Pick<WorkflowClaimRegistryOptions, 'storage' | 'getNow'>,
): WorkflowClaimRegistryOptions {
  return {
    engineId: 'engine-a',
    claimTtlMs: TTL_MS,
    claimRenewIntervalMs: RENEW_MS,
    ...overrides,
  };
}

async function readEpoch(storage: Storage, workflowId: string): Promise<number | null> {
  const raw = await storage.get(KEYS.workflowOwnerEpoch(workflowId));
  return raw === null ? null : decodeEpoch(raw);
}

/** Commit `fragment` exactly as a real "folded" enabling write would — a bare `storageConditionalBatch`, never through the registry itself. */
async function commitFragmentAsExternalCaller(
  storage: Storage,
  fragment: WorkflowClaimTransitionFragment,
): Promise<boolean> {
  return storageConditionalBatch(storage, fragment.conditions, fragment.operations);
}

describe('WorkflowClaimRegistry.prepareAcquireFragment / recordFoldedAcquire', () => {
  it('mints epoch 1 for a never-before-seen workflow id and leaves the registry untracked until recorded', async () => {
    const storage = new MemoryStorage();
    const registry = new WorkflowClaimRegistry(registryOptions({ storage, getNow: () => 1_000 }));

    const preparation = await registry.prepareAcquireFragment('wf-fresh');

    expect(preparation.epoch).toBe(1);
    expect(preparation.claimedAt).toBe(1_000);
    expect(preparation.fragment.conditions).toEqual([
      { key: KEYS.workflowOwnerHolder('wf-fresh'), expectedValue: null },
      { key: KEYS.workflowOwnerEpoch('wf-fresh'), expectedValue: null },
    ]);
    // Preparing alone must not commit or track anything.
    expect(await storage.get(KEYS.workflowOwnerEpoch('wf-fresh'))).toBeNull();
    expect(registry.currentEpoch('wf-fresh')).toBeNull();
  });

  it('mints the successor of the true prior epoch for a previously claimed-and-released id — the ABA-safety property', async () => {
    const storage = new MemoryStorage();
    await storage.put(KEYS.workflowOwnerEpoch('wf-reused'), encodeEpoch(7));
    const registry = new WorkflowClaimRegistry(registryOptions({ storage, getNow: () => 1_000 }));

    const preparation = await registry.prepareAcquireFragment('wf-reused');

    expect(preparation.epoch).toBe(8);
    expect(preparation.fragment.conditions[1]).toEqual({
      key: KEYS.workflowOwnerEpoch('wf-reused'),
      expectedValue: encodeEpoch(7),
    });
  });

  it('re-reads fresh bytes on every call — a second preparation after a competitor commits reflects the new epoch', async () => {
    const storage = new MemoryStorage();
    const registry = new WorkflowClaimRegistry(registryOptions({ storage, getNow: () => 1_000 }));

    const first = await registry.prepareAcquireFragment('wf-contended');
    // A competitor's fragment lands between this registry's two prepare calls.
    const committed = await commitFragmentAsExternalCaller(storage, first.fragment);
    expect(committed).toBe(true);

    const second = await registry.prepareAcquireFragment('wf-contended');
    expect(second.epoch).toBe(2);
    // The holder condition is always "expected absent"; the epoch condition
    // is what proves the second preparation re-read the just-committed state.
    expect(second.fragment.conditions[1]?.expectedValue).toEqual(encodeEpoch(1));
  });

  it('a successful folded commit is round-trip usable by renew() and release() after recordFoldedAcquire', async () => {
    const storage = new MemoryStorage();
    const registry = new WorkflowClaimRegistry(registryOptions({ storage, getNow: () => 1_000 }));

    const preparation = await registry.prepareAcquireFragment('wf-folded');
    const committed = await commitFragmentAsExternalCaller(storage, preparation.fragment);
    expect(committed).toBe(true);
    expect(registry.currentEpoch('wf-folded')).toBeNull(); // not yet recorded

    registry.recordFoldedAcquire('wf-folded', preparation);

    expect(registry.currentEpoch('wf-folded')).toBe(1);
    expect(await readEpoch(storage, 'wf-folded')).toBe(1);

    const renewed = await registry.renew('wf-folded');
    expect(renewed).toEqual({ status: 'renewed', workflowId: 'wf-folded' });

    const released = await registry.release('wf-folded');
    expect(released).toEqual({ status: 'released', workflowId: 'wf-folded' });
    expect(registry.currentEpoch('wf-folded')).toBeNull();
    // The epoch key is permanently retained even after release.
    expect(await readEpoch(storage, 'wf-folded')).toBe(1);
  });

  it('recordFoldedAcquire never touches storage itself — only local tracking', async () => {
    const storage = new MemoryStorage();
    const registry = new WorkflowClaimRegistry(registryOptions({ storage, getNow: () => 1_000 }));

    // Deliberately record WITHOUT committing the fragment first, to prove
    // recordFoldedAcquire performs no IO of its own — it only extracts bytes
    // already present on the fragment and installs local tracking state.
    const preparation = await registry.prepareAcquireFragment('wf-uncommitted');
    registry.recordFoldedAcquire('wf-uncommitted', preparation);

    expect(registry.currentEpoch('wf-uncommitted')).toBe(1);
    expect(await storage.get(KEYS.workflowOwnerEpoch('wf-uncommitted'))).toBeNull();
  });
});

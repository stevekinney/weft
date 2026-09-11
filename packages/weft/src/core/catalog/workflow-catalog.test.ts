import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { buildWorkflowContract } from '../contract/build.ts';
import { buildWorkflowRevisionManifest } from '../contract/manifest.ts';
import type { WorkflowRevisionManifest } from '../contract/types.ts';
import type { RegisteredWorkflowDefinition } from '../types/workflow-registry.ts';
import {
  WorkflowCatalogActivationConflictError,
  WorkflowCatalogActiveEntryMissingError,
  WorkflowCatalogConflictError,
  WorkflowRevisionNotInstalledError,
  WorkflowRevisionTombstonedError,
} from './errors.ts';
import { WorkflowCatalog } from './workflow-catalog.ts';

function fakeDefinition(type: string): RegisteredWorkflowDefinition {
  return { type, version: '1.0.0', tags: [] };
}

async function manifestFor(
  name: string,
  version: string,
  overrides?: { revision?: string; description?: string },
): Promise<WorkflowRevisionManifest> {
  const contract = buildWorkflowContract({
    name,
    version,
    ...(overrides?.description === undefined ? {} : { description: overrides.description }),
  });
  return buildWorkflowRevisionManifest(
    contract,
    overrides?.revision === undefined ? undefined : { revision: overrides.revision },
  );
}

describe('WorkflowCatalog.install', () => {
  it('installs two distinct revisions of the same workflow without overwriting either', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const v1 = await manifestFor('checkout', '1.0.0');
    const v2 = await manifestFor('checkout', '2.0.0');

    await catalog.install(v1, fakeDefinition('checkout'));
    await catalog.install(v2, fakeDefinition('checkout'));

    expect(catalog.getEntry('checkout', v1.revision)?.manifest.revision).toBe(v1.revision);
    expect(catalog.getEntry('checkout', v2.revision)?.manifest.revision).toBe(v2.revision);
    expect(catalog.listRevisions('checkout')).toHaveLength(2);
  });

  it('is a no-op for a byte-identical reinstall of the same (name, revision)', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const manifest = await manifestFor('checkout', '1.0.0');

    const first = await catalog.install(manifest, fakeDefinition('checkout'));
    const second = await catalog.install(manifest, fakeDefinition('checkout'));

    expect(second).toBe(first);
    expect(catalog.listRevisions('checkout')).toHaveLength(1);
  });

  it('throws WorkflowCatalogConflictError for differing metadata under an existing (name, revision) key', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const manifest = await manifestFor('checkout', '1.0.0', { revision: 'pinned-1' });
    const conflicting = await manifestFor('checkout', '2.0.0', { revision: 'pinned-1' });

    await catalog.install(manifest, fakeDefinition('checkout'));

    await expect(catalog.install(conflicting, fakeDefinition('checkout'))).rejects.toThrow(
      WorkflowCatalogConflictError,
    );
  });

  it('rejects conflicting metadata for an existing key even when the conflict is only visible durably, from a DIFFERENT WorkflowCatalog instance sharing storage', async () => {
    const storage = new MemoryStorage();
    // Two independently-seeded instances sharing one durable store — the
    // cross-process shape: neither instance's in-memory `#entries` cache
    // knows what the other has installed.
    const writer = new WorkflowCatalog(storage);
    const reader = new WorkflowCatalog(storage);
    const manifest = await manifestFor('checkout', '1.0.0', { revision: 'pinned-1' });
    const conflicting = await manifestFor('checkout', '2.0.0', { revision: 'pinned-1' });

    await writer.install(manifest, fakeDefinition('checkout'));

    // `reader` has never seen `pinned-1` in its own cache, but durable
    // storage already holds different content under that exact key —
    // `install()` must read through and reject, not silently last-write-win.
    await expect(reader.install(conflicting, fakeDefinition('checkout'))).rejects.toThrow(
      WorkflowCatalogConflictError,
    );

    // The durable record is untouched by the rejected write.
    const third = new WorkflowCatalog(storage);
    const adopted = await third.install(manifest, fakeDefinition('checkout'));
    expect(adopted.manifest.workflowVersion).toBe(manifest.workflowVersion);
  });

  it('adopts a byte-identical durable entry installed by a DIFFERENT WorkflowCatalog instance as an idempotent no-op', async () => {
    const storage = new MemoryStorage();
    const writer = new WorkflowCatalog(storage);
    const reader = new WorkflowCatalog(storage);
    const manifest = await manifestFor('checkout', '1.0.0', { revision: 'pinned-1' });
    const sameContentDifferentObject = await manifestFor('checkout', '1.0.0', {
      revision: 'pinned-1',
    });

    const original = await writer.install(manifest, fakeDefinition('checkout'));
    const adopted = await reader.install(sameContentDifferentObject, fakeDefinition('checkout'));

    expect(adopted.installedAt).toBe(original.installedAt);
    expect(reader.getEntry('checkout', 'pinned-1')).toBeDefined();
  });

  it('refuses to resurrect a revision whose removal has written a tombstone (WFT-21, Codex review items 1-3)', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const manifest = await manifestFor('checkout', '1.0.0', { revision: 'pinned-1' });

    // Simulate `removeCatalogEntry()` having already deleted the entry and
    // written its tombstone in the same `conditionalBatch` — the exact
    // durable state a fork's dynamic-source load can observe mid-removal,
    // before the tombstone is resolved (restored or finalized).
    await storage.put(
      KEYS.catalogTombstone('checkout', 'pinned-1'),
      new TextEncoder().encode(JSON.stringify({ manifest, installedAt: Date.now() })),
    );

    await expect(catalog.install(manifest, fakeDefinition('checkout'))).rejects.toThrow(
      WorkflowRevisionTombstonedError,
    );
    // No entry was resurrected.
    expect(catalog.getEntry('checkout', 'pinned-1')).toBeUndefined();
    expect(await storage.get(KEYS.catalogEntry('checkout', 'pinned-1'))).toBeNull();
  });

  it('installs a fresh (name, revision) normally once its tombstone has been resolved (finalized)', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const manifest = await manifestFor('checkout', '1.0.0', { revision: 'pinned-1' });

    // A tombstone that already existed and was resolved would have been
    // deleted by the resolver — simulate that by never writing one at all,
    // confirming the tombstone condition does not spuriously block a
    // perfectly ordinary fresh install.
    const installed = await catalog.install(manifest, fakeDefinition('checkout'));
    expect(installed.manifest.revision).toBe('pinned-1');
  });

  it('throws WorkflowCatalogConflictError (not a tombstoned refusal) when a fenced install loses its CAS to a genuine concurrent writer with no removal in play (WFT-21, Codex review round 14, P1 item Q7jH)', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const manifest = await manifestFor('checkout', '1.0.0', { revision: 'pinned-1' });

    // Force this install's own write CAS to report a lost race, simulating
    // a genuine concurrent writer — no removal is involved at all, so the
    // durable removal-generation counter stays absent (`null`) throughout.
    const originalConditionalBatch = storage.conditionalBatch.bind(storage);
    let intercepted = false;
    storage.conditionalBatch = async (conditions, operations) => {
      if (!intercepted) {
        intercepted = true;
        return false;
      }
      return originalConditionalBatch(conditions, operations);
    };

    await expect(
      catalog.install(manifest, fakeDefinition('checkout'), { removalGeneration: null }),
    ).rejects.toThrow(WorkflowCatalogConflictError);
  });

  it('defensively rejects an invalid workflow name even for a hand-built manifest', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const manifest = await manifestFor('checkout', '1.0.0');
    const invalid = { ...manifest, name: '1invalid' } as WorkflowRevisionManifest;

    await expect(catalog.install(invalid, fakeDefinition('1invalid'))).rejects.toThrow();
  });

  it('revalidates a cache hit against durable storage rather than trusting it outright — a peer that durably removed and tombstoned this exact entry is not masked by a stale cache hit (WFT-21, Codex review round 14, P1 item TYR4)', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const manifest = await manifestFor('checkout', '1.0.0', { revision: 'pinned-1' });

    await catalog.install(manifest, fakeDefinition('checkout'));
    expect(catalog.getEntry('checkout', 'pinned-1')).toBeDefined();

    // Simulate a peer's `remove()` + tombstone write landing durably WITHOUT
    // ever touching this process's own in-memory `#entries` cache — the
    // exact durable state a peer removal leaves behind while a stale cache
    // hit here still believes the revision installed.
    await storage.delete(KEYS.catalogEntry('checkout', 'pinned-1'));
    await storage.put(
      KEYS.catalogTombstone('checkout', 'pinned-1'),
      new TextEncoder().encode(JSON.stringify({ manifest, installedAt: Date.now() })),
    );

    // Before this fix, the cache hit above short-circuited, returning the
    // stale entry without ever reading durable storage. Now it revalidates,
    // finds the entry durably absent, evicts the stale cache entry, and
    // falls through to the ordinary not-cached path — which fails closed on
    // the tombstone exactly like a genuinely fresh install would.
    await expect(catalog.install(manifest, fakeDefinition('checkout'))).rejects.toThrow(
      WorkflowRevisionTombstonedError,
    );
    expect(catalog.getEntry('checkout', 'pinned-1')).toBeUndefined();
  });
});

describe('WorkflowCatalog.activateRegistered', () => {
  it('activates the first installed revision at generation 1', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const manifest = await manifestFor('checkout', '1.0.0');

    const pointer = await catalog.activateRegistered(
      'checkout',
      manifest,
      fakeDefinition('checkout'),
    );

    expect(pointer.revision).toBe(manifest.revision);
    expect(pointer.generation).toBe(1);
    expect(catalog.resolveActive('checkout')).toEqual(pointer);
  });

  it('reactivating the same revision is a no-op: generation is unchanged', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const manifest = await manifestFor('checkout', '1.0.0');

    const first = await catalog.activateRegistered(
      'checkout',
      manifest,
      fakeDefinition('checkout'),
    );
    const second = await catalog.activateRegistered(
      'checkout',
      manifest,
      fakeDefinition('checkout'),
    );

    expect(second.generation).toBe(first.generation);
    expect(second.revision).toBe(first.revision);
  });

  it('activating a different revision bumps the generation by exactly 1', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const v1 = await manifestFor('checkout', '1.0.0');
    const v2 = await manifestFor('checkout', '2.0.0');

    const first = await catalog.activateRegistered('checkout', v1, fakeDefinition('checkout'));
    const second = await catalog.activateRegistered('checkout', v2, fakeDefinition('checkout'));

    expect(second.generation).toBe(first.generation + 1);
    expect(second.revision).toBe(v2.revision);
  });

  it('converges to exactly one commit under concurrent activateRegistered calls', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const v1 = await manifestFor('checkout', '1.0.0');
    const v2 = await manifestFor('checkout', '2.0.0');
    await catalog.install(v1, fakeDefinition('checkout'));
    await catalog.install(v2, fakeDefinition('checkout'));

    await Promise.all([
      catalog.activateRegistered('checkout', v1, fakeDefinition('checkout')),
      catalog.activateRegistered('checkout', v2, fakeDefinition('checkout')),
    ]);

    // Two concurrent activations of two DIFFERENT revisions must produce
    // exactly two durable generation bumps total (one CAS win each, via
    // retry for whichever call lost the first race) — never corrupted state
    // (a torn write) and never a lost update (only one bump landing).
    const final = catalog.resolveActive('checkout');
    expect(final).toBeDefined();
    expect(final?.generation).toBe(2);
    expect([v1.revision, v2.revision]).toContain(final?.revision ?? '');
  });

  it('throws WorkflowCatalogActivationConflictError after exhausting the 5-attempt CAS retry budget', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const manifest = await manifestFor('checkout', '1.0.0');
    // Install (a real, unstubbed conditionalBatch write) before stubbing —
    // this test exercises exhaustion of `activateRegistered`'s OWN
    // active-pointer CAS retry loop, not `install()`'s CAS-guarded entry
    // write, so the entry must already be durably installed first.
    await catalog.install(manifest, fakeDefinition('checkout'));
    storage.conditionalBatch = async () => false;

    await expect(
      catalog.activateRegistered('checkout', manifest, fakeDefinition('checkout')),
    ).rejects.toThrow(WorkflowCatalogActivationConflictError);
  });

  it("fences the active-pointer CAS on the candidate entry's own bytes and reinstalls (rather than fails) when a peer removes it mid-activation (WFT-21, Codex review round 14, P1 item UXP7)", async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const manifest = await manifestFor('checkout', '1.0.0', { revision: 'pinned-1' });

    // Intercept `conditionalBatch` to delete the candidate entry the moment
    // `activateRegistered`'s OWN pointer-write CAS is attempted — after its
    // internal `install()` call has already completed, simulating a peer
    // removal landing in the exact gap the fence exists to close.
    const originalConditionalBatch = storage.conditionalBatch.bind(storage);
    let interceptedOnce = false;
    storage.conditionalBatch = async (conditions, operations) => {
      const isActivePointerWrite = operations.some(
        (op) => op.type === 'put' && op.key === KEYS.catalogActive('checkout'),
      );
      if (isActivePointerWrite && !interceptedOnce) {
        interceptedOnce = true;
        await storage.delete(KEYS.catalogEntry('checkout', 'pinned-1'));
      }
      return originalConditionalBatch(conditions, operations);
    };

    const pointer = await catalog.activateRegistered(
      'checkout',
      manifest,
      fakeDefinition('checkout'),
    );

    // Unlike `activateCandidate`, this call owns the manifest/definition
    // content directly, so it reinstalls and succeeds rather than throwing
    // — the "unconditional, never hard-fails construction" contract.
    expect(pointer.revision).toBe('pinned-1');
    expect(catalog.resolveActive('checkout')?.revision).toBe('pinned-1');
    expect(await storage.get(KEYS.catalogEntry('checkout', 'pinned-1'))).not.toBeNull();
  });

  it('retries the whole iteration instead of committing a null candidate-entry precondition when a peer removes the reinstalled candidate AGAIN before the reread (WFT-21, Codex review round 15, P2 item U4Jg)', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const manifest = await manifestFor('checkout', '1.0.0', { revision: 'pinned-1' });
    const entryKey = KEYS.catalogEntry('checkout', 'pinned-1');

    // Sabotage the FIRST two durable entry writes (each `conditionalBatch`
    // call that successfully puts the entry key), deleting the entry again
    // immediately after each one commits — simulating a peer removing it a
    // moment later, twice in a row. The third write is left alone so
    // `activateRegistered()` eventually converges.
    const originalConditionalBatch = storage.conditionalBatch.bind(storage);
    let entryWriteCount = 0;
    storage.conditionalBatch = async (conditions, operations) => {
      const isEntryWrite = operations.some((op) => op.type === 'put' && op.key === entryKey);
      const result = await originalConditionalBatch(conditions, operations);
      if (isEntryWrite && result) {
        entryWriteCount += 1;
        if (entryWriteCount === 1 || entryWriteCount === 2) {
          await storage.delete(entryKey);
        }
      }
      return result;
    };

    const pointer = await catalog.activateRegistered(
      'checkout',
      manifest,
      fakeDefinition('checkout'),
    );

    // Before this fix, the SECOND null re-read (after the first reinstall)
    // would have been passed straight into the pointer-write CAS as its
    // candidate-entry precondition — matching the durably-absent state and
    // letting the write succeed, planting a pointer naming a missing
    // entry. It now retries instead, converging once the third write is
    // left standing.
    expect(pointer.revision).toBe('pinned-1');
    expect(catalog.resolveActive('checkout')?.revision).toBe('pinned-1');
    expect(entryWriteCount).toBe(3);
    expect(await storage.get(entryKey)).not.toBeNull();
  });
});

describe('WorkflowCatalog.activateCandidate', () => {
  it('bypasses the compatibility check for the first-ever activation of a name', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const manifest = await manifestFor('checkout', '1.0.0');

    const result = await catalog.activateCandidate('checkout', manifest);

    expect(result.applied).toBe(true);
  });

  it('applies and bumps the generation for a compatible candidate with the correct expectedGeneration', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const v1 = await manifestFor('checkout', '1.0.0', { revision: 'r1' });
    const v1Compatible = await manifestFor('checkout', '1.0.0', { revision: 'r1' });
    await catalog.activateCandidate('checkout', v1);

    const result = await catalog.activateCandidate('checkout', v1Compatible, {
      expectedGeneration: 1,
    });

    expect(result.applied).toBe(true);
  });

  it('refuses an incompatible candidate without writing, and attaches the verdict', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const v1 = await manifestFor('checkout', '1.0.0');
    const incompatible = await manifestFor('other-workflow', '1.0.0');
    await catalog.activateCandidate('checkout', v1);

    const result = await catalog.activateCandidate('checkout', incompatible, {
      expectedGeneration: 1,
    });

    expect(result.applied).toBe(false);
    if (!result.applied && result.reason === 'incompatible') {
      expect(result.verdict.compatible).toBe(false);
    } else {
      throw new Error('expected an incompatible refusal');
    }
    expect(catalog.resolveActive('checkout')?.revision).toBe(v1.revision);
  });

  it('refuses a stale expectedGeneration without writing', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const v1 = await manifestFor('checkout', '1.0.0');
    const v2 = await manifestFor('checkout', '2.0.0');
    await catalog.activateCandidate('checkout', v1);

    const result = await catalog.activateCandidate('checkout', v2, { expectedGeneration: 99 });

    expect(result.applied).toBe(false);
    if (!result.applied && result.reason === 'stale-generation') {
      expect(result.currentGeneration).toBe(1);
    } else {
      throw new Error('expected a stale-generation refusal');
    }
    expect(catalog.resolveActive('checkout')?.revision).toBe(v1.revision);
  });

  it('does not retry on a single lost CAS race: reports conflict', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const v1 = await manifestFor('checkout', '1.0.0');
    await catalog.activateCandidate('checkout', v1);
    storage.conditionalBatch = async () => false;

    // A compatible candidate (the same already-active revision, so every
    // `checkWorkflowCompatibility` reason passes trivially) whose CAS write
    // itself fails — the lost-race path, distinct from `incompatible`.
    const result = await catalog.activateCandidate('checkout', v1, { expectedGeneration: 1 });

    expect(result.applied).toBe(false);
    if (!result.applied) {
      expect(result.reason).toBe('conflict');
    }
  });

  it('enforces compatibility against a cross-process active revision this instance never cached (durable read-through, not a silent skip)', async () => {
    const storage = new MemoryStorage();
    const writer = new WorkflowCatalog(storage);
    const v1 = await manifestFor('checkout', '1.0.0');
    await writer.activateCandidate('checkout', v1);

    // A second instance sharing the same storage — e.g. a second process —
    // never called `install`/`activateCandidate` for `checkout` itself, so
    // its in-memory `#entries` cache has no entry for v1 even though v1 is
    // durably active. Before this fix, `getEntry`'s cache-only lookup would
    // return `undefined` here and `#refuseIncompatibleCandidate` would
    // treat the comparison as vacuously compatible, silently skipping the
    // check entirely.
    const reader = new WorkflowCatalog(storage);
    const incompatible = await manifestFor('other-workflow', '1.0.0');

    const result = await reader.activateCandidate('checkout', incompatible, {
      expectedGeneration: 1,
    });

    expect(result.applied).toBe(false);
    if (!result.applied && result.reason === 'incompatible') {
      expect(result.verdict.compatible).toBe(false);
    } else {
      throw new Error('expected an incompatible refusal from the durable read-through');
    }
    expect(await reader.resolveActiveDurable('checkout')).toMatchObject({ revision: v1.revision });
  });

  it('fails closed with WorkflowCatalogActiveEntryMissingError when the durably-active revision has no resolvable entry at all', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const v1 = await manifestFor('checkout', '1.0.0');
    await catalog.activateCandidate('checkout', v1);

    // Simulate storage-level corruption: the active pointer survives but
    // its own entry does not, so neither the in-memory cache nor a durable
    // read-through can resolve it.
    await storage.delete(KEYS.catalogEntry('checkout', v1.revision));
    const v2 = await manifestFor('checkout', '2.0.0');
    const fresh = new WorkflowCatalog(storage);

    await expect(
      fresh.activateCandidate('checkout', v2, { expectedGeneration: 1 }),
    ).rejects.toThrow(WorkflowCatalogActiveEntryMissingError);
  });

  it('refuses an omitted expectedGeneration on a 2nd-or-later activation: two refreshers cannot silently last-write-win', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const v1 = await manifestFor('checkout', '1.0.0');
    const v2 = await manifestFor('checkout', '2.0.0');
    await catalog.activateCandidate('checkout', v1);

    const result = await catalog.activateCandidate('checkout', v2);

    expect(result.applied).toBe(false);
    if (!result.applied && result.reason === 'expected-generation-required') {
      expect(result.currentGeneration).toBe(1);
    } else {
      throw new Error('expected an expected-generation-required refusal');
    }
    expect(catalog.resolveActive('checkout')?.revision).toBe(v1.revision);
  });

  it('still applies an explicit expectedGeneration: 0 on the very first activation (no active pointer yet)', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const manifest = await manifestFor('checkout', '1.0.0');

    const result = await catalog.activateCandidate('checkout', manifest, { expectedGeneration: 0 });

    expect(result.applied).toBe(true);
  });

  it('refuses a non-zero explicit expectedGeneration on the very first activation as stale-generation', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const manifest = await manifestFor('checkout', '1.0.0');

    const result = await catalog.activateCandidate('checkout', manifest, { expectedGeneration: 5 });

    expect(result.applied).toBe(false);
    if (!result.applied && result.reason === 'stale-generation') {
      expect(result.currentGeneration).toBe(0);
    } else {
      throw new Error('expected a stale-generation refusal');
    }
    expect(catalog.resolveActive('checkout')).toBeUndefined();
  });

  it("fences the active-pointer CAS on the candidate entry's own bytes: a peer's removal landing exactly between the read and the commit loses the pointer write, not just the earlier install() call", async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const manifest = await manifestFor('checkout', '1.0.0', { revision: 'pinned-1' });

    // Intercept `conditionalBatch` to delete the candidate entry the moment
    // `activateCandidate`'s OWN pointer-write CAS is attempted — after its
    // internal `install()` call (and the entry-bytes read that follows it)
    // has already completed, simulating a peer removal landing in the exact
    // gap the fence exists to close.
    const originalConditionalBatch = storage.conditionalBatch.bind(storage);
    let interceptedOnce = false;
    storage.conditionalBatch = async (conditions, operations) => {
      const isActivePointerWrite = operations.some(
        (op) => op.type === 'put' && op.key === KEYS.catalogActive('checkout'),
      );
      if (isActivePointerWrite && !interceptedOnce) {
        interceptedOnce = true;
        await storage.delete(KEYS.catalogEntry('checkout', 'pinned-1'));
      }
      return originalConditionalBatch(conditions, operations);
    };

    await expect(catalog.activateCandidate('checkout', manifest)).rejects.toThrow(
      WorkflowRevisionNotInstalledError,
    );
    expect(catalog.resolveActive('checkout')).toBeUndefined();
    expect(await storage.get(KEYS.catalogActive('checkout'))).toBeNull();
  });
});

describe('WorkflowCatalog.resolveEntry', () => {
  it('resolves a previously-cached entry (revalidated durably) to the correct record', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const manifest = await manifestFor('checkout', '1.0.0');
    await catalog.install(manifest, fakeDefinition('checkout'));

    const resolved = await catalog.resolveEntry('checkout', manifest.revision);

    expect(resolved?.manifest.revision).toBe(manifest.revision);
  });

  it('resolves to undefined once a peer durably removes the entry, even though this instance still has it cached (WFT-21, Codex review round 14, P2 item UXP-)', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const manifest = await manifestFor('checkout', '1.0.0', { revision: 'pinned-1' });
    await catalog.install(manifest, fakeDefinition('checkout'));
    expect(catalog.getEntry('checkout', 'pinned-1')).toBeDefined();

    // Simulate a peer's `remove()` durably deleting the entry WITHOUT
    // touching this process's own in-memory cache.
    await storage.delete(KEYS.catalogEntry('checkout', 'pinned-1'));

    const resolved = await catalog.resolveEntry('checkout', 'pinned-1');

    expect(resolved).toBeUndefined();
    expect(catalog.getEntry('checkout', 'pinned-1')).toBeUndefined();
  });

  it('reads through to durable storage for an entry installed by a different instance', async () => {
    const storage = new MemoryStorage();
    const writer = new WorkflowCatalog(storage);
    const reader = new WorkflowCatalog(storage);
    const manifest = await manifestFor('checkout', '1.0.0');
    await writer.install(manifest, fakeDefinition('checkout'));

    const resolved = await reader.resolveEntry('checkout', manifest.revision);

    expect(resolved?.manifest.revision).toBe(manifest.revision);
    expect(resolved?.manifest.workflowVersion).toBe(manifest.workflowVersion);
  });

  it('resolves to undefined for an unknown (name, revision) pair', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);

    const resolved = await catalog.resolveEntry('checkout', 'nonexistent-revision');

    expect(resolved).toBeUndefined();
  });

  it('has no TOCTOU gap against a concurrent install() on the same instance', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const manifest = await manifestFor('checkout', '1.0.0');

    const [resolved] = await Promise.all([
      catalog.resolveEntry('checkout', manifest.revision),
      catalog.install(manifest, fakeDefinition('checkout')),
    ]);

    // JS is single-threaded with no yield point inside install() before its
    // cache write on the fast (already-installed) path relevant here — this
    // proves the concurrent pair converges to a consistent final state
    // rather than the resolve landing on a torn intermediate one.
    expect(resolved === undefined || resolved.manifest.revision === manifest.revision).toBe(true);
    const final = await catalog.resolveEntry('checkout', manifest.revision);
    expect(final?.manifest.revision).toBe(manifest.revision);
  });
});

describe('WorkflowCatalog.listInstalledRevisions', () => {
  it('lists every installed revision of a name, sorted by codepoint', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const v1 = await manifestFor('checkout', '1.0.0', { revision: 'b-revision' });
    const v2 = await manifestFor('checkout', '2.0.0', { revision: 'a-revision' });
    await catalog.install(v1, fakeDefinition('checkout'));
    await catalog.install(v2, fakeDefinition('checkout'));

    const revisions = await catalog.listInstalledRevisions('checkout');

    expect(revisions.map((r) => r.manifest.revision)).toEqual(['a-revision', 'b-revision']);
  });

  it('returns an empty array for an unknown workflow name', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);

    const revisions = await catalog.listInstalledRevisions('nonexistent');

    expect(revisions).toEqual([]);
  });

  it('reads durable entries installed by a different instance sharing storage', async () => {
    const storage = new MemoryStorage();
    const writer = new WorkflowCatalog(storage);
    const reader = new WorkflowCatalog(storage);
    const v1 = await manifestFor('checkout', '1.0.0');
    await writer.install(v1, fakeDefinition('checkout'));

    const revisions = await reader.listInstalledRevisions('checkout');

    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.manifest.revision).toBe(v1.revision);
  });
});

describe('WorkflowCatalog.hasInstalled', () => {
  it('is false for a never-installed (name, revision)', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    expect(await catalog.hasInstalled('checkout', 'unknown')).toBe(false);
  });

  it('is true from the in-memory cache after this instance installs', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const manifest = await manifestFor('checkout', '1.0.0');
    await catalog.install(manifest, fakeDefinition('checkout'));
    expect(await catalog.hasInstalled('checkout', manifest.revision)).toBe(true);
  });

  it('is true via a durable read-through when a DIFFERENT instance installed it', async () => {
    const storage = new MemoryStorage();
    const writer = new WorkflowCatalog(storage);
    const reader = new WorkflowCatalog(storage);
    const manifest = await manifestFor('checkout', '1.0.0');
    await writer.install(manifest, fakeDefinition('checkout'));

    expect(await reader.hasInstalled('checkout', manifest.revision)).toBe(true);
  });

  it('is false once a peer durably removes the entry, even though this instance still has it cached (WFT-21, Codex review round 14, P2 item UXP-)', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const manifest = await manifestFor('checkout', '1.0.0', { revision: 'pinned-1' });
    await catalog.install(manifest, fakeDefinition('checkout'));
    expect(catalog.getEntry('checkout', 'pinned-1')).toBeDefined();

    // Simulate a peer's `remove()` durably deleting the entry WITHOUT
    // touching this process's own in-memory cache, which still believes it
    // installed.
    await storage.delete(KEYS.catalogEntry('checkout', 'pinned-1'));

    expect(await catalog.hasInstalled('checkout', 'pinned-1')).toBe(false);
  });
});

describe('WorkflowCatalog.remove', () => {
  it('delegates to removeCatalogEntry and evicts the entry from the in-memory cache on success', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const v1 = await manifestFor('checkout', '1.0.0');
    const v2 = await manifestFor('checkout', '2.0.0');
    await catalog.activateRegistered('checkout', v1, fakeDefinition('checkout'));
    await catalog.activateRegistered('checkout', v2, fakeDefinition('checkout'));

    const result = await catalog.remove('checkout', v1.revision);

    expect(result.outcome).toBe('removed');
    // WFT-17/18: a successful removal also durably tombstones the deleted
    // bytes (see `core/catalog/removal.ts`) — `remove()` passes that
    // outcome through unchanged.
    expect(result).toHaveProperty('tombstoneBytes');
    expect(catalog.getEntry('checkout', v1.revision)).toBeUndefined();
    expect(catalog.listRevisions('checkout')).toHaveLength(1);
  });

  it('refuses to remove the active revision', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const manifest = await manifestFor('checkout', '1.0.0');
    await catalog.activateRegistered('checkout', manifest, fakeDefinition('checkout'));

    const result = await catalog.remove('checkout', manifest.revision);

    expect(result).toEqual({ outcome: 'active', activeRevision: manifest.revision });
    expect(catalog.getEntry('checkout', manifest.revision)).toBeDefined();
  });

  it('is a no-op "not-found" outcome for an unknown (name, revision)', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const result = await catalog.remove('checkout', 'unknown');
    expect(result).toEqual({ outcome: 'not-found' });
  });
});

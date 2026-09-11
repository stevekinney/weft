import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { buildWorkflowContract } from '../contract/build.ts';
import { buildWorkflowRevisionManifest } from '../contract/manifest.ts';
import type { WorkflowRevisionManifest } from '../contract/types.ts';
import type { RegisteredWorkflowDefinition } from '../types/workflow-registry.ts';
import {
  finalizeCatalogTombstone,
  removeCatalogEntry,
  restoreCatalogEntryFromTombstone,
} from './removal.ts';
import { restoreWorkflowCatalog } from './storage-io.ts';
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

describe('removeCatalogEntry', () => {
  it('is a no-op "not-found" outcome for a (name, revision) that was never installed', async () => {
    const storage = new MemoryStorage();
    const result = await removeCatalogEntry(storage, 'checkout', 'never-installed');
    expect(result).toEqual({ outcome: 'not-found' });
  });

  it('refuses removal of the active revision with an "active" outcome', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const manifest = await manifestFor('checkout', '1.0.0');
    await catalog.activateRegistered('checkout', manifest, fakeDefinition('checkout'));

    const result = await removeCatalogEntry(storage, 'checkout', manifest.revision);
    expect(result).toEqual({ outcome: 'active', activeRevision: manifest.revision });
  });

  it('removes an installed, non-active revision from durable storage', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const v1 = await manifestFor('checkout', '1.0.0');
    const v2 = await manifestFor('checkout', '2.0.0');
    await catalog.activateRegistered('checkout', v1, fakeDefinition('checkout'));
    await catalog.activateRegistered('checkout', v2, fakeDefinition('checkout'));

    const result = await removeCatalogEntry(storage, 'checkout', v1.revision);
    expect(result.outcome).toBe('removed');

    const restored = await restoreWorkflowCatalog(storage);
    expect(restored.entries.get('checkout')?.get(v1.revision)).toBeUndefined();
    expect(restored.entries.get('checkout')?.get(v2.revision)).toBeDefined();
    expect(restored.active.get('checkout')?.revision).toBe(v2.revision);

    // WFT-17/18: the delete atomically leaves a tombstone carrying the
    // exact deleted bytes — the durable record a crashed peer's removal
    // would otherwise leave unrecoverable (see `removal.ts`'s module doc).
    expect(result).toMatchObject({ outcome: 'removed' });
    const tombstoneBytes = await storage.get(KEYS.catalogTombstone('checkout', v1.revision));
    expect(tombstoneBytes).not.toBeNull();
    expect(tombstoneBytes).toEqual((result as { tombstoneBytes: Uint8Array }).tombstoneBytes);
  });

  it('is fenced on the active-pointer key, not just the entry bytes: a concurrent activation between read and CAS loses the removal to "conflict"', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const v1 = await manifestFor('checkout', '1.0.0');
    const v2 = await manifestFor('checkout', '2.0.0');
    const v3 = await manifestFor('checkout', '3.0.0');
    await catalog.activateRegistered('checkout', v1, fakeDefinition('checkout'));
    await catalog.activateRegistered('checkout', v2, fakeDefinition('checkout'));
    // v1 is now installed but not active (v2 is). Deterministically
    // interleave: the instant removeCatalogEntry reads the active-pointer
    // bytes (still v2's), land a concurrent activation of v3 BEFORE
    // removeCatalogEntry's own conditionalBatch CAS runs — so its captured
    // active-pointer expectedValue (v2's bytes) no longer matches storage
    // (now v3's bytes) by the time the CAS is attempted.
    const activeKey = KEYS.catalogActive('checkout');
    const originalGet = storage.get.bind(storage);
    let intercepted = false;
    storage.get = async (key: string) => {
      const bytes = await originalGet(key);
      if (key === activeKey && !intercepted) {
        intercepted = true;
        await catalog.activateRegistered('checkout', v3, fakeDefinition('checkout'));
      }
      return bytes;
    };

    const result = await removeCatalogEntry(storage, 'checkout', v1.revision);
    expect(result).toEqual({ outcome: 'conflict' });

    const restored = await restoreWorkflowCatalog(storage);
    expect(restored.entries.get('checkout')?.get(v1.revision)).toBeDefined();
    expect(restored.active.get('checkout')?.revision).toBe(v3.revision);
  });

  it('reports a "conflict" outcome when the entry bytes change between read and CAS', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const v1 = await manifestFor('checkout', '1.0.0');
    const v2 = await manifestFor('checkout', '2.0.0');
    await catalog.activateRegistered('checkout', v1, fakeDefinition('checkout'));
    await catalog.activateRegistered('checkout', v2, fakeDefinition('checkout'));

    // Force the conditionalBatch CAS to lose regardless of what it's
    // checking against, simulating a lost race after the reads above.
    storage.conditionalBatch = async () => false;

    const result = await removeCatalogEntry(storage, 'checkout', v1.revision);
    expect(result).toEqual({ outcome: 'conflict' });
  });

  it('bumps the durable removal-generation counter by exactly 1 on each removal, decoding an existing nonzero counter rather than only ever reading it absent (WFT-21, Codex review round 14, P1 item Q7jH)', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const manifest = await manifestFor('checkout', '1.0.0', { revision: 'pinned-1' });
    const generationKey = KEYS.catalogRemovalGeneration('checkout', 'pinned-1');

    expect(await storage.get(generationKey)).toBeNull();

    await catalog.install(manifest, fakeDefinition('checkout'));
    const firstRemoval = await removeCatalogEntry(storage, 'checkout', 'pinned-1');
    if (firstRemoval.outcome !== 'removed') {
      throw new Error(`expected a "removed" outcome, got ${JSON.stringify(firstRemoval)}`);
    }
    expect(new TextDecoder().decode((await storage.get(generationKey))!)).toBe('1');
    // Resolve (finalize) the first removal's tombstone before reinstalling —
    // otherwise the reinstall below fails closed on the still-present
    // tombstone, which is not what this test targets.
    await finalizeCatalogTombstone(storage, 'checkout', 'pinned-1', firstRemoval.tombstoneBytes);

    // A deliberate reinstall after removal (unfenced — see
    // `WorkflowCatalog.install()`'s own doc) followed by a SECOND removal:
    // `decodeRemovalGeneration()` must decode the EXISTING nonzero counter
    // bytes, not just ever observe them absent.
    await catalog.install(manifest, fakeDefinition('checkout'));
    const secondRemoval = await removeCatalogEntry(storage, 'checkout', 'pinned-1');
    expect(secondRemoval.outcome).toBe('removed');
    expect(new TextDecoder().decode((await storage.get(generationKey))!)).toBe('2');
  });

  it('fails closed with a corrupt-counter error when the durable removal-generation counter bytes do not decode as a non-negative integer', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const manifest = await manifestFor('checkout', '1.0.0', { revision: 'pinned-1' });
    const generationKey = KEYS.catalogRemovalGeneration('checkout', 'pinned-1');

    // Simulate storage corruption of Weft's own bookkeeping key — never
    // written by any producer other than `removeCatalogEntry` itself.
    await storage.put(generationKey, new TextEncoder().encode('not-a-number'));
    await catalog.install(manifest, fakeDefinition('checkout'));

    await expect(removeCatalogEntry(storage, 'checkout', 'pinned-1')).rejects.toThrow(
      /do not decode as a non-negative integer/,
    );
  });
});

describe('finalizeCatalogTombstone / restoreCatalogEntryFromTombstone (WFT-17/18)', () => {
  it('finalizeCatalogTombstone durably deletes the tombstone, completing the removal', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const v1 = await manifestFor('checkout', '1.0.0');
    const v2 = await manifestFor('checkout', '2.0.0');
    await catalog.activateRegistered('checkout', v1, fakeDefinition('checkout'));
    await catalog.activateRegistered('checkout', v2, fakeDefinition('checkout'));

    const removed = await removeCatalogEntry(storage, 'checkout', v1.revision);
    if (removed.outcome !== 'removed') throw new Error('expected removed');

    const applied = await finalizeCatalogTombstone(
      storage,
      'checkout',
      v1.revision,
      removed.tombstoneBytes,
    );
    expect(applied).toBe(true);
    expect(await storage.get(KEYS.catalogTombstone('checkout', v1.revision))).toBeNull();
    expect(await storage.get(KEYS.catalogEntry('checkout', v1.revision))).toBeNull();
  });

  it('finalizeCatalogTombstone is a harmless no-op when the tombstone was already resolved', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const v1 = await manifestFor('checkout', '1.0.0');
    const v2 = await manifestFor('checkout', '2.0.0');
    await catalog.activateRegistered('checkout', v1, fakeDefinition('checkout'));
    await catalog.activateRegistered('checkout', v2, fakeDefinition('checkout'));

    const removed = await removeCatalogEntry(storage, 'checkout', v1.revision);
    if (removed.outcome !== 'removed') throw new Error('expected removed');
    expect(
      await finalizeCatalogTombstone(storage, 'checkout', v1.revision, removed.tombstoneBytes),
    ).toBe(true);

    // Second call against the SAME (now-stale) tombstoneBytes loses its CAS
    // — the tombstone key is already gone — rather than throwing or
    // double-processing.
    expect(
      await finalizeCatalogTombstone(storage, 'checkout', v1.revision, removed.tombstoneBytes),
    ).toBe(false);
  });

  it('restoreCatalogEntryFromTombstone atomically re-installs the entry and clears the tombstone, byte-identical to what was deleted', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const v1 = await manifestFor('checkout', '1.0.0');
    const v2 = await manifestFor('checkout', '2.0.0');
    await catalog.activateRegistered('checkout', v1, fakeDefinition('checkout'));
    await catalog.activateRegistered('checkout', v2, fakeDefinition('checkout'));

    const originalEntryBytes = await storage.get(KEYS.catalogEntry('checkout', v1.revision));
    const removed = await removeCatalogEntry(storage, 'checkout', v1.revision);
    if (removed.outcome !== 'removed') throw new Error('expected removed');
    expect(await storage.get(KEYS.catalogEntry('checkout', v1.revision))).toBeNull();

    const applied = await restoreCatalogEntryFromTombstone(
      storage,
      'checkout',
      v1.revision,
      removed.tombstoneBytes,
    );
    expect(applied).toBe(true);
    expect(await storage.get(KEYS.catalogTombstone('checkout', v1.revision))).toBeNull();
    expect(await storage.get(KEYS.catalogEntry('checkout', v1.revision))).toEqual(
      originalEntryBytes,
    );

    const restored = await restoreWorkflowCatalog(storage);
    expect(restored.entries.get('checkout')?.get(v1.revision)).toBeDefined();
  });

  it('restoreCatalogEntryFromTombstone is a harmless no-op when the tombstone was already resolved', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const v1 = await manifestFor('checkout', '1.0.0');
    const v2 = await manifestFor('checkout', '2.0.0');
    await catalog.activateRegistered('checkout', v1, fakeDefinition('checkout'));
    await catalog.activateRegistered('checkout', v2, fakeDefinition('checkout'));

    const removed = await removeCatalogEntry(storage, 'checkout', v1.revision);
    if (removed.outcome !== 'removed') throw new Error('expected removed');
    expect(
      await finalizeCatalogTombstone(storage, 'checkout', v1.revision, removed.tombstoneBytes),
    ).toBe(true);

    expect(
      await restoreCatalogEntryFromTombstone(
        storage,
        'checkout',
        v1.revision,
        removed.tombstoneBytes,
      ),
    ).toBe(false);
    // Finalized (not restored) — the entry must still be gone.
    expect(await storage.get(KEYS.catalogEntry('checkout', v1.revision))).toBeNull();
  });
});

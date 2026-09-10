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

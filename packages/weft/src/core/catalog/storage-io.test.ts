import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { buildWorkflowContract } from '../contract/build.ts';
import { buildWorkflowRevisionManifest } from '../contract/manifest.ts';
import { encodeActivePointer } from './codec.ts';
import {
  readActivePointer,
  readCatalogEntry,
  restoreWorkflowCatalog,
  scanCatalogEntriesForName,
  writeCatalogEntry,
} from './storage-io.ts';

describe('restoreWorkflowCatalog', () => {
  it('returns empty maps for an empty store', async () => {
    const storage = new MemoryStorage();
    const restored = await restoreWorkflowCatalog(storage);
    expect(restored.entries.size).toBe(0);
    expect(restored.active.size).toBe(0);
  });

  it('hydrates installed entries and active pointers from seeded storage', async () => {
    const storage = new MemoryStorage();
    const contract = buildWorkflowContract({ name: 'checkout', version: '1.0.0' });
    const manifest = await buildWorkflowRevisionManifest(contract);
    await writeCatalogEntry(storage, manifest, 1_000);
    await storage.put(
      KEYS.catalogActive('checkout'),
      encodeActivePointer({ revision: manifest.revision, generation: 1, activatedAt: 1_000 }),
    );

    const restored = await restoreWorkflowCatalog(storage);

    expect(restored.entries.get('checkout')?.get(manifest.revision)?.manifest.revision).toBe(
      manifest.revision,
    );
    expect(restored.active.get('checkout')).toEqual({
      revision: manifest.revision,
      generation: 1,
      activatedAt: 1_000,
    });
  });

  it('fails closed on a corrupt catalog-active record instead of treating it as absent', async () => {
    const storage = new MemoryStorage();
    await storage.put(
      KEYS.catalogActive('checkout'),
      new TextEncoder().encode('not valid msgpack json'),
    );

    await expect(restoreWorkflowCatalog(storage)).rejects.toThrow();
  });

  it('fails closed on a catalog entry that fails manifest validation', async () => {
    const storage = new MemoryStorage();
    await storage.put(
      KEYS.catalogEntry('checkout', 'bogus-revision'),
      new TextEncoder().encode(JSON.stringify({ manifest: { not: 'a manifest' }, installedAt: 1 })),
    );

    await expect(restoreWorkflowCatalog(storage)).rejects.toThrow();
  });

  it('fails closed on a catalog-entry key that does not match the expected shape', async () => {
    const storage = new MemoryStorage();
    // Missing the trailing `:<revision>` segment.
    await storage.put('catalog-entry:checkout', new TextEncoder().encode('irrelevant'));

    await expect(restoreWorkflowCatalog(storage)).rejects.toThrow(/does not match the expected/);
  });

  it('fails closed on a catalog-entry record that is not valid JSON', async () => {
    const storage = new MemoryStorage();
    await storage.put(KEYS.catalogEntry('checkout', 'r1'), new TextEncoder().encode('not json {'));

    await expect(restoreWorkflowCatalog(storage)).rejects.toThrow(/could not be parsed as JSON/);
  });

  it('fails closed when a manifest (name, revision) disagrees with its storage key', async () => {
    const storage = new MemoryStorage();
    const contract = buildWorkflowContract({ name: 'checkout', version: '1.0.0' });
    const manifest = await buildWorkflowRevisionManifest(contract);
    // Stored under a DIFFERENT revision than the manifest itself claims.
    await storage.put(
      KEYS.catalogEntry('checkout', 'mismatched-revision'),
      new TextEncoder().encode(JSON.stringify({ manifest, installedAt: 1 })),
    );

    await expect(restoreWorkflowCatalog(storage)).rejects.toThrow(/disagrees with its storage key/);
  });

  it('fails closed on a catalog-active key that does not match the expected shape', async () => {
    const storage = new MemoryStorage();
    // Starts with the scanned prefix but has an extra `:`-delimited segment,
    // so it does not split into exactly the expected `[prefix, name]` shape.
    await storage.put('catalog-active:a:b', new TextEncoder().encode('irrelevant'));

    await expect(restoreWorkflowCatalog(storage)).rejects.toThrow(/does not match the expected/);
  });
});

describe('readActivePointer', () => {
  it('returns null when absent', async () => {
    const storage = new MemoryStorage();
    expect(await readActivePointer(storage, 'checkout')).toBeNull();
  });

  it('reads back a previously written pointer', async () => {
    const storage = new MemoryStorage();
    await storage.put(
      KEYS.catalogActive('checkout'),
      encodeActivePointer({ revision: 'r1', generation: 3, activatedAt: 42 }),
    );

    expect(await readActivePointer(storage, 'checkout')).toEqual({
      revision: 'r1',
      generation: 3,
      activatedAt: 42,
    });
  });

  it('fails closed on a corrupt pointer record', async () => {
    const storage = new MemoryStorage();
    await storage.put(KEYS.catalogActive('checkout'), new TextEncoder().encode('garbage'));

    await expect(readActivePointer(storage, 'checkout')).rejects.toThrow();
  });
});

describe('readCatalogEntry', () => {
  it('returns null when absent', async () => {
    const storage = new MemoryStorage();
    expect(await readCatalogEntry(storage, 'checkout', 'r1')).toBeNull();
  });

  it('reads back a previously written entry', async () => {
    const storage = new MemoryStorage();
    const contract = buildWorkflowContract({ name: 'checkout', version: '1.0.0' });
    const manifest = await buildWorkflowRevisionManifest(contract);
    await writeCatalogEntry(storage, manifest, 1_000);

    const entry = await readCatalogEntry(storage, 'checkout', manifest.revision);

    expect(entry?.manifest.revision).toBe(manifest.revision);
    expect(entry?.installedAt).toBe(1_000);
  });

  it('fails closed on a record that is not valid JSON', async () => {
    const storage = new MemoryStorage();
    await storage.put(KEYS.catalogEntry('checkout', 'r1'), new TextEncoder().encode('not json {'));

    await expect(readCatalogEntry(storage, 'checkout', 'r1')).rejects.toThrow(
      /could not be parsed as JSON/,
    );
  });

  it('fails closed on a record that fails manifest validation', async () => {
    const storage = new MemoryStorage();
    await storage.put(
      KEYS.catalogEntry('checkout', 'r1'),
      new TextEncoder().encode(JSON.stringify({ manifest: { not: 'a manifest' }, installedAt: 1 })),
    );

    await expect(readCatalogEntry(storage, 'checkout', 'r1')).rejects.toThrow(
      /does not decode as a valid installed-revision record/,
    );
  });

  it('fails closed when the stored manifest (name, revision) disagrees with the requested key', async () => {
    const storage = new MemoryStorage();
    const contract = buildWorkflowContract({ name: 'checkout', version: '1.0.0' });
    const manifest = await buildWorkflowRevisionManifest(contract);
    // Stored under a DIFFERENT revision than the manifest itself claims.
    await storage.put(
      KEYS.catalogEntry('checkout', 'mismatched-revision'),
      new TextEncoder().encode(JSON.stringify({ manifest, installedAt: 1 })),
    );

    await expect(readCatalogEntry(storage, 'checkout', 'mismatched-revision')).rejects.toThrow(
      /disagrees with its storage key/,
    );
  });
});

describe('scanCatalogEntriesForName', () => {
  it('returns an empty array for an unknown name', async () => {
    const storage = new MemoryStorage();
    expect(await scanCatalogEntriesForName(storage, 'nonexistent')).toEqual([]);
  });

  it('returns every installed revision of a name, ignoring other names', async () => {
    const storage = new MemoryStorage();
    const checkoutV1 = await buildWorkflowRevisionManifest(
      buildWorkflowContract({ name: 'checkout', version: '1.0.0' }),
    );
    const checkoutV2 = await buildWorkflowRevisionManifest(
      buildWorkflowContract({ name: 'checkout', version: '2.0.0' }),
    );
    const otherWorkflow = await buildWorkflowRevisionManifest(
      buildWorkflowContract({ name: 'other-workflow', version: '1.0.0' }),
    );
    await writeCatalogEntry(storage, checkoutV1, 1_000);
    await writeCatalogEntry(storage, checkoutV2, 2_000);
    await writeCatalogEntry(storage, otherWorkflow, 3_000);

    const revisions = await scanCatalogEntriesForName(storage, 'checkout');

    expect(revisions).toHaveLength(2);
    expect(revisions.map((r) => r.manifest.revision).toSorted()).toEqual(
      [checkoutV1.revision, checkoutV2.revision].toSorted(),
    );
  });

  it('fails closed on a corrupt record encountered mid-scan, exactly like restoreWorkflowCatalog', async () => {
    const storage = new MemoryStorage();
    await storage.put(KEYS.catalogEntry('checkout', 'r1'), new TextEncoder().encode('not json {'));

    await expect(scanCatalogEntriesForName(storage, 'checkout')).rejects.toThrow(
      /could not be parsed as JSON/,
    );
  });

  it('fails closed on a scanned key that does not match the expected catalog-entry:<name>:<revision> shape', async () => {
    // Unreachable through any real write path — every `catalog-entry:` key
    // this codebase ever writes has exactly the shape
    // `catalog-entry:<name>:<revision>` — but a corrupted store could still
    // return a malformed key under the scanned prefix, so the guard itself
    // must be exercised directly, same as `restoreWorkflowCatalog`'s
    // equivalent branch.
    const storage = new MemoryStorage();
    const malformedKey = `catalog-entry:${encodeURIComponent('checkout')}:extra:colons`;
    const originalScan = storage.scan.bind(storage);
    storage.scan = (prefix, options) => {
      if (prefix === KEYS.catalogEntryPrefix('checkout')) {
        return (async function* () {
          yield [malformedKey, new TextEncoder().encode('{}')] as [string, Uint8Array];
        })();
      }
      return originalScan(prefix, options);
    };

    await expect(scanCatalogEntriesForName(storage, 'checkout')).rejects.toThrow(
      /does not match the expected catalog-entry:<name>:<revision> shape/,
    );
  });

  it('fails closed when a scanned manifest (name, revision) disagrees with its storage key', async () => {
    const storage = new MemoryStorage();
    const manifest = await buildWorkflowRevisionManifest(
      buildWorkflowContract({ name: 'checkout', version: '1.0.0' }),
    );
    await storage.put(
      KEYS.catalogEntry('checkout', 'mismatched-revision'),
      new TextEncoder().encode(JSON.stringify({ manifest, installedAt: 1 })),
    );

    await expect(scanCatalogEntriesForName(storage, 'checkout')).rejects.toThrow(
      /disagrees with its storage key/,
    );
  });
});

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

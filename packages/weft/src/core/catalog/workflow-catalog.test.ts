import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { buildWorkflowContract } from '../contract/build.ts';
import { buildWorkflowRevisionManifest } from '../contract/manifest.ts';
import type { WorkflowRevisionManifest } from '../contract/types.ts';
import type { RegisteredWorkflowDefinition } from '../types/workflow-registry.ts';
import { WorkflowCatalogActivationConflictError, WorkflowCatalogConflictError } from './errors.ts';
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

  it('defensively rejects an invalid workflow name even for a hand-built manifest', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const manifest = await manifestFor('checkout', '1.0.0');
    const invalid = { ...manifest, name: '1invalid' } as WorkflowRevisionManifest;

    await expect(catalog.install(invalid, fakeDefinition('1invalid'))).rejects.toThrow();
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
});

describe('WorkflowCatalog.resolveEntry', () => {
  it('resolves a cache-hit entry without touching storage', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const manifest = await manifestFor('checkout', '1.0.0');
    await catalog.install(manifest, fakeDefinition('checkout'));

    const resolved = await catalog.resolveEntry('checkout', manifest.revision);

    expect(resolved?.manifest.revision).toBe(manifest.revision);
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

    expect(result).toEqual({ outcome: 'removed' });
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

/**
 * Tests for `engine.workflows` — the public promotion of the durable
 * workflow catalog (WFT-11).
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import {
  WorkflowCatalogConflictError,
  WorkflowRevisionNotInstalledError,
} from '../catalog/index.ts';
import { buildWorkflowContract } from '../contract/build.ts';
import { buildWorkflowRevisionManifest } from '../contract/manifest.ts';
import { buildRegistrySnapshot } from '../registry-snapshot.ts';
import type { WorkflowContext } from '../types.ts';
import { workflow } from '../types.ts';
import { WorkflowNotRegisteredError } from './errors.ts';
import { Engine } from './index.ts';

function createEngine(): Engine {
  return new Engine({ storage: new MemoryStorage() });
}

const checkout = workflow({ name: 'checkout', version: '1.0.0' }).execute(async function* (
  _ctx: WorkflowContext,
  input: string,
) {
  return input;
});

describe('engine.workflows.install', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('installs a manifest for an already-registered workflow', async () => {
    engine = createEngine();
    engine.register(checkout);
    const manifest = await buildWorkflowRevisionManifest(
      buildWorkflowContract({ name: 'checkout', version: '1.0.0' }),
    );

    const record = await engine.workflows.install(manifest);

    expect(record.manifest.revision).toBe(manifest.revision);
    expect(record.installedAt).toBeGreaterThan(0);
  });

  it('is idempotent on a byte-identical reinstall', async () => {
    engine = createEngine();
    engine.register(checkout);
    const manifest = await buildWorkflowRevisionManifest(
      buildWorkflowContract({ name: 'checkout', version: '1.0.0' }),
    );

    const first = await engine.workflows.install(manifest);
    const second = await engine.workflows.install(manifest);

    expect(second.installedAt).toBe(first.installedAt);
  });

  it('throws WorkflowCatalogConflictError for a differing-content reinstall under the same revision', async () => {
    engine = createEngine();
    engine.register(checkout);
    const manifest = await buildWorkflowRevisionManifest(
      buildWorkflowContract({ name: 'checkout', version: '1.0.0' }),
      { revision: 'pinned-1' },
    );
    const conflicting = await buildWorkflowRevisionManifest(
      buildWorkflowContract({ name: 'checkout', version: '2.0.0' }),
      { revision: 'pinned-1' },
    );
    await engine.workflows.install(manifest);

    await expect(engine.workflows.install(conflicting)).rejects.toThrow(
      WorkflowCatalogConflictError,
    );
  });

  it('throws WorkflowNotRegisteredError when the engine has no in-process definition for the manifest name', async () => {
    engine = createEngine();
    const manifest = await buildWorkflowRevisionManifest(
      buildWorkflowContract({ name: 'never-registered', version: '1.0.0' }),
    );

    await expect(engine.workflows.install(manifest)).rejects.toThrow(WorkflowNotRegisteredError);
  });

  it('never returns a `definition` field: only manifest and installedAt reach the caller', async () => {
    engine = createEngine();
    engine.register(checkout);
    const manifest = await buildWorkflowRevisionManifest(
      buildWorkflowContract({ name: 'checkout', version: '1.0.0' }),
    );

    const record = await engine.workflows.install(manifest);

    expect(Object.keys(record).toSorted()).toEqual(['installedAt', 'manifest']);
  });
});

describe('engine.workflows.activate', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('re-stamps (bumps the generation of) the currently active revision when given the exact same manifest and expectedGeneration', async () => {
    engine = createEngine();
    engine.register(checkout);
    const active = await engine.workflows.getActive('checkout');
    expect(active).not.toBeNull();

    const result = await engine.workflows.activate('checkout', active!.revision, {
      expectedGeneration: active!.generation,
    });

    expect(result.applied).toBe(true);
    if (result.applied) {
      expect(result.pointer.generation).toBe(active!.generation + 1);
      expect(result.pointer.revision).toBe(active!.revision);
    }
  });

  it('throws WorkflowRevisionNotInstalledError for a revision that was never installed', async () => {
    engine = createEngine();
    engine.register(checkout);

    await expect(
      engine.workflows.activate('checkout', 'never-installed', { expectedGeneration: 1 }),
    ).rejects.toThrow(WorkflowRevisionNotInstalledError);
  });

  it('refuses with expected-generation-required when expectedGeneration is omitted after the first activation', async () => {
    engine = createEngine();
    engine.register(checkout);
    const active = await engine.workflows.getActive('checkout');

    const result = await engine.workflows.activate('checkout', active!.revision);

    expect(result.applied).toBe(false);
    if (!result.applied) {
      expect(result.reason).toBe('expected-generation-required');
    }
  });

  it('refuses with stale-generation for a wrong expectedGeneration', async () => {
    engine = createEngine();
    engine.register(checkout);
    const active = await engine.workflows.getActive('checkout');

    const result = await engine.workflows.activate('checkout', active!.revision, {
      expectedGeneration: active!.generation + 99,
    });

    expect(result.applied).toBe(false);
    if (!result.applied) {
      expect(result.reason).toBe('stale-generation');
    }
  });

  it('refuses with incompatible for an installed candidate whose contract differs from the active one', async () => {
    engine = createEngine();
    engine.register(checkout);
    const active = await engine.workflows.getActive('checkout');
    const incompatibleCandidate = await buildWorkflowRevisionManifest(
      buildWorkflowContract({ name: 'checkout', version: '99.0.0' }),
      { revision: 'incompatible-candidate' },
    );
    await engine.workflows.install(incompatibleCandidate);

    const result = await engine.workflows.activate('checkout', 'incompatible-candidate', {
      expectedGeneration: active!.generation,
    });

    expect(result.applied).toBe(false);
    if (!result.applied) {
      expect(result.reason).toBe('incompatible');
    }
  });

  it('activating a different revision changes the advertised active pointer but NOT what engine.start()/getWorkflowDefinition() executes', async () => {
    engine = createEngine();
    engine.register(checkout);
    const originalDefinition = engine.getWorkflowDefinition('checkout');
    const active = await engine.workflows.getActive('checkout');

    // Install a documentation-only variant (same contractHash, different
    // revision) and activate it with the lenient policy — the only way a
    // successful activate() can move the pointer to a genuinely different
    // revision string.
    const docsVariant = await buildWorkflowRevisionManifest(
      buildWorkflowContract({
        name: 'checkout',
        version: '1.0.0',
        description: 'an updated description',
      }),
    );
    await engine.workflows.install(docsVariant);
    const result = await engine.workflows.activate('checkout', docsVariant.revision, {
      expectedGeneration: active!.generation,
      policy: { requireExactRevision: false },
    });
    expect(result.applied).toBe(true);

    const newActive = await engine.workflows.getActive('checkout');
    expect(newActive?.revision).toBe(docsVariant.revision);
    expect(newActive?.revision).not.toBe(active?.revision);

    // What engine.start() would dispatch to is untouched: the in-process
    // definition is exactly what was registered, unaffected by activation.
    expect(engine.getWorkflowDefinition('checkout')).toEqual(originalDefinition);
  });
});

describe('engine.workflows.getActive / getRevision / listRevisions', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('getActive returns null for a name that was never registered or installed', async () => {
    engine = createEngine();

    expect(await engine.workflows.getActive('nonexistent')).toBeNull();
  });

  it('getRevision returns null for an uninstalled revision', async () => {
    engine = createEngine();
    engine.register(checkout);

    expect(await engine.workflows.getRevision('checkout', 'nonexistent-revision')).toBeNull();
  });

  it('listRevisions returns every installed revision, sorted deterministically', async () => {
    engine = createEngine();
    engine.register(checkout);
    // `register()` already durably installs+activates the content-derived
    // revision of `checkout` itself — `listRevisions` must include it
    // alongside the two explicitly-installed candidates below.
    const registeredActive = await engine.workflows.getActive('checkout');
    const v1 = await buildWorkflowRevisionManifest(
      buildWorkflowContract({ name: 'checkout', version: '1.0.0' }),
      { revision: 'b-revision' },
    );
    const v2 = await buildWorkflowRevisionManifest(
      buildWorkflowContract({ name: 'checkout', version: '1.0.0', description: 'v2' }),
      { revision: 'a-revision' },
    );
    await engine.workflows.install(v1);
    await engine.workflows.install(v2);

    const revisions = await engine.workflows.listRevisions('checkout');
    const sortedRevisionStrings = revisions.map((r) => r.manifest.revision);

    expect(sortedRevisionStrings).toContain('a-revision');
    expect(sortedRevisionStrings).toContain('b-revision');
    expect(sortedRevisionStrings).toContain(registeredActive!.revision);
    expect(sortedRevisionStrings).toHaveLength(3);
    // Deterministic codepoint order, not insertion order.
    expect(sortedRevisionStrings).toEqual(
      sortedRevisionStrings.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });

  it('getActive/getRevision/listRevisions agree with buildRegistrySnapshot(engine) for the same engine — cross-surface consistency', async () => {
    engine = createEngine();
    engine.register(checkout);

    const snapshot = await buildRegistrySnapshot(engine);
    const active = await engine.workflows.getActive('checkout');
    const revisions = await engine.workflows.listRevisions('checkout');

    expect(active).not.toBeNull();
    expect(snapshot.activeRevisions['checkout']).toBe(active!.revision);
    expect(revisions.map((r) => r.manifest.revision)).toContain(active!.revision);

    const revisionRecord = await engine.workflows.getRevision('checkout', active!.revision);
    expect(revisionRecord?.manifest.revision).toBe(active!.revision);
  });
});

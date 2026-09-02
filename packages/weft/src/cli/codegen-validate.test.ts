/**
 * Direct unit tests for `codegen-validate.ts`'s hostile-input paths that a
 * real `weft codegen --from <file>` invocation cannot reach on its own:
 * `activeRevisions` arriving as a non-plain object is only possible from a
 * caller that bypasses `JSON.parse` (which never produces an exotic
 * prototype), and an `activeRevisions` entry with no matching `workflows`
 * manifest is otherwise exercised only end-to-end in `codegen.test.ts`.
 * `executeCodegen`'s end-to-end fixtures in `codegen.test.ts` cover the rest
 * of this module's behavior (envelope validation, version mismatch, manifest
 * parsing, boolean-root-schema rejection, active-manifest resolution).
 */
import { describe, expect, it } from 'bun:test';

import {
  buildWorkflowRevisionManifest,
  type BuildWorkflowRevisionManifestOptions,
  type WorkflowContract,
} from '../core/contract/index.ts';
import { validateRegistrySnapshot } from './codegen-validate.ts';

async function fixtureManifest(
  contract: WorkflowContract,
  options?: BuildWorkflowRevisionManifestOptions,
) {
  return buildWorkflowRevisionManifest(contract, options);
}

describe('validateRegistrySnapshot', () => {
  it('rejects activeRevisions that is not a plain object (e.g. an exotic-prototype value)', async () => {
    // Passes the envelope's `objectValue` refine (`typeof === 'object' &&
    // !Array.isArray && !== null`) but fails `isRecord`'s plain-object
    // check — only reachable from a caller that hands validateRegistrySnapshot
    // a value that never went through JSON.parse.
    const result = await validateRegistrySnapshot({
      registryVersion: 2,
      generatedAt: new Date(0).toISOString(),
      workflows: [],
      activeRevisions: new Date(),
      activities: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.error).toBe(
      'codegen: invalid registry snapshot: activeRevisions must be an object',
    );
  });

  it('rejects an activeRevisions value that is not a string', async () => {
    const result = await validateRegistrySnapshot({
      registryVersion: 2,
      generatedAt: new Date(0).toISOString(),
      workflows: [],
      activeRevisions: { welcome: 123 },
      activities: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.error).toBe(
      'codegen: invalid registry snapshot: activeRevisions["welcome"] must be a string',
    );
  });

  it('rejects an activeRevisions entry with no matching workflows manifest', async () => {
    const manifest = await fixtureManifest({ name: 'welcome', workflowVersion: '1.0.0' });
    const result = await validateRegistrySnapshot({
      registryVersion: 2,
      generatedAt: new Date(0).toISOString(),
      workflows: [manifest],
      // Names a revision that does not match the one manifest present.
      activeRevisions: { welcome: 'sha256:does-not-exist' },
      activities: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.error).toBe(
      'codegen: invalid registry snapshot: activeRevisions["welcome"] = "sha256:does-not-exist" has no matching entry in workflows',
    );
  });

  it('accepts a well-formed snapshot and projects the active manifest plus activity count', async () => {
    const manifest = await fixtureManifest({
      name: 'welcome',
      workflowVersion: '1.0.0',
      description: 'Greets a person.',
      tags: ['demo'],
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
    });
    const result = await validateRegistrySnapshot({
      registryVersion: 2,
      generatedAt: new Date(0).toISOString(),
      workflows: [manifest],
      activeRevisions: { welcome: manifest.revision },
      activities: { ping: { queue: 'default' } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value.workflows).toEqual({
      welcome: {
        description: 'Greets a person.',
        tags: ['demo'],
        inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
      },
    });
    expect(Object.keys(result.value.activities)).toEqual(['ping']);
  });

  it('rejects a workflows array over the maximum manifest count before parsing or hashing any element', async () => {
    // Every element here is `{}` — not even a well-formed placeholder —
    // proving the count bound rejects the payload before a single element
    // is parsed (parsing `{}` as a WorkflowRevisionManifest would itself
    // fail, but with a different, per-element error this test never
    // reaches).
    const workflows = Array.from({ length: 513 }, () => ({}));
    const result = await validateRegistrySnapshot({
      registryVersion: 2,
      generatedAt: new Date(0).toISOString(),
      workflows,
      activeRevisions: {},
      activities: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.error).toBe(
      'codegen: invalid registry snapshot: workflows has 513 entries, exceeding the maximum of 512',
    );
  });

  it('rejects an activeRevisions map over the maximum entry count before reading any entry', async () => {
    const activeRevisions: Record<string, string> = {};
    for (let index = 0; index < 513; index += 1) {
      activeRevisions[`workflow-${index}`] = 'rev';
    }
    const result = await validateRegistrySnapshot({
      registryVersion: 2,
      generatedAt: new Date(0).toISOString(),
      workflows: [],
      activeRevisions,
      activities: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.error).toBe(
      'codegen: invalid registry snapshot: activeRevisions has more than 512 entries',
    );
  });

  it('rejects an activeRevisions value exceeding the maximum identifier byte length', async () => {
    const result = await validateRegistrySnapshot({
      registryVersion: 2,
      generatedAt: new Date(0).toISOString(),
      workflows: [],
      activeRevisions: { welcome: 'a'.repeat(513) },
      activities: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.error).toBe(
      'codegen: invalid registry snapshot: activeRevisions["welcome"] exceeds the maximum identifier length of 512 bytes',
    );
  });

  it('rejects an activeRevisions key exceeding the maximum identifier byte length', async () => {
    const oversizedName = 'w'.repeat(513);
    const result = await validateRegistrySnapshot({
      registryVersion: 2,
      generatedAt: new Date(0).toISOString(),
      workflows: [],
      activeRevisions: { [oversizedName]: 'rev' },
      activities: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.error).toBe(
      `codegen: invalid registry snapshot: activeRevisions key ${JSON.stringify(oversizedName)} exceeds the maximum identifier length of 512 bytes`,
    );
  });

  it('rejects workflows containing two manifests that share a (name, revision) identity rather than silently keeping the first', async () => {
    // Both manifests share an explicit `revision` (a hand-vendored `--from`
    // file can assert any string here) but carry different contracts —
    // exactly the case a plain `.find()` would resolve by first-match,
    // silently discarding the second.
    const first = await fixtureManifest(
      { name: 'welcome', workflowVersion: '1.0.0' },
      { revision: 'shared-revision' },
    );
    const second = await fixtureManifest(
      { name: 'welcome', workflowVersion: '1.0.0', description: 'A different contract.' },
      { revision: 'shared-revision' },
    );
    const result = await validateRegistrySnapshot({
      registryVersion: 2,
      generatedAt: new Date(0).toISOString(),
      workflows: [first, second],
      activeRevisions: { welcome: 'shared-revision' },
      activities: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.error).toBe(
      'codegen: invalid registry snapshot: workflows contains more than one manifest for name "welcome", revision "shared-revision"',
    );
  });
});

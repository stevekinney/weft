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

import { buildWorkflowRevisionManifest, type WorkflowContract } from '../core/contract/index.ts';
import { validateRegistrySnapshot } from './codegen-validate.ts';

async function fixtureManifest(contract: WorkflowContract) {
  return buildWorkflowRevisionManifest(contract);
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
});

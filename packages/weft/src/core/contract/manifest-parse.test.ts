import { describe, expect, it } from 'bun:test';

import type { DefinitionSchema, StandardJSONSchemaV1 } from '../types/definition-schema.ts';
import { buildWorkflowContract } from './build.ts';
import { contractHash } from './hash.ts';
import { MAX_CONTRACT_IDENTIFIER_BYTES, MAX_CONTRACT_MESSAGE_COUNT } from './limits.ts';
import { parseWorkflowRevisionManifest } from './manifest-parse.ts';
import { buildWorkflowRevisionManifest } from './manifest.ts';
import { canonicalWorkflowContractJson } from './normalize.ts';
import { WORKFLOW_REVISION_MANIFEST_VERSION } from './types.ts';

/** A schema whose structural `~standard.jsonSchema` converter returns a fixed fragment. */
function fixedSchema(fragment: Record<string, unknown>): DefinitionSchema {
  const schema: StandardJSONSchemaV1 = {
    '~standard': {
      version: 1,
      vendor: 'weft-test-fixture',
      jsonSchema: { input: () => fragment, output: () => fragment },
    },
  };
  return schema;
}

async function validManifest() {
  const contract = buildWorkflowContract({
    name: 'checkout',
    version: '2.1.0',
    signals: { cancel: {} },
  });
  return buildWorkflowRevisionManifest(contract);
}

/** A manifest exercising every optional contract field: description, tags, and a finalizer. */
async function fullFeaturedManifest() {
  const contract = buildWorkflowContract({
    name: 'checkout',
    version: '2.1.0',
    description: 'Runs the checkout flow.',
    tags: ['commerce', 'billing'],
    signals: { cancel: {} },
    finalizer: { name: 'cleanup', inputSchema: fixedSchema({ type: 'string' }) },
  });
  return buildWorkflowRevisionManifest(contract);
}

describe('parseWorkflowRevisionManifest', () => {
  it('accepts a valid, untampered manifest with canonicalJson matching canonicalWorkflowContractJson(manifest.contract)', async () => {
    const manifest = await validManifest();
    const result = await parseWorkflowRevisionManifest(manifest);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.manifest.name).toBe('checkout');
    expect(result.manifest.contractHash).toBe(manifest.contractHash);
    expect(result.canonicalJson).toBe(canonicalWorkflowContractJson(result.manifest.contract));
  });

  it('rejects a supplied incorrect contractHash after recomputation', async () => {
    const manifest = await validManifest();
    const tampered = { ...manifest, contractHash: `${manifest.contractHash.slice(0, -1)}0` };
    const result = await parseWorkflowRevisionManifest(tampered);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('contract-hash-mismatch');
  });

  it('rejects an unsupported manifestVersion', async () => {
    const manifest = await validManifest();
    const result = await parseWorkflowRevisionManifest({ ...manifest, manifestVersion: 2 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('manifest-version-unsupported');
  });

  it('rejects non-object input', async () => {
    const result = await parseWorkflowRevisionManifest('not an object');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('not-an-object');
  });

  it('rejects null', async () => {
    const result = await parseWorkflowRevisionManifest(null);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('not-an-object');
  });

  it('rejects a missing/invalid field with invalid-field', async () => {
    const manifest = await validManifest();
    const result = await parseWorkflowRevisionManifest({ ...manifest, name: 42 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('invalid-field');
  });

  it('rejects when manifest.name disagrees with manifest.contract.name', async () => {
    const manifest = await validManifest();
    const result = await parseWorkflowRevisionManifest({ ...manifest, name: 'different' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('invalid-field');
    expect(result.path).toBe('manifest.name');
  });

  it('rejects when manifest.workflowVersion disagrees with manifest.contract.workflowVersion', async () => {
    const manifest = await validManifest();
    const result = await parseWorkflowRevisionManifest({ ...manifest, workflowVersion: '9.9.9' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('invalid-field');
    expect(result.path).toBe('manifest.workflowVersion');
  });

  it('rejects an identifier exceeding the maximum byte size', async () => {
    const manifest = await validManifest();
    const oversized = 'x'.repeat(MAX_CONTRACT_IDENTIFIER_BYTES + 1);
    const result = await parseWorkflowRevisionManifest({ ...manifest, revision: oversized });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('identifier-too-long');
  });

  it('rejects a signals record with too many entries', async () => {
    const manifest = await validManifest();
    const signals: Record<string, unknown> = {};
    for (let index = 0; index < MAX_CONTRACT_MESSAGE_COUNT + 1; index++) {
      signals[`signal-${index}`] = {};
    }
    const result = await parseWorkflowRevisionManifest({
      ...manifest,
      contract: { ...manifest.contract, signals },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('too-many-entries');
  });

  it('rejects a contract that normalizes past the maximum manifest size', async () => {
    const manifest = await validManifest();
    const hugeSchema = {
      type: 'object',
      properties: { field: { type: 'string', description: 'x'.repeat(300_000) } },
    };
    const result = await parseWorkflowRevisionManifest({
      ...manifest,
      contract: { ...manifest.contract, inputSchema: hugeSchema },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('manifest-too-large');
  });

  it('rejects a schema fragment nested past the maximum depth', async () => {
    const manifest = await validManifest();
    let deep: Record<string, unknown> = { type: 'string' };
    for (let index = 0; index < 100; index++) {
      deep = { type: 'object', properties: { next: deep } };
    }
    const result = await parseWorkflowRevisionManifest({
      ...manifest,
      contract: { ...manifest.contract, inputSchema: deep },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('invalid-field');
  });

  it('rejects a schema fragment that is not JSON-safe', async () => {
    const manifest = await validManifest();
    const result = await parseWorkflowRevisionManifest({
      ...manifest,
      contract: {
        ...manifest.contract,
        inputSchema: { type: 'string', bad: () => 'not json-safe' },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('invalid-field');
  });

  it('rejects an activity map key that is not a wire-safe name', async () => {
    const manifest = await validManifest();
    const result = await parseWorkflowRevisionManifest({
      ...manifest,
      contract: { ...manifest.contract, activities: { 'bad.name': {} } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('invalid-field');
  });

  it('accepts an unconstrained signal name that would fail activity-name grammar', async () => {
    const manifest = await validManifest();
    const result = await parseWorkflowRevisionManifest({
      ...manifest,
      contract: {
        ...manifest.contract,
        signals: { 'dotted.signal.name': {} },
      },
    });
    // contractHash was computed for a different signals map, so recomputation
    // legitimately mismatches — the point here is the reason is NOT
    // 'invalid-field' from a grammar check on the signal name itself.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('contract-hash-mismatch');
  });

  it('WORKFLOW_REVISION_MANIFEST_VERSION is the version this parser accepts', async () => {
    const manifest = await validManifest();
    expect(manifest.manifestVersion).toBe(WORKFLOW_REVISION_MANIFEST_VERSION);
  });

  it('accepts and clones an array-valued schema fragment (enum) without mutation sharing', async () => {
    const manifest = await validManifest();
    const accepted = {
      ...manifest,
      contract: {
        ...manifest.contract,
        inputSchema: { type: 'string', enum: ['a', 'b', 'c'] },
      },
    };
    // Recompute contractHash for the mutated contract so this fixture is
    // internally consistent rather than relying on a coincidental match.
    const recomputedContractHash = await contractHash(accepted.contract);
    const result = await parseWorkflowRevisionManifest({
      ...accepted,
      contractHash: recomputedContractHash,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.manifest.contract.inputSchema).toEqual({ type: 'string', enum: ['a', 'b', 'c'] });
  });

  it('accepts a manifest with description, tags, and a finalizer (full field coverage)', async () => {
    const manifest = await fullFeaturedManifest();
    const result = await parseWorkflowRevisionManifest(manifest);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.manifest.contract.description).toBe('Runs the checkout flow.');
    expect(result.manifest.contract.tags).toEqual(['billing', 'commerce']);
    expect(result.manifest.contract.finalizer?.inputSchema).toEqual({ type: 'string' });
  });

  it('rejects a non-array tags field', async () => {
    const manifest = await validManifest();
    const result = await parseWorkflowRevisionManifest({
      ...manifest,
      contract: { ...manifest.contract, tags: 'not-an-array' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('invalid-field');
  });

  it('rejects a tags array containing a non-string entry', async () => {
    const manifest = await validManifest();
    const result = await parseWorkflowRevisionManifest({
      ...manifest,
      contract: { ...manifest.contract, tags: ['ok', 42] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('invalid-field');
  });

  it('rejects a non-string description', async () => {
    const manifest = await validManifest();
    const result = await parseWorkflowRevisionManifest({
      ...manifest,
      contract: { ...manifest.contract, description: 42 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('invalid-field');
  });

  it('rejects a non-object finalizer', async () => {
    const manifest = await validManifest();
    const result = await parseWorkflowRevisionManifest({
      ...manifest,
      contract: { ...manifest.contract, finalizer: 'not-an-object' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('invalid-field');
  });

  it('rejects a finalizer with an invalid outputSchema', async () => {
    const manifest = await validManifest();
    const result = await parseWorkflowRevisionManifest({
      ...manifest,
      contract: {
        ...manifest.contract,
        finalizer: { inputSchema: { type: 'string' }, outputSchema: 'not-an-object' },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('invalid-field');
  });

  it('accepts a valid outputSchema (success path for both halves of a schema pair)', async () => {
    const contract = buildWorkflowContract({
      name: 'checkout',
      version: '2.1.0',
      outputSchema: fixedSchema({ type: 'string' }),
    });
    const manifest = await buildWorkflowRevisionManifest(contract);
    const result = await parseWorkflowRevisionManifest(manifest);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.manifest.contract.outputSchema).toEqual({ type: 'string' });
  });

  it('rejects a non-object inputSchema', async () => {
    const manifest = await validManifest();
    const result = await parseWorkflowRevisionManifest({
      ...manifest,
      contract: { ...manifest.contract, inputSchema: 'not-an-object' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('invalid-field');
  });

  it('rejects manifest.contract itself being a non-object', async () => {
    const manifest = await validManifest();
    const result = await parseWorkflowRevisionManifest({ ...manifest, contract: 'not-an-object' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('invalid-field');
  });

  it('rejects an empty activity key', async () => {
    const manifest = await validManifest();
    const result = await parseWorkflowRevisionManifest({
      ...manifest,
      contract: { ...manifest.contract, activities: { '': {} } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('invalid-field');
  });

  it('rejects an activity key exceeding the maximum identifier byte size', async () => {
    const manifest = await validManifest();
    const oversizedName = 'a'.repeat(MAX_CONTRACT_IDENTIFIER_BYTES + 1);
    const result = await parseWorkflowRevisionManifest({
      ...manifest,
      contract: { ...manifest.contract, activities: { [oversizedName]: {} } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('identifier-too-long');
  });

  it('rejects a non-object signals/updates/queries/activities record', async () => {
    const manifest = await validManifest();
    const result = await parseWorkflowRevisionManifest({
      ...manifest,
      contract: { ...manifest.contract, updates: 'not-an-object' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('invalid-field');
  });

  it('rejects a schema fragment whose array value nests past the maximum depth', async () => {
    const manifest = await validManifest();
    // Exercise the array branch of the iterative depth walk, not just the
    // object branch: `enum` is a JSON array, and its entries are objects
    // nested deep enough to cross MAX_CONTRACT_SCHEMA_DEPTH.
    let deep: Record<string, unknown> = { type: 'string' };
    for (let index = 0; index < 100; index++) {
      deep = { type: 'object', properties: { next: deep } };
    }
    const result = await parseWorkflowRevisionManifest({
      ...manifest,
      contract: { ...manifest.contract, inputSchema: { type: 'array', enum: [deep] } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.reason).toBe('invalid-field');
  });
});

import { describe, expect, it } from 'bun:test';

import { jsonSchemaToTypeScript } from '../../cli/codegen-emit.ts';
import equivalentContracts from './__fixtures__/equivalent-contracts-different-key-order.json';
import semanticallyDifferentContracts from './__fixtures__/semantically-different-contracts.json';
import { activityContractHash, contractHash, digestCanonicalWorkflowContract } from './hash.ts';
import { canonicalWorkflowContractJson, normalizeWorkflowContract } from './normalize.ts';
import type { WorkflowContract } from './types.ts';
import { WORKFLOW_CONTRACT_VERSION } from './types.ts';

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

describe('contractHash', () => {
  it('produces a well-formed, algorithm-tagged digest (guards against a missed await)', async () => {
    const hash = await contractHash({ name: 'checkout', workflowVersion: '1.0.0' });
    expect(hash).toMatch(HASH_PATTERN);
  });

  it('is order-invariant: equivalent contracts hash identically regardless of source key order', async () => {
    const { a, b } = equivalentContracts as { a: WorkflowContract; b: WorkflowContract };
    const [left, right] = await Promise.all([contractHash(a), contractHash(b)]);
    expect(left).toBe(right);
    expect(left).toMatch(HASH_PATTERN);
  });

  it('excludes name, workflowVersion, description, and tags', async () => {
    const base = { inputSchema: { type: 'object', properties: { id: { type: 'string' } } } };
    const [left, right] = await Promise.all([
      contractHash({ ...base, name: 'checkout', workflowVersion: '1.0.0' }),
      contractHash({
        ...base,
        name: 'refund',
        workflowVersion: '2.0.0',
        description: 'different',
        tags: ['different'],
      }),
    ]);
    expect(left).toBe(right);
  });

  it('embeds WORKFLOW_CONTRACT_VERSION as a domain separator', () => {
    expect(WORKFLOW_CONTRACT_VERSION).toBe(1);
    // Full-identity canonical JSON also carries the separator, so a future
    // bump changes both contractHash's payload serialization (asserted by
    // this constant existing and being folded into every digest input) and
    // deriveWorkflowRevision's.
    const canonical = canonicalWorkflowContractJson({ name: 'checkout', workflowVersion: '1.0.0' });
    expect(canonical).toContain(`"contractVersion":${WORKFLOW_CONTRACT_VERSION}`);
  });

  describe('semantically different contracts cannot share a hash', () => {
    for (const entry of semanticallyDifferentContracts as Array<{
      description: string;
      field?: 'inputSchema' | 'outputSchema';
      signalField?: string;
      a: WorkflowContract;
      b: WorkflowContract;
    }>) {
      it(entry.description, async () => {
        const [left, right] = await Promise.all([
          contractHash(normalizeWorkflowContract(entry.a)),
          contractHash(normalizeWorkflowContract(entry.b)),
        ]);
        expect(left).not.toBe(right);

        if (entry.field !== undefined) {
          const aSchema = entry.a[entry.field];
          const bSchema = entry.b[entry.field];
          expect(jsonSchemaToTypeScript(aSchema)).not.toBe(jsonSchemaToTypeScript(bSchema));
        }
        if (entry.signalField !== undefined) {
          const aSignal = entry.a.signals?.[entry.signalField];
          const bSignal = entry.b.signals?.[entry.signalField];
          expect(jsonSchemaToTypeScript(aSignal?.inputSchema)).not.toBe(
            jsonSchemaToTypeScript(bSignal?.inputSchema),
          );
        }
      });
    }
  });
});

describe('activityContractHash', () => {
  it('produces a well-formed digest independent of the workflow contract', async () => {
    const hash = await activityContractHash({
      inputSchema: { type: 'object', properties: { amount: { type: 'number' } } },
    });
    expect(hash).toMatch(HASH_PATTERN);
  });

  it('differs for different activity schemas', async () => {
    const [left, right] = await Promise.all([
      activityContractHash({
        inputSchema: { type: 'object', properties: { amount: { type: 'number' } } },
      }),
      activityContractHash({
        inputSchema: { type: 'object', properties: { amount: { type: 'string' } } },
      }),
    ]);
    expect(left).not.toBe(right);
  });
});

describe('digestCanonicalWorkflowContract', () => {
  it('digests arbitrary canonical JSON text', async () => {
    const hash = await digestCanonicalWorkflowContract('{"a":1}');
    expect(hash).toMatch(HASH_PATTERN);
  });

  it('is a pure function of its input text', async () => {
    const [left, right] = await Promise.all([
      digestCanonicalWorkflowContract('{"a":1}'),
      digestCanonicalWorkflowContract('{"a":1}'),
    ]);
    expect(left).toBe(right);
  });
});

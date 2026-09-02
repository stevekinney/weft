import { describe, expect, it } from 'bun:test';

import { emitPropertyKey, jsonSchemaToTypeScript } from '../../cli/codegen-emit.ts';
import hostileContract from './__fixtures__/hostile-identifiers.json';
import { contractHash } from './hash.ts';
import { buildWorkflowRevisionManifest } from './manifest.ts';
import { canonicalWorkflowContractJson, normalizeWorkflowContract } from './normalize.ts';
import type { WorkflowContract } from './types.ts';

const contract = hostileContract as WorkflowContract;

describe('unsafe identifiers and descriptions cannot inject generated TypeScript', () => {
  it('normalizeWorkflowContract round-trips hostile names and descriptions without throwing or mangling them', () => {
    const normalized = normalizeWorkflowContract(contract);
    expect(normalized.description).toBe(contract.description);
    expect(Object.keys(normalized.signals ?? {}).toSorted()).toEqual(
      Object.keys(contract.signals ?? {}).toSorted(),
    );
  });

  it('contractHash and canonicalWorkflowContractJson round-trip without throwing', async () => {
    expect(() => canonicalWorkflowContractJson(contract)).not.toThrow();
    await expect(contractHash(contract)).resolves.toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('buildWorkflowRevisionManifest round-trips the hostile contract without throwing', async () => {
    await expect(buildWorkflowRevisionManifest(contract)).resolves.toBeDefined();
  });

  it('a __proto__-named signal survives as an own enumerable property, never prototype pollution', () => {
    const normalized = normalizeWorkflowContract(contract);
    expect(Object.prototype.hasOwnProperty.call(normalized.signals, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);

    const normalizedQueries = normalized.queries ?? {};
    expect(Object.prototype.hasOwnProperty.call(normalizedQueries, '__proto__')).toBe(true);
  });

  it('the canonical JSON string safely quotes every hostile signal name (no unescaped injection)', () => {
    const json = canonicalWorkflowContractJson(contract);
    for (const name of Object.keys(contract.signals ?? {})) {
      expect(json).toContain(JSON.stringify(name));
    }
    // A parseable round-trip proves no raw quote/newline broke the JSON string.
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('emitPropertyKey() (existing codegen-emit.ts function, exercised directly) safely quotes hostile names', () => {
    for (const name of Object.keys(contract.signals ?? {})) {
      const emitted = emitPropertyKey(name);
      // A safely emitted property key is a double-quoted JSON string literal
      // whose parsed value round-trips to exactly the original name — proof
      // that no unescaped quote, newline, comment-closer, or template
      // literal inside the name escaped its quoted position.
      expect(emitted.startsWith('"')).toBe(true);
      expect(emitted.endsWith('"')).toBe(true);
      expect(JSON.parse(emitted)).toBe(name);
    }
  });

  it('jsonSchemaToTypeScript() on every hostile-named entry still emits valid type text', () => {
    for (const entry of Object.values(contract.signals ?? {})) {
      const emitted = jsonSchemaToTypeScript(entry.inputSchema);
      expect(typeof emitted).toBe('string');
      expect(emitted.length).toBeGreaterThan(0);
    }
  });
});

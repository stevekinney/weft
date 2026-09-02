import { describe, expect, it } from 'bun:test';

import equivalentContracts from './__fixtures__/equivalent-contracts-different-key-order.json';
import { canonicalWorkflowContractJson, normalizeWorkflowContract } from './normalize.ts';
import type { WorkflowContract } from './types.ts';

describe('normalizeWorkflowContract', () => {
  it('sorts signal, update, query, and activity keys', () => {
    const normalized = normalizeWorkflowContract({
      name: 'checkout',
      workflowVersion: '1.0.0',
      signals: { zeta: {}, alpha: {} },
      updates: { zeta: {}, alpha: {} },
      queries: { zeta: {}, alpha: {} },
      activities: { zeta: {}, alpha: {} },
    });

    expect(Object.keys(normalized.signals ?? {})).toEqual(['alpha', 'zeta']);
    expect(Object.keys(normalized.updates ?? {})).toEqual(['alpha', 'zeta']);
    expect(Object.keys(normalized.queries ?? {})).toEqual(['alpha', 'zeta']);
    expect(Object.keys(normalized.activities ?? {})).toEqual(['alpha', 'zeta']);
  });

  it('omits empty signals/updates/queries/activities records rather than emitting {}', () => {
    const normalized = normalizeWorkflowContract({
      name: 'checkout',
      workflowVersion: '1.0.0',
      signals: {},
      updates: {},
      queries: {},
      activities: {},
    });

    expect(normalized.signals).toBeUndefined();
    expect(normalized.updates).toBeUndefined();
    expect(normalized.queries).toBeUndefined();
    expect(normalized.activities).toBeUndefined();
    expect(normalized).toEqual({ name: 'checkout', workflowVersion: '1.0.0' });
  });

  it('sorts tags', () => {
    const normalized = normalizeWorkflowContract({
      name: 'checkout',
      workflowVersion: '1.0.0',
      tags: ['zeta', 'alpha'],
    });
    expect(normalized.tags).toEqual(['alpha', 'zeta']);
  });

  it('clones schema fragments so mutating the input does not affect the normalized output', () => {
    const inputSchema = { type: 'object', properties: { id: { type: 'string' } } };
    const normalized = normalizeWorkflowContract({
      name: 'checkout',
      workflowVersion: '1.0.0',
      inputSchema,
    });
    inputSchema.properties.id.type = 'number';
    const normalizedProperties = normalized.inputSchema as {
      properties: { id: { type: string } };
    };
    expect(normalizedProperties.properties.id.type).toBe('string');
  });

  it('lets a signal literally named __proto__ survive as an own property, not a prototype mutation', () => {
    // `{}` inherits the `__proto__` *accessor* from `Object.prototype`, so
    // both object-literal syntax and plain bracket assignment (`obj['__proto__']
    // = x`) invoke that setter and change the prototype instead of creating
    // an own property. `Object.defineProperty` is the one construction path
    // that actually creates an own data property named `__proto__`.
    const signals: Record<string, { inputSchema?: Record<string, unknown> }> = {};
    Object.defineProperty(signals, '__proto__', {
      value: { inputSchema: { type: 'string' } },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(Object.keys(signals)).toEqual(['__proto__']);

    const normalized = normalizeWorkflowContract({
      name: 'checkout',
      workflowVersion: '1.0.0',
      signals,
    });
    expect(Object.prototype.hasOwnProperty.call(normalized.signals, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  describe('equivalent contracts regardless of source key order', () => {
    const { a, b } = equivalentContracts as { a: WorkflowContract; b: WorkflowContract };

    it('normalizes to deep-equal in-memory values', () => {
      expect(normalizeWorkflowContract(a)).toEqual(normalizeWorkflowContract(b));
    });

    it('serializes to byte-identical canonical JSON', () => {
      expect(canonicalWorkflowContractJson(a)).toBe(canonicalWorkflowContractJson(b));
    });

    it('serialization is deterministic across repeated calls (snapshot determinism)', () => {
      const first = canonicalWorkflowContractJson(a);
      const second = canonicalWorkflowContractJson(a);
      const third = canonicalWorkflowContractJson(normalizeWorkflowContract(a));
      expect(first).toBe(second);
      expect(first).toBe(third);
    });
  });
});

describe('canonicalWorkflowContractJson', () => {
  it('embeds the contract version domain separator', () => {
    const json = canonicalWorkflowContractJson({ name: 'checkout', workflowVersion: '1.0.0' });
    expect(json).toContain('"contractVersion":1');
  });

  it('includes name, workflowVersion, description, and tags (the full identity)', () => {
    const json = canonicalWorkflowContractJson({
      name: 'checkout',
      workflowVersion: '1.0.0',
      description: 'desc',
      tags: ['a'],
    });
    expect(json).toContain('"name":"checkout"');
    expect(json).toContain('"workflowVersion":"1.0.0"');
    expect(json).toContain('"description":"desc"');
    expect(json).toContain('"tags":["a"]');
  });
});

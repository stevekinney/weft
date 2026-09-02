import { describe, expect, it } from 'bun:test';

import { jsonSchemaToTypeScript } from '../../cli/codegen-emit.ts';
import type { DefinitionSchema, StandardJSONSchemaV1 } from '../types/definition-schema.ts';
import { query, signal, update } from '../types/message-handles.ts';
import hostileSchemas from './__fixtures__/hostile-schemas.json';
import { buildWorkflowContract, WorkflowContractConversionError } from './build.ts';
import type { WorkflowContractSource } from './types.ts';

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

/** A schema whose structural converter throws for the requested direction. */
function throwingSchema(): DefinitionSchema {
  const schema: StandardJSONSchemaV1 = {
    '~standard': {
      version: 1,
      vendor: 'weft-test-fixture',
      jsonSchema: {
        input: () => {
          throw new Error('boom');
        },
        output: () => {
          throw new Error('boom');
        },
      },
    },
  };
  return schema;
}

describe('buildWorkflowContract', () => {
  it('builds name and workflowVersion, defaulting workflowVersion when omitted', () => {
    const contract = buildWorkflowContract({ name: 'checkout' });
    expect(contract.name).toBe('checkout');
    expect(contract.workflowVersion).toBe('0.0.0');
  });

  it('preserves an explicit version, description, and tags', () => {
    const contract = buildWorkflowContract({
      name: 'checkout',
      version: '2.1.0',
      description: 'desc',
      tags: ['a', 'b'],
    });
    expect(contract.workflowVersion).toBe('2.1.0');
    expect(contract.description).toBe('desc');
    expect(contract.tags).toEqual(['a', 'b']);
  });

  it('converts workflow input/output schemas', () => {
    const contract = buildWorkflowContract({
      name: 'checkout',
      inputSchema: fixedSchema({ type: 'object', properties: { cartId: { type: 'string' } } }),
      outputSchema: fixedSchema({ type: 'string' }),
    });
    expect(contract.inputSchema).toEqual({
      type: 'object',
      properties: { cartId: { type: 'string' } },
    });
    expect(contract.outputSchema).toEqual({ type: 'string' });
  });

  it('converts signals, updates, queries, activities, and the finalizer', () => {
    const contract = buildWorkflowContract({
      name: 'checkout',
      signals: { cancel: { name: 'cancel', inputSchema: fixedSchema({ type: 'string' }) } },
      updates: {
        applyDiscount: {
          name: 'applyDiscount',
          inputSchema: fixedSchema({ type: 'string' }),
          outputSchema: fixedSchema({ type: 'boolean' }),
        },
      },
      queries: { status: { name: 'status', outputSchema: fixedSchema({ type: 'string' }) } },
      activities: { charge: { name: 'charge', inputSchema: fixedSchema({ type: 'number' }) } },
      finalizer: { name: 'cleanup', inputSchema: fixedSchema({ type: 'string' }) },
    });
    expect(contract.signals?.['cancel']?.inputSchema).toEqual({ type: 'string' });
    expect(contract.updates?.['applyDiscount']?.outputSchema).toEqual({ type: 'boolean' });
    expect(contract.queries?.['status']?.outputSchema).toEqual({ type: 'string' });
    expect(contract.activities?.['charge']?.inputSchema).toEqual({ type: 'number' });
    expect(contract.finalizer?.inputSchema).toEqual({ type: 'string' });
  });

  it("keys signals/updates/queries by the message definition's own runtime name, not the builder-map alias", () => {
    // `.signals({ localAlias: signal('wireName') })` registers under the
    // handle's own `.name` (`normalizeMessageDefinitions()` in
    // `core/engine/registration.ts` rekeys by `definition.name`), not the JS
    // object key the caller happened to use. buildWorkflowContract() must
    // match that so the built contract's keys line up with what the
    // registry and codegen actually expose.
    const contract = buildWorkflowContract({
      name: 'checkout',
      signals: {
        localSignalAlias: signal('wireSignalName', {
          inputSchema: fixedSchema({ type: 'string' }),
        }),
      },
      updates: {
        localUpdateAlias: update('wireUpdateName', {
          inputSchema: fixedSchema({ type: 'number' }),
        }),
      },
      queries: {
        localQueryAlias: query('wireQueryName', { outputSchema: fixedSchema({ type: 'boolean' }) }),
      },
    });
    expect(Object.keys(contract.signals ?? {})).toEqual(['wireSignalName']);
    expect(Object.keys(contract.updates ?? {})).toEqual(['wireUpdateName']);
    expect(Object.keys(contract.queries ?? {})).toEqual(['wireQueryName']);
    expect(contract.signals?.['localSignalAlias']).toBeUndefined();
    expect(contract.updates?.['localUpdateAlias']).toBeUndefined();
    expect(contract.queries?.['localQueryAlias']).toBeUndefined();
  });

  it('returns a normalized WorkflowContract (sorted keys) rather than the raw draft', () => {
    // Source keys are declared out of canonical order; the returned contract
    // must come back sorted, matching normalizeWorkflowContract()'s
    // contract, since buildWorkflowContract()'s own JSDoc and types.ts both
    // describe its return value as normalized. (Schema-fragment
    // null-prototype cloning and __proto__-key safety are already pinned
    // directly against normalizeWorkflowContract() in normalize.test.ts —
    // this only needs to prove buildWorkflowContract() actually routes
    // through it.)
    const contract = buildWorkflowContract({
      name: 'checkout',
      tags: ['zeta', 'alpha'],
      signals: {
        zetaSignal: signal('zeta-signal'),
        alphaSignal: signal('alpha-signal'),
      },
    });
    expect(contract.tags).toEqual(['alpha', 'zeta']);
    expect(Object.keys(contract.signals ?? {})).toEqual(['alpha-signal', 'zeta-signal']);
    expect(Object.getPrototypeOf(contract.signals)).toBeNull();
  });

  it('omits signals/updates/queries/activities entirely when none are declared', () => {
    const contract = buildWorkflowContract({ name: 'checkout' });
    expect(contract.signals).toBeUndefined();
    expect(contract.updates).toBeUndefined();
    expect(contract.queries).toBeUndefined();
    expect(contract.activities).toBeUndefined();
    expect(contract.finalizer).toBeUndefined();
  });

  describe('hostile schema constructs degrade to unknown (pinned via jsonSchemaToTypeScript, not reimplemented)', () => {
    for (const fixture of hostileSchemas as Array<{
      name: string;
      schema: Record<string, unknown>;
    }>) {
      it(fixture.name, () => {
        const contract = buildWorkflowContract({
          name: 'checkout',
          inputSchema: fixedSchema(fixture.schema),
        });
        expect(jsonSchemaToTypeScript(contract.inputSchema)).toBe('unknown');
      });
    }
  });

  it('a runtime-only artifact (unrecognized construct) degrades to unknown rather than throwing', () => {
    const contract = buildWorkflowContract({
      name: 'checkout',
      inputSchema: fixedSchema({ someBrandNewKeywordNoEmitterUnderstands: true }),
    });
    expect(jsonSchemaToTypeScript(contract.inputSchema)).toBe('unknown');
  });

  describe('conversion failures throw WorkflowContractConversionError with the right entityKind/entityName/direction', () => {
    const cases: Array<{
      entityKind: 'workflow' | 'signal' | 'update' | 'query' | 'activity' | 'finalizer';
      direction: 'inputSchema' | 'outputSchema';
      source: WorkflowContractSource;
    }> = [
      {
        entityKind: 'workflow',
        direction: 'inputSchema',
        source: { name: 'checkout', inputSchema: throwingSchema() },
      },
      {
        entityKind: 'workflow',
        direction: 'outputSchema',
        source: { name: 'checkout', outputSchema: throwingSchema() },
      },
      {
        entityKind: 'signal',
        direction: 'inputSchema',
        source: {
          name: 'checkout',
          signals: { cancel: { name: 'cancel', inputSchema: throwingSchema() } },
        },
      },
      {
        entityKind: 'update',
        direction: 'inputSchema',
        source: {
          name: 'checkout',
          updates: { applyDiscount: { name: 'applyDiscount', inputSchema: throwingSchema() } },
        },
      },
      {
        entityKind: 'update',
        direction: 'outputSchema',
        source: {
          name: 'checkout',
          updates: { applyDiscount: { name: 'applyDiscount', outputSchema: throwingSchema() } },
        },
      },
      {
        entityKind: 'query',
        direction: 'outputSchema',
        source: {
          name: 'checkout',
          queries: { status: { name: 'status', outputSchema: throwingSchema() } },
        },
      },
      {
        entityKind: 'activity',
        direction: 'inputSchema',
        source: {
          name: 'checkout',
          activities: { charge: { name: 'charge', inputSchema: throwingSchema() } },
        },
      },
      {
        entityKind: 'activity',
        direction: 'outputSchema',
        source: {
          name: 'checkout',
          activities: { charge: { name: 'charge', outputSchema: throwingSchema() } },
        },
      },
      {
        entityKind: 'finalizer',
        direction: 'inputSchema',
        source: { name: 'checkout', finalizer: { name: 'cleanup', inputSchema: throwingSchema() } },
      },
      {
        entityKind: 'finalizer',
        direction: 'outputSchema',
        source: {
          name: 'checkout',
          finalizer: { name: 'cleanup', outputSchema: throwingSchema() },
        },
      },
      {
        entityKind: 'signal',
        direction: 'outputSchema',
        source: {
          name: 'checkout',
          signals: { cancel: { name: 'cancel', outputSchema: throwingSchema() } },
        },
      },
      {
        entityKind: 'query',
        direction: 'inputSchema',
        source: {
          name: 'checkout',
          queries: { status: { name: 'status', inputSchema: throwingSchema() } },
        },
      },
    ];

    for (const testCase of cases) {
      it(`${testCase.entityKind}.${testCase.direction}`, () => {
        let caught: unknown;
        try {
          buildWorkflowContract(testCase.source);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(WorkflowContractConversionError);
        const error = caught as WorkflowContractConversionError;
        expect(error.entityKind).toBe(testCase.entityKind);
        expect(error.direction).toBe(testCase.direction);
      });
    }
  });
});

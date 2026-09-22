/**
 * COR-1283: direct unit test for `makeDefinitionSchema`'s own `validate`
 * closure. Every existing use of `makeDefinitionSchema()` (in
 * `workflow-adapter-metadata.test.ts`) passes its return value to
 * `catalogWorkflow` to prove that an unsupported (`vendor: 'weft-test'`)
 * `DefinitionSchema` is rejected before any schema conversion happens —
 * `catalogWorkflow` throws on the unrecognized vendor without ever calling
 * `~standard.validate`, so this fixture's own `validate` implementation was
 * never actually invoked by anything. It exists to make the fixture's
 * return value structurally conform to the `DefinitionSchema` shape
 * (`~standard.validate` must be present), not because any current caller
 * runs it — this test proves it does what its "unsupported test schema"
 * message documents, in case anything ever does.
 */
import { describe, expect, it } from 'bun:test';

import { makeDefinitionSchema } from './workflow-adapter.test-support.ts';

describe('makeDefinitionSchema', () => {
  it('its ~standard.validate always reports the schema itself as unsupported', () => {
    const schema = makeDefinitionSchema<{ orderId: string }>();

    expect(schema['~standard'].version).toBe(1);
    expect(schema['~standard'].vendor).toBe('weft-test');
    if (!('validate' in schema['~standard'])) {
      throw new Error("Expected makeDefinitionSchema's ~standard to expose validate()");
    }
    expect(schema['~standard'].validate({ orderId: 'ord-1' })).toEqual({
      issues: [{ message: 'unsupported test schema' }],
    });
  });
});

import { afterEach, describe, expect, it } from 'bun:test';
import { waitForever } from '../testing/fake-timers.test-support.ts';

import {
  collectKeys,
  flush,
  storageBackends,
  teardown,
} from '../testing/storage-backends.test-support.ts';
import { Engine } from './engine.ts';
import { workflow, type SearchAttributeSchema, type WorkflowContext } from './types.ts';

// ---------------------------------------------------------------------------
// A7: Multi-backend test coverage for search attributes
//
// Parametrize core search attribute integration tests across all storage
// backends to verify that attribute storage, index operations, and schema
// validation work identically on every backend.
// ---------------------------------------------------------------------------

for (const backend of storageBackends) {
  describe(`Search attributes integration [${backend.name}]`, () => {
    let engine: Engine;
    let cleanup: () => void;

    afterEach(async () => {
      await teardown(engine, cleanup);
    });

    // -----------------------------------------------------------------
    // Initial search attributes at start()
    // -----------------------------------------------------------------

    it('stores initial search attributes on start()', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const schema: SearchAttributeSchema = {
        status: { type: 'string' },
        priority: { type: 'number' },
      };

      const attrTestWorkflow = workflow({ name: 'attr-test', version: '1' })
        .searchAttributes(schema)
        .execute(async function* (_ctx: WorkflowContext) {
          // Keep workflow alive so attributes are not cleaned up
          await waitForever();
          return 'done';
        });
      engine.register(attrTestWorkflow);

      const handle = await engine.start('attr-test', undefined, {
        searchAttributes: { status: 'active', priority: 5 },
      });
      handle.result().catch(() => {});
      await flush();

      const attributes = await engine.getAttributes(handle.id);
      expect(attributes).not.toBeNull();
      expect(attributes!['status']).toBe('active');
      expect(attributes!['priority']).toBe(5);
    });

    // -----------------------------------------------------------------
    // setAttributes updates index
    // -----------------------------------------------------------------

    it('setAttributes creates index entries', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const idxTestWorkflow = workflow({ name: 'idx-test' }).execute(async function* (
        _ctx: WorkflowContext,
      ) {
        await waitForever();
        return 'done';
      });
      engine.register(idxTestWorkflow);

      const handle = await engine.start('idx-test', undefined);
      handle.result().catch(() => {});
      await flush();

      await engine.setAttributes(handle.id, { region: 'us-east' });

      const indexKeys = await collectKeys(result.storage, 'idx:region:');
      expect(indexKeys.length).toBeGreaterThanOrEqual(1);
      expect(indexKeys.some((key) => key.includes(handle.id))).toBe(true);
    });

    // -----------------------------------------------------------------
    // setAttributes updates existing attributes
    // -----------------------------------------------------------------

    it('setAttributes merges with existing attributes', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const mergeTestWorkflow = workflow({ name: 'merge-test' }).execute(async function* (
        _ctx: WorkflowContext,
      ) {
        await waitForever();
        return 'done';
      });
      engine.register(mergeTestWorkflow);

      const handle = await engine.start('merge-test', undefined);
      handle.result().catch(() => {});
      await flush();

      await engine.setAttributes(handle.id, { color: 'blue' });
      await engine.setAttributes(handle.id, { size: 42 });

      const attributes = await engine.getAttributes(handle.id);
      expect(attributes!['color']).toBe('blue');
      expect(attributes!['size']).toBe(42);
    });

    // -----------------------------------------------------------------
    // Schema validation rejects unknown attributes
    // -----------------------------------------------------------------

    it('rejects unknown search attribute names against schema', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const schema: SearchAttributeSchema = {
        status: { type: 'string' },
      };

      const schemaTestWorkflow = workflow({ name: 'schema-test', version: '1' })
        .searchAttributes(schema)
        .execute(async function* (_ctx: WorkflowContext) {
          await waitForever();
          return 'done';
        });
      engine.register(schemaTestWorkflow);

      const handle = await engine.start('schema-test', undefined);
      handle.result().catch(() => {});
      await flush();

      try {
        await engine.setAttributes(handle.id, { unknown_attr: 'value' });
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('Unknown search attribute');
        expect((error as Error).message).toContain('unknown_attr');
      }
    });

    // -----------------------------------------------------------------
    // Schema type validation rejects type mismatches
    // -----------------------------------------------------------------

    it('rejects type mismatch against schema', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const schema: SearchAttributeSchema = {
        priority: { type: 'number' },
      };

      const typeMismatchWorkflow = workflow({ name: 'type-mismatch', version: '1' })
        .searchAttributes(schema)
        .execute(async function* (_ctx: WorkflowContext) {
          await waitForever();
          return 'done';
        });
      engine.register(typeMismatchWorkflow);

      const handle = await engine.start('type-mismatch', undefined);
      handle.result().catch(() => {});
      await flush();

      try {
        await engine.setAttributes(handle.id, { priority: 'high' as any });
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('declared as "number"');
        expect((error as Error).message).toContain('string');
      }
    });

    // -----------------------------------------------------------------
    // Oversized value validation
    // -----------------------------------------------------------------

    it('rejects oversized attribute values', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const sizeTestWorkflow = workflow({ name: 'size-test' }).execute(async function* (
        _ctx: WorkflowContext,
      ) {
        await waitForever();
        return 'done';
      });
      engine.register(sizeTestWorkflow);

      const handle = await engine.start('size-test', undefined);
      handle.result().catch(() => {});
      await flush();

      try {
        await engine.setAttributes(handle.id, { bigValue: 'a'.repeat(2000) });
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('exceeds');
      }
    });

    // -----------------------------------------------------------------
    // Attribute filtering in list()
    // -----------------------------------------------------------------

    it('list() filters by attribute values', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const filterableWorkflow = workflow({ name: 'filterable' }).execute(async function* (
        _ctx: WorkflowContext,
      ) {
        // Keep alive so attributes are not cleaned up on completion
        await waitForever();
        return 'done';
      });
      engine.register(filterableWorkflow);

      const handle1 = await engine.start('filterable', undefined);
      handle1.result().catch(() => {});
      await flush();
      await engine.setAttributes(handle1.id, { team: 'alpha' });

      const handle2 = await engine.start('filterable', undefined);
      handle2.result().catch(() => {});
      await flush();
      await engine.setAttributes(handle2.id, { team: 'beta' });

      const alphaResults = await engine.list({
        attributes: [{ key: 'team', value: 'alpha' }],
      });

      expect(alphaResults.items.length).toBe(1);
      expect(alphaResults.items[0]!.id).toBe(handle1.id);
    });

    // -----------------------------------------------------------------
    // Boolean and Date attribute types
    // -----------------------------------------------------------------

    it('stores and retrieves boolean and Date attributes', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const typesTestWorkflow = workflow({ name: 'types-test' }).execute(async function* (
        _ctx: WorkflowContext,
      ) {
        // Keep alive so attributes persist
        await waitForever();
        return 'done';
      });
      engine.register(typesTestWorkflow);

      const handle = await engine.start('types-test', undefined);
      handle.result().catch(() => {});
      await flush();

      const testDate = new Date('2025-06-15T12:00:00.000Z');
      await engine.setAttributes(handle.id, {
        active: true,
        createdAt: testDate,
      });

      const attributes = await engine.getAttributes(handle.id);
      expect(attributes).not.toBeNull();
      expect(attributes!['active']).toBe(true);
      // Date round-trips through encoding may come back as string in some backends;
      // verify the value is semantically correct
      const storedDate = attributes!['createdAt'];
      if (storedDate instanceof Date) {
        expect(storedDate.toISOString()).toBe(testDate.toISOString());
      } else {
        expect(String(storedDate)).toContain('2025-06-15');
      }
    });
  });
}

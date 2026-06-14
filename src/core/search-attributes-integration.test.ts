import { afterEach, describe, expect, it } from 'bun:test';
import { sleepForTesting } from '../testing/fake-timers.test-support.ts';

import { KEYS } from '../storage/interface.ts';
import {
  collectKeys,
  flush,
  storageBackends,
  storageHas,
  teardown,
} from '../testing/storage-backends.test-support.ts';
import { decode } from './codec.ts';
import { Engine } from './engine.ts';
import { searchAttribute } from './search-attributes.ts';
import type { SearchAttributeValue, WorkflowContext } from './types.ts';
import { workflow } from './types.ts';

const waitForUpdateTestTimeoutMs = 90_000;

// ---------------------------------------------------------------------------
// Search Attributes
// ---------------------------------------------------------------------------

for (const backend of storageBackends) {
  describe(`Search Attributes Integration [${backend.name}]`, () => {
    let engine: Engine;
    let cleanup: () => void;

    afterEach(async () => {
      await teardown(engine, cleanup);
    });

    it('engine.start() with searchAttributes writes attr: and idx: keys', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const noopWorkflow = workflow({ name: 'noop' }).execute(async function* () {
        yield {
          type: 'sleep',
          operationId: 'test',
          duration: 100_000,
          scheduledFireAt: Date.now() + 100_000,
        };
        return 'done';
      });
      engine.register(noopWorkflow);

      await engine.start('noop', null, {
        id: 'wf-1',
        searchAttributes: {
          status: 'active',
          priority: 5,
        },
      });

      await flush();

      // Verify attr: key was written
      const attributeBytes = await result.storage.get(KEYS.attribute('wf-1'));
      expect(attributeBytes).not.toBeNull();
      const attributes = decode(attributeBytes!) as Record<string, SearchAttributeValue>;
      expect(attributes['status']).toBe('active');
      expect(attributes['priority']).toBe(5);

      // Verify idx: keys were written
      const indexKeys = await collectKeys(result.storage, 'idx:');
      expect(indexKeys.length).toBe(2);

      // Verify the specific index keys exist
      const statusIndexKey = KEYS.attributeIndex('status', 's:active', 'wf-1');
      expect(await storageHas(result.storage, statusIndexKey)).toBe(true);
    });

    it('ctx.setAttribute() writes idx: entries while workflow is running', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const setAttributeActivity = async () => 'done';

      const setAttrsRunningWorkflow = workflow({ name: 'set-attrs-running' }).execute(
        async function* (ctx: WorkflowContext) {
          const context = ctx;
          context.setAttribute('region', 'us-east');
          // Run an activity to trigger a checkpoint persist
          yield* context.run(setAttributeActivity);
          // Keep workflow running
          yield* context.waitForSignal('stop');
          return 'done';
        },
      );
      engine.register(setAttrsRunningWorkflow);

      await engine.start('set-attrs-running', null, { id: 'wf-3' });
      await flush();

      // Verify idx: key for 'region' was written
      const regionIndexKey = KEYS.attributeIndex('region', 's:us-east', 'wf-3');
      expect(await storageHas(result.storage, regionIndexKey)).toBe(true);

      // Verify attr: record was written
      const attributeBytes = await result.storage.get(KEYS.attribute('wf-3'));
      expect(attributeBytes).not.toBeNull();
      const attributes = decode(attributeBytes!) as Record<string, SearchAttributeValue>;
      expect(attributes['region']).toBe('us-east');
    });

    it('engine.list() with attribute filter returns matching workflows', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const stayRunningWorkflow = workflow({ name: 'stay-running' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        yield* ctx.waitForSignal('stop');
        return 'done';
      });
      engine.register(stayRunningWorkflow);

      // Start workflows with different attributes
      await engine.start('stay-running', null, {
        id: 'wf-active-1',
        searchAttributes: { status: 'active' },
      });

      await engine.start('stay-running', null, {
        id: 'wf-active-2',
        searchAttributes: { status: 'active' },
      });

      await engine.start('stay-running', null, {
        id: 'wf-pending-1',
        searchAttributes: { status: 'pending' },
      });

      await flush();

      // Query for active workflows
      const result2 = await engine.list({
        attributes: [{ key: 'status', value: 'active' }],
      });

      expect(result2.items.length).toBe(2);
      const ids = result2.items.map((item) => item.id).toSorted();
      expect(ids).toEqual(['wf-active-1', 'wf-active-2']);
    });

    it('engine.list() treats attribute value arrays as any-of exact filters', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const stayRunningWorkflow = workflow({ name: 'stay-running' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        yield* ctx.waitForSignal('stop');
        return 'done';
      });
      engine.register(stayRunningWorkflow);

      await engine.start('stay-running', null, {
        id: 'wf-region-east',
        searchAttributes: { region: 'us-east' },
      });
      await engine.start('stay-running', null, {
        id: 'wf-region-west',
        searchAttributes: { region: 'eu-west' },
      });
      await engine.start('stay-running', null, {
        id: 'wf-region-south',
        searchAttributes: { region: 'ap-south' },
      });
      await flush();

      const listResult = await engine.list({
        attributes: [{ key: 'region', value: ['us-east', 'eu-west'] }],
      });

      expect(listResult.items.map((item) => item.id).toSorted()).toEqual([
        'wf-region-east',
        'wf-region-west',
      ]);
    });

    it('engine.list() with range attribute filter works', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const stayRunningWorkflow2 = workflow({ name: 'stay-running' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        yield* ctx.waitForSignal('stop');
        return 'done';
      });
      engine.register(stayRunningWorkflow2);

      await engine.start('stay-running', null, {
        id: 'wf-price-5',
        searchAttributes: { price: 5 },
      });

      await engine.start('stay-running', null, {
        id: 'wf-price-50',
        searchAttributes: { price: 50 },
      });

      await engine.start('stay-running', null, {
        id: 'wf-price-150',
        searchAttributes: { price: 150 },
      });

      await flush();

      // Range query: price between 10 and 100
      const listResult = await engine.list({
        attributes: [{ key: 'price', gte: 10, lte: 100 }],
      });

      expect(listResult.items.length).toBe(1);
      expect(listResult.items[0]!.id).toBe('wf-price-50');
    });

    it('searchAttribute() handles preserve exact, range, date, and array filters', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const customerId = searchAttribute('customerId', 'string');
      const orderTotal = searchAttribute('orderTotal', 'number');
      const createdAt = searchAttribute('createdAt', { type: 'string', format: 'date-time' });
      const labels = searchAttribute('labels', {
        type: 'array',
        items: { type: 'string' },
      });

      const indexedOrderWorkflow = workflow({ name: 'indexed-order' })
        .searchAttributes({
          customerId,
          orderTotal,
          createdAt,
          labels,
        })
        .execute(async function* (ctx: WorkflowContext) {
          yield* ctx.waitForSignal('stop');
          return 'done';
        });
      engine.register(indexedOrderWorkflow);

      await engine.start('indexed-order', null, {
        id: 'wf-indexed-a',
        searchAttributes: {
          customerId: 'cust-a',
          orderTotal: 75,
          createdAt: new Date('2026-01-15T00:00:00.000Z'),
          labels: ['priority', 'manual-review'],
        },
      });
      await engine.start('indexed-order', null, {
        id: 'wf-indexed-b',
        searchAttributes: {
          customerId: 'cust-b',
          orderTotal: 20,
          createdAt: new Date('2026-02-15T00:00:00.000Z'),
          labels: ['standard'],
        },
      });
      await flush();

      const exactMatch = await engine.list({
        attributes: [{ key: customerId, value: 'cust-a' }],
      });
      expect(exactMatch.items.map((item) => item.id)).toEqual(['wf-indexed-a']);

      const rangeMatch = await engine.list({
        attributes: [{ key: orderTotal, gte: 50, lte: 100 }],
      });
      expect(rangeMatch.items.map((item) => item.id)).toEqual(['wf-indexed-a']);

      const dateMatch = await engine.list({
        attributes: [
          {
            key: createdAt,
            gte: new Date('2026-01-01T00:00:00.000Z'),
            lt: new Date('2026-02-01T00:00:00.000Z'),
          },
        ],
      });
      expect(dateMatch.items.map((item) => item.id)).toEqual(['wf-indexed-a']);

      const arrayContainmentMatch = await engine.list({
        attributes: [{ key: labels, value: 'priority' }],
      });
      expect(arrayContainmentMatch.items.map((item) => item.id)).toEqual(['wf-indexed-a']);

      const arrayAnyOfMatch = await engine.list({
        attributes: [{ key: labels, value: ['priority', 'standard'] }],
      });
      expect(arrayAnyOfMatch.items.map((item) => item.id).toSorted()).toEqual([
        'wf-indexed-a',
        'wf-indexed-b',
      ]);
    });

    it('index entries are cleaned up on workflow completion', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const completeQuicklyWorkflow = workflow({ name: 'complete-quickly' }).execute(
        async function* () {
          return 'done';
        },
      );
      engine.register(completeQuicklyWorkflow);

      await engine.start('complete-quickly', null, {
        id: 'wf-cleanup',
        searchAttributes: { status: 'active', priority: 1 },
      });

      // Wait for the workflow to complete
      const handle = engine.getHandle('wf-cleanup');
      await handle.result();

      // Verify that index entries are cleaned up
      const indexKeys = await collectKeys(result.storage, 'idx:');
      expect(indexKeys.length).toBe(0);

      // Verify attr: record is cleaned up
      const attributeBytes = await result.storage.get(KEYS.attribute('wf-cleanup'));
      expect(attributeBytes).toBeNull();
    });

    it('user-set index entries are cleaned up on workflow failure; failureCategory index entry survives', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const failQuicklyWorkflow = workflow({ name: 'fail-quickly' }).execute(async function* () {
        throw new Error('intentional failure');
      });
      engine.register(failQuicklyWorkflow);

      const handle = await engine.start('fail-quickly', null, {
        id: 'wf-fail-cleanup',
        searchAttributes: { status: 'active' },
      });

      try {
        await handle.result();
      } catch {
        // expected
      }

      await flush();

      // The user-set "status" index entry is cleaned up, but the engine-managed
      // "failureCategory" index entry survives so engine.list({ attributes: ... }) works.
      const indexKeys = await collectKeys(result.storage, 'idx:');
      expect(indexKeys.length).toBe(1);
      expect(indexKeys[0]).toContain('failureCategory');

      // The attr: record survives (contains failureCategory)
      const attributeBytes = await result.storage.get(KEYS.attribute('wf-fail-cleanup'));
      expect(attributeBytes).not.toBeNull();
      const attributes = decode(attributeBytes!) as Record<string, unknown>;
      expect(attributes['failureCategory']).toBe('application');
    });

    it('index entries are cleaned up on workflow cancellation', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const stayRunningWorkflow3 = workflow({ name: 'stay-running' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        yield* ctx.waitForSignal('stop');
        return 'done';
      });
      engine.register(stayRunningWorkflow3);

      const handle = await engine.start('stay-running', null, {
        id: 'wf-cancel-cleanup',
        searchAttributes: { status: 'active' },
      });

      // Catch the rejection from the result promise so it does not surface as unhandled
      handle.result().catch(() => {});

      await flush();

      // Verify index exists before cancel
      let indexKeys = await collectKeys(result.storage, 'idx:');
      expect(indexKeys.length).toBe(1);

      await engine.cancel('wf-cancel-cleanup');

      // Verify index entries are cleaned up
      indexKeys = await collectKeys(result.storage, 'idx:');
      expect(indexKeys.length).toBe(0);
    });

    it('list with multiple attribute filters intersects results', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const stayRunningWorkflow4 = workflow({ name: 'stay-running' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        yield* ctx.waitForSignal('stop');
        return 'done';
      });
      engine.register(stayRunningWorkflow4);

      await engine.start('stay-running', null, {
        id: 'wf-both',
        searchAttributes: { status: 'active', region: 'us-east' },
      });

      await engine.start('stay-running', null, {
        id: 'wf-status-only',
        searchAttributes: { status: 'active', region: 'eu-west' },
      });

      await engine.start('stay-running', null, {
        id: 'wf-region-only',
        searchAttributes: { status: 'pending', region: 'us-east' },
      });

      await flush();

      const listResult = await engine.list({
        attributes: [
          { key: 'status', value: 'active' },
          { key: 'region', value: 'us-east' },
        ],
      });

      expect(listResult.items.length).toBe(1);
      expect(listResult.items[0]!.id).toBe('wf-both');
    });
  });

  // -------------------------------------------------------------------------
  // Handle-level getAttributes / setAttributes
  // -------------------------------------------------------------------------

  describe(`Handle-level getAttributes / setAttributes [${backend.name}]`, () => {
    let engine: Engine;
    let cleanup: () => void;

    afterEach(async () => {
      await teardown(engine, cleanup);
    });

    it('handle.setAttributes() persists the attribute', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const stayRunningWorkflow5 = workflow({ name: 'stay-running' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        yield* ctx.waitForSignal('stop');
        return 'done';
      });
      engine.register(stayRunningWorkflow5);

      const handle = await engine.start('stay-running', null, { id: 'wf-handle-set' });
      await flush();

      await handle.setAttributes({ region: 'us-east' });

      // Verify the attribute was persisted
      const attributes = await engine.getAttributes('wf-handle-set');
      expect(attributes).not.toBeNull();
      expect(attributes!['region']).toBe('us-east');
    });

    it('handle.getAttributes() retrieves the set attributes', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const stayRunningWorkflow6 = workflow({ name: 'stay-running' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        yield* ctx.waitForSignal('stop');
        return 'done';
      });
      engine.register(stayRunningWorkflow6);

      const handle = await engine.start('stay-running', null, {
        id: 'wf-handle-get',
        searchAttributes: { priority: 10, region: 'eu-west' },
      });
      await flush();

      const attributes = await handle.getAttributes();
      expect(attributes).not.toBeNull();
      expect(attributes!['priority']).toBe(10);
      expect(attributes!['region']).toBe('eu-west');
    });

    it('handle methods work with the engine.start() return value', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const stayRunningWorkflow7 = workflow({ name: 'stay-running' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        yield* ctx.waitForSignal('stop');
        return 'done';
      });
      engine.register(stayRunningWorkflow7);

      const handle = await engine.start('stay-running', null, { id: 'wf-handle-both' });
      await flush();

      // Set via handle
      await handle.setAttributes({ status: 'active', count: 42 });

      // Get via same handle
      const attributes = await handle.getAttributes();
      expect(attributes).not.toBeNull();
      expect(attributes!['status']).toBe('active');
      expect(attributes!['count']).toBe(42);
    });
  });

  // -------------------------------------------------------------------------
  // Schema Registration and Validation
  // -------------------------------------------------------------------------

  describe(`Schema Registration and Validation [${backend.name}]`, () => {
    let engine: Engine;
    let cleanup: () => void;

    afterEach(async () => {
      await teardown(engine, cleanup);
    });

    it('setting a registered attribute succeeds', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const schemaWfWorkflow = workflow({ name: 'schema-wf' })
        .searchAttributes({
          region: { type: 'string' },
          priority: { type: 'number' },
        })
        .execute(async function* (ctx: WorkflowContext) {
          const context = ctx;
          context.setAttribute('region', 'us-east');
          yield* context.run(async () => 'done');
          yield* context.waitForSignal('stop');
          return 'done';
        });
      engine.register(schemaWfWorkflow);

      await engine.start('schema-wf', null, { id: 'wf-schema-ok' });
      await flush();

      const attributes = await engine.getAttributes('wf-schema-ok');
      expect(attributes).not.toBeNull();
      expect(attributes!['region']).toBe('us-east');
    });

    it('setting an unknown attribute throws with descriptive error', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const schemaStrictWorkflow = workflow({ name: 'schema-strict' })
        .searchAttributes({
          region: { type: 'string' },
          priority: { type: 'number' },
        })
        .execute(async function* (ctx: WorkflowContext) {
          const context = ctx;
          context.setAttribute('unknownKey', 'value');
          yield* context.run(async () => 'done');
          return 'done';
        });
      engine.register(schemaStrictWorkflow);

      const handle = await engine.start('schema-strict', null, { id: 'wf-schema-fail' });

      try {
        await handle.result();
        // If we reach here, the workflow completed without throwing. In the inline
        // strategy the error from setAttribute propagates through the generator.
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('Unknown search attribute "unknownKey"');
        expect((error as Error).message).toContain('region');
        expect((error as Error).message).toContain('priority');
      }
    });

    it('workflows without schema accept any search attribute key', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const noSchemaWorkflow = workflow({ name: 'no-schema' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        const context = ctx;
        context.setAttribute('anything', 'goes');
        context.setAttribute('random', 123);
        yield* context.run(async () => 'done');
        yield* context.waitForSignal('stop');
        return 'done';
      });
      engine.register(noSchemaWorkflow);

      await engine.start('no-schema', null, { id: 'wf-no-schema' });
      await flush();

      const attributes = await engine.getAttributes('wf-no-schema');
      expect(attributes).not.toBeNull();
      expect(attributes!['anything']).toBe('goes');
      expect(attributes!['random']).toBe(123);
    });

    it('external engine.setAttributes() validates against schema', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const schemaExtWorkflow = workflow({ name: 'schema-ext' })
        .searchAttributes({
          region: { type: 'string' },
          priority: { type: 'number' },
        })
        .execute(async function* (ctx: WorkflowContext) {
          yield* ctx.waitForSignal('stop');
          return 'done';
        });
      engine.register(schemaExtWorkflow);

      await engine.start('schema-ext', null, { id: 'wf-schema-ext' });
      await flush();

      // Valid attribute should succeed
      await engine.setAttributes('wf-schema-ext', { region: 'us-west' });

      // Invalid attribute should throw
      try {
        await engine.setAttributes('wf-schema-ext', { badKey: 'value' });
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('Unknown search attribute "badKey"');
        expect((error as Error).message).toContain('region');
        expect((error as Error).message).toContain('priority');
      }
    });

    it('context.setAttributes() (batch) validates all keys against schema', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const schemaBatchWorkflow = workflow({ name: 'schema-batch' })
        .searchAttributes({
          region: { type: 'string' },
        })
        .execute(async function* (ctx: WorkflowContext) {
          const context = ctx;
          context.setAttributes({ region: 'us-east', badKey: 'oops' });
          yield* context.run(async () => 'done');
          return 'done';
        });
      engine.register(schemaBatchWorkflow);

      const handle = await engine.start('schema-batch', null, { id: 'wf-schema-batch' });

      try {
        await handle.result();
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('Unknown search attribute "badKey"');
      }
    });

    it('setting a number value for a string-declared attribute throws a type error', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const schemaTypeMismatchWorkflow = workflow({ name: 'schema-type-mismatch' })
        .searchAttributes({
          status: { type: 'string' },
          priority: { type: 'number' },
        })
        .execute(async function* (ctx: WorkflowContext) {
          yield* ctx.waitForSignal('stop');
          return 'done';
        });
      engine.register(schemaTypeMismatchWorkflow);

      await engine.start('schema-type-mismatch', null, { id: 'wf-type-mismatch' });
      await flush();

      // Setting a number where string is expected should throw
      try {
        await engine.setAttributes('wf-type-mismatch', { status: 12345 as any });
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('declared as "string"');
        expect((error as Error).message).toContain('received number');
      }
    });

    it('setting a string value for a number-declared attribute throws a type error', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const schemaTypeMismatchNumWorkflow = workflow({ name: 'schema-type-mismatch-num' })
        .searchAttributes({
          priority: { type: 'number' },
        })
        .execute(async function* (ctx: WorkflowContext) {
          yield* ctx.waitForSignal('stop');
          return 'done';
        });
      engine.register(schemaTypeMismatchNumWorkflow);

      await engine.start('schema-type-mismatch-num', null, { id: 'wf-type-mismatch-num' });
      await flush();

      try {
        await engine.setAttributes('wf-type-mismatch-num', { priority: 'high' as any });
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('declared as "number"');
        expect((error as Error).message).toContain('received string');
      }
    });

    it('setting a correctly-typed value succeeds with type validation', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const schemaTypeOkWorkflow = workflow({ name: 'schema-type-ok' })
        .searchAttributes({
          status: { type: 'string' },
          priority: { type: 'number' },
          active: { type: 'boolean' },
        })
        .execute(async function* (ctx: WorkflowContext) {
          yield* ctx.waitForSignal('stop');
          return 'done';
        });
      engine.register(schemaTypeOkWorkflow);

      await engine.start('schema-type-ok', null, { id: 'wf-type-ok' });
      await flush();

      // All correctly-typed values should succeed
      await engine.setAttributes('wf-type-ok', {
        status: 'active',
        priority: 5,
        active: true,
      });

      const attributes = await engine.getAttributes('wf-type-ok');
      expect(attributes).not.toBeNull();
      expect(attributes!['status']).toBe('active');
      expect(attributes!['priority']).toBe(5);
      expect(attributes!['active']).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // gt / lt Filter Operators
  // -------------------------------------------------------------------------

  describe(`gt / lt Filter Operators [${backend.name}]`, () => {
    let engine: Engine;
    let cleanup: () => void;

    afterEach(async () => {
      await teardown(engine, cleanup);
    });

    it('engine.list() with gt filter excludes the boundary value', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const stayRunningWorkflow8 = workflow({ name: 'stay-running' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        yield* ctx.waitForSignal('stop');
        return 'done';
      });
      engine.register(stayRunningWorkflow8);

      await engine.start('stay-running', null, {
        id: 'wf-p3',
        searchAttributes: { priority: 3 },
      });
      await engine.start('stay-running', null, {
        id: 'wf-p5',
        searchAttributes: { priority: 5 },
      });
      await engine.start('stay-running', null, {
        id: 'wf-p7',
        searchAttributes: { priority: 7 },
      });
      await engine.start('stay-running', null, {
        id: 'wf-p10',
        searchAttributes: { priority: 10 },
      });

      await flush();

      // gt: 5 should return only priority > 5 (not 5 itself)
      const listResult = await engine.list({
        attributes: [{ key: 'priority', gt: 5 }],
      });

      const ids = listResult.items.map((item) => item.id).toSorted();
      expect(ids).toEqual(['wf-p10', 'wf-p7']);
    });

    it('engine.list() with lt filter excludes the boundary value', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const stayRunningWorkflow9 = workflow({ name: 'stay-running' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        yield* ctx.waitForSignal('stop');
        return 'done';
      });
      engine.register(stayRunningWorkflow9);

      await engine.start('stay-running', null, {
        id: 'wf-p3',
        searchAttributes: { priority: 3 },
      });
      await engine.start('stay-running', null, {
        id: 'wf-p5',
        searchAttributes: { priority: 5 },
      });
      await engine.start('stay-running', null, {
        id: 'wf-p10',
        searchAttributes: { priority: 10 },
      });

      await flush();

      // lt: 10 should return only priority < 10 (not 10 itself)
      const listResult = await engine.list({
        attributes: [{ key: 'priority', lt: 10 }],
      });

      const ids = listResult.items.map((item) => item.id).toSorted();
      expect(ids).toEqual(['wf-p3', 'wf-p5']);
    });

    it('gt and lt can be combined for an exclusive range', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const stayRunningWorkflow10 = workflow({ name: 'stay-running' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        yield* ctx.waitForSignal('stop');
        return 'done';
      });
      engine.register(stayRunningWorkflow10);

      await engine.start('stay-running', null, {
        id: 'wf-p1',
        searchAttributes: { priority: 1 },
      });
      await engine.start('stay-running', null, {
        id: 'wf-p5',
        searchAttributes: { priority: 5 },
      });
      await engine.start('stay-running', null, {
        id: 'wf-p10',
        searchAttributes: { priority: 10 },
      });

      await flush();

      // gt: 1, lt: 10 -- only priority=5 matches
      const listResult = await engine.list({
        attributes: [{ key: 'priority', gt: 1, lt: 10 }],
      });

      expect(listResult.items.length).toBe(1);
      expect(listResult.items[0]!.id).toBe('wf-p5');
    });
  });

  // -------------------------------------------------------------------------
  // Synchronous Updates (wait-update)
  // -------------------------------------------------------------------------

  describe(`Synchronous Updates (waitForUpdate) [${backend.name}]`, () => {
    let engine: Engine;
    let cleanup: () => void;

    afterEach(async () => {
      await teardown(engine, cleanup);
    });

    it(
      'ctx.waitForUpdate() pauses until engine.update() is called',
      async () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        engine = new Engine({ storage: result.storage });

        const waitForUpdateWorkflow = workflow({ name: 'wait-for-update' }).execute(
          async function* (ctx: WorkflowContext) {
            const context = ctx;
            const { payload, respond } = yield* context.waitForUpdate<{ value: number }>(
              'my-update',
            );
            respond({ accepted: true, value: payload.value });
            return payload;
          },
        );
        engine.register(waitForUpdateWorkflow);

        const handle = await engine.start('wait-for-update', null, { id: 'wf-update-1' });

        await flush();

        // Send update -- the caller receives whatever respond() was called with
        const updateResult = await engine.update(
          'wf-update-1',
          'my-update',
          { value: 42 },
          {
            timeout: waitForUpdateTestTimeoutMs,
          },
        );
        expect(updateResult).toEqual({ accepted: true, value: 42 });

        // Workflow should have completed with the update payload
        const workflowResult = await handle.result();
        expect(workflowResult).toEqual({ value: 42 });
      },
      waitForUpdateTestTimeoutMs,
    );

    it(
      'multiple concurrent waitForUpdate calls with different names work independently',
      async () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        engine = new Engine({ storage: result.storage });

        const multiUpdateWorkflow = workflow({ name: 'multi-update' }).execute(async function* (
          ctx: WorkflowContext,
        ) {
          const context = ctx;
          const { payload: firstPayload, respond: respond1 } =
            yield* context.waitForUpdate<string>('update-a');
          respond1(firstPayload);
          const { payload: secondPayload, respond: respond2 } =
            yield* context.waitForUpdate<string>('update-b');
          respond2(secondPayload);
          return `${firstPayload}-${secondPayload}`;
        });
        engine.register(multiUpdateWorkflow);

        const handle = await engine.start('multi-update', null, { id: 'wf-multi-update' });

        await flush();

        // Send first update
        await engine.update('wf-multi-update', 'update-a', 'hello', {
          timeout: waitForUpdateTestTimeoutMs,
        });

        await flush();

        // Send second update
        await engine.update('wf-multi-update', 'update-b', 'world', {
          timeout: waitForUpdateTestTimeoutMs,
        });

        const workflowResult = await handle.result();
        expect(workflowResult).toBe('hello-world');
      },
      waitForUpdateTestTimeoutMs,
    );

    it('waitForUpdate with pre-existing pending update resolves immediately', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const pendingUpdateWorkflow = workflow({ name: 'pending-update' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        const context = ctx;
        // Run an activity first to give time for the update to be queued
        yield* context.run(async () => {
          // This gives the engine time to process the update request
          await sleepForTesting(50);
          return 'activity-done';
        });
        const { payload, respond } = yield* context.waitForUpdate<string>('pending');
        respond(payload);
        return payload;
      });
      engine.register(pendingUpdateWorkflow);

      const handle = await engine.start('pending-update', null, { id: 'wf-pending-update' });

      // Queue update before workflow reaches waitForUpdate.
      // Don't await immediately so it runs concurrently with the workflow.
      const updatePromise = engine
        .update('wf-pending-update', 'pending', 'pre-queued', {
          timeout: 10000,
        })
        .catch(() => {});

      await flush();
      await flush();

      const workflowResult = await handle.result();
      expect(workflowResult).toBe('pre-queued');

      // Ensure the update polling has fully settled before teardown
      await updatePromise;
    });

    it(
      'update events are dispatched for wait-update path',
      async () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        engine = new Engine({ storage: result.storage });
        const events: string[] = [];

        engine.addEventListener('update:received', () => events.push('received'));
        engine.addEventListener('update:completed', () => events.push('completed'));

        const eventsUpdateWorkflow = workflow({ name: 'events-update' }).execute(async function* (
          ctx: WorkflowContext,
        ) {
          const context = ctx;
          const { payload, respond } = yield* context.waitForUpdate('my-update');
          respond(payload);
          return payload;
        });
        engine.register(eventsUpdateWorkflow);

        const handle = await engine.start('events-update', null, { id: 'wf-events-update' });
        await flush();

        await engine.update('wf-events-update', 'my-update', 'data', {
          timeout: waitForUpdateTestTimeoutMs,
        });
        await handle.result();
        // Extra flushes to let update coordinator's background polling settle
        // before afterEach disposes the engine and storage.
        await flush();
        await flush();

        expect(events).toContain('received');
        expect(events).toContain('completed');
      },
      waitForUpdateTestTimeoutMs,
    );
  });
}

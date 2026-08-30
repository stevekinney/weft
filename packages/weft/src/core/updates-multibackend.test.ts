import { afterEach, describe, expect, it } from 'bun:test';
import { waitForever } from '../testing/fake-timers.test-support.ts';

import { KEYS } from '../storage/interface.ts';
import {
  flush,
  storageBackends,
  teardown,
  waitForWorkflowStatus,
} from '../testing/storage-backends.test-support.ts';
import { encode } from './codec.ts';
import { Engine } from './engine.ts';
import type { WorkflowContext } from './types.ts';
import { workflow } from './types.ts';
import { WorkflowTerminalError } from './updates.ts';

// ---------------------------------------------------------------------------
// A7: Multi-backend test coverage for updates
//
// Parametrize core update-handling tests across all storage backends to
// verify that synchronous updates, coordinated updates, and update
// lifecycle work identically on every backend.
// ---------------------------------------------------------------------------

for (const backend of storageBackends) {
  describe(`Updates integration [${backend.name}]`, () => {
    let engine: Engine;
    let cleanup: () => void;

    afterEach(async () => {
      await teardown(engine, cleanup);
    });

    // -----------------------------------------------------------------
    // Inline handler: onUpdate responds synchronously
    // -----------------------------------------------------------------

    it('inline onUpdate handler responds synchronously', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        ctx.onUpdate('echo', (payload) => `echo: ${String(payload)}`);
        await waitForever();
        return 'done';
      });
      engine.register(echoWorkflow);

      const handle = await engine.start('echo', undefined);
      handle.result().catch(() => {});
      await flush();

      const updateResult = await engine.update(handle.id, 'echo', 'hello');
      expect(updateResult).toBe('echo: hello');
    });

    // -----------------------------------------------------------------
    // waitForUpdate yields { payload, respond }
    // -----------------------------------------------------------------

    it('waitForUpdate yields payload and respond function', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const waiterWorkflow = workflow({ name: 'waiter' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        const { payload, respond } = yield* ctx.waitForUpdate<string>('review');
        respond({ accepted: true, data: payload });
        return `processed: ${payload}`;
      });
      engine.register(waiterWorkflow);

      const handle = await engine.start('waiter', undefined);
      await waitForWorkflowStatus(engine, handle.id, 'running');

      const updateResult = await engine.update(handle.id, 'review', 'my-data');
      expect(updateResult).toEqual({ accepted: true, data: 'my-data' });

      const handleResult = await handle.result();
      expect(handleResult).toBe('processed: my-data');
    });

    // -----------------------------------------------------------------
    // Update to terminal workflow throws WorkflowTerminalError
    // -----------------------------------------------------------------

    it('rejects update to completed workflow', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const quickWorkflow = workflow({ name: 'quick' }).execute(async function* (
        _ctx: WorkflowContext,
      ) {
        return 'done';
      });
      engine.register(quickWorkflow);

      const handle = await engine.start('quick', undefined);
      await handle.result();
      await flush();

      try {
        await engine.update(handle.id, 'something', undefined);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(WorkflowTerminalError);
        expect((error as WorkflowTerminalError).status).toBe('completed');
      }
    });

    // -----------------------------------------------------------------
    // Update timeout
    // -----------------------------------------------------------------

    it('update times out when no handler responds', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const noHandlerWorkflow = workflow({ name: 'no-handler' }).execute(async function* (
        _ctx: WorkflowContext,
      ) {
        await waitForever();
        return 'done';
      });
      engine.register(noHandlerWorkflow);

      const handle = await engine.start('no-handler', undefined);
      handle.result().catch(() => {});
      await flush();

      try {
        await engine.update(handle.id, 'nonexistent', undefined, { timeout: 50 });
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('timed out');
      }
    });

    // -----------------------------------------------------------------
    // Multiple updates in sequence
    // -----------------------------------------------------------------

    it('handles multiple sequential updates', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      let counter = 0;
      const counterWorkflow = workflow({ name: 'counter' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        ctx.onUpdate('increment', () => {
          counter += 1;
          return counter;
        });
        await waitForever();
        return counter;
      });
      engine.register(counterWorkflow);

      const handle = await engine.start('counter', undefined);
      handle.result().catch(() => {});
      await flush();

      const r1 = await engine.update(handle.id, 'increment', undefined);
      const r2 = await engine.update(handle.id, 'increment', undefined);
      const r3 = await engine.update(handle.id, 'increment', undefined);

      expect(r1).toBe(1);
      expect(r2).toBe(2);
      expect(r3).toBe(3);
    });

    // -----------------------------------------------------------------
    // Coordinated update FIFO ordering
    // -----------------------------------------------------------------

    it('coordinated updates are processed in FIFO order', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const workflowId = `fifo-${backend.name}-${Date.now()}`;

      // Pre-seed two coordinated updates with explicit timestamps
      const older = {
        updateId: 'upd-old',
        workflowId,
        name: 'data',
        payload: 'first',
        createdAt: 1000,
      };
      const newer = {
        updateId: 'upd-new',
        workflowId,
        name: 'data',
        payload: 'second',
        createdAt: 2000,
      };

      // Insert newer first to verify sort, not insertion order
      await result.storage.put(KEYS.update(workflowId, 'upd-new'), encode(newer));
      await result.storage.put(KEYS.update(workflowId, 'upd-old'), encode(older));

      const fifoWorkflow = workflow({ name: 'fifo' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        const { payload, respond } = yield* ctx.waitForUpdate<string>('data');
        respond(payload);
        return payload;
      });
      engine.register(fifoWorkflow);

      const handle = await engine.start('fifo', undefined, { id: workflowId });
      const handleResult = await handle.result();

      // FIFO: the older update (payload 'first') should be consumed first
      expect(handleResult).toBe('first');
    });

    // -----------------------------------------------------------------
    // Update after cancel
    // -----------------------------------------------------------------

    it('rejects update after workflow cancellation', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });

      const cancelableWorkflow = workflow({ name: 'cancelable' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        yield* ctx.sleep('1 hour');
        return 'done';
      });
      engine.register(cancelableWorkflow);

      const handle = await engine.start('cancelable', undefined);
      handle.result().catch(() => {});
      await flush();

      await engine.cancel(handle.id);
      await flush();

      try {
        await engine.update(handle.id, 'anything', undefined);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(WorkflowTerminalError);
        expect((error as WorkflowTerminalError).status).toBe('cancelled');
      }
    });
  });
}

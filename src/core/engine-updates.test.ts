import { afterEach, describe, expect, it } from 'bun:test';
import { waitForever } from '../testing/fake-timers.ts';

import type { ScanOptions, Storage } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';
import {
  collectKeys,
  flush,
  storageBackends,
  teardown,
  waitForWorkflowStatus,
} from '../testing/storage-backends.ts';
import { decode, encode } from './codec.ts';
import { Engine } from './engine.ts';
import type { WorkflowContext } from './types.ts';
import { workflow } from './types.ts';
import { UpdateCoordinator, UpdateTimeoutError, WorkflowTerminalError } from './updates.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Suppress unhandled rejection from a handle's result promise. */
function suppressResult(handle: { result(): Promise<unknown> }): void {
  handle.result().catch(() => {});
}

function wrapStorageWithUpdateScanHook(
  storage: Storage,
  onUpdateScan: (prefix: string, options?: ScanOptions) => Promise<void> | void,
): Storage {
  const wrapped: Storage = {
    capabilities() {
      return storage.capabilities();
    },
    get(key) {
      return storage.get(key);
    },
    put(key, value) {
      return storage.put(key, value);
    },
    delete(key) {
      return storage.delete(key);
    },
    scan(prefix, options) {
      return (async function* () {
        if (prefix.startsWith('upd:')) {
          await onUpdateScan(prefix, options);
        }

        for await (const entry of storage.scan(prefix, options)) {
          yield entry;
        }
      })();
    },
    batch(operations) {
      return storage.batch(operations);
    },
    [Symbol.dispose]() {
      storage[Symbol.dispose]();
    },
  };

  if (storage.query) {
    wrapped.query = storage.query.bind(storage);
  }

  return wrapped;
}

function wrapStorageWithStaleWorkflowStateRead(storage: Storage): {
  storage: Storage;
  armStaleWorkflowStateRead: (workflowKey: string, staleStateBytes: Uint8Array) => void;
} {
  let staleWorkflowStateRead: { key: string; value: Uint8Array } | null = null;

  const wrapped: Storage = {
    capabilities() {
      return storage.capabilities();
    },
    async get(key) {
      if (staleWorkflowStateRead !== null && key === staleWorkflowStateRead.key) {
        const staleStateBytes = new Uint8Array(staleWorkflowStateRead.value);
        staleWorkflowStateRead = null;
        return staleStateBytes;
      }

      return storage.get(key);
    },
    put: storage.put.bind(storage),
    delete: storage.delete.bind(storage),
    scan: storage.scan.bind(storage),
    batch: storage.batch.bind(storage),
    [Symbol.dispose]() {
      storage[Symbol.dispose]();
    },
  };

  if (storage.has) {
    wrapped.has = storage.has.bind(storage);
  }

  if (storage.deletePrefix) {
    wrapped.deletePrefix = storage.deletePrefix.bind(storage);
  }

  if (storage.keys) {
    wrapped.keys = storage.keys.bind(storage);
  }

  if (storage.count) {
    wrapped.count = storage.count.bind(storage);
  }

  if (storage.scoped) {
    wrapped.scoped = storage.scoped.bind(storage);
  }

  if (storage.query) {
    wrapped.query = storage.query.bind(storage);
  }

  return {
    storage: wrapped,
    armStaleWorkflowStateRead(workflowKey: string, staleStateBytes: Uint8Array): void {
      staleWorkflowStateRead = {
        key: workflowKey,
        value: new Uint8Array(staleStateBytes),
      };
    },
  };
}

function wrapStorageWithDelayedUpdateResponse(storage: Storage, result: unknown): Storage {
  let pendingRequestKey: string | null = null;
  let responseVisible = false;
  let responseTimerWasScheduled = false;

  return {
    capabilities() {
      return storage.capabilities();
    },
    async get(key) {
      if (key.startsWith('upr:')) {
        const updateId = key.slice('upr:'.length);

        if (!responseTimerWasScheduled) {
          responseTimerWasScheduled = true;
          setTimeout(() => {
            responseVisible = true;
          }, 1);
        }

        if (responseVisible) {
          if (pendingRequestKey !== null) {
            await storage.delete(pendingRequestKey);
            pendingRequestKey = null;
          }

          return encode({ updateId, result, createdAt: Date.now() });
        }

        return null;
      }

      return storage.get(key);
    },
    async put(key, value) {
      if (key.startsWith('upd:')) {
        pendingRequestKey = key;
      }

      await storage.put(key, value);
    },
    delete: storage.delete.bind(storage),
    scan: storage.scan.bind(storage),
    batch: storage.batch.bind(storage),
    [Symbol.dispose]() {
      storage[Symbol.dispose]();
    },
  };
}

function wrapStorageWithPostDeleteUpdateResponse(storage: Storage, result: unknown): Storage {
  let visibleUpdateResponseId: string | null = null;

  return {
    capabilities() {
      return storage.capabilities();
    },
    async get(key) {
      if (key.startsWith('upr:')) {
        const updateId = key.slice('upr:'.length);
        if (visibleUpdateResponseId === updateId) {
          return encode({ updateId, result, createdAt: Date.now() });
        }

        return null;
      }

      return storage.get(key);
    },
    put: storage.put.bind(storage),
    async delete(key) {
      await storage.delete(key);
      if (key.startsWith('upd:')) {
        visibleUpdateResponseId = key.slice(key.lastIndexOf(':') + 1);
      }
    },
    scan: storage.scan.bind(storage),
    batch: storage.batch.bind(storage),
    [Symbol.dispose]() {
      storage[Symbol.dispose]();
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

for (const backend of storageBackends) {
  describe(`Synchronous Updates [${backend.name}]`, () => {
    let engine: Engine;
    let cleanup: () => void;

    afterEach(async () => {
      await teardown(engine, cleanup);
    });

    // ---------------------------------------------------------------------
    // Step 1: Default timeout and TTL
    // ---------------------------------------------------------------------

    describe('default timeout', () => {
      it('uses 30s default timeout (not 5s)', async () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        engine = new Engine({ storage: result.storage });

        const simpleWorkflow = workflow({ name: 'simple' }).execute(async function* (
          _ctx: WorkflowContext,
        ) {
          await waitForever();
          return 'done';
        });
        engine.register(simpleWorkflow);

        const handle = await engine.start('simple', undefined);
        suppressResult(handle);
        await flush();

        // With a 50ms timeout, update should timeout quickly
        try {
          await engine.update(handle.id, 'nonexistent', undefined, { timeout: 50 });
          expect.unreachable('should have thrown');
        } catch (error) {
          // UpdateTimeoutError is thrown -- this confirms timeout is configurable
          expect((error as Error).message).toContain('timed out');
        }
      });
    });

    describe('cleanup TTL', () => {
      it('uses 5-minute default TTL (old responses cleaned, recent ones kept)', async () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        const coordinator = new UpdateCoordinator(result.storage);

        const sixMinutesAgo = Date.now() - 6 * 60 * 1000;
        const twoMinutesAgo = Date.now() - 2 * 60 * 1000;

        // Old response (> 5 minutes) -- should be cleaned
        await result.storage.put(
          'upr:old-1',
          encode({ updateId: 'old-1', result: 'stale', createdAt: sixMinutesAgo }),
        );

        // Recent response (< 5 minutes) -- should be kept
        await result.storage.put(
          'upr:recent-1',
          encode({ updateId: 'recent-1', result: 'fresh', createdAt: twoMinutesAgo }),
        );

        const cleaned = await coordinator.cleanupExpiredResponses();

        expect(cleaned).toBe(1);
        expect(await result.storage.get('upr:old-1')).toBeNull();
        expect(await result.storage.get('upr:recent-1')).not.toBeNull();

        // Engine was never created; set a no-op so afterEach teardown works
        engine = new Engine({ storage: result.storage });
      });
    });

    // ---------------------------------------------------------------------
    // Step 2: Reject updates to terminal workflows
    // ---------------------------------------------------------------------

    describe('terminal workflow guard', () => {
      it('throws WorkflowTerminalError for completed workflow via update()', async () => {
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
          await engine.update(handle.id, 'someUpdate', 'payload');
          expect.unreachable('should have thrown');
        } catch (error) {
          expect(error).toBeInstanceOf(WorkflowTerminalError);
          expect((error as WorkflowTerminalError).workflowId).toBe(handle.id);
          expect((error as WorkflowTerminalError).status).toBe('completed');
          expect((error as WorkflowTerminalError).message).toContain('terminal');
        }
      });

      it('throws WorkflowTerminalError for failed workflow via update()', async () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        engine = new Engine({ storage: result.storage });

        const failWorkflow = workflow({ name: 'fail' }).execute(async function* (
          _ctx: WorkflowContext,
        ) {
          throw new Error('intentional failure');
        });
        engine.register(failWorkflow);

        const handle = await engine.start('fail', undefined);
        suppressResult(handle);
        await flush();

        try {
          await engine.update(handle.id, 'someUpdate', 'payload');
          expect.unreachable('should have thrown');
        } catch (error) {
          expect(error).toBeInstanceOf(WorkflowTerminalError);
          expect((error as WorkflowTerminalError).status).toBe('failed');
        }
      });

      it('throws WorkflowTerminalError for completed workflow via submitCoordinatedUpdate()', async () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        engine = new Engine({ storage: result.storage });

        const quickWorkflow2 = workflow({ name: 'quick' }).execute(async function* (
          _ctx: WorkflowContext,
        ) {
          return 'done';
        });
        engine.register(quickWorkflow2);

        const handle = await engine.start('quick', undefined);
        await handle.result();
        await flush();

        try {
          await engine.submitCoordinatedUpdate(handle.id, 'someUpdate', 'payload');
          expect.unreachable('should have thrown');
        } catch (error) {
          expect(error).toBeInstanceOf(WorkflowTerminalError);
          expect((error as WorkflowTerminalError).status).toBe('completed');
        }
      });

      it('re-checks terminal state after creating a coordinated update for update()', async () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        const staleWorkflowStateStorage = wrapStorageWithStaleWorkflowStateRead(result.storage);
        engine = new Engine({ storage: staleWorkflowStateStorage.storage });

        const quickWorkflow3 = workflow({ name: 'quick' }).execute(async function* (
          _ctx: WorkflowContext,
        ) {
          return 'done';
        });
        engine.register(quickWorkflow3);

        const handle = await engine.start('quick', undefined);
        const workflowKey = KEYS.workflow(handle.id);
        const runningStateBytes = await result.storage.get(workflowKey);
        expect(runningStateBytes).not.toBeNull();
        await handle.result();
        await flush();

        staleWorkflowStateStorage.armStaleWorkflowStateRead(workflowKey, runningStateBytes!);

        await expect(engine.update(handle.id, 'someUpdate', 'payload')).rejects.toBeInstanceOf(
          WorkflowTerminalError,
        );
        expect(await collectKeys(result.storage, KEYS.updatePrefix(handle.id))).toEqual([]);
      });

      it('waits for a delayed coordinated update response before deleting a terminal-race request', async () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        const staleWorkflowStateStorage = wrapStorageWithStaleWorkflowStateRead(result.storage);
        const delayedUpdateResponseStorage = wrapStorageWithDelayedUpdateResponse(
          staleWorkflowStateStorage.storage,
          'late-response',
        );
        engine = new Engine({ storage: delayedUpdateResponseStorage });

        const quickWorkflow4 = workflow({ name: 'quick' }).execute(async function* (
          _ctx: WorkflowContext,
        ) {
          return 'done';
        });
        engine.register(quickWorkflow4);

        const handle = await engine.start('quick', undefined);
        const workflowKey = KEYS.workflow(handle.id);
        const runningStateBytes = await result.storage.get(workflowKey);
        expect(runningStateBytes).not.toBeNull();
        await handle.result();
        await flush();

        staleWorkflowStateStorage.armStaleWorkflowStateRead(workflowKey, runningStateBytes!);

        await expect(engine.update(handle.id, 'someUpdate', 'payload')).resolves.toBe(
          'late-response',
        );
        expect(await collectKeys(result.storage, KEYS.updatePrefix(handle.id))).toEqual([]);
      });

      it('post-delete response check prevents terminal error when update was consumed just after delete', async () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        const staleWorkflowStateStorage = wrapStorageWithStaleWorkflowStateRead(result.storage);
        const postDeleteResponseStorage = wrapStorageWithPostDeleteUpdateResponse(
          staleWorkflowStateStorage.storage,
          'post-delete-response',
        );
        engine = new Engine({ storage: postDeleteResponseStorage });

        const quickWorkflow5 = workflow({ name: 'quick' }).execute(async function* (
          _ctx: WorkflowContext,
        ) {
          return 'done';
        });
        engine.register(quickWorkflow5);

        const handle = await engine.start('quick', undefined);
        const workflowKey = KEYS.workflow(handle.id);
        const runningStateBytes = await result.storage.get(workflowKey);
        expect(runningStateBytes).not.toBeNull();
        await handle.result();
        await flush();

        staleWorkflowStateStorage.armStaleWorkflowStateRead(workflowKey, runningStateBytes!);

        await expect(engine.update(handle.id, 'someUpdate', 'payload')).resolves.toBe(
          'post-delete-response',
        );
        expect(await collectKeys(result.storage, KEYS.updatePrefix(handle.id))).toEqual([]);
      });

      it('returns response that appears on the 5th poll attempt', async () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        const staleWorkflowStateStorage = wrapStorageWithStaleWorkflowStateRead(result.storage);

        let responseReadCount = 0;
        let pendingRequestKey: string | null = null;
        const wrappedStorage: Storage = {
          ...staleWorkflowStateStorage.storage,
          async get(key: string) {
            if (key.startsWith('upr:')) {
              responseReadCount++;
              if (responseReadCount < 5) return null;

              if (pendingRequestKey !== null) {
                await staleWorkflowStateStorage.storage.delete(pendingRequestKey);
                pendingRequestKey = null;
              }

              const updateId = key.slice('upr:'.length);
              return encode({
                updateId,
                result: 'fifth-poll-response',
                createdAt: Date.now(),
              });
            }

            return staleWorkflowStateStorage.storage.get(key);
          },
          async put(key, value) {
            if (key.startsWith('upd:')) {
              pendingRequestKey = key;
            }

            await staleWorkflowStateStorage.storage.put(key, value);
          },
        };

        engine = new Engine({ storage: wrappedStorage });
        const quickWorkflow6 = workflow({ name: 'quick' }).execute(async function* (
          _ctx: WorkflowContext,
        ) {
          return 'done';
        });
        engine.register(quickWorkflow6);

        const handle = await engine.start('quick', undefined);
        const workflowKey = KEYS.workflow(handle.id);
        const runningStateBytes = await result.storage.get(workflowKey);
        expect(runningStateBytes).not.toBeNull();
        await handle.result();
        await flush();

        staleWorkflowStateStorage.armStaleWorkflowStateRead(workflowKey, runningStateBytes!);

        await expect(engine.update(handle.id, 'someUpdate', 'payload')).resolves.toBe(
          'fifth-poll-response',
        );
        expect(await collectKeys(result.storage, KEYS.updatePrefix(handle.id))).toEqual([]);
      });

      it('throws WorkflowTerminalError and cleans up request when all poll attempts are exhausted', async () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        const staleWorkflowStateStorage = wrapStorageWithStaleWorkflowStateRead(result.storage);

        const wrappedStorage: Storage = {
          ...staleWorkflowStateStorage.storage,
          async get(key: string) {
            if (key.startsWith('upr:')) return null;

            return staleWorkflowStateStorage.storage.get(key);
          },
        };

        engine = new Engine({ storage: wrappedStorage });
        const quickWorkflow7 = workflow({ name: 'quick' }).execute(async function* (
          _ctx: WorkflowContext,
        ) {
          return 'done';
        });
        engine.register(quickWorkflow7);

        const handle = await engine.start('quick', undefined);
        const workflowKey = KEYS.workflow(handle.id);
        const runningStateBytes = await result.storage.get(workflowKey);
        expect(runningStateBytes).not.toBeNull();
        await handle.result();
        await flush();

        staleWorkflowStateStorage.armStaleWorkflowStateRead(workflowKey, runningStateBytes!);

        await expect(engine.update(handle.id, 'someUpdate', 'payload')).rejects.toBeInstanceOf(
          WorkflowTerminalError,
        );
        expect(await collectKeys(result.storage, KEYS.updatePrefix(handle.id))).toEqual([]);
      });

      it('re-checks terminal state after creating a coordinated update for submitCoordinatedUpdate()', async () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        const staleWorkflowStateStorage = wrapStorageWithStaleWorkflowStateRead(result.storage);
        engine = new Engine({ storage: staleWorkflowStateStorage.storage });

        const quickWorkflow8 = workflow({ name: 'quick' }).execute(async function* (
          _ctx: WorkflowContext,
        ) {
          return 'done';
        });
        engine.register(quickWorkflow8);

        const handle = await engine.start('quick', undefined);
        const workflowKey = KEYS.workflow(handle.id);
        const runningStateBytes = await result.storage.get(workflowKey);
        expect(runningStateBytes).not.toBeNull();
        await handle.result();
        await flush();

        staleWorkflowStateStorage.armStaleWorkflowStateRead(workflowKey, runningStateBytes!);

        await expect(
          engine.submitCoordinatedUpdate(handle.id, 'someUpdate', 'payload'),
        ).rejects.toBeInstanceOf(WorkflowTerminalError);
        expect(await collectKeys(result.storage, KEYS.updatePrefix(handle.id))).toEqual([]);
      });

      it('throws WorkflowTerminalError for cancelled workflow', async () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        engine = new Engine({ storage: result.storage });

        const cancelmeWorkflow = workflow({ name: 'cancelme' }).execute(async function* (
          ctx: WorkflowContext,
        ) {
          yield* ctx.sleep('1 hour');
          return 'done';
        });
        engine.register(cancelmeWorkflow);

        const handle = await engine.start('cancelme', undefined);
        suppressResult(handle);
        await flush();

        await engine.cancel(handle.id);
        await flush();

        try {
          await engine.update(handle.id, 'someUpdate', 'payload');
          expect.unreachable('should have thrown');
        } catch (error) {
          expect(error).toBeInstanceOf(WorkflowTerminalError);
          expect((error as WorkflowTerminalError).status).toBe('cancelled');
        }
      });

      it('allows updates to running workflows', async () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        engine = new Engine({ storage: result.storage });

        const waiterWorkflow = workflow({ name: 'waiter' }).execute(async function* (
          ctx: WorkflowContext,
        ) {
          ctx.onUpdate('greet', (payload) => `hello ${String(payload)}`);
          await waitForever();
          return 'done';
        });
        engine.register(waiterWorkflow);

        const handle = await engine.start('waiter', undefined);
        suppressResult(handle);
        await flush();

        // Should not throw -- workflow is still running
        const updateResult = await engine.update(handle.id, 'greet', 'world');
        expect(updateResult).toBe('hello world');
      });
    });

    // ---------------------------------------------------------------------
    // Step 3: Generator handler validation
    // ---------------------------------------------------------------------

    describe('onUpdate handler validation', () => {
      it('rejects sync generator handler', async () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        engine = new Engine({ storage: result.storage });

        const genTestWorkflow = workflow({ name: 'gen-test' }).execute(async function* (
          ctx: WorkflowContext,
        ) {
          expect(() => {
            ctx.onUpdate('bad', function* () {
              yield 1;
            } as unknown as (payload: unknown) => unknown);
          }).toThrow(TypeError);

          return 'done';
        });
        engine.register(genTestWorkflow);

        const handle = await engine.start('gen-test', undefined);
        await handle.result();
      });

      it('rejects async generator handler', async () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        engine = new Engine({ storage: result.storage });

        const asyncGenTestWorkflow = workflow({ name: 'async-gen-test' }).execute(async function* (
          ctx: WorkflowContext,
        ) {
          expect(() => {
            ctx.onUpdate('bad', async function* () {
              yield 1;
            } as unknown as (payload: unknown) => unknown);
          }).toThrow(TypeError);

          return 'done';
        });
        engine.register(asyncGenTestWorkflow);

        const handle = await engine.start('async-gen-test', undefined);
        await handle.result();
      });

      it('accepts normal function handler', async () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        engine = new Engine({ storage: result.storage });

        const normalTestWorkflow = workflow({ name: 'normal-test' }).execute(async function* (
          ctx: WorkflowContext,
        ) {
          // Regular function -- should not throw
          ctx.onUpdate('good', (payload) => `ok ${String(payload)}`);
          // Arrow function -- should not throw
          ctx.onUpdate('also-good', (payload) => payload);
          // Async function -- should not throw
          ctx.onUpdate('async-good', async (payload) => payload);
          return 'done';
        });
        engine.register(normalTestWorkflow);

        const handle = await engine.start('normal-test', undefined);
        await handle.result();
      });

      it('error message mentions handler name', async () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        engine = new Engine({ storage: result.storage });

        const msgTestWorkflow = workflow({ name: 'msg-test' }).execute(async function* (
          ctx: WorkflowContext,
        ) {
          let threw = false;
          try {
            ctx.onUpdate('myHandler', function* () {
              yield 1;
            } as unknown as (payload: unknown) => unknown);
            expect.unreachable('should have thrown');
          } catch (error) {
            threw = true;
            expect((error as TypeError).message).toContain('myHandler');
            expect((error as TypeError).message).toContain('generator');
          }
          expect(threw).toBe(true);
          return 'done';
        });
        engine.register(msgTestWorkflow);

        const handle = await engine.start('msg-test', undefined);
        await handle.result();
      });
    });

    // ---------------------------------------------------------------------
    // Step 4: BroadcastChannel notification
    // ---------------------------------------------------------------------

    describe('broadcast notification on update completion', () => {
      it('broadcasts update:completed via inline handler path', async () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        engine = new Engine({ storage: result.storage, broadcastEvents: true });
        const messages: Record<string, unknown>[] = [];

        // Listen on the BroadcastChannel
        const channel = new BroadcastChannel('weft:events');
        channel.onmessage = (event) => {
          messages.push(event.data as Record<string, unknown>);
        };

        const bcTestWorkflow = workflow({ name: 'bc-test' }).execute(async function* (
          ctx: WorkflowContext,
        ) {
          ctx.onUpdate('ping', () => 'pong');
          await waitForever();
          return 'done';
        });
        engine.register(bcTestWorkflow);

        const handle = await engine.start('bc-test', undefined);
        suppressResult(handle);
        await flush();

        await engine.update(handle.id, 'ping', null);
        await flush();

        const updateMessages = messages.filter((message) => message['type'] === 'update:completed');
        expect(updateMessages.length).toBeGreaterThanOrEqual(1);
        expect(updateMessages[0]!['workflowId']).toBe(handle.id);
        expect(typeof updateMessages[0]!['updateId']).toBe('string');

        channel.close();
      });
    });

    // ---------------------------------------------------------------------
    // Step 5: FIFO ordering of concurrent updates
    // ---------------------------------------------------------------------

    describe('FIFO ordering', () => {
      it('selects the oldest pending update when multiple match the same name', async () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        const coordinator = new UpdateCoordinator(result.storage);

        // Create three updates with explicit timestamps in non-chronological
        // insertion order to ensure sorting (not insertion order) determines
        // priority.
        const updates = [
          {
            updateId: 'update-3',
            workflowId: 'wf-fifo',
            name: 'data',
            payload: 'third',
            createdAt: 3000,
          },
          {
            updateId: 'update-1',
            workflowId: 'wf-fifo',
            name: 'data',
            payload: 'first',
            createdAt: 1000,
          },
          {
            updateId: 'update-2',
            workflowId: 'wf-fifo',
            name: 'data',
            payload: 'second',
            createdAt: 2000,
          },
        ];

        for (const update of updates) {
          await result.storage.put(KEYS.update('wf-fifo', update.updateId), encode(update));
        }

        const pending = await coordinator.getPendingUpdates('wf-fifo');
        const filtered = pending.filter((u) => u.name === 'data');

        // getPendingUpdates must return FIFO order -- assert directly without re-sorting
        expect(filtered[0]!.payload).toBe('first');
        expect(filtered[1]!.payload).toBe('second');
        expect(filtered[2]!.payload).toBe('third');

        // Engine was never created; set a no-op so afterEach teardown works
        engine = new Engine({ storage: result.storage });
      });

      it('engine consumes the oldest pending update via waitForUpdate', async () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        engine = new Engine({ storage: result.storage });

        const workflowId = 'fifo-wf';

        const oldUpdate = {
          updateId: 'update-old',
          workflowId,
          name: 'data',
          payload: 'first',
          createdAt: Date.now() - 1000,
        };
        const newUpdate = {
          updateId: 'update-new',
          workflowId,
          name: 'data',
          payload: 'second',
          createdAt: Date.now(),
        };

        // Insert newer first to ensure sort, not insertion order, wins
        await result.storage.put(KEYS.update(workflowId, 'update-new'), encode(newUpdate));
        await result.storage.put(KEYS.update(workflowId, 'update-old'), encode(oldUpdate));

        const fifoTestWorkflow = workflow({ name: 'fifo-test' }).execute(async function* (
          ctx: WorkflowContext,
        ) {
          const { payload, respond } = yield* ctx.waitForUpdate<string>('data');
          respond(payload);
          return payload;
        });
        engine.register(fifoTestWorkflow);

        const handle = await engine.start('fifo-test', undefined, { id: workflowId });
        const handleResult = await handle.result();

        // FIFO: the older update (payload 'first') should win
        expect(handleResult).toBe('first');
      });
    });

    // ---------------------------------------------------------------------
    // Step 6: Pending updates processed on resume
    // ---------------------------------------------------------------------

    describe('pending updates on resume', () => {
      it('processes pending coordinated updates when inline handler is registered', async () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        engine = new Engine({ storage: result.storage });

        const resumableWorkflow = workflow({ name: 'resumable' }).execute(async function* (
          ctx: WorkflowContext,
        ) {
          ctx.onUpdate('validate', (payload) => {
            return `validated: ${String(payload)}`;
          });
          // Sleep to keep the workflow active
          yield* ctx.sleep('1 hour');
          return 'done';
        });
        engine.register(resumableWorkflow);

        const handle = await engine.start('resumable', undefined);
        suppressResult(handle);
        await flush();

        // Create a pending coordinated update in storage as if it arrived
        // while the engine was restarting (simulates the crash-recovery case)
        const pendingUpdate = {
          updateId: 'pending-1',
          workflowId: handle.id,
          name: 'validate',
          payload: 'test-data',
          createdAt: Date.now(),
        };
        await engine.storage.put(KEYS.update(handle.id, 'pending-1'), encode(pendingUpdate));

        // The inline handler path should handle this update directly since
        // the workflow is active and has a matching handler registered
        const updateResult = await engine.update(handle.id, 'validate', 'direct-call');
        expect(updateResult).toBe('validated: direct-call');
      });

      it('drains pending updates for registered handlers after resume', async () => {
        const result = backend.factory();
        cleanup = result.cleanup;

        const engine1 = new Engine({ storage: result.storage });
        const durableWorkflow = workflow({ name: 'durable' }).execute(async function* (
          ctx: WorkflowContext,
        ) {
          ctx.onUpdate('process', (payload) => {
            return `processed: ${String(payload)}`;
          });
          yield* ctx.sleep('1 hour');
          return 'done';
        });
        engine1.register(durableWorkflow);

        const handle = await engine1.start('durable', undefined);
        suppressResult(handle);
        await flush();

        // Seed a pending coordinated update in storage
        const pendingUpdate = {
          updateId: 'pending-drain',
          workflowId: handle.id,
          name: 'process',
          payload: 'queued-data',
          createdAt: Date.now(),
        };
        await result.storage.put(KEYS.update(handle.id, 'pending-drain'), encode(pendingUpdate));

        // Dispose engine1 to simulate crash
        engine1[Symbol.dispose]();
        await flush();

        // Create engine2 with the same storage, simulating restart
        engine = new Engine({ storage: result.storage });
        const durableWorkflow2 = workflow({ name: 'durable' }).execute(async function* (
          ctx: WorkflowContext,
        ) {
          ctx.onUpdate('process', (payload) => {
            return `processed: ${String(payload)}`;
          });
          yield* ctx.sleep('1 hour');
          return 'done';
        });
        engine.register(durableWorkflow2);

        // Resume the workflow on engine2
        const resumedHandle = await engine.resume(handle.id);
        suppressResult(resumedHandle);

        // Wait for queueMicrotask + async processing
        await flush();
        await flush();

        // The pending update request should have been consumed from storage
        const remaining = await result.storage.get(KEYS.update(handle.id, 'pending-drain'));
        expect(remaining).toBeNull();

        // The response should have been written
        const response = await result.storage.get('upr:pending-drain');
        expect(response).not.toBeNull();
        const decoded = decode(response!) as { result: unknown };
        expect(decoded.result).toBe('processed: queued-data');
      });
    });

    // ---------------------------------------------------------------------
    // WorkflowTerminalError
    // ---------------------------------------------------------------------

    describe('WorkflowTerminalError', () => {
      it('has correct properties', () => {
        // No engine needed for this unit test; create a disposable one for afterEach
        const result = backend.factory();
        cleanup = result.cleanup;
        engine = new Engine({ storage: result.storage });

        const error = new WorkflowTerminalError('wf-123', 'completed');
        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('WorkflowTerminalError');
        expect(error.workflowId).toBe('wf-123');
        expect(error.status).toBe('completed');
        expect(error.message).toContain('wf-123');
        expect(error.message).toContain('completed');
        expect(error.message).toContain('terminal');
      });
    });

    // ---------------------------------------------------------------------
    // Inline handler path (integration)
    // ---------------------------------------------------------------------

    describe('inline handler integration', () => {
      it('dispatches UpdateReceivedEvent and UpdateCompletedEvent', async () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        engine = new Engine({ storage: result.storage });
        const events: string[] = [];

        engine.addEventListener('update:received', () => events.push('received'));
        engine.addEventListener('update:completed', () => events.push('completed'));

        const eventTestWorkflow = workflow({ name: 'event-test' }).execute(async function* (
          ctx: WorkflowContext,
        ) {
          ctx.onUpdate('test', (payload) => `echo: ${String(payload)}`);
          await waitForever();
          return 'done';
        });
        engine.register(eventTestWorkflow);

        const handle = await engine.start('event-test', undefined);
        suppressResult(handle);
        await flush();

        const updateResult = await engine.update(handle.id, 'test', 'hello');
        expect(updateResult).toBe('echo: hello');
        expect(events).toContain('received');
        expect(events).toContain('completed');
      });

      it('delivers an update sent immediately after start before the first inline turn launches', async () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        engine = new Engine({ storage: result.storage });

        const immediateUpdateWorkflow = workflow({ name: 'immediate-update' }).execute(
          async function* (ctx: WorkflowContext) {
            ctx.onUpdate('test', (payload) => `echo: ${String(payload)}`);
            return yield* ctx.waitForSignal('finish');
          },
        );
        engine.register(immediateUpdateWorkflow);

        const handle = await engine.start('immediate-update', undefined);

        await expect(handle.update('test', 'hello')).resolves.toBe('echo: hello');

        await handle.signal('finish', 'done');
        await expect(handle.result()).resolves.toBe('done');
      });
    });

    // ---------------------------------------------------------------------
    // Step 7: waitForUpdate returns { payload, respond }
    // ---------------------------------------------------------------------

    describe('waitForUpdate { payload, respond } shape', () => {
      it('respond() sends the result back to the engine.update() caller', async () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        engine = new Engine({ storage: result.storage });

        const respondTestWorkflow = workflow({ name: 'respond-test' }).execute(async function* (
          ctx: WorkflowContext,
        ) {
          const { payload, respond } = yield* ctx.waitForUpdate<string>('review');
          respond({ accepted: true, originalPayload: payload });
          return `processed: ${payload}`;
        });
        engine.register(respondTestWorkflow);

        const handle = await engine.start('respond-test', undefined);
        await waitForWorkflowStatus(engine, handle.id, 'running');

        // engine.update() should return whatever respond() was called with
        const updateResult = await engine.update(handle.id, 'review', 'my-data');
        expect(updateResult).toEqual({ accepted: true, originalPayload: 'my-data' });

        // Workflow should complete with its own return value
        const handleResult = await handle.result();
        expect(handleResult).toBe('processed: my-data');
      });

      it('times out when waitForUpdate does not call respond()', async () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        engine = new Engine({ storage: result.storage });

        const missingRespondWorkflow = workflow({ name: 'missing-respond' }).execute(
          async function* (ctx: WorkflowContext) {
            const { payload } = yield* ctx.waitForUpdate<string>('review');
            return `processed without respond: ${payload}`;
          },
        );
        engine.register(missingRespondWorkflow);

        const handle = await engine.start('missing-respond', undefined);
        await waitForWorkflowStatus(engine, handle.id, 'running');

        let timeoutError: UpdateTimeoutError | null = null;
        try {
          await engine.update(handle.id, 'review', 'my-data', { timeout: 25 });
        } catch (error) {
          expect(error).toBeInstanceOf(UpdateTimeoutError);
          timeoutError = error as UpdateTimeoutError;
        }

        expect(timeoutError).not.toBeNull();
        await expect(handle.result()).resolves.toBe('processed without respond: my-data');
        await flush();
        expect(await collectKeys(result.storage, KEYS.updatePrefix(handle.id))).toEqual([]);
        expect(await engine.getUpdateResult(timeoutError!.updateId)).toBeNull();
      });

      it('calling respond() multiple times is idempotent', async () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        engine = new Engine({ storage: result.storage });

        const idempotentRespondWorkflow = workflow({ name: 'idempotent-respond' }).execute(
          async function* (ctx: WorkflowContext) {
            const { payload, respond } = yield* ctx.waitForUpdate<string>('data');
            // Call respond twice -- the second call should be a no-op
            respond('first-response');
            respond('second-response');
            return payload;
          },
        );
        engine.register(idempotentRespondWorkflow);

        const handle = await engine.start('idempotent-respond', undefined);
        await waitForWorkflowStatus(engine, handle.id, 'running');

        const updateResult = await engine.update(handle.id, 'data', 'input');
        // Only the first respond() call should matter
        expect(updateResult).toBe('first-response');

        const handleResult = await handle.result();
        expect(handleResult).toBe('input');
      });

      it('respond() works with pending coordinated updates', async () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        engine = new Engine({ storage: result.storage });
        const workflowId = 'coordinated-respond-wf';

        // Seed a pending coordinated update
        const pendingUpdate = {
          updateId: 'coordinated-1',
          workflowId,
          name: 'approve',
          payload: { amount: 100 },
          createdAt: Date.now() - 500,
        };
        await result.storage.put(KEYS.update(workflowId, 'coordinated-1'), encode(pendingUpdate));

        const coordinatedRespondWorkflow = workflow({ name: 'coordinated-respond' }).execute(
          async function* (ctx: WorkflowContext) {
            const { payload, respond } = yield* ctx.waitForUpdate<{ amount: number }>('approve');
            respond({ approved: true, amount: payload.amount });
            return `approved: ${payload.amount}`;
          },
        );
        engine.register(coordinatedRespondWorkflow);

        const handle = await engine.start('coordinated-respond', undefined, { id: workflowId });
        const handleResult = await handle.result();
        expect(handleResult).toBe('approved: 100');

        // Verify the response was written to storage
        await flush();
        const responseBytes = await result.storage.get('upr:coordinated-1');
        expect(responseBytes).not.toBeNull();
        const response = decode(responseBytes!) as { result: unknown };
        expect(response.result).toEqual({ approved: true, amount: 100 });
      });

      if (backend.name === 'MemoryStorage') {
        // This test injects an artificial storage-scan delay to force an
        // engine-level waiter race. The behavior under test is backend
        // agnostic, so keeping it on the simplest storage avoids adapter
        // timing noise while still covering the fallback path.
        it(
          'falls back to coordinated delivery when a stale waiter is consumed during the async gap',
          async () => {
            const result = backend.factory();
            cleanup = result.cleanup;

            let delayNextUpdateScan = false;
            const delayedScanStarted = Promise.withResolvers<void>();
            const releaseDelayedScan = Promise.withResolvers<void>();
            const storage = wrapStorageWithUpdateScanHook(result.storage, async () => {
              if (!delayNextUpdateScan) {
                return;
              }

              delayNextUpdateScan = false;
              delayedScanStarted.resolve();
              await releaseDelayedScan.promise;
            });

            engine = new Engine({ storage });

            const staleWaiterRaceWorkflow = workflow({ name: 'stale-waiter-race' }).execute(
              async function* (ctx: WorkflowContext) {
                const first = yield* ctx.waitForUpdate<string>('data');
                first.respond(`first:${first.payload}`);

                const second = yield* ctx.waitForUpdate<string>('data');
                second.respond(`second:${second.payload}`);

                return [first.payload, second.payload];
              },
            );
            engine.register(staleWaiterRaceWorkflow);

            const handle = await engine.start('stale-waiter-race', undefined);
            await flush();

            delayNextUpdateScan = true;
            const delayedUpdate = engine.update(handle.id, 'data', 'first-payload', {
              timeout: 15_000,
            });
            delayedUpdate.catch(() => {});
            await delayedScanStarted.promise;

            const immediateUpdateResult = await engine.update(handle.id, 'data', 'second-payload', {
              timeout: 15_000,
            });
            expect(immediateUpdateResult).toBe('first:second-payload');

            await flush();
            releaseDelayedScan.resolve();

            await expect(delayedUpdate).resolves.toBe('second:first-payload');
            await expect(handle.result()).resolves.toEqual(['second-payload', 'first-payload']);
          },
          { timeout: 15_000 },
        );
      }

      it('re-checks pending updates after waiter registration to catch arrivals during registration', async () => {
        const result = backend.factory();
        cleanup = result.cleanup;

        let updateScanCount = 0;
        const secondScanStarted = Promise.withResolvers<void>();
        const releaseSecondScan = Promise.withResolvers<void>();
        const storage = wrapStorageWithUpdateScanHook(result.storage, async () => {
          updateScanCount++;
          if (updateScanCount !== 2) {
            return;
          }

          secondScanStarted.resolve();
          await releaseSecondScan.promise;
        });

        engine = new Engine({ storage });
        const workflowId = `wait-update-registration-race-${backend.name}`;

        const waitUpdateRegistrationRaceWorkflow = workflow({
          name: 'wait-update-registration-race',
        }).execute(async function* (ctx: WorkflowContext) {
          const { payload, respond } = yield* ctx.waitForUpdate<string>('data');
          respond(`processed:${payload}`);
          return payload;
        });
        engine.register(waitUpdateRegistrationRaceWorkflow);

        const handle = await engine.start('wait-update-registration-race', undefined, {
          id: workflowId,
        });

        await secondScanStarted.promise;

        const pendingUpdate = {
          updateId: 'registration-race-update',
          workflowId,
          name: 'data',
          payload: 'arrived-during-registration',
          createdAt: Date.now(),
        };
        await result.storage.put(
          KEYS.update(workflowId, pendingUpdate.updateId),
          encode(pendingUpdate),
        );
        releaseSecondScan.resolve();

        await expect(handle.result()).resolves.toBe('arrived-during-registration');
        await flush();

        const responseBytes = await result.storage.get(KEYS.updateResponse(pendingUpdate.updateId));
        expect(responseBytes).not.toBeNull();
        const response = decode(responseBytes!) as { result: unknown };
        expect(response.result).toBe('processed:arrived-during-registration');
      });

      it('recovery path provides no-op respond function', async () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        engine = new Engine({ storage: result.storage });

        let respondCallCount = 0;

        const recoveryRespondWorkflow = workflow({ name: 'recovery-respond' }).execute(
          async function* (ctx: WorkflowContext) {
            const { payload, respond } = yield* ctx.waitForUpdate<string>('data');
            respondCallCount++;
            respond(payload);
            return payload;
          },
        );
        engine.register(recoveryRespondWorkflow);

        const handle = await engine.start('recovery-respond', undefined);
        await waitForWorkflowStatus(engine, handle.id, 'running');

        await engine.update(handle.id, 'data', 'test-value');
        const handleResult = await handle.result();
        expect(handleResult).toBe('test-value');
        expect(respondCallCount).toBe(1);
      });
    });

    // ---------------------------------------------------------------------
    // Step 8: Runtime generator check for onUpdate handler invocation
    // ---------------------------------------------------------------------

    describe('runtime generator check on handler invocation', () => {
      it('throws if onUpdate handler returns a generator at runtime', async () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        engine = new Engine({ storage: result.storage });

        // Use a normal function that returns an actual generator object (not
        // detected at registration time because the outer function is not a
        // generator -- it just returns a generator's result)
        function* sneakyGenerator() {
          yield 1;
        }
        const runtimeGenWorkflow = workflow({ name: 'runtime-gen' }).execute(async function* (
          ctx: WorkflowContext,
        ) {
          ctx.onUpdate('bad-runtime', () => {
            return sneakyGenerator();
          });
          await waitForever();
          return 'done';
        });
        engine.register(runtimeGenWorkflow);

        const handle = await engine.start('runtime-gen', undefined);
        suppressResult(handle);
        await flush();

        try {
          await engine.update(handle.id, 'bad-runtime', 'payload');
          expect.unreachable('should have thrown');
        } catch (error) {
          expect((error as Error).message).toContain('generator');
          expect((error as Error).message).toContain('bad-runtime');
        }
      });
    });

    // ---------------------------------------------------------------------
    // Step 9: Cleanup interval
    // ---------------------------------------------------------------------

    describe('response cleanup interval', () => {
      it('engine disposal clears the cleanup interval', () => {
        const result = backend.factory();
        cleanup = result.cleanup;
        // Create a standalone engine just for this test
        const testEngine = new Engine({ storage: result.storage });
        // If disposal doesn't throw, the interval was properly cleared
        testEngine[Symbol.dispose]();
        // Disposing again should also be safe (no-op)
        testEngine[Symbol.dispose]();
        // Assign to engine so afterEach teardown works
        engine = new Engine({ storage: result.storage });
      });
    });
  });
}

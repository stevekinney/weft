import { afterEach, describe, expect, it } from 'bun:test';

import { MemoryStorage, type BatchOperation, type Storage } from "../embedded/storage/src/index.ts";
import { sleepForTesting, waitForCondition } from "../../test-support/embedded/testing/src/fake-timers.ts";
import { throwingRejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { KEYS } from '../storage/keys.ts';
import {
  collectKeys,
  flush,
  storageBackends,
  teardown,
  waitForWorkflowStatus,
} from '../testing/storage-backends.test-support.ts';
import { decode, encode } from './codec.ts';
import { Engine } from './engine.ts';
import { cleanupWorkflowStorage } from './engine/termination/cleanup.ts';
import type { WorkflowContext } from './types.ts';
import { workflow } from './types.ts';
import { isUpdateHistoryCursor, type UpdateHistoryEntry } from './update-history.ts';
import { UpdateCoordinator, UpdateTimeoutError } from './updates.ts';

/** A workflow that answers `greet`, fails `explode`, has no handler for `unhandled`, and ends on `finish`. */
const historyWorkflow = workflow({ name: 'update-history' }).execute(async function* (
  ctx: WorkflowContext,
) {
  ctx.onUpdate('greet', (payload) => `hello ${String(payload)}`);
  ctx.onUpdate('explode', () => {
    throw new Error('the handler refused');
  });
  yield* ctx.waitForSignal('finish');
  return 'done';
});

function seedEntry(workflowId: string, receivedAt: number, updateId: string): [string, Uint8Array] {
  const entry: UpdateHistoryEntry = { updateId, name: 'seeded', receivedAt, outcome: 'pending' };
  return [KEYS.updateHistory(workflowId, receivedAt, updateId), encode(entry)];
}

describe('UpdateCoordinator update history', () => {
  it('writes the request and its pending history entry in one batch', async () => {
    const batches: BatchOperation[][] = [];
    const puts: string[] = [];
    const backing = new MemoryStorage();
    const storage: Storage = {
      capabilities: () => backing.capabilities(),
      get: (key) => backing.get(key),
      put: async (key, value) => {
        puts.push(key);
        await backing.put(key, value);
      },
      delete: (key) => backing.delete(key),
      scan: (prefix, options) => backing.scan(prefix, options),
      batch: async (operations) => {
        batches.push([...operations]);
        await backing.batch(operations);
      },
      [Symbol.dispose]: () => backing[Symbol.dispose](),
    };
    const coordinator = new UpdateCoordinator(storage);

    const request = await coordinator.submitRequest('wf-1', 'rename', { name: 'Ada' });

    expect(puts).toEqual([]);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((operation) => operation.key)).toEqual([
      KEYS.update('wf-1', request.updateId),
      KEYS.updateHistory('wf-1', request.createdAt, request.updateId),
    ]);
    const stored = decode((await backing.get(batches[0]![1]!.key))!) as UpdateHistoryEntry;
    expect(stored).toEqual({
      updateId: request.updateId,
      name: 'rename',
      receivedAt: request.createdAt,
      outcome: 'pending',
    });
  });

  it("replaces the pending entry at the same key in the response's batch, for a result and for a failure", async () => {
    const storage = new MemoryStorage();
    const coordinator = new UpdateCoordinator(storage);
    const completed = await coordinator.submitRequest('wf-1', 'greet', 'Ada');
    const failed = await coordinator.submitRequest('wf-1', 'explode', null);

    await storage.batch(
      coordinator.buildResponseOperations(
        completed.updateId,
        'wf-1',
        'hello Ada',
        undefined,
        undefined,
        { name: completed.name, receivedAt: completed.createdAt },
      ),
    );
    await storage.batch(
      coordinator.buildResponseOperations(
        failed.updateId,
        'wf-1',
        undefined,
        'the handler refused',
        undefined,
        { name: failed.name, receivedAt: failed.createdAt },
      ),
    );

    const page = await coordinator.listHistory('wf-1');
    expect(page.items).toHaveLength(2);
    const byId = new Map(page.items.map((entry) => [entry.updateId, entry]));
    expect(byId.get(completed.updateId)).toEqual({
      updateId: completed.updateId,
      name: 'greet',
      receivedAt: completed.createdAt,
      outcome: 'completed',
      completedAt: expect.any(Number),
    });
    expect(byId.get(failed.updateId)).toEqual({
      updateId: failed.updateId,
      name: 'explode',
      receivedAt: failed.createdAt,
      outcome: 'failed',
      completedAt: expect.any(Number),
      error: 'the handler refused',
    });
    expect(await collectKeys(storage, KEYS.updateHistoryPrefix('wf-1'))).toHaveLength(2);
  });

  it('pages newest first without repeating or skipping an entry', async () => {
    const storage = new MemoryStorage();
    const coordinator = new UpdateCoordinator(storage);
    for (const [index, id] of ['a', 'b', 'c', 'd', 'e'].entries()) {
      const [key, value] = seedEntry('wf-1', 1_000 + index, `update-${id}`);
      await storage.put(key, value);
    }
    const [otherKey, otherValue] = seedEntry('wf-2', 5_000, 'other-workflow');
    await storage.put(otherKey, otherValue);

    const first = await coordinator.listHistory('wf-1', { limit: 2 });
    expect(first.items.map((entry) => entry.updateId)).toEqual(['update-e', 'update-d']);
    expect(first.nextCursor).toBeDefined();

    const second = await coordinator.listHistory('wf-1', { limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((entry) => entry.updateId)).toEqual(['update-c', 'update-b']);

    const last = await coordinator.listHistory('wf-1', { limit: 2, cursor: second.nextCursor! });
    expect(last.items.map((entry) => entry.updateId)).toEqual(['update-a']);
    expect(last.nextCursor).toBeUndefined();

    // A page that holds exactly the remaining entries is the last page: no cursor to nowhere.
    const exact = await coordinator.listHistory('wf-1', { limit: 5 });
    expect(exact.items).toHaveLength(5);
    expect(exact.nextCursor).toBeUndefined();
    const unknown = await coordinator.listHistory('wf-unknown');
    expect(unknown.items).toEqual([]);
  });

  it('refuses a limit or a cursor the scan cannot honor, before it scans', async () => {
    const coordinator = new UpdateCoordinator(new MemoryStorage());

    for (const limit of [Number.NaN, 0, -1, 1.5, 201, Number.POSITIVE_INFINITY]) {
      const refused = await throwingRejectionOf(coordinator.listHistory('wf-1', { limit }));
      expect(refused).toThrow('options.limit must be an integer from 1 to 200');
    }
    const badCursor = await throwingRejectionOf(
      coordinator.listHistory('wf-1', { cursor: 'not-a-cursor' }),
    );
    expect(badCursor).toThrow('options.cursor is not a cursor');

    const engine = new Engine({ storage: new MemoryStorage() });
    try {
      const engineLimit = await throwingRejectionOf(
        engine.listUpdateHistory('wf-1', { limit: Number.NaN }),
      );
      expect(engineLimit).toThrow('options.limit');
      const engineCursor = await throwingRejectionOf(
        engine.listUpdateHistory('wf-1', { cursor: '1:update-a' }),
      );
      expect(engineCursor).toThrow('options.cursor');
      // The bounds themselves are fine.
      const page = await engine.listUpdateHistory('wf-1', { limit: 200 });
      expect(page.items).toEqual([]);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('recognises only a well-formed cursor', () => {
    expect(isUpdateHistoryCursor('0000000000001000:update-a')).toBe(true);
    expect(isUpdateHistoryCursor('')).toBe(false);
    expect(isUpdateHistoryCursor('1000:update-a')).toBe(false);
    expect(isUpdateHistoryCursor('0000000000001000:')).toBe(false);
    expect(isUpdateHistoryCursor('0000000000001000:a:b')).toBe(false);
  });
});

for (const backend of storageBackends) {
  describe(`Update history through the engine [${backend.name}]`, () => {
    let engine: Engine;
    let cleanup: () => void | Promise<void>;

    afterEach(async () => {
      await teardown(engine, cleanup);
    });

    async function startWorkflow(): Promise<{ id: string; storage: Storage }> {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });
      engine.register(historyWorkflow);
      const handle = await engine.start('update-history', undefined);
      handle.result().catch(() => {});
      await waitForWorkflowStatus(engine, handle.id, 'running');
      await flush();
      return { id: handle.id, storage: result.storage };
    }

    /** Submit a pending, a completed, and a failed update, in that order, one millisecond apart. */
    async function submitThree(id: string): Promise<{ timedOutUpdateId: string }> {
      const timedOut = await engine
        .submitCoordinatedUpdate(id, 'unhandled', { n: 1 }, { timeout: 25 })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(timedOut).toBeInstanceOf(UpdateTimeoutError);
      // load-proof: the next submitCoordinatedUpdate is awaited and queues behind the prior update through the engine's own promise chain, so the yield is surplus
      await sleepForTesting(2);
      const greeted = await engine.submitCoordinatedUpdate(id, 'greet', 'Ada', { timeout: 2_000 });
      expect(greeted.result).toBe('hello Ada');
      // load-proof: the next submitCoordinatedUpdate is awaited and queues behind the prior update through the engine's own promise chain, so the yield is surplus
      await sleepForTesting(2);
      const exploded = await engine.submitCoordinatedUpdate(id, 'explode', null, {
        timeout: 2_000,
      });
      expect(exploded.error).toBe('the handler refused');
      return { timedOutUpdateId: (timedOut as UpdateTimeoutError).updateId };
    }

    it('pages the history newest first, with no entry repeated or skipped, on every backend', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });
      for (const [index, id] of ['a', 'b', 'c', 'd', 'e'].entries()) {
        const [key, value] = seedEntry('wf-paged', 1_000 + index, `update-${id}`);
        await result.storage.put(key, value);
      }
      const [otherKey, otherValue] = seedEntry('wf-other', 9_000, 'other-workflow');
      await result.storage.put(otherKey, otherValue);

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await engine.listUpdateHistory('wf-paged', {
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        });
        seen.push(...page.items.map((entry) => entry.updateId));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== undefined && pages < 10);

      expect(pages).toBe(3);
      expect(seen).toEqual(['update-e', 'update-d', 'update-c', 'update-b', 'update-a']);
    });

    it('records a pending, a completed, and a failed update with the failure message', async () => {
      const { id } = await startWorkflow();
      const { timedOutUpdateId } = await submitThree(id);

      const page = await engine.listUpdateHistory(id);

      expect(page.items.map((entry) => [entry.name, entry.outcome])).toEqual([
        ['explode', 'failed'],
        ['greet', 'completed'],
        ['unhandled', 'pending'],
      ]);
      const [failed, completed, pending] = page.items;
      expect(failed!.error).toBe('the handler refused');
      expect(failed!.completedAt).toBeGreaterThanOrEqual(failed!.receivedAt);
      expect(completed!.error).toBeUndefined();
      expect(completed!.completedAt).toBeGreaterThanOrEqual(completed!.receivedAt);
      expect(pending!.updateId).toBe(timedOutUpdateId);
      expect(pending!.completedAt).toBeUndefined();
      // The history agrees with the stored response: the answered ones have a response, the
      // timed-out one does not.
      expect(await engine.getUpdateResult(completed!.updateId)).not.toBeNull();
      expect(await engine.getUpdateResult(pending!.updateId)).toBeNull();
    });

    it('keeps one entry per update when the answer comes through a parked waiter', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });
      const waiting = workflow({ name: 'waits-for-update' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        const { payload, respond } = yield* ctx.waitForUpdate<string>('review');
        respond(`reviewed ${payload}`);
        yield* ctx.waitForSignal('finish');
        return 'done';
      });
      engine.register(waiting);
      const handle = await engine.start('waits-for-update', undefined);
      handle.result().catch(() => {});
      await waitForWorkflowStatus(engine, handle.id, 'running');
      await flush();

      const answered = await engine.submitCoordinatedUpdate(handle.id, 'review', 'doc', {
        timeout: 2_000,
      });
      expect(answered.result).toBe('reviewed doc');

      await waitForCondition(async () => {
        const page = await engine.listUpdateHistory(handle.id);
        return page.items.length === 1 && page.items[0]!.outcome === 'completed';
      });
      expect(await collectKeys(result.storage, KEYS.updateHistoryPrefix(handle.id))).toHaveLength(
        1,
      );
    });

    it('survives terminal cleanup and goes with a purge, with the answers it names', async () => {
      const { id, storage } = await startWorkflow();
      await submitThree(id);
      const beforeCleanup = await engine.listUpdateHistory(id);
      const answered = beforeCleanup.items.filter((entry) => entry.outcome !== 'pending');
      expect(answered).toHaveLength(2);

      await engine.signal(id, 'finish', undefined);
      await waitForWorkflowStatus(engine, id, 'completed');
      await flush();

      // Terminal cleanup sweeps a finished run's scratch state, and leaves the history alone.
      await cleanupWorkflowStorage({ storage } as never, id, true);
      expect(await collectKeys(storage, KEYS.updateHistoryPrefix(id))).toHaveLength(3);
      const afterCleanup = await engine.listUpdateHistory(id);
      expect(afterCleanup.items).toHaveLength(3);
      for (const entry of answered) {
        expect(await engine.getUpdateResult(entry.updateId)).not.toBeNull();
      }

      const purged = await engine.purge({ status: 'completed' });
      expect(purged.deleted).toBeGreaterThanOrEqual(1);
      expect(await collectKeys(storage, KEYS.updateHistoryPrefix(id))).toEqual([]);
      const afterPurge = await engine.listUpdateHistory(id);
      expect(afterPurge.items).toEqual([]);
      // The answered responses the history named go with it, before the five-minute sweep.
      for (const entry of answered) {
        expect(await engine.getUpdateResult(entry.updateId)).toBeNull();
      }
    });
  });
}

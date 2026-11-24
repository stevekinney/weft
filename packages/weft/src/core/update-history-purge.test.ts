import { afterEach, describe, expect, it } from 'bun:test';

import {
  type BatchOperation,
  type Storage,
  encodeStorageKeyComponent,
  MemoryStorage,
} from "../embedded/storage/src/index.ts";
import { rejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { KEYS } from '../storage/keys.ts';
import {
  collectKeys,
  flush,
  storageBackends,
  teardown,
  waitForWorkflowStatus,
} from '../testing/storage-backends.test-support.ts';
import { encode } from './codec.ts';
import { Engine } from './engine.ts';
import type { WorkflowContext } from './types.ts';
import { workflow } from './types.ts';
import type { UpdateHistoryEntry } from './update-history.ts';

/** More entries than one batch holds twice over: each entry costs two deletes (itself, and its response). */
const HISTORY_ENTRIES = 5_200;
const SEED_BATCH = 1_000;

const parked = workflow({ name: 'update-heavy' }).execute(async function* (ctx: WorkflowContext) {
  yield* ctx.waitForSignal('finish');
  return 'done';
});

/** Give `workflowId` a history of `count` answered updates, and a still-kept response for every tenth. */
async function seedHistory(storage: Storage, workflowId: string, count: number): Promise<string[]> {
  const updateIds: string[] = [];
  for (let start = 0; start < count; start += SEED_BATCH) {
    const operations: BatchOperation[] = [];
    for (let index = start; index < Math.min(count, start + SEED_BATCH); index += 1) {
      const updateId = `seeded-update-${String(index).padStart(6, '0')}`;
      updateIds.push(updateId);
      const entry: UpdateHistoryEntry = {
        updateId,
        name: 'seeded',
        receivedAt: 1_000 + index,
        outcome: 'completed',
        completedAt: 2_000 + index,
      };
      operations.push({
        type: 'put',
        key: KEYS.updateHistory(workflowId, entry.receivedAt, updateId),
        value: encode(entry),
      });
      if (index % 10 === 0) {
        operations.push({
          type: 'put',
          key: KEYS.updateResponse(updateId),
          value: encode({ updateId, result: index, createdAt: Date.now() }),
        });
      }
    }
    await storage.batch(operations);
  }
  return updateIds;
}

/** Every key that names the run or one of its updates, apart from the two the engine keeps by design. */
async function keysNaming(
  storage: Storage,
  workflowId: string,
  updateIds: readonly string[],
): Promise<string[]> {
  const encoded = encodeStorageKeyComponent(workflowId);
  const keys = await collectKeys(storage, '');
  return keys.filter(
    (key) =>
      !key.startsWith('wf-gen:') &&
      !key.startsWith('sigseq:') &&
      (key.includes(encoded) || updateIds.some((updateId) => key.includes(updateId))),
  );
}

for (const backend of storageBackends) {
  describe(`Purging a large update history [${backend.name}]`, () => {
    let engine: Engine;
    let cleanup: () => void | Promise<void>;

    afterEach(async () => {
      await teardown(engine, cleanup);
    });

    it('purges a run whose history is larger than one batch, leaving no key that names it', async () => {
      const result = backend.factory();
      cleanup = result.cleanup;
      engine = new Engine({ storage: result.storage });
      engine.register(parked);
      const handle = await engine.start('update-heavy', undefined);
      handle.result().catch(() => {});
      await waitForWorkflowStatus(engine, handle.id, 'running');
      const updateIds = await seedHistory(result.storage, handle.id, HISTORY_ENTRIES);
      await engine.signal(handle.id, 'finish', undefined);
      await waitForWorkflowStatus(engine, handle.id, 'completed');
      await flush();

      const purged = await engine.purge({ status: 'completed' });

      expect(purged.deleted).toBe(1);
      expect(await keysNaming(result.storage, handle.id, updateIds)).toEqual([]);
      expect(await collectKeys(result.storage, 'uph:')).toEqual([]);
      expect(await collectKeys(result.storage, 'upr:')).toEqual([]);
    });
  });
}

describe('A purge that stops partway', () => {
  let engine: Engine | undefined;

  afterEach(async () => {
    engine?.[Symbol.dispose]();
    await flush();
  });

  it('finishes when it is retried, whatever the first attempt had already removed', async () => {
    const backing = new MemoryStorage();
    let historyDeleteBatches = 0;
    let failOnSecond = true;
    const guard = (operations: readonly BatchOperation[]): void => {
      const touchesHistory = operations.some(
        (operation) => operation.type === 'delete' && operation.key.startsWith('uph:'),
      );
      if (!touchesHistory) return;
      historyDeleteBatches += 1;
      if (failOnSecond && historyDeleteBatches === 2) {
        failOnSecond = false;
        throw new Error('storage went away partway through the purge');
      }
    };
    const storage: Storage = {
      capabilities: () => backing.capabilities(),
      get: (key) => backing.get(key),
      put: (key, value) => backing.put(key, value),
      delete: (key) => backing.delete(key),
      scan: (prefix, options) => backing.scan(prefix, options),
      batch: async (operations) => {
        guard(operations);
        await backing.batch(operations);
      },
      conditionalBatch: async (conditions, operations) => {
        guard(operations);
        return backing.conditionalBatch(conditions, operations);
      },
      [Symbol.dispose]: () => backing[Symbol.dispose](),
    };
    engine = new Engine({ storage });
    engine.register(parked);
    const handle = await engine.start('update-heavy', undefined);
    handle.result().catch(() => {});
    await waitForWorkflowStatus(engine, handle.id, 'running');
    const updateIds = await seedHistory(backing, handle.id, 3_000);
    await engine.signal(handle.id, 'finish', undefined);
    await waitForWorkflowStatus(engine, handle.id, 'completed');
    await flush();

    const firstAttempt = await rejectionOf(engine.purge({ status: 'completed' }));
    expect(String(firstAttempt)).toContain('storage went away');
    // It removed some of the history and left the run in place.
    const stillThere = await engine.get(handle.id);
    expect(stillThere?.status).toBe('completed');
    const remaining = await collectKeys(backing, 'uph:');
    expect(remaining.length).toBeGreaterThan(0);
    expect(remaining.length).toBeLessThan(3_000);

    const retried = await engine.purge({ status: 'completed' });

    expect(retried.deleted).toBe(1);
    expect(await keysNaming(backing, handle.id, updateIds)).toEqual([]);
  });
});

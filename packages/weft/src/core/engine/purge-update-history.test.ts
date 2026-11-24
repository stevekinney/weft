import { afterEach, describe, expect, it } from 'bun:test';

import { type ScanOptions, type Storage, MemoryStorage } from "../../embedded/storage/src/index.ts";
import { KEYS } from '../../storage/keys.ts';
import {
  collectKeys,
  flush,
  waitForWorkflowStatus,
} from '../../testing/storage-backends.test-support.ts';
import { encode } from '../codec.ts';
import { Engine } from '../engine.ts';
import type { WorkflowContext } from '../types.ts';
import { workflow } from '../types.ts';
import type { UpdateHistoryEntry } from '../update-history.ts';
import { EngineDisposedError } from './errors.ts';
import { getInternals } from './internals.ts';
import { drainUpdateHistory, UPDATE_HISTORY_PURGE_CHUNK } from './purge-update-history.ts';
import { addUpdateDeleteKeys } from './purge-update-keys.ts';

const parked = workflow({ name: 'drain-subject' }).execute(async function* (ctx: WorkflowContext) {
  yield* ctx.waitForSignal('finish');
  return 'done';
});

async function completedRunWithHistory(
  storage: Storage,
  entries: number,
): Promise<{ engine: Engine; workflowId: string }> {
  const engine = new Engine({ storage });
  engine.register(parked);
  const handle = await engine.start('drain-subject', undefined);
  handle.result().catch(() => {});
  await waitForWorkflowStatus(engine, handle.id, 'running');
  for (let index = 0; index < entries; index += 1) {
    const updateId = `drain-update-${index}`;
    const entry: UpdateHistoryEntry = {
      updateId,
      name: 'seeded',
      receivedAt: 1_000 + index,
      outcome: 'completed',
      completedAt: 2_000 + index,
    };
    await storage.put(KEYS.updateHistory(handle.id, entry.receivedAt, updateId), encode(entry));
    await storage.put(
      KEYS.updateResponse(updateId),
      encode({ updateId, result: index, createdAt: Date.now() }),
    );
  }
  await engine.signal(handle.id, 'finish', undefined);
  await waitForWorkflowStatus(engine, handle.id, 'completed');
  await flush();
  return { engine, workflowId: handle.id };
}

describe('drainUpdateHistory', () => {
  let engine: Engine | undefined;

  afterEach(async () => {
    engine?.[Symbol.dispose]();
    await flush();
  });

  it('removes every entry and the response it names, across more than one chunk', async () => {
    const storage = new MemoryStorage();
    const count = UPDATE_HISTORY_PURGE_CHUNK * 2 + 5;
    const run = await completedRunWithHistory(storage, count);
    engine = run.engine;
    const state = await engine.get(run.workflowId);

    await drainUpdateHistory(getInternals(engine), state!);

    expect(await collectKeys(storage, 'uph:')).toEqual([]);
    expect(await collectKeys(storage, 'upr:')).toEqual([]);
  });

  it('leaves the history alone for a run record other than the one it was asked about', async () => {
    const storage = new MemoryStorage();
    const run = await completedRunWithHistory(storage, 3);
    engine = run.engine;
    const state = await engine.get(run.workflowId);

    // A same-id replacement carries another execution token, and shares this key prefix.
    await drainUpdateHistory(getInternals(engine), {
      ...state!,
      workflowExecutionToken: 'a-replacement-run',
    });

    expect(await collectKeys(storage, 'uph:')).toHaveLength(3);
    expect(await collectKeys(storage, 'upr:')).toHaveLength(3);
  });

  it('stops, removing nothing further, when the run record moved after it was read', async () => {
    const backing = new MemoryStorage();
    let fenceLost = false;
    const storage: Storage = {
      capabilities: () => backing.capabilities(),
      get: (key) => backing.get(key),
      put: (key, value) => backing.put(key, value),
      delete: (key) => backing.delete(key),
      scan: (prefix, options) => backing.scan(prefix, options),
      batch: (operations) => backing.batch(operations),
      // The record changed between the read and the chunk: the fence refuses.
      conditionalBatch: async (conditions, operations) =>
        fenceLost ? false : backing.conditionalBatch(conditions, operations),
      [Symbol.dispose]: () => backing[Symbol.dispose](),
    };
    const run = await completedRunWithHistory(storage, 3);
    engine = run.engine;
    const state = await engine.get(run.workflowId);
    fenceLost = true;

    await drainUpdateHistory(getInternals(engine), state!);

    expect(await collectKeys(backing, 'uph:')).toHaveLength(3);
  });
});

describe('addUpdateDeleteKeys', () => {
  let engine: Engine | undefined;

  afterEach(async () => {
    engine?.[Symbol.dispose]();
    await flush();
  });

  it('still names whatever history is left when the purge batch is built, and the responses it names', async () => {
    const storage = new MemoryStorage();
    const run = await completedRunWithHistory(storage, 2);
    engine = run.engine;

    const keys = new Set<string>();
    await addUpdateDeleteKeys(storage, keys, run.workflowId);

    expect([...keys].toSorted()).toEqual(
      [
        ...(await collectKeys(storage, 'uph:')),
        KEYS.updateResponse('drain-update-0'),
        KEYS.updateResponse('drain-update-1'),
      ].toSorted(),
    );
  });
});

/**
 * Storage whose scans of the update history keep listing what they listed when it was frozen, as an
 * eventually consistent store (`readAfterWrite: 'eventual'`) may until its deletes are visible. A
 * scan cap turns a drain that re-reads deleted keys into a failure instead of a hung test.
 */
class StaleHistoryScans extends MemoryStorage {
  #frozen: string[] | undefined;
  historyScans = 0;

  freezeHistory(keys: readonly string[]): void {
    this.#frozen = keys.toSorted();
  }

  override async *scan(
    prefix: string,
    options: ScanOptions = {},
  ): AsyncIterable<[string, Uint8Array]> {
    if (this.#frozen === undefined || !prefix.startsWith('uph:')) {
      yield* super.scan(prefix, options);
      return;
    }
    this.historyScans += 1;
    if (this.historyScans > 50) throw new Error('the drain kept scanning keys it had deleted');
    let emitted = 0;
    for (const key of this.#frozen) {
      if (!key.startsWith(prefix)) continue;
      if (options.gt !== undefined && key <= options.gt) continue;
      if (options.limit !== undefined && emitted >= options.limit) return;
      yield [key, (await super.get(key)) ?? new Uint8Array()];
      emitted += 1;
    }
  }
}

describe('drainUpdateHistory over a store whose scans lag its deletes', () => {
  let engine: Engine | undefined;

  afterEach(async () => {
    engine?.[Symbol.dispose]();
    await flush();
  });

  it('never rescans what it deleted, so it ends after one pass over the history', async () => {
    const storage = new StaleHistoryScans();
    const count = UPDATE_HISTORY_PURGE_CHUNK * 2 + 5;
    const run = await completedRunWithHistory(storage, count);
    engine = run.engine;
    const state = await engine.get(run.workflowId);
    storage.freezeHistory(await collectKeys(storage, 'uph:'));

    await drainUpdateHistory(getInternals(engine), state!);

    // Three chunks of history, then one scan that finds nothing past the last key deleted.
    expect(storage.historyScans).toBe(4);
    const remaining: string[] = [];
    for await (const [key] of MemoryStorage.prototype.scan.call(storage, 'uph:'))
      remaining.push(key);
    expect(remaining).toEqual([]);
  });

  it('drains without a record fence on a storage that cannot condition a write', async () => {
    const storage = new MemoryStorage();
    const run = await completedRunWithHistory(storage, 3);
    engine = run.engine;
    const state = await engine.get(run.workflowId);
    storage.capabilities = () => ({
      ...MemoryStorage.prototype.capabilities.call(storage),
      conditionalBatch: false,
    });
    storage.conditionalBatch = async () => {
      throw new Error('a drain without conditional batches must not condition its writes');
    };

    await drainUpdateHistory(getInternals(engine), state!);

    expect(await collectKeys(storage, 'uph:')).toEqual([]);
  });

  it('stops at once when the engine is disposed between chunks', async () => {
    const storage = new StaleHistoryScans();
    const run = await completedRunWithHistory(storage, UPDATE_HISTORY_PURGE_CHUNK + 5);
    engine = run.engine;
    const state = await engine.get(run.workflowId);
    const internals = getInternals(engine);
    engine[Symbol.dispose]();
    engine = undefined;

    const failure = await drainUpdateHistory(internals, state!).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(EngineDisposedError);
  });
});

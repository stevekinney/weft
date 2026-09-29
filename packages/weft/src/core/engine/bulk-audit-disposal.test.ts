import { describe, expect, it } from 'bun:test';

import type { BatchOperation, ConditionalBatchCondition } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { rejectionOf } from '../../testing/promise-outcome.test-support.ts';
import { Engine } from '../engine.ts';
import { workflow } from '../types.ts';
import { EngineDisposedError } from './errors.ts';

const TYPE = 'bulk-audit-disposal';
const WORKFLOW_ID = 'bulk-audit-disposal-run';
const AUDIT_PREFIX = KEYS.bulkOperationAuditPrefix();

/**
 * A `MemoryStorage` that parks either the purge commit deleting one workflow's
 * record or the bulk-operation audit `put`, until the test releases it.
 */
class GatedStorage extends MemoryStorage {
  #held: 'commit' | 'audit' | null = null;
  #reached = Promise.withResolvers<void>();
  #release = Promise.withResolvers<void>();

  arm(held: 'commit' | 'audit'): void {
    this.#held = held;
  }

  get reached(): Promise<void> {
    return this.#reached.promise;
  }

  release(): void {
    this.#held = null;
    this.#release.resolve();
  }

  async #hold(kind: 'commit' | 'audit', matches: boolean): Promise<void> {
    if (this.#held !== kind || !matches) return;
    this.#reached.resolve();
    await this.#release.promise;
  }

  override async put(key: string, value: Uint8Array): Promise<void> {
    await this.#hold('audit', key.startsWith(AUDIT_PREFIX));
    return super.put(key, value);
  }

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    const deletesRun = operations.some(
      (operation) => operation.type === 'delete' && operation.key === KEYS.workflow(WORKFLOW_ID),
    );
    await this.#hold('commit', deletesRun);
    return super.conditionalBatch(conditions, operations);
  }
}

async function createEngineWithCompletedRun(storage: GatedStorage): Promise<Engine> {
  const engine = new Engine({ storage });
  engine.register(
    workflow({ name: TYPE }).execute(async function* () {
      return 'done';
    }),
  );
  const handle = await engine.start(TYPE, null, { id: WORKFLOW_ID });
  await handle.result();
  return engine;
}

async function auditKeys(storage: MemoryStorage): Promise<string[]> {
  const keys: string[] = [];
  for await (const [key] of storage.scan(AUDIT_PREFIX)) keys.push(key);
  return keys;
}

describe('bulk-operation audit write and engine disposal', () => {
  it('a bulk delete whose engine is disposed before its audit write writes no audit record', async () => {
    // The purge commit was issued before disposal, so it lands; the audit
    // record is a new write the disposed engine must not issue. That matches a
    // bulk delete that fails part-way, which also writes no audit record.
    const storage = new GatedStorage();
    const engine = await createEngineWithCompletedRun(storage);
    storage.arm('commit');
    const deletion = engine.deleteAll({ status: 'completed' }, { requestId: 'audit-disposal' });
    await storage.reached;

    engine[Symbol.dispose]();
    storage.release();

    expect(await rejectionOf(deletion)).toBeInstanceOf(EngineDisposedError);
    expect(await storage.get(KEYS.workflow(WORKFLOW_ID))).toBeNull();
    expect(await auditKeys(storage)).toEqual([]);
  });

  it('async disposal waits for a bulk-operation audit write already issued', async () => {
    const storage = new GatedStorage();
    const engine = await createEngineWithCompletedRun(storage);
    storage.arm('audit');
    const deletion = engine.deleteAll({ status: 'completed' }, { requestId: 'audit-disposal' });
    await storage.reached;

    let disposalSettled = false;
    const disposal = engine[Symbol.asyncDispose]().then(() => {
      disposalSettled = true;
    });
    // The held audit write is the only thing disposal can be waiting on, so
    // nothing but the release below can let it finish.
    await Bun.sleep(0);
    expect(disposalSettled).toBe(false);

    storage.release();
    await disposal;
    const result = await deletion;
    expect(result.deleted).toBe(1);
    expect(await auditKeys(storage)).toHaveLength(1);
  });
});

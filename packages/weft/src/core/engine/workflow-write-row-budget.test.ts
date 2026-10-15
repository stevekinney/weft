/**
 * Pins the exact rows a workflow's start and completion write (COR-1387).
 *
 * Every row costs a storage write on the hottest path the engine has, and the
 * workflow-start benchmark that measures it is kept out of the default gate
 * because it measures host load as much as code. Weft PR 229 tripled the rows
 * per start without any deterministic check noticing, so this test lists them:
 * a change that adds a row to either batch must update this list on purpose.
 */
import { describe, expect, it } from 'bun:test';

import type { BatchOperation, ConditionalBatchCondition } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import { Engine } from './index.ts';

class BatchRecordingStorage extends MemoryStorage {
  readonly batches: string[][] = [];

  #record(operations: BatchOperation[]): void {
    // The key namespace (everything before the first `:`) identifies the row kind.
    this.batches.push(
      operations.map((operation) => `${operation.type} ${operation.key.split(':')[0]}`),
    );
  }

  override async batch(operations: BatchOperation[]): Promise<void> {
    this.#record(operations);
    await super.batch(operations);
  }

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    this.#record(operations);
    return super.conditionalBatch(conditions, operations);
  }
}

const workflows = {
  noop: workflow({ name: 'noop' }).execute(async function* (_ctx: WorkflowContext) {
    return 'done';
  }),
};

async function recordStartAndCompletion(
  maintainWorkflowVisibilityIndexes: boolean,
): Promise<string[][]> {
  const storage = new BatchRecordingStorage();
  // The clock advances on every read, so `updatedAt` changes between start and
  // completion, but stays inside the minute that one `wf-idx-updated:` bucket covers.
  let now = 1_700_000_040_000;
  await using engine = await Engine.create({
    storage,
    workflows,
    recover: false,
    maintainWorkflowVisibilityIndexes,
    getNow: () => (now += 1),
  });
  storage.batches.length = 0;

  const handle = await engine.start('noop', null);
  await handle.result();
  const state = await engine.get(handle.id);
  expect(state?.updatedAt).toBeGreaterThan(state?.createdAt ?? Number.POSITIVE_INFINITY);
  expect(now).toBeLessThan(1_700_000_100_000);

  return storage.batches;
}

describe('rows written by a generated-id start and its completion', () => {
  it('writes two rows per batch while the visibility indexes are not maintained', async () => {
    expect(await recordStartAndCompletion(false)).toEqual([
      ['put wf', 'put wf'],
      ['put wf-terminal', 'put wf'],
    ]);
  });

  it('adds four index rows to the start and moves only the status row on completion', async () => {
    expect(await recordStartAndCompletion(true)).toEqual([
      [
        'put wf',
        'put wf',
        'put wf-idx-status',
        'put wf-idx-type',
        'put wf-idx-created',
        'put wf-idx-updated',
      ],
      ['put wf-terminal', 'put wf', 'delete wf-idx-status', 'put wf-idx-status'],
    ]);
  });
});

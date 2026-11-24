import { describe, expect, it } from 'bun:test';

import {
  MemoryStorage,
  type BatchOperation,
  type ConditionalBatchCondition,
} from "../../embedded/storage/src/index.ts";
import { KEYS } from '../../storage/keys.ts';
import { Engine } from '../engine.ts';
import { CleanupWarningEvent } from '../events.ts';
import { workflow } from '../types.ts';

/** A store that fails the commit purging one workflow record once the test arms it. */
class PurgeFailingStorage extends MemoryStorage {
  readonly failure = new Error('storage write failed');
  armed = false;

  constructor(private readonly purgedKey: string) {
    super();
  }

  #check(operations: readonly BatchOperation[]): void {
    if (
      this.armed &&
      operations.some(({ type, key }) => type === 'delete' && key === this.purgedKey)
    ) {
      throw this.failure;
    }
  }

  override async batch(operations: BatchOperation[]): Promise<void> {
    this.#check(operations);
    return super.batch(operations);
  }

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    this.#check(operations);
    return super.conditionalBatch(conditions, operations);
  }
}

describe('retention sweep armed by registering a workflow with retention', () => {
  it('reports a failed purge as a retentionSweep cleanup warning', async () => {
    const workflowId = 'registered-retention-run';
    const storage = new PurgeFailingStorage(KEYS.workflow(workflowId));
    const clock = { now: 5_000 };
    // No engine-level retention, so construction arms no sweep: the workflow's own retention does,
    // when it is registered.
    const engine = new Engine({
      storage,
      getNow: () => clock.now,
      retentionSweepInterval: '10ms',
    });
    const warning = Promise.withResolvers<CleanupWarningEvent>();
    engine.addEventListener(CleanupWarningEvent.type, (event) => warning.resolve(event));
    engine.register(
      workflow({ name: 'registered-retention', retention: { completed: '1s' } }).execute(
        async function* () {
          return 'done';
        },
      ),
    );
    const handle = await engine.start('registered-retention', null, { id: workflowId });
    await handle.result();

    storage.armed = true;
    clock.now += 1_500; // past the 1s retention window: the next sweep purges the run
    const received = await warning.promise;

    expect(received.source).toBe('retentionSweep');
    expect(received.error).toBe(storage.failure);
    await engine[Symbol.asyncDispose]();
  });
});

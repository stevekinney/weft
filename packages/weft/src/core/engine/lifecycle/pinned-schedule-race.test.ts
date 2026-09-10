/**
 * The pinned-schedule create/update TOCTOU (WFT-20): capturing
 * `pinnedRevision` then writing `ScheduleState` has an await gap where a
 * concurrent `removeWorkflowRevision()` for that EXACT `(type, revision)`
 * could land in between — the scan-based `pinnedSchedules` reference count
 * cannot see an uncommitted schedule write, so the removal's own reference
 * check would not have blocked it. `writeScheduleState`'s `extraConditions`
 * (fenced via `buildCatalogEntryRevisionCondition`, mirroring
 * `start-commit.ts`'s identical fence for a fresh `start()`) closes this —
 * the schedule write must fail cleanly, never silently commit a pin to a
 * just-removed revision.
 */
import { describe, expect, it } from 'bun:test';

import {
  KEYS,
  type BatchOperation,
  type ConditionalBatchCondition,
} from '../../../storage/interface.ts';
import { MemoryStorage } from '../../../storage/memory.ts';
import { workflow, type WorkflowContext } from '../../types.ts';
import { Engine } from '../index.ts';
import { WorkflowRevisionUnavailableError } from '../revision-errors.ts';

/**
 * Simulates a concurrent `removeWorkflowRevision()` landing in the exact
 * await gap between this process's own pin capture and its schedule-create
 * commit: the FIRST `conditionalBatch` call whose operations include a
 * `schedule:` put (the pin-creating write) is intercepted — before letting
 * it proceed, the storage's own catalog entry for the target `(type,
 * revision)` is deleted directly, exactly as a peer process's own committed
 * removal would have left it. The schedule write's own fenced precondition
 * (the catalog entry's prior bytes) must then legitimately fail.
 */
class InterleavedRemovalStorage extends MemoryStorage {
  #catalogEntryKeyToRemove: string | null = null;
  #triggered = false;

  armInterleavedRemoval(catalogEntryKey: string): void {
    this.#catalogEntryKeyToRemove = catalogEntryKey;
    this.#triggered = false;
  }

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    const isScheduleCreateWrite = operations.some(
      (operation) => operation.type === 'put' && operation.key.startsWith('schedule:'),
    );
    if (isScheduleCreateWrite && !this.#triggered && this.#catalogEntryKeyToRemove !== null) {
      this.#triggered = true;
      await super.delete(this.#catalogEntryKeyToRemove);
    }
    return super.conditionalBatch(conditions, operations);
  }
}

describe('pinned-schedule create/update TOCTOU fencing (WFT-20)', () => {
  it('fails the pinned-schedule create write when the pinned revision is concurrently removed before the commit lands', async () => {
    const storage = new InterleavedRemovalStorage();
    const engine = new Engine({ storage, backgroundTasks: 'manual' });
    const definition = workflow({ name: 'race-eager' }).execute(async function* (
      _ctx: WorkflowContext,
    ) {
      return 'done';
    });
    engine.register(definition);
    // Force catalog readiness (and learn the real registered revision)
    // through a throwaway start/complete before arming the race — reading
    // `registeredCatalogRevisions` before any `ensureWorkflowCatalogReady()`
    // await can race the map's own population.
    const warmup = await engine.start('race-eager', null);
    await warmup.result();
    const revision = (await engine.get(warmup.id))!.revision!;

    // Simulates the exact state a concurrent, already-committed
    // `removeWorkflowRevision()` on a peer process would leave: the catalog
    // entry gone from storage, no tombstone bookkeeping needed for this test
    // since only the schedule write's OWN fenced precondition is under test.
    storage.armInterleavedRemoval(KEYS.catalogEntry('race-eager', revision));

    const rejection = await engine
      .schedule('race-eager', null, '* * * * *', { revisionPolicy: 'pinned' })
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(WorkflowRevisionUnavailableError);

    // The pin never committed durably — no schedule exists.
    const listed = await engine.listSchedules();
    expect(listed.items).toEqual([]);

    engine[Symbol.dispose]();
  });
});

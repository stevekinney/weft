import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { removeCatalogEntry } from '../catalog/removal.ts';
import { WorkflowCatalog } from '../catalog/workflow-catalog.ts';
import { encode } from '../codec.ts';
import { buildWorkflowContract } from '../contract/build.ts';
import { buildWorkflowRevisionManifest } from '../contract/manifest.ts';
import type { WorkflowRevisionManifest } from '../contract/types.ts';
import type { ScheduleState } from '../types/schedules.ts';
import type { RegisteredWorkflowDefinition } from '../types/workflow-registry.ts';
import { DEFAULT_WORKFLOW_VERSION } from '../versioning.ts';
import {
  resolveCatalogTombstoneIfPresent,
  resolveOrphanedCatalogTombstones,
} from './catalog-tombstone-recovery.ts';
import type { TeardownDeadLetterRecord } from './termination/finalizer-claim.ts';

function fakeDefinition(type: string): RegisteredWorkflowDefinition {
  return { type, version: '1.0.0', tags: [] };
}

async function manifestFor(
  name: string,
  version: string,
  overrides?: { revision?: string; description?: string },
): Promise<WorkflowRevisionManifest> {
  const contract = buildWorkflowContract({
    name,
    version,
    ...(overrides?.description === undefined ? {} : { description: overrides.description }),
  });
  return buildWorkflowRevisionManifest(
    contract,
    overrides?.revision === undefined ? undefined : { revision: overrides.revision },
  );
}

/**
 * Simulate the crash `removeCatalogEntry` (WFT-17/18) is defending
 * against: its own delete+tombstone commit lands, but the process that
 * called it crashes before resolving the tombstone. Calling the low-level
 * primitive directly (never `removeWorkflowRevision()`, which would
 * resolve it itself in the same call) leaves the tombstone genuinely
 * orphaned, exactly like a real crash would.
 */
async function simulateCrashedRemoval(
  storage: MemoryStorage,
  name: string,
  revision: string,
): Promise<void> {
  const removed = await removeCatalogEntry(storage, name, revision);
  if (removed.outcome !== 'removed') {
    throw new Error(`expected removeCatalogEntry to succeed, got ${JSON.stringify(removed)}`);
  }
  expect(await storage.get(KEYS.catalogTombstone(name, revision))).not.toBeNull();
  expect(await storage.get(KEYS.catalogEntry(name, revision))).toBeNull();
}

describe('resolveOrphanedCatalogTombstones', () => {
  it('is a no-op when no tombstones are present', async () => {
    const storage = new MemoryStorage();
    await expect(resolveOrphanedCatalogTombstones(storage)).resolves.toBeUndefined();
  });

  it('finalizes an orphaned tombstone with zero durable non-terminal references', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const v1 = await manifestFor('checkout', '1.0.0');
    const v2 = await manifestFor('checkout', '2.0.0');
    await catalog.activateRegistered('checkout', v1, fakeDefinition('checkout'));
    await catalog.activateRegistered('checkout', v2, fakeDefinition('checkout'));

    await simulateCrashedRemoval(storage, 'checkout', v1.revision);

    await resolveOrphanedCatalogTombstones(storage);

    expect(await storage.get(KEYS.catalogTombstone('checkout', v1.revision))).toBeNull();
    expect(await storage.get(KEYS.catalogEntry('checkout', v1.revision))).toBeNull();
  });

  it('restores an orphaned tombstone that a non-terminal run still durably references', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const v1 = await manifestFor('checkout', '1.0.0');
    const v2 = await manifestFor('checkout', '2.0.0');
    await catalog.activateRegistered('checkout', v1, fakeDefinition('checkout'));
    await catalog.activateRegistered('checkout', v2, fakeDefinition('checkout'));

    // A non-terminal run pinned to v1 — the durable reference the orphan
    // resolution's fresh `countNonTerminalRunsForRevision` scan must see,
    // regardless of any process's own in-memory state (there is none here
    // at all — this is deliberately storage-only, matching what a crashed
    // peer's own process state can never contribute).
    await storage.put(
      KEYS.workflow('checkout-pinned'),
      encode({
        id: 'checkout-pinned',
        type: 'checkout',
        status: 'running',
        input: null,
        versionTuple: { workflowVersion: DEFAULT_WORKFLOW_VERSION },
        revision: v1.revision,
        createdAt: 1,
        updatedAt: 1,
      }),
    );

    await simulateCrashedRemoval(storage, 'checkout', v1.revision);

    await resolveOrphanedCatalogTombstones(storage);

    expect(await storage.get(KEYS.catalogTombstone('checkout', v1.revision))).toBeNull();
    const restoredBytes = await storage.get(KEYS.catalogEntry('checkout', v1.revision));
    expect(restoredBytes).not.toBeNull();
  });

  it('restores an orphaned tombstone still referenced by a PINNED SCHEDULE — the pre-existing pinnedSchedules-blind gap this batch fixes (WFT-21)', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const v1 = await manifestFor('checkout', '1.0.0');
    const v2 = await manifestFor('checkout', '2.0.0');
    await catalog.activateRegistered('checkout', v1, fakeDefinition('checkout'));
    await catalog.activateRegistered('checkout', v2, fakeDefinition('checkout'));

    // A pinned schedule referencing v1 — no non-terminal run and no
    // terminal/dead-lettered record exist, so before this batch's fix the
    // sweep (checking only `nonTerminalRuns`) would have wrongly finalized
    // this tombstone out from under the still-live pinned schedule.
    const scheduleState: ScheduleState = {
      id: 'sched-pinned-v1',
      workflowType: 'checkout',
      input: null,
      cronExpression: '* * * * *',
      status: 'active',
      overlap: 'skip',
      backfill: false,
      revisionPolicy: 'pinned',
      pinnedRevision: v1.revision,
      createdAt: 1,
      updatedAt: 1,
      nextFireAt: 60_000,
      missedFireCount: 0,
      queuedRuns: [],
    };
    await storage.put(KEYS.schedule(scheduleState.id), encode(scheduleState));

    await simulateCrashedRemoval(storage, 'checkout', v1.revision);

    await resolveOrphanedCatalogTombstones(storage);

    expect(await storage.get(KEYS.catalogTombstone('checkout', v1.revision))).toBeNull();
    const restoredBytes = await storage.get(KEYS.catalogEntry('checkout', v1.revision));
    expect(restoredBytes).not.toBeNull();
  });

  it('restores an orphaned tombstone still referenced by a terminal, unpurged run (retainedRecoveryRecords, WFT-21)', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const v1 = await manifestFor('checkout', '1.0.0');
    const v2 = await manifestFor('checkout', '2.0.0');
    await catalog.activateRegistered('checkout', v1, fakeDefinition('checkout'));
    await catalog.activateRegistered('checkout', v2, fakeDefinition('checkout'));

    await storage.put(
      KEYS.workflow('checkout-terminal'),
      encode({
        id: 'checkout-terminal',
        type: 'checkout',
        status: 'completed',
        input: null,
        versionTuple: { workflowVersion: DEFAULT_WORKFLOW_VERSION },
        revision: v1.revision,
        createdAt: 1,
        updatedAt: 1,
      }),
    );

    await simulateCrashedRemoval(storage, 'checkout', v1.revision);

    await resolveOrphanedCatalogTombstones(storage);

    expect(await storage.get(KEYS.catalogTombstone('checkout', v1.revision))).toBeNull();
    const restoredBytes = await storage.get(KEYS.catalogEntry('checkout', v1.revision));
    expect(restoredBytes).not.toBeNull();
  });

  it('restores an orphaned tombstone still referenced by a dead-lettered finalizer record (retainedRecoveryRecords, WFT-21)', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const v1 = await manifestFor('checkout', '1.0.0');
    const v2 = await manifestFor('checkout', '2.0.0');
    await catalog.activateRegistered('checkout', v1, fakeDefinition('checkout'));
    await catalog.activateRegistered('checkout', v2, fakeDefinition('checkout'));

    const deadLetter: TeardownDeadLetterRecord = {
      type: 'checkout',
      lastError: 'resource leaked',
      attempts: 8,
      deadLetteredAt: 1,
      revision: v1.revision,
    };
    // Seed under `teardownDeadLetterHistory` — the namespace
    // `countTeardownDeadLettersForRevision()` actually scans (WFT-21, Codex
    // review round 3, P2), not the single-slot `teardownDeadLetter`.
    await storage.put(
      KEYS.teardownDeadLetterHistory('checkout-dead-lettered', 'dead-letter-token'),
      encode(deadLetter),
    );

    await simulateCrashedRemoval(storage, 'checkout', v1.revision);

    await resolveOrphanedCatalogTombstones(storage);

    expect(await storage.get(KEYS.catalogTombstone('checkout', v1.revision))).toBeNull();
    const restoredBytes = await storage.get(KEYS.catalogEntry('checkout', v1.revision));
    expect(restoredBytes).not.toBeNull();
  });

  it('resolves multiple orphaned tombstones for DIFFERENT (name, revision) pairs independently', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const checkoutV1 = await manifestFor('checkout', '1.0.0');
    const checkoutV2 = await manifestFor('checkout', '2.0.0');
    const shippingV1 = await manifestFor('shipping', '1.0.0');
    const shippingV2 = await manifestFor('shipping', '2.0.0');
    await catalog.activateRegistered('checkout', checkoutV1, fakeDefinition('checkout'));
    await catalog.activateRegistered('checkout', checkoutV2, fakeDefinition('checkout'));
    await catalog.activateRegistered('shipping', shippingV1, fakeDefinition('shipping'));
    await catalog.activateRegistered('shipping', shippingV2, fakeDefinition('shipping'));

    await simulateCrashedRemoval(storage, 'checkout', checkoutV1.revision);
    await simulateCrashedRemoval(storage, 'shipping', shippingV1.revision);

    await resolveOrphanedCatalogTombstones(storage);

    expect(await storage.get(KEYS.catalogTombstone('checkout', checkoutV1.revision))).toBeNull();
    expect(await storage.get(KEYS.catalogTombstone('shipping', shippingV1.revision))).toBeNull();
    expect(await storage.get(KEYS.catalogEntry('checkout', checkoutV1.revision))).toBeNull();
    expect(await storage.get(KEYS.catalogEntry('shipping', shippingV1.revision))).toBeNull();
  });

  it('fails closed when a catalog-tombstone key does not match the expected catalog-tombstone:<name>:<revision> shape', async () => {
    const storage = new MemoryStorage();
    await storage.put('catalog-tombstone:onlyonepart', new TextEncoder().encode('{}'));

    await expect(resolveOrphanedCatalogTombstones(storage)).rejects.toThrow(
      /does not match the expected/,
    );
  });
});

describe('resolveCatalogTombstoneIfPresent', () => {
  it('is a no-op when no tombstone exists for the exact (name, revision) key', async () => {
    const storage = new MemoryStorage();
    await expect(
      resolveCatalogTombstoneIfPresent(storage, 'checkout', 'no-such-revision'),
    ).resolves.toBeUndefined();
  });

  it('resolves a tombstone present for the exact (name, revision) key', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkflowCatalog(storage);
    const v1 = await manifestFor('checkout', '1.0.0');
    const v2 = await manifestFor('checkout', '2.0.0');
    await catalog.activateRegistered('checkout', v1, fakeDefinition('checkout'));
    await catalog.activateRegistered('checkout', v2, fakeDefinition('checkout'));

    await simulateCrashedRemoval(storage, 'checkout', v1.revision);

    await resolveCatalogTombstoneIfPresent(storage, 'checkout', v1.revision);

    expect(await storage.get(KEYS.catalogTombstone('checkout', v1.revision))).toBeNull();
  });
});

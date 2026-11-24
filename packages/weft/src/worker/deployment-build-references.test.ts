/**
 * The scan behind a build's reference count (COR-1582): which run records and task-ledger entries
 * count as work bound to a build, and which do not.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { encode } from '../core/codec/index.ts';
import {
  seedBoundRun,
  seedLedgerEntry,
  type SeededRunStatus,
} from './deployment-build-references.test-support.ts';
import { countBuildReference, countBuildReferences } from './deployment-build-references.ts';

const BILLING_A = { deploymentName: 'billing', buildId: 'build-a' };
const BILLING_B = { deploymentName: 'billing', buildId: 'build-b' };
const SHIPPING_A = { deploymentName: 'shipping', buildId: 'build-a' };

describe('what counts as a run referencing a build', () => {
  it.each(['pending', 'running', 'suspended'] as const)(
    'counts a %s run whose current binding names the build',
    async (status) => {
      const storage = new MemoryStorage();
      await seedBoundRun(storage, { workflowId: 'run-1', ...BILLING_A, status });

      expect(await countBuildReference(storage, BILLING_A)).toBe(1);
      expect(await countBuildReference(storage, BILLING_B)).toBe(0);
    },
  );

  it.each(['completed', 'failed', 'cancelled', 'timed-out'] as const)(
    'does not count a %s run',
    async (status: SeededRunStatus) => {
      const storage = new MemoryStorage();
      await seedBoundRun(storage, { workflowId: 'run-1', ...BILLING_A, status });

      expect(await countBuildReference(storage, BILLING_A)).toBe(0);
    },
  );

  it('counts an auto-upgrade run, which still executes on its current build', async () => {
    const storage = new MemoryStorage();
    await seedBoundRun(storage, { workflowId: 'run-1', ...BILLING_A, policy: 'auto-upgrade' });

    expect(await countBuildReference(storage, BILLING_A)).toBe(1);
  });

  it('keys a build by its deployment, so the same build id elsewhere is another build', async () => {
    const storage = new MemoryStorage();
    await seedBoundRun(storage, { workflowId: 'run-1', ...SHIPPING_A });

    expect(await countBuildReference(storage, BILLING_A)).toBe(0);
    expect(await countBuildReference(storage, SHIPPING_A)).toBe(1);
  });

  it('ignores a run with no worker binding and the records that merely share the wf: prefix', async () => {
    const storage = new MemoryStorage();
    await storage.put(
      'wf:unversioned',
      encode({ id: 'unversioned', type: 'checkout', status: 'running' }),
    );
    await storage.put('wf:unversioned:ckpt', encode({ status: 'running', workerBinding: {} }));
    await storage.put('wf:not-a-record', encode('a string, not a run'));
    await storage.put(
      'wf:half-bound',
      encode({ status: 'running', workerBinding: { current: { buildId: 'build-a' } } }),
    );
    await storage.put('wf:no-current', encode({ status: 'running', workerBinding: {} }));

    expect(await countBuildReferences(storage, [BILLING_A])).toEqual([0]);
  });
});

describe('what counts as a ledger entry referencing a build', () => {
  it('counts an entry that is not terminal and ignores one that is', async () => {
    const storage = new MemoryStorage();
    await seedLedgerEntry(storage, { operationId: 'op-queued', requirement: BILLING_A });
    await seedLedgerEntry(storage, {
      operationId: 'op-finished',
      requirement: BILLING_A,
      finished: true,
    });

    expect(await countBuildReference(storage, BILLING_A)).toBe(1);
  });

  it('counts a requirement that names the build id alone for every deployment that has one', async () => {
    const storage = new MemoryStorage();
    await seedLedgerEntry(storage, { operationId: 'op-1', requirement: { buildId: 'build-a' } });

    expect(await countBuildReferences(storage, [BILLING_A, SHIPPING_A, BILLING_B])).toEqual([
      1, 1, 0,
    ]);
  });

  it('ignores an entry whose requirement names another deployment, another build, or no build', async () => {
    const storage = new MemoryStorage();
    await seedLedgerEntry(storage, { operationId: 'op-1', requirement: SHIPPING_A });
    await seedLedgerEntry(storage, { operationId: 'op-2', requirement: BILLING_B });
    await seedLedgerEntry(storage, {
      operationId: 'op-3',
      requirement: { deploymentName: 'billing' },
    });
    await seedLedgerEntry(storage, { operationId: 'op-4', requirement: {} });
    await storage.put('task-ledger:malformed', encode({ state: 'queued' }));

    expect(await countBuildReference(storage, BILLING_A)).toBe(0);
  });
});

describe('counting several builds at once', () => {
  it('serves each build from one pass and answers in the order asked', async () => {
    const storage = new MemoryStorage();
    await seedBoundRun(storage, { workflowId: 'run-1', ...BILLING_A });
    await seedBoundRun(storage, { workflowId: 'run-2', ...BILLING_A });
    await seedBoundRun(storage, { workflowId: 'run-3', ...BILLING_B });
    await seedLedgerEntry(storage, { operationId: 'op-1', requirement: BILLING_B });

    expect(await countBuildReferences(storage, [BILLING_B, BILLING_A, SHIPPING_A])).toEqual([
      2, 2, 0,
    ]);
  });

  it('answers an empty list without reading anything', async () => {
    expect(await countBuildReferences(new MemoryStorage(), [])).toEqual([]);
  });
});

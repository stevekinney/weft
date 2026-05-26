import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';

import {
  queryWorkflowIdPrefixCandidates,
  queryWorkflowStatusIndex,
  queryWorkflowTimeRangeIndex,
  queryWorkflowTypeIndex,
} from './workflow-visibility-queries.ts';

const EMPTY = new Uint8Array(0);

async function seedIndex(storage: MemoryStorage, key: string): Promise<void> {
  await storage.put(key, EMPTY);
}

describe('queryWorkflowStatusIndex', () => {
  it('returns ids matching any of the listed statuses', async () => {
    await using storage = new MemoryStorage();
    await seedIndex(storage, KEYS.workflowVisibilityStatus('running', 'wf-1'));
    await seedIndex(storage, KEYS.workflowVisibilityStatus('running', 'wf-2'));
    await seedIndex(storage, KEYS.workflowVisibilityStatus('pending', 'wf-3'));
    await seedIndex(storage, KEYS.workflowVisibilityStatus('completed', 'wf-4'));

    const ids = await queryWorkflowStatusIndex(storage, ['running', 'pending']);
    expect(ids).toEqual(new Set(['wf-1', 'wf-2', 'wf-3']));
  });

  it('returns an empty set when statuses are empty', async () => {
    await using storage = new MemoryStorage();
    const ids = await queryWorkflowStatusIndex(storage, []);
    expect(ids).toEqual(new Set());
  });
});

describe('queryWorkflowTypeIndex', () => {
  it('matches workflows by type, decoding encoded ids', async () => {
    await using storage = new MemoryStorage();
    await seedIndex(storage, KEYS.workflowVisibilityType('order', 'wf-a'));
    await seedIndex(storage, KEYS.workflowVisibilityType('order', 'wf b'));
    await seedIndex(storage, KEYS.workflowVisibilityType('payment', 'wf-c'));

    const ids = await queryWorkflowTypeIndex(storage, 'order');
    expect(ids).toEqual(new Set(['wf-a', 'wf b']));
  });
});

describe('queryWorkflowTimeRangeIndex', () => {
  it('matches a closed range with gte and lte', async () => {
    await using storage = new MemoryStorage();
    await seedIndex(storage, KEYS.workflowVisibilityCreated(100, 'a'));
    await seedIndex(storage, KEYS.workflowVisibilityCreated(200, 'b'));
    await seedIndex(storage, KEYS.workflowVisibilityCreated(300, 'c'));
    await seedIndex(storage, KEYS.workflowVisibilityCreated(400, 'd'));

    const ids = await queryWorkflowTimeRangeIndex(storage, 'created', { gte: 150, lte: 300 });
    expect(ids).toEqual(new Set(['b', 'c']));
  });

  it('treats gt and lt as exclusive boundaries', async () => {
    await using storage = new MemoryStorage();
    await seedIndex(storage, KEYS.workflowVisibilityUpdated(100, 'a'));
    await seedIndex(storage, KEYS.workflowVisibilityUpdated(200, 'b'));
    await seedIndex(storage, KEYS.workflowVisibilityUpdated(300, 'c'));

    const ids = await queryWorkflowTimeRangeIndex(storage, 'updated', { gt: 100, lt: 300 });
    expect(ids).toEqual(new Set(['b']));
  });

  it('supports the deadline index', async () => {
    await using storage = new MemoryStorage();
    await seedIndex(storage, KEYS.workflowVisibilityDeadline(500, 'wf-1'));
    await seedIndex(storage, KEYS.workflowVisibilityDeadline(900, 'wf-2'));

    expect(await queryWorkflowTimeRangeIndex(storage, 'deadline', { gte: 600 })).toEqual(
      new Set(['wf-2']),
    );
  });
});

describe('queryWorkflowIdPrefixCandidates', () => {
  it('enumerates top-level workflow keys whose id starts with the prefix', async () => {
    await using storage = new MemoryStorage();
    await storage.put(KEYS.workflow('order-1'), EMPTY);
    await storage.put(KEYS.workflow('order-2'), EMPTY);
    await storage.put(KEYS.workflow('payment-1'), EMPTY);
    await storage.put(KEYS.checkpoint('order-1'), EMPTY); // child key must be ignored

    expect(await queryWorkflowIdPrefixCandidates(storage, 'order-')).toEqual(
      new Set(['order-1', 'order-2']),
    );
  });

  it('returns an empty set when nothing matches', async () => {
    await using storage = new MemoryStorage();
    await storage.put(KEYS.workflow('payment-1'), EMPTY);

    expect(await queryWorkflowIdPrefixCandidates(storage, 'order-')).toEqual(new Set());
  });
});

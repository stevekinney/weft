import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { rejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { KEYS } from '../../storage/keys.ts';
import { encode } from '../codec.ts';
import { Engine } from '../engine.ts';
import type { WorkflowState } from '../types.ts';
import { workflow } from '../types.ts';
import { aggregate } from './aggregate.ts';
import { getInternals } from './internals.ts';
import { MAX_LIST_SCAN_ROWS, WorkflowListScanCapExceededError } from './workflow-indexes.ts';

function completedState(workflowId: string, overrides: Partial<WorkflowState> = {}): WorkflowState {
  const now = Date.now();
  return {
    id: workflowId,
    type: 'attribute-grouped',
    status: 'completed',
    input: null,
    versionTuple: { workflowVersion: 'test' },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const attributeWorkflow = workflow({ name: 'attribute-grouped' })
  .searchAttributes({
    count: { type: 'number' },
    flag: { type: 'boolean' },
    tags: { type: 'array' },
    odd: { type: 'string' },
  })
  .execute(async function* () {
    return 'ok';
  });

describe('aggregate attribute dimension keys', () => {
  it('buckets number, boolean, array and date attribute values by their string form', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    engine.register(attributeWorkflow);
    const when = new Date('2026-01-02T03:04:05.000Z');
    const records: Array<[string, Record<string, unknown>]> = [
      ['agg-branch-1', { count: 7, flag: true, tags: ['a', 'b'], odd: when }],
      ['agg-branch-2', { count: 7, flag: false, tags: ['a', 'b'], odd: { nested: 1 } }],
      ['agg-branch-3', { count: 8, flag: false, tags: [], odd: 'plain' }],
    ];
    for (const [workflowId, attributes] of records) {
      await storage.put(KEYS.workflow(workflowId), encode(completedState(workflowId)));
      await storage.put(KEYS.attribute(workflowId), encode(attributes));
    }

    const options = (attribute: string) => ({ groupBy: { attribute } });
    const filter = { idPrefix: 'agg-branch-' };
    const keysFor = async (attribute: string) => {
      const result = await engine.aggregate(filter, options(attribute));
      return result.groups.map((group) => group.key);
    };

    // Groups come back ordered by count, then by key.
    expect(await keysFor('count')).toEqual(['7', '8']);
    expect(await keysFor('flag')).toEqual(['false', 'true']);
    expect(await keysFor('tags')).toEqual(['a,b', '']);
    // A value that is not a search attribute value is dropped when the record is decoded.
    expect(await keysFor('odd')).toEqual([null, '2026-01-02T03:04:05.000Z', 'plain']);
  });
});

describe('aggregate candidate handling', () => {
  it('skips constrained candidates that fail the post-filter', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    engine.register(attributeWorkflow);
    await storage.put(
      KEYS.workflow('agg-filter-1'),
      encode(completedState('agg-filter-1', { status: 'completed' })),
    );
    await storage.put(
      KEYS.workflow('agg-filter-2'),
      encode(completedState('agg-filter-2', { status: 'failed' })),
    );

    const result = await engine.aggregate(
      { idPrefix: 'agg-filter-', status: 'completed' },
      { groupBy: 'status' },
    );

    expect(result.total).toBe(1);
    expect(result.groups).toEqual([{ key: 'completed', count: 1 }]);
  });

  it('flushes a full scan in chunks of the batch size', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    engine.register(attributeWorkflow);
    const writes = [];
    for (let index = 0; index < 130; index += 1) {
      const workflowId = `agg-scan-${String(index).padStart(3, '0')}`;
      writes.push({
        type: 'put' as const,
        key: KEYS.workflow(workflowId),
        value: encode(completedState(workflowId)),
      });
      writes.push({
        type: 'put' as const,
        key: KEYS.attribute(workflowId),
        value: encode({ count: index % 2 }),
      });
    }
    await storage.batch(writes);

    const result = await engine.aggregate(undefined, { groupBy: { attribute: 'count' } });

    expect(result.total).toBe(130);
    expect(result.groups).toEqual([
      { key: '0', count: 65 },
      { key: '1', count: 65 },
    ]);
  });

  it('keeps a missing key and an empty-string key in a stable order', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    engine.register(attributeWorkflow);
    await storage.put(KEYS.workflow('agg-empty-1'), encode(completedState('agg-empty-1')));
    await storage.put(KEYS.attribute('agg-empty-1'), encode(null));
    await storage.put(KEYS.workflow('agg-empty-2'), encode(completedState('agg-empty-2')));
    await storage.put(KEYS.attribute('agg-empty-2'), encode({ odd: '' }));

    const result = await engine.aggregate(
      { idPrefix: 'agg-empty-' },
      { groupBy: { attribute: 'odd' } },
    );

    expect(result.total).toBe(2);
    expect(result.groups.map((group) => group.key)).toEqual([null, '']);
  });

  it('orders equally sized groups by key', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    await storage.put(
      KEYS.workflow('agg-order-1'),
      encode(completedState('agg-order-1', { type: 'zeta' })),
    );
    await storage.put(
      KEYS.workflow('agg-order-2'),
      encode(completedState('agg-order-2', { type: 'alpha' })),
    );
    await storage.put(
      KEYS.workflow('agg-order-3'),
      encode(completedState('agg-order-3', { type: 'alpha' })),
    );
    await storage.put(
      KEYS.workflow('agg-order-4'),
      encode(completedState('agg-order-4', { type: 'beta' })),
    );
    await storage.put(
      KEYS.workflow('agg-order-5'),
      encode(completedState('agg-order-5', { type: 'zeta' })),
    );

    const result = await engine.aggregate(undefined, { groupBy: 'type' });

    expect(result.groups).toEqual([
      { key: 'alpha', count: 2 },
      { key: 'zeta', count: 2 },
      { key: 'beta', count: 1 },
    ]);
  });
});

describe('aggregate scan caps', () => {
  it('rejects a constrained candidate set larger than the scan cap', async () => {
    class OversizedPrefixStorage extends MemoryStorage {
      override async *scan(prefix: string): AsyncIterableIterator<[string, Uint8Array]> {
        if (prefix !== KEYS.workflow('cap-')) return;
        for (let index = 0; index <= MAX_LIST_SCAN_ROWS; index += 1) {
          yield [`${prefix}${String(index)}`, new Uint8Array()];
        }
      }
    }
    await using engine = new Engine({ storage: new OversizedPrefixStorage() });

    const error = await rejectionOf(
      aggregate(getInternals(engine), { idPrefix: 'cap-' }, { groupBy: 'status' }),
    );

    expect(error).toBeInstanceOf(WorkflowListScanCapExceededError);
  });

  it('rejects a full scan larger than the scan cap', async () => {
    const stateBytes = encode(completedState('cap-full'));
    class OversizedScanStorage extends MemoryStorage {
      override async *scan(prefix: string): AsyncIterableIterator<[string, Uint8Array]> {
        if (prefix !== 'wf:') return;
        for (let index = 0; index <= MAX_LIST_SCAN_ROWS; index += 1) {
          yield [`wf:cap-${String(index)}`, stateBytes];
        }
      }
    }
    await using engine = new Engine({ storage: new OversizedScanStorage() });

    const error = await rejectionOf(
      aggregate(getInternals(engine), undefined, { groupBy: 'status' }),
    );

    expect(error).toBeInstanceOf(WorkflowListScanCapExceededError);
  });
});

describe('aggregate inherited attribute names', () => {
  it.each(['constructor', 'toString'])(
    'puts a record without the declared attribute "%s" in the null bucket',
    async (attributeName) => {
      const storage = new MemoryStorage();
      await using engine = new Engine({ storage });
      engine.register(
        workflow({ name: `inherited-${attributeName}` })
          .searchAttributes({ [attributeName]: { type: 'string' }, other: { type: 'string' } })
          .execute(async function* () {
            return 'ok';
          }),
      );
      const workflowId = `agg-inherited-${attributeName}`;
      await storage.put(KEYS.workflow(workflowId), encode(completedState(workflowId)));
      await storage.put(KEYS.attribute(workflowId), encode({ other: 'present' }));

      const result = await engine.aggregate(
        { idPrefix: 'agg-inherited-' },
        { groupBy: { attribute: attributeName } },
      );

      expect(result.total).toBe(1);
      expect(result.groups).toEqual([{ key: null, count: 1 }]);
    },
  );
});

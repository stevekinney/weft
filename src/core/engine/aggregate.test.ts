import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { AggregateDistinctKeyCapExceededError } from '../aggregate-validation.ts';
import { encode } from '../codec.ts';
import { Engine } from '../engine.ts';
import { buildIndexOperations } from '../search-attributes.ts';
import type { WorkflowContext, WorkflowState } from '../types.ts';
import { workflow } from '../types.ts';
import { aggregate as aggregateWorkflows } from './aggregate.ts';
import { getInternals } from './internals.ts';

async function startAndComplete(
  engine: Engine,
  workflowType: string,
  workflowId: string,
): Promise<void> {
  const handle = await engine.start(workflowType, null, { id: workflowId });
  await handle.result();
}

async function writeDistinctTypeWorkflows(storage: MemoryStorage, count: number): Promise<void> {
  const now = Date.now();
  await storage.batch(
    Array.from({ length: count }, (_, index) => {
      const workflowId = `distinct-type-${index}`;
      const state: WorkflowState = {
        id: workflowId,
        type: `distinct-type-${index}`,
        status: 'completed',
        input: null,
        versionTuple: { workflowVersion: 'test' },
        createdAt: now + index,
        updatedAt: now + index,
      };
      return { type: 'put', key: KEYS.workflow(workflowId), value: encode(state) };
    }),
  );
}

class ConcurrentAggregateReadCountingStorage extends MemoryStorage {
  activeAttributeReadCount = 0;
  activeWorkflowReadCount = 0;
  attributeReadCount = 0;
  maxConcurrentAttributeReadCount = 0;
  maxConcurrentWorkflowReadCount = 0;
  workflowReadCount = 0;

  override async get(key: string): Promise<Uint8Array | null> {
    if (key.startsWith('wf:aggregate-batched-')) {
      this.workflowReadCount += 1;
      this.activeWorkflowReadCount += 1;
      this.maxConcurrentWorkflowReadCount = Math.max(
        this.maxConcurrentWorkflowReadCount,
        this.activeWorkflowReadCount,
      );
      try {
        await Promise.resolve();
        return await super.get(key);
      } finally {
        this.activeWorkflowReadCount -= 1;
      }
    }

    if (key.startsWith('attr:aggregate-batched-')) {
      this.attributeReadCount += 1;
      this.activeAttributeReadCount += 1;
      this.maxConcurrentAttributeReadCount = Math.max(
        this.maxConcurrentAttributeReadCount,
        this.activeAttributeReadCount,
      );
      try {
        await Promise.resolve();
        return await super.get(key);
      } finally {
        this.activeAttributeReadCount -= 1;
      }
    }

    return super.get(key);
  }
}

async function writeAttributeGroupedWorkflows(
  storage: MemoryStorage,
  count: number,
): Promise<void> {
  const now = Date.now();
  await storage.batch(
    Array.from({ length: count }).flatMap((_, index) => {
      const workflowId = `aggregate-batched-${index}`;
      const state: WorkflowState = {
        id: workflowId,
        type: 'attribute-grouped',
        status: 'completed',
        input: null,
        versionTuple: { workflowVersion: 'test' },
        createdAt: now + index,
        updatedAt: now + index,
      };
      const segment = index % 2 === 0 ? 'even' : 'odd';
      return [
        { type: 'put' as const, key: KEYS.workflow(workflowId), value: encode(state) },
        { type: 'put' as const, key: KEYS.attribute(workflowId), value: encode({ segment }) },
        ...buildIndexOperations(workflowId, {}, { segment }),
      ];
    }),
  );
}

describe('engine.aggregate', () => {
  it('groups by status and counts each bucket', async () => {
    const engine = new Engine();
    const doneWorkflow = workflow({ name: 'done' }).execute(async function* () {
      return 'ok';
    });
    engine.register(doneWorkflow);
    const hangWorkflow = workflow({ name: 'hang' }).execute(async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('go');
      return 'ok';
    });
    engine.register(hangWorkflow);

    await startAndComplete(engine, 'done', 'd-1');
    await startAndComplete(engine, 'done', 'd-2');
    await engine.start('hang', null, { id: 'h-1' });
    await engine.start('hang', null, { id: 'h-2' });
    await engine.start('hang', null, { id: 'h-3' });

    const result = await engine.aggregate(undefined, { groupBy: 'status' });
    expect(result.total).toBe(5);
    expect(result.truncated).toBe(false);

    const counts = Object.fromEntries(result.groups.map((group) => [group.key, group.count]));
    expect(counts.completed).toBe(2);
    expect(counts.running).toBe(3);

    engine[Symbol.dispose]();
  });

  it('groups by type', async () => {
    const engine = new Engine();
    const alphaWorkflow = workflow({ name: 'alpha' }).execute(async function* () {
      return 'ok';
    });
    engine.register(alphaWorkflow);
    const betaWorkflow = workflow({ name: 'beta' }).execute(async function* () {
      return 'ok';
    });
    engine.register(betaWorkflow);

    await startAndComplete(engine, 'alpha', 'a-1');
    await startAndComplete(engine, 'alpha', 'a-2');
    await startAndComplete(engine, 'beta', 'b-1');

    const result = await engine.aggregate(undefined, { groupBy: 'type' });
    expect(result.total).toBe(3);
    expect(result.groups[0]).toEqual({ key: 'alpha', count: 2 });
    expect(result.groups[1]).toEqual({ key: 'beta', count: 1 });

    engine[Symbol.dispose]();
  });

  it('sorts groups by count desc with key asc as tiebreaker', async () => {
    const engine = new Engine();
    const alphaWorkflow2 = workflow({ name: 'alpha' }).execute(async function* () {
      return 'ok';
    });
    engine.register(alphaWorkflow2);
    const betaWorkflow2 = workflow({ name: 'beta' }).execute(async function* () {
      return 'ok';
    });
    engine.register(betaWorkflow2);
    const gammaWorkflow = workflow({ name: 'gamma' }).execute(async function* () {
      return 'ok';
    });
    engine.register(gammaWorkflow);

    await startAndComplete(engine, 'gamma', 'g-1');
    await startAndComplete(engine, 'alpha', 'a-1');
    await startAndComplete(engine, 'beta', 'b-1');

    const result = await engine.aggregate(undefined, { groupBy: 'type' });
    expect(result.groups.map((group) => group.key)).toEqual(['alpha', 'beta', 'gamma']);
    engine[Symbol.dispose]();
  });

  it('applies the filter before aggregating', async () => {
    const engine = new Engine();
    const doneWorkflow2 = workflow({ name: 'done' }).execute(async function* () {
      return 'ok';
    });
    engine.register(doneWorkflow2);
    const doneOtherWorkflow = workflow({ name: 'done-other' }).execute(async function* () {
      return 'ok';
    });
    engine.register(doneOtherWorkflow);

    await startAndComplete(engine, 'done', 'd-1');
    await startAndComplete(engine, 'done', 'd-2');
    await startAndComplete(engine, 'done-other', 'o-1');

    const result = await engine.aggregate({ type: 'done' }, { groupBy: 'status' });
    expect(result.total).toBe(2);
    expect(result.groups).toEqual([{ key: 'completed', count: 2 }]);
    engine[Symbol.dispose]();
  });

  it('groups failureCategory from workflow state, not stale search attributes', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const failsWorkflow = workflow({ name: 'fails' }).execute(async function* () {
      throw new Error('boom');
    });
    engine.register(failsWorkflow);

    const handle = await engine.start('fails', null, { id: 'failed-1' });
    await expect(handle.result()).rejects.toThrow('boom');
    await storage.delete(KEYS.attribute('failed-1'));

    const result = await engine.aggregate(
      { status: 'failed', failureCategory: 'application' },
      { groupBy: 'failureCategory' },
    );
    expect(result.total).toBe(1);
    expect(result.groups).toEqual([{ key: 'application', count: 1 }]);
    engine[Symbol.dispose]();
  });

  it('marks truncated when there are more groups than the requested limit', async () => {
    const engine = new Engine();
    for (const typeName of ['t-a', 't-b', 't-c', 't-d']) {
      engine.register(
        workflow({ name: typeName }).execute(async function* () {
          return 'ok';
        }),
      );
      await startAndComplete(engine, typeName, `${typeName}-1`);
    }

    const result = await engine.aggregate(undefined, { groupBy: 'type', limit: 2 });
    expect(result.groups).toHaveLength(2);
    expect(result.truncated).toBe(true);
    engine[Symbol.dispose]();
  });

  it('returns an empty result when no workflows match', async () => {
    const engine = new Engine();
    const anyWorkflow = workflow({ name: 'any' }).execute(async function* () {
      return 'ok';
    });
    engine.register(anyWorkflow);

    const result = await engine.aggregate({ type: 'nope' }, { groupBy: 'status' });
    expect(result.total).toBe(0);
    expect(result.groups).toEqual([]);
    expect(result.truncated).toBe(false);
    engine[Symbol.dispose]();
  });

  it('throws when groupBy.attribute is not declared in any registered schema', async () => {
    const engine = new Engine();
    const typedWorkflow = workflow({ name: 'typed' })
      .searchAttributes({ knownAttribute: { type: 'string' } })
      .execute(async function* () {
        return 'ok';
      });
    engine.register(typedWorkflow);
    await startAndComplete(engine, 'typed', 'wf-1');

    await expect(
      engine.aggregate(undefined, { groupBy: { attribute: 'unknownAttribute' } }),
    ).rejects.toThrow(/Unknown search attribute/);
    engine[Symbol.dispose]();
  });

  it('groups corrupted attribute records under null instead of throwing', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const typedWorkflow = workflow({ name: 'corrupt-attribute-grouped' })
      .searchAttributes({ segment: { type: 'string' } })
      .execute(async function* () {
        return 'ok';
      });
    engine.register(typedWorkflow);

    await startAndComplete(engine, 'corrupt-attribute-grouped', 'corrupt-aggregate-1');
    await storage.put(KEYS.attribute('corrupt-aggregate-1'), encode(null));

    const result = await engine.aggregate(
      { idPrefix: 'corrupt-aggregate' },
      { groupBy: { attribute: 'segment' } },
    );

    expect(result.total).toBe(1);
    expect(result.groups).toEqual([{ key: null, count: 1 }]);
    engine[Symbol.dispose]();
  });

  it('throws when an aggregate would materialize too many distinct group keys', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    await writeDistinctTypeWorkflows(storage, 4);

    try {
      await aggregateWorkflows(
        getInternals(engine),
        undefined,
        { groupBy: 'type' },
        {
          distinctKeyCap: 3,
        },
      );
      throw new Error('Expected aggregate to reject after exceeding the distinct-key cap');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateDistinctKeyCapExceededError);
      if (error instanceof AggregateDistinctKeyCapExceededError) {
        expect(error.cap).toBe(3);
      }
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('allows aggregates exactly at the distinct-key cap', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    await writeDistinctTypeWorkflows(storage, 3);

    const result = await aggregateWorkflows(
      getInternals(engine),
      undefined,
      { groupBy: 'type' },
      {
        distinctKeyCap: 3,
      },
    );

    expect(result.total).toBe(3);
    expect(result.groups).toHaveLength(3);
    expect(result.truncated).toBe(false);
    engine[Symbol.dispose]();
  });

  it('batches constrained state reads and attribute groupBy reads across chunk boundaries', async () => {
    const storage = new ConcurrentAggregateReadCountingStorage();
    const engine = new Engine({ storage });
    const typedWorkflow = workflow({ name: 'attribute-grouped' })
      .searchAttributes({ segment: { type: 'string' } })
      .execute(async function* () {
        return 'ok';
      });
    engine.register(typedWorkflow);
    await writeAttributeGroupedWorkflows(storage, 130);

    const result = await engine.aggregate(
      { idPrefix: 'aggregate-batched-' },
      { groupBy: { attribute: 'segment' } },
    );

    expect(result.total).toBe(130);
    expect(result.groups).toEqual([
      { key: 'even', count: 65 },
      { key: 'odd', count: 65 },
    ]);
    expect(storage.workflowReadCount).toBe(130);
    expect(storage.attributeReadCount).toBe(130);
    expect(storage.maxConcurrentWorkflowReadCount).toBeGreaterThan(1);
    expect(storage.maxConcurrentWorkflowReadCount).toBeLessThanOrEqual(64);
    expect(storage.maxConcurrentAttributeReadCount).toBeGreaterThan(1);
    expect(storage.maxConcurrentAttributeReadCount).toBeLessThanOrEqual(64);
    engine[Symbol.dispose]();
  });

  it('reuses attribute records already read for attribute-filtered grouping', async () => {
    const storage = new ConcurrentAggregateReadCountingStorage();
    const engine = new Engine({ storage });
    const typedWorkflow = workflow({ name: 'attribute-grouped' })
      .searchAttributes({ segment: { type: 'string' } })
      .execute(async function* () {
        return 'ok';
      });
    engine.register(typedWorkflow);
    await writeAttributeGroupedWorkflows(storage, 130);

    const result = await engine.aggregate(
      {
        idPrefix: 'aggregate-batched-',
        attributes: [{ key: 'segment', value: 'even' }],
      },
      { groupBy: { attribute: 'segment' } },
    );

    expect(result.total).toBe(65);
    expect(result.groups).toEqual([{ key: 'even', count: 65 }]);
    expect(storage.workflowReadCount).toBe(65);
    expect(storage.attributeReadCount).toBe(65);
    engine[Symbol.dispose]();
  });

  it('AggregateDistinctKeyCapExceededError carries the cap', () => {
    const error = new AggregateDistinctKeyCapExceededError(42);
    expect(error.cap).toBe(42);
    expect(error.message).toContain('42');
  });
});

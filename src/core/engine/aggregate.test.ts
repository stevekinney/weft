import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { AggregateDistinctKeyCapExceededError } from '../aggregate-validation.ts';
import { Engine } from '../engine.ts';
import type { WorkflowContext } from '../types.ts';

async function startAndComplete(
  engine: Engine,
  workflowType: string,
  workflowId: string,
): Promise<void> {
  const handle = await engine.start(workflowType, null, { id: workflowId });
  await handle.result();
}

describe('engine.aggregate', () => {
  it('groups by status and counts each bucket', async () => {
    const engine = new Engine();
    engine.register('done', async function* () {
      return 'ok';
    });
    engine.register('hang', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('go');
      return 'ok';
    });

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
    engine.register('alpha', async function* () {
      return 'ok';
    });
    engine.register('beta', async function* () {
      return 'ok';
    });

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
    engine.register('alpha', async function* () {
      return 'ok';
    });
    engine.register('beta', async function* () {
      return 'ok';
    });
    engine.register('gamma', async function* () {
      return 'ok';
    });

    await startAndComplete(engine, 'gamma', 'g-1');
    await startAndComplete(engine, 'alpha', 'a-1');
    await startAndComplete(engine, 'beta', 'b-1');

    const result = await engine.aggregate(undefined, { groupBy: 'type' });
    expect(result.groups.map((group) => group.key)).toEqual(['alpha', 'beta', 'gamma']);
    engine[Symbol.dispose]();
  });

  it('applies the filter before aggregating', async () => {
    const engine = new Engine();
    engine.register('done', async function* () {
      return 'ok';
    });
    engine.register('done-other', async function* () {
      return 'ok';
    });

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
    engine.register('fails', async function* () {
      throw new Error('boom');
    });

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
      engine.register(typeName, async function* () {
        return 'ok';
      });
      await startAndComplete(engine, typeName, `${typeName}-1`);
    }

    const result = await engine.aggregate(undefined, { groupBy: 'type', limit: 2 });
    expect(result.groups).toHaveLength(2);
    expect(result.truncated).toBe(true);
    engine[Symbol.dispose]();
  });

  it('returns an empty result when no workflows match', async () => {
    const engine = new Engine();
    engine.register('any', async function* () {
      return 'ok';
    });

    const result = await engine.aggregate({ type: 'nope' }, { groupBy: 'status' });
    expect(result.total).toBe(0);
    expect(result.groups).toEqual([]);
    expect(result.truncated).toBe(false);
    engine[Symbol.dispose]();
  });

  it('throws when groupBy.attribute is not declared in any registered schema', async () => {
    const engine = new Engine();
    engine.register('typed', {
      handler: async function* () {
        return 'ok';
      },
      searchAttributes: { knownAttribute: { type: 'string' } },
    });
    await startAndComplete(engine, 'typed', 'wf-1');

    await expect(
      engine.aggregate(undefined, { groupBy: { attribute: 'unknownAttribute' } }),
    ).rejects.toThrow(/Unknown search attribute/);
    engine[Symbol.dispose]();
  });

  it('AggregateDistinctKeyCapExceededError carries the cap', () => {
    const error = new AggregateDistinctKeyCapExceededError(42);
    expect(error.cap).toBe(42);
    expect(error.message).toContain('42');
  });
});

/**
 * A remote-mode activity's timeline entry names the task ledger record it was enqueued under
 * (`WorkflowTimelineEntry.taskOperationId`), set by the engine where it dispatches. A client reads
 * the ledger by that value and never rebuilds Weft's internal key from the entry's step: the
 * ledger key follows the activity's own counter, one below the timeline step.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { waitForCondition } from "../../../test-support/embedded/testing/src/fake-timers.ts";
import { decodeRemoteTaskRecord } from '../task-ledger/task-ledger.ts';
import type { WorkflowContext } from '../types.ts';
import { activity, workflow } from '../types.ts';
import { Engine } from './index.ts';

let engine: Engine | undefined;
afterEach(() => {
  engine?.[Symbol.dispose]();
  engine = undefined;
});

async function queuedOperationIds(target: Engine): Promise<string[]> {
  const ids: string[] = [];
  for await (const [, value] of target.storage.scan('task-ledger:')) {
    const record = decodeRemoteTaskRecord(value);
    if (record !== null && record.state === 'queued') ids.push(record.operationId);
  }
  return ids;
}

async function completeEveryQueued(target: Engine, expected: number): Promise<void> {
  const completed: string[] = [];
  while (completed.length < expected) {
    await waitForCondition(
      async () => {
        const queued = await queuedOperationIds(target);
        return queued.some((id) => !completed.includes(id));
      },
      { intervalMs: 10, label: 'a queued remote task' },
    );
    for (const id of await queuedOperationIds(target)) {
      if (completed.includes(id)) continue;
      completed.push(id);
      await target.completeAsyncActivity(id, `done:${id}`);
    }
  }
}

async function ledgerActivityName(
  target: Engine,
  operationId: string,
): Promise<string | undefined> {
  for await (const [, value] of target.storage.scan('task-ledger:')) {
    const record = decodeRemoteTaskRecord(value);
    if (record?.operationId === operationId) return record.activityName;
  }
  return undefined;
}

const first = activity({ name: 'first', execute: async (_input: null) => 'local-first' });
const second = activity({ name: 'second', execute: async (_input: null) => 'local-second' });

describe('timeline entry taskOperationId', () => {
  it('names each of two sequential remote ctx.run() activities’ own ledger record', async () => {
    engine = new Engine({ activityExecution: { mode: 'remote' } });
    engine.register(
      workflow({ name: 'sequential-remote' })
        .activities({ first, second })
        .execute(async function* (context: WorkflowContext) {
          const a = yield* context.run(first, null);
          const b = yield* context.run(second, null);
          return [a, b];
        }),
    );
    const handle = await engine.start('sequential-remote', null, { id: 'sequential-remote-1' });
    await completeEveryQueued(engine, 2);
    await handle.result();

    const timeline = await engine.getTimeline('sequential-remote-1');
    const entries = timeline.filter((entry) => entry.operationType === 'activity');
    expect(entries.map((entry) => entry.operationLabel)).toEqual(['first', 'second']);
    const identities = entries.map((entry) => entry.taskOperationId);
    expect(new Set(identities).size).toBe(2);
    for (const entry of entries) {
      expect(entry.taskOperationId).toBeDefined();
      // Each identity resolves to the record for that very activity, not its neighbour's.
      expect(await ledgerActivityName(engine, entry.taskOperationId ?? '')).toBe(
        `sequential-remote.${entry.operationLabel}`,
      );
    }
  });

  it('gives each engine retry its own entry, naming the record of that dispatch', async () => {
    const flaky = activity({
      name: 'flaky',
      retry: { maxAttempts: 2, initialBackoff: 0, backoffMultiplier: 1, maxBackoff: 0 },
      execute: async (_input: null) => 'local',
    });
    engine = new Engine({ activityExecution: { mode: 'remote' } });
    engine.register(
      workflow({ name: 'retrying-remote' })
        .activities({ flaky })
        .execute(async function* (context: WorkflowContext) {
          return yield* context.run(flaky, null);
        }),
    );
    const handle = await engine.start('retrying-remote', null, { id: 'retrying-remote-1' });
    await waitForCondition(
      async () => {
        const queued = await queuedOperationIds(engine!);
        return queued.length > 0;
      },
      { intervalMs: 10, label: 'the first dispatch' },
    );
    const [firstDispatch] = await queuedOperationIds(engine);
    await engine.failAsyncActivity(firstDispatch ?? '', new Error('first dispatch failed'));
    // The retry enqueues a second record; the failed first one stays in the ledger.
    await waitForCondition(
      async () => {
        const queued = await queuedOperationIds(engine!);
        return queued.some((id) => id !== firstDispatch);
      },
      { intervalMs: 10, label: 'the retry dispatch' },
    );
    const afterRetry = await queuedOperationIds(engine);
    const retried = afterRetry.find((id) => id !== firstDispatch);
    await engine.completeAsyncActivity(retried ?? '', 'recovered');
    await handle.result();

    const timeline = await engine.getTimeline('retrying-remote-1');
    const entries = timeline.filter((entry) => entry.operationType === 'activity');
    expect(entries).toHaveLength(2);
    const [failed, succeeded] = entries;
    expect(failed?.status).toBe('failed');
    expect(succeeded?.status).toBe('completed');
    // One entry per dispatch, each naming its own record, never the other's.
    expect(failed?.taskOperationId).toBe(firstDispatch);
    expect(succeeded?.taskOperationId).toBe(retried);
    expect(succeeded?.taskOperationId).not.toBe(failed?.taskOperationId);
  });

  it('never sets it on a coordinator entry, whatever its branches enqueue', async () => {
    engine = new Engine({ activityExecution: { mode: 'remote' } });
    engine.register(
      workflow({ name: 'coordinated-remote' })
        .activities({ first, second })
        .execute(async function* (context: WorkflowContext) {
          return yield* context.all([context.run(first, null), context.run(second, null)]);
        }),
    );
    await engine.start('coordinated-remote', null, { id: 'coordinated-remote-1' });
    // Remote dispatch does not run a coordinator's branches: the run fails, leaving the
    // coordinator's entry with the branches' deferrals but no task of its own.
    await waitForCondition(
      async () => {
        const state = await engine?.get('coordinated-remote-1');
        return state?.status === 'failed';
      },
      { intervalMs: 10, label: 'the coordinated run to fail' },
    );

    const timeline = await engine.getTimeline('coordinated-remote-1');
    const coordinators = timeline.filter((entry) => entry.operationType !== 'activity');
    expect(coordinators.length).toBeGreaterThan(0);
    for (const entry of coordinators) expect(entry).not.toHaveProperty('taskOperationId');
  });

  it('is absent on entries that did not go through the task ledger', async () => {
    engine = new Engine();
    engine.register(
      workflow({ name: 'inline-only' })
        .activities({ first, second })
        .execute(async function* (context: WorkflowContext) {
          const a = yield* context.run(first, null);
          const b = yield* context.run(second, null);
          return [a, b];
        }),
    );
    const handle = await engine.start('inline-only', null, { id: 'inline-only-1' });
    await handle.result();

    const entries = await engine.getTimeline('inline-only-1');
    expect(entries.map((entry) => entry.operationLabel)).toEqual(['first', 'second']);
    for (const entry of entries) expect(entry).not.toHaveProperty('taskOperationId');
  });
});

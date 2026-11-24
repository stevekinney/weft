/**
 * COR-1720: an inline activity run as a `ctx.all` / `ctx.race` branch reports
 * `activity:started` when it is invoked and `activity:completed` once the
 * coordinator's result commits, only for the branches that result carries.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { ActivityCompletedEvent, ActivityStartedEvent } from '../events.ts';
import type { WorkflowContext } from '../types.ts';
import { activity, workflow } from '../types.ts';
import { Engine } from './index.ts';

let engine: Engine | undefined;
afterEach(() => {
  engine?.[Symbol.dispose]();
  engine = undefined;
});

function recordLifecycle(target: Engine) {
  const started: ActivityStartedEvent[] = [];
  const completed: ActivityCompletedEvent[] = [];
  target.addEventListener(ActivityStartedEvent.type, (event) => {
    started.push(event);
  });
  target.addEventListener(ActivityCompletedEvent.type, (event) => {
    completed.push(event);
  });
  return { started, completed };
}

describe('branch activity lifecycle evidence', () => {
  it('reports every ctx.all branch once it starts and once the all commits', async () => {
    engine = new Engine();
    const first = activity({ name: 'first', execute: async (_input: null) => 'one' });
    const second = activity({ name: 'second', execute: async (_input: null) => 'two' });
    engine.register(
      workflow({ name: 'all-lifecycle' })
        .activities({ first, second })
        .execute(async function* (context: WorkflowContext) {
          return yield* context.all([context.run(first, null), context.run(second, null)]);
        }),
    );
    const { started, completed } = recordLifecycle(engine);

    const handle = await engine.start('all-lifecycle', null, { id: 'all-lifecycle-1' });

    expect(await handle.result()).toEqual(['one', 'two']);
    expect(started.map((event) => event.activityName).toSorted()).toEqual(['first', 'second']);
    expect(completed.map((event) => event.operationId).toSorted()).toEqual(
      started.map((event) => event.operationId).toSorted(),
    );
    expect(completed.every((event) => event.workflowId === 'all-lifecycle-1')).toBe(true);
  });

  it('reports only the ctx.race winner as completed, even when the loser later succeeds', async () => {
    engine = new Engine();
    const loserGate = Promise.withResolvers<void>();
    const loserSettled = Promise.withResolvers<void>();
    const winner = activity({ name: 'winner', execute: async (_input: null) => 'won' });
    const loser = activity({
      name: 'loser',
      execute: async (_input: null) => {
        await loserGate.promise;
        loserSettled.resolve();
        return 'late';
      },
    });
    engine.register(
      workflow({ name: 'race-lifecycle' })
        .activities({ winner, loser })
        .execute(async function* (context: WorkflowContext) {
          return yield* context.race([context.run(loser, null), context.run(winner, null)]);
        }),
    );
    const { started, completed } = recordLifecycle(engine);

    const handle = await engine.start('race-lifecycle', null, { id: 'race-lifecycle-1' });
    expect(await handle.result()).toBe('won');
    loserGate.resolve();
    await loserSettled.promise;

    expect(started.map((event) => event.activityName).toSorted()).toEqual(['loser', 'winner']);
    expect(completed.map((event) => event.activityName)).toEqual(['winner']);
    expect(completed[0]?.operationId).toBe(
      started.find((event) => event.activityName === 'winner')?.operationId,
    );
  });
});

/**
 * COR-1604: a memo helper activity's retry sleep is woken by its durable timer.
 *
 * The retry sleep scheduled its timer without the run's execution token but bound
 * its resolver to that token, so the timer could never match the resolver: the
 * fire was collected as another generation's, and a retry with a real backoff
 * never ran. Time is driven by hand through the scheduler, never by sleeping.
 */
import { expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { durableActivity } from '../context/durable-activity.ts';
import { activity, workflow, type WorkflowContext } from '../types.ts';
import { ENGINE_WAIT_FOR_SLEEP_RESOLVER_FOR_TESTING, Engine } from './index.ts';

it('runs the next attempt of a memo helper activity when its retry timer fires', async () => {
  let now = 1_000;
  let attempts = 0;
  const flakyTool = activity({
    name: 'flakyTool',
    retry: { maxAttempts: 2, initialBackoff: 5_000, backoffMultiplier: 1, maxBackoff: 5_000 },
    execute: async (tool: string) => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient helper failure');
      return { attempts, tool };
    },
    verify: (_result, context) =>
      context?.phase === 'pre-dispatch-reconciliation' ? 'not-completed' : true,
  });
  const definition = workflow({ name: 'cor-1604-memo-retry-timer' })
    .activities({ flakyTool })
    .execute(async function* (ctx: WorkflowContext) {
      return yield* ctx.memo('step-0', async () =>
        durableActivity(flakyTool, 'lookup', { idempotencyKey: 'retry:lookup' }),
      );
    });

  await using engine = new Engine({
    storage: new MemoryStorage(),
    getNow: () => now,
    backgroundTasks: 'manual',
  });
  engine.register(definition);
  const handle = await engine.start(definition.name, null, { id: 'memo-retry-timer' });
  await engine[ENGINE_WAIT_FOR_SLEEP_RESOLVER_FOR_TESTING]('memo-retry-timer');
  expect(attempts).toBe(1);

  now += 5_000;
  await engine.scheduler.tick(now);

  expect(await handle.result()).toEqual({ attempts: 2, tool: 'lookup' });
});

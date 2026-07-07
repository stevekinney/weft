import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { nextAsyncPendingToken } from '../../testing/async-activity.test-support.ts';
import { withTimeout } from '../../testing/fake-timers.test-support.ts';
import { Engine } from '../engine.ts';
import type { ActivityContext, WorkflowContext } from '../types.ts';
import { activity, workflow } from '../types.ts';
import { recoverPendingAsyncActivities } from './async-activity-records.ts';
import { getInternals } from './internals.ts';

const awaitCallback = activity({
  name: 'awaitCallback',
  execute: (_input: void, context?: ActivityContext): unknown => context!.completeAsync(),
});

describe('async activity completion recovery buffering', () => {
  it('buffers a completion delivered after token recovery but before generator adoption', async () => {
    await using storage = new MemoryStorage();

    const orderWorkflow = workflow({ name: 'early-complete-order' })
      .activities({ awaitCallback })
      .execute(async function* (ctx: WorkflowContext) {
        const approval = yield* ctx.run(awaitCallback);
        return { approval };
      });

    let workflowId: string;
    let token: string;
    {
      const firstEngine = new Engine({ storage });
      firstEngine.register(orderWorkflow);
      const tokenPromise = nextAsyncPendingToken(firstEngine);
      const handle = await firstEngine.start('early-complete-order', null);
      workflowId = handle.id;
      token = await tokenPromise;
      firstEngine[Symbol.dispose]();
    }

    const recoveredEngine = new Engine({ storage });
    recoveredEngine.register(orderWorkflow);
    await recoverPendingAsyncActivities(getInternals(recoveredEngine));
    await recoveredEngine.completeAsyncActivity(token, { decision: 'arrived-before-adoption' });

    await recoveredEngine.recoverAll();
    const handle = recoveredEngine.getHandle(workflowId);
    await expect(withTimeout(handle.result(), 500, 'early async completion')).resolves.toEqual({
      approval: { decision: 'arrived-before-adoption' },
    });

    recoveredEngine[Symbol.dispose]();
  });

  it('buffers a failure delivered after token recovery but before generator adoption', async () => {
    await using storage = new MemoryStorage();

    const orderWorkflow = workflow({ name: 'early-fail-order' })
      .activities({ awaitCallback })
      .execute(async function* (ctx: WorkflowContext) {
        try {
          yield* ctx.run(awaitCallback);
          return 'should-not-reach';
        } catch (error) {
          return `caught:${(error as Error).message}`;
        }
      });

    let workflowId: string;
    let token: string;
    {
      const firstEngine = new Engine({ storage });
      firstEngine.register(orderWorkflow);
      const tokenPromise = nextAsyncPendingToken(firstEngine);
      const handle = await firstEngine.start('early-fail-order', null);
      workflowId = handle.id;
      token = await tokenPromise;
      firstEngine[Symbol.dispose]();
    }

    const recoveredEngine = new Engine({ storage });
    recoveredEngine.register(orderWorkflow);
    await recoverPendingAsyncActivities(getInternals(recoveredEngine));
    await recoveredEngine.failAsyncActivity(token, new Error('arrived-before-adoption'));

    await recoveredEngine.recoverAll();
    const handle = recoveredEngine.getHandle(workflowId);
    await expect(withTimeout(handle.result(), 500, 'early async failure')).resolves.toBe(
      'caught:arrived-before-adoption',
    );

    recoveredEngine[Symbol.dispose]();
  });
});

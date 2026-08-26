import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { nextAsyncPendingToken } from '../../testing/async-activity.test-support.ts';
import { withTimeout } from '../../testing/fake-timers.test-support.ts';
import { encode } from '../codec.ts';
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

  it('ignores malformed persisted resolution outcomes while recovering records', async () => {
    await using storage = new MemoryStorage();
    await storage.put(
      KEYS.asyncActivityResolution('workflow-1', 'token-1'),
      encode({
        version: 1,
        kind: 'resolution',
        token: 'token-1',
        workflowId: 'workflow-1',
        outcome: { status: 'cancelled', error: 'not-a-real-outcome' },
      }),
    );

    const engine = new Engine({ storage });
    await recoverPendingAsyncActivities(getInternals(engine));

    expect(getInternals(engine).pendingAsyncActivityResolutions?.size ?? 0).toBe(0);

    engine[Symbol.dispose]();
  });
  it('reloads only the requested workflow when scoped to a single id', async () => {
    // ADR 0002 reclaim-driven resume calls this with a workflowId so a takeover
    // pays for one workflow instead of a store-wide sweep. An unbounded scan
    // would still "work" for the reclaimed run, so the load-bearing assertion
    // is that the OTHER workflow's token is NOT pulled into memory.
    await using storage = new MemoryStorage();

    const scopedWorkflow = workflow({ name: 'scoped-recovery-order' })
      .activities({ awaitCallback })
      .execute(async function* (ctx: WorkflowContext) {
        const approval = yield* ctx.run(awaitCallback);
        return { approval };
      });

    let reclaimedWorkflowId: string;
    let reclaimedToken: string;
    let siblingToken: string;
    {
      const firstEngine = new Engine({ storage });
      firstEngine.register(scopedWorkflow);

      const reclaimedTokenPromise = nextAsyncPendingToken(firstEngine);
      const reclaimedHandle = await firstEngine.start('scoped-recovery-order', null);
      reclaimedWorkflowId = reclaimedHandle.id;
      reclaimedToken = await reclaimedTokenPromise;

      const siblingTokenPromise = nextAsyncPendingToken(firstEngine);
      await firstEngine.start('scoped-recovery-order', null);
      siblingToken = await siblingTokenPromise;

      firstEngine[Symbol.dispose]();
    }

    expect(reclaimedToken).not.toBe(siblingToken);

    const recoveredEngine = new Engine({ storage });
    recoveredEngine.register(scopedWorkflow);
    await recoverPendingAsyncActivities(getInternals(recoveredEngine), reclaimedWorkflowId);

    const pending = getInternals(recoveredEngine).pendingAsyncActivities;
    expect(pending.has(reclaimedToken)).toBe(true);
    expect(pending.has(siblingToken)).toBe(false);

    recoveredEngine[Symbol.dispose]();
  });
});

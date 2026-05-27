import { describe, expect, it } from 'bun:test';
import { sleepForTesting } from '../testing/fake-timers.test-support.ts';

import { Engine } from './engine.ts';
import type { WorkflowContext } from './types.ts';
import { workflow } from './types/workflow-function.ts';

// ---------------------------------------------------------------------------
// ctx.suspendUntil() resumes via signal delivery
// ---------------------------------------------------------------------------

describe('ctx.suspendUntil', () => {
  it('pauses a workflow and resumes when a matching signal arrives', async () => {
    const engine = new Engine();
    const token = 'resume-token-abc';

    const awaitWebhook = workflow({ name: 'await-webhook' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const payload = yield* ctx.suspendUntil<{ status: string }>(token);
      return payload.status;
    });
    engine.register(awaitWebhook);

    const handle = await engine.start('await-webhook', null);

    // Attach the rejection/resolution handler synchronously so the await
    // below never sees an unhandled promise if the engine settles early.
    const resultPromise = handle.result();

    // Let the workflow reach the yield.
    await sleepForTesting(10);

    // Deliver the resume "signal" with the payload.
    await engine.signal(handle.id, token, { status: 'ready' });

    const result = await resultPromise;
    expect(result).toBe('ready');
  });

  it('multiple suspensions in the same workflow use distinct tokens', async () => {
    const engine = new Engine();

    const multiSuspend = workflow({ name: 'multi-suspend' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const context = ctx;
      const first = yield* context.suspendUntil<{ value: number }>('token-one');
      const second = yield* context.suspendUntil<{ value: number }>('token-two');
      return first.value + second.value;
    });
    engine.register(multiSuspend);

    const handle = await engine.start('multi-suspend', null);
    const resultPromise = handle.result();

    await sleepForTesting(10);
    await engine.signal(handle.id, 'token-one', { value: 3 });
    await sleepForTesting(10);
    await engine.signal(handle.id, 'token-two', { value: 4 });

    const result = await resultPromise;
    expect(result).toBe(7);
  });
});

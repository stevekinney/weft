/**
 * #453: cooperative activity cancellation — the TRUE behavior.
 *
 * Weft activity cancellation is cooperative AND fires only on WORKFLOW
 * cancellation. `ActivityContext.signal` is derived from the per-workflow
 * AbortController, which `engine.cancel()` aborts. A `ctx.race()` branch LOSS
 * does NOT abort the losing activity's signal — the race is a result-selection
 * primitive, not a cancellation primitive: it stops awaiting the loser but lets
 * it run to completion. These tests pin both directions so the docs (and users
 * migrating from Temporal's CancellationScope) describe what actually happens.
 */
import { describe, expect, it } from 'bun:test';

import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import type { ActivityContext, WorkflowContext } from '../types.ts';
import { activity, workflow } from '../types.ts';
import { Engine } from './index.ts';

describe('#453 cooperative activity cancellation', () => {
  it('does NOT abort a losing activity signal when a ctx.race branch wins', async () => {
    await using engine = new Engine();
    let losingActivityStarted = false;
    let losingSignalAborted = false;
    let losingActivityCompleted = false;
    let releaseLoser: () => void = () => {};

    const slowLoser = activity({
      name: 'slow-loser',
      execute: async (_input: unknown, ctx?: ActivityContext) => {
        losingActivityStarted = true;
        ctx?.signal.addEventListener('abort', () => {
          losingSignalAborted = true;
        });
        await new Promise<void>((resolve) => {
          releaseLoser = resolve;
        });
        losingActivityCompleted = true;
        return 'loser-done';
      },
    });

    engine.register(
      workflow({ name: 'race-loss' })
        .activities({ 'slow-loser': slowLoser })
        .execute(async function* (ctx: WorkflowContext) {
          // The signal branch wins; the activity branch loses.
          return yield* ctx.race([ctx.run('slow-loser'), ctx.waitForSignal<string>('go')]);
        }),
    );

    const handle = await engine.start('race-loss', null, { id: 'race-loss-1' });
    await waitForCondition(() => losingActivityStarted, {
      timeoutMs: 2000,
      label: 'losing activity started',
    });
    await engine.signal('race-loss-1', 'go', 'signal-wins');

    const winner = await handle.result();
    expect(winner).toBe('signal-wins');
    // The race settled — but the losing activity's signal was NOT aborted.
    expect(losingSignalAborted).toBe(false);
    // The loser is still running (we never released it); it was abandoned, not
    // cancelled. Release it so it does not leak.
    expect(losingActivityCompleted).toBe(false);
    releaseLoser();
  });

  it('DOES abort the activity signal when the workflow is cancelled', async () => {
    await using engine = new Engine();
    let activityStarted = false;
    let signalAborted = false;
    let observedThrow = false;

    const longActivity = activity({
      name: 'long',
      execute: async (_input: unknown, ctx?: ActivityContext) => {
        activityStarted = true;
        ctx?.signal.addEventListener('abort', () => {
          signalAborted = true;
        });
        try {
          await new Promise<void>((_resolve, reject) => {
            ctx?.signal.addEventListener('abort', () =>
              reject(ctx.signal.reason ?? new Error('aborted')),
            );
          });
          return 'long-done';
        } catch {
          observedThrow = true;
          throw new Error('activity-aborted');
        }
      },
    });

    engine.register(
      workflow({ name: 'cancel-wf' })
        .activities({ long: longActivity })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.run('long');
        }),
    );

    const handle = await engine.start('cancel-wf', null, { id: 'cancel-1' });
    await waitForCondition(() => activityStarted, {
      timeoutMs: 2000,
      label: 'long activity started',
    });
    // The result rejects once cancellation tears the workflow down; swallow it so
    // the rejection is observed rather than surfacing as an unhandled rejection.
    const settled = handle.result().then(
      () => 'resolved',
      () => 'rejected',
    );
    await engine.cancel('cancel-1');

    // The per-workflow AbortController fired, so the in-flight activity's signal
    // aborted and the activity observed it.
    await waitForCondition(() => signalAborted, {
      timeoutMs: 2000,
      label: 'activity signal aborted on workflow cancel',
    });
    expect(signalAborted).toBe(true);
    expect(observedThrow).toBe(true);
    expect(await settled).toBe('rejected');
  });
});

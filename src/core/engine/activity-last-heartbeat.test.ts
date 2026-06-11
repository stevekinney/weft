/**
 * #450: `ActivityContext.lastHeartbeatDetails` exposes the previous attempt's
 * heartbeat payload to a retry, so a long-running activity can resume mid-stream
 * instead of re-running from the start.
 *
 * The value is held in engine memory keyed by `workflowId -> step` (NOT by
 * `workflowId` alone) so two activities running concurrently inside a `ctx.all`
 * never read each other's heartbeats. It is non-durable: `undefined` on the first
 * attempt, after an engine restart, and for worker-executed activities.
 */
import { describe, expect, it } from 'bun:test';

import type { ActivityContext, WorkflowContext } from '../types.ts';
import { activity, workflow } from '../types.ts';
import { Engine } from './index.ts';

describe('#450 ActivityContext.lastHeartbeatDetails', () => {
  it('is undefined on the first attempt and equals the prior heartbeat on retry', async () => {
    await using engine = new Engine();
    const seen: Array<unknown> = [];

    const resumable = activity({
      name: 'resumable',
      // Zero backoff so the durable retry sleep is past-due and fires immediately,
      // keeping the test deterministic under parallel-suite load.
      retry: { maxAttempts: 3, initialBackoff: 0, backoffMultiplier: 1, maxBackoff: 0 },
      execute: async (_input?: unknown, ctx?: ActivityContext) => {
        seen.push(ctx?.lastHeartbeatDetails);
        if (seen.length === 1) {
          // First attempt: record progress, then fail so a retry happens.
          ctx?.heartbeat({ done: 2 });
          throw new Error('transient');
        }
        // Second attempt: resume from where the prior attempt left off.
        return { resumedFrom: ctx?.lastHeartbeatDetails };
      },
    });

    engine.register(
      workflow({ name: 'resume-wf' })
        .activities({ resumable })
        // Call by reference so the definition's `retry` policy drives the retry.
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.run(resumable);
        }),
    );

    const handle = await engine.start('resume-wf', null, { id: 'resume-1' });
    const result = (await handle.result()) as { resumedFrom: unknown };

    // First attempt saw no prior heartbeat; second attempt saw the {done:2} the
    // first attempt recorded before it failed.
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toEqual({ done: 2 });
    expect(result.resumedFrom).toEqual({ done: 2 });
  });

  it('does not bleed one step heartbeat into a later step first attempt (per-step keying)', async () => {
    // lastHeartbeatDetails is read at EVERY ActivityContext construction, including
    // first attempts. Keyed by workflowId alone, a later step's first attempt would
    // read an earlier step's heartbeat. Per-step keying isolates them: step B's
    // first run must see `undefined`, not step A's `{a:1}`. No retry, no crash —
    // this is the reachable correctness case the per-step key exists for.
    await using engine = new Engine();
    let bSawOnFirstRun: unknown = 'unset';

    const stepA = activity({
      name: 'step-a',
      execute: async (_input?: unknown, ctx?: ActivityContext) => {
        ctx?.heartbeat({ a: 1 });
        return 'a-done';
      },
    });
    const stepB = activity({
      name: 'step-b',
      execute: async (_input?: unknown, ctx?: ActivityContext) => {
        bSawOnFirstRun = ctx?.lastHeartbeatDetails;
        return 'b-done';
      },
    });

    engine.register(
      workflow({ name: 'cross-step-wf' })
        .activities({ 'step-a': stepA, 'step-b': stepB })
        .execute(async function* (ctx: WorkflowContext) {
          yield* ctx.run(stepA);
          yield* ctx.run(stepB);
          return 'done';
        }),
    );

    const handle = await engine.start('cross-step-wf', null, { id: 'cross-step-1' });
    await handle.result();
    // Step B's first (only) attempt saw no heartbeat — step A's {a:1} did NOT bleed.
    expect(bSawOnFirstRun).toBeUndefined();
  });

  it('does not bleed a ctx.all branch heartbeat into a later top-level step (sub-operations carry distinct steps)', async () => {
    // The concern behind the `operation.step ?? 0` fallback: if a ctx.all branch
    // activity reached buildActivityContext without a distinct step, its heartbeat
    // would key to step 0 and could bleed into a later top-level activity's first
    // attempt. It cannot — each branch's request is built through the same
    // `stepIndex++` path as a top-level run, so branches get distinct steps and a
    // later top-level step reads `undefined`. This pins that invariant end-to-end.
    await using engine = new Engine();
    let laterStepSawOnFirstRun: unknown = 'unset';

    const branch = activity({
      name: 'branch',
      execute: async (_input?: unknown, ctx?: ActivityContext) => {
        ctx?.heartbeat({ fromBranch: true });
        return 'branch-done';
      },
    });
    const laterStep = activity({
      name: 'later-step',
      execute: async (_input?: unknown, ctx?: ActivityContext) => {
        laterStepSawOnFirstRun = ctx?.lastHeartbeatDetails;
        return 'later-done';
      },
    });

    engine.register(
      workflow({ name: 'all-then-step-wf' })
        .activities({ branch, 'later-step': laterStep })
        .execute(async function* (ctx: WorkflowContext) {
          // Two concurrent branches both heartbeat; neither retries (ctx.all
          // activities don't), so the keying just has to keep them off step 0.
          yield* ctx.all([ctx.run(branch), ctx.run(branch)]);
          yield* ctx.run(laterStep);
          return 'done';
        }),
    );

    const handle = await engine.start('all-then-step-wf', null, { id: 'all-then-step-1' });
    await handle.result();
    // The later top-level step's first attempt saw no heartbeat — no branch bled in.
    expect(laterStepSawOnFirstRun).toBeUndefined();
  });
});

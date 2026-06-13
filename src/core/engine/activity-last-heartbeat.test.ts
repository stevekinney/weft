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

import { DevelopmentWarningEvent } from '../events.ts';
import type { ActivityContext, WorkflowContext } from '../types.ts';
import { activity, workflow } from '../types.ts';
import {
  clearLastHeartbeatForStep,
  recordLastHeartbeatForStep,
  warnIfRetryMissingHeartbeat,
} from './activity-heartbeat-tracking.ts';
import { Engine } from './index.ts';
import type { EngineInternals } from './internals.ts';
import { getInternals } from './internals.ts';

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

describe('#487 lastHeartbeatDetails cleared on successful step completion', () => {
  // The clear is NOT behaviorally observable — a completed step never re-runs,
  // so there is no input→output signal for "the per-step entry is gone." These
  // tests deliberately read engine internals (the only oracle for the cleanup)
  // and prove the clear happens AFTER inline verify, never before, so a
  // verify-rejection retry keeps reading its prior attempt's heartbeat.

  it('keeps the heartbeat across a verify-rejection retry, then clears it after final success', async () => {
    await using engine = new Engine();
    const seen: Array<unknown> = [];
    let verifyCalls = 0;

    const verified = activity({
      name: 'verified-resumable',
      // Zero backoff so the durable retry fires immediately under parallel load.
      retry: { maxAttempts: 3, initialBackoff: 0, backoffMultiplier: 1, maxBackoff: 0 },
      execute: async (_input?: unknown, ctx?: ActivityContext) => {
        seen.push(ctx?.lastHeartbeatDetails);
        // Every attempt records its progress before returning.
        ctx?.heartbeat({ done: seen.length });
        return { attempt: seen.length };
      },
      // Reject the first result so finalizeActivityResult throws and the step
      // re-runs; pass the second. A rejecting verify must NOT clear the heartbeat.
      verify: async () => {
        verifyCalls += 1;
        return verifyCalls > 1;
      },
    });

    engine.register(
      workflow({ name: 'verify-retry-wf' })
        .activities({ 'verified-resumable': verified })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.run(verified);
        }),
    );

    const handle = await engine.start('verify-retry-wf', null, { id: 'verify-retry-1' });
    await handle.result();

    // First attempt saw no prior heartbeat; the verify-rejection retry still saw
    // the {done:1} the first attempt recorded — the clear did not strip it.
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toEqual({ done: 1 });
    expect(verifyCalls).toBe(2);

    // After the step completed successfully, its per-step entry is gone and the
    // (now-empty) outer workflow entry was dropped.
    const internals = getInternals(engine);
    expect(internals.lastHeartbeatDetailsByStep.has('verify-retry-1')).toBe(false);
  });

  it('clears with no heartbeat recorded (byStep undefined early return)', async () => {
    await using engine = new Engine();

    // A step that completes without ever calling heartbeat() leaves no per-step
    // entry; the clear must early-return rather than touch a missing map.
    const noHeartbeat = activity({
      name: 'no-heartbeat',
      execute: async () => 'done',
    });

    engine.register(
      workflow({ name: 'no-heartbeat-wf' })
        .activities({ 'no-heartbeat': noHeartbeat })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.run(noHeartbeat);
        }),
    );

    const handle = await engine.start('no-heartbeat-wf', null, { id: 'no-heartbeat-1' });
    await handle.result();

    const internals = getInternals(engine);
    expect(internals.lastHeartbeatDetailsByStep.has('no-heartbeat-1')).toBe(false);
  });

  it('clears one step but keeps a sibling, then drops the outer entry on the last clear', () => {
    // The clear has two map-shaping branches: when a workflow has more than one
    // tracked step, clearing one must KEEP the outer entry (the sibling remains);
    // clearing the last step must DROP the outer entry. A real `ctx.all` race
    // would reach both branches, but only nondeterministically and via wall-clock
    // polling — so this exercises them directly and deterministically. The
    // per-step keying invariant itself is pinned by the `ctx.all` test in the
    // #450 suite above.
    const internals = {
      lastHeartbeatDetailsByStep: new Map<string, Map<number, unknown>>(),
    } as unknown as EngineInternals;

    recordLastHeartbeatForStep(internals, 'wf-1', 0, { step: 0 });
    recordLastHeartbeatForStep(internals, 'wf-1', 1, { step: 1 });

    // Clearing step 0 leaves step 1 — the outer entry survives (keep-outer).
    clearLastHeartbeatForStep(internals, 'wf-1', 0);
    const byStep = internals.lastHeartbeatDetailsByStep.get('wf-1');
    expect(byStep?.has(0)).toBe(false);
    expect(byStep?.get(1)).toEqual({ step: 1 });

    // Clearing the last step drops the now-empty outer entry (drop-outer).
    clearLastHeartbeatForStep(internals, 'wf-1', 1);
    expect(internals.lastHeartbeatDetailsByStep.has('wf-1')).toBe(false);
  });
});

describe('#493 development warning for a retry missing its heartbeat', () => {
  // The trigger is a coarse, development-mode-only over-warning: we cannot tell
  // "the prior attempt never heartbeated" from "the heartbeat was wiped by a
  // restart" at runtime, so the warning fires for both and the message says so.
  // The arms (development gate, inline gate, attempt gate, heartbeat-present gate)
  // are unit-tested directly because most cannot be reached end-to-end without a
  // worker harness or an actual process restart.

  // A minimal EngineInternals stub carrying exactly the fields the warning reads.
  // `engine` is a real EventTarget so dispatched warnings are observable.
  function buildWarningInternals(overrides: {
    development?: boolean;
    activityWorkerDispatcher?: unknown;
  }): { internals: EngineInternals; warnings: DevelopmentWarningEvent[] } {
    const warnings: DevelopmentWarningEvent[] = [];
    const engine = new EventTarget();
    engine.addEventListener(DevelopmentWarningEvent.type, (event) => {
      if (event instanceof DevelopmentWarningEvent) {
        warnings.push(event);
      }
    });
    const internals = {
      engine,
      options: { development: overrides.development ?? true },
      activityWorkerDispatcher: overrides.activityWorkerDispatcher ?? null,
      lastHeartbeatDetailsByStep: new Map<string, Map<number, unknown>>(),
    } as unknown as EngineInternals;
    return { internals, warnings };
  }

  it('warns on an inline retry (attempt > 1) with no recorded heartbeat', () => {
    const { internals, warnings } = buildWarningInternals({ development: true });
    warnIfRetryMissingHeartbeat(internals, 'wf-1', 0, 2);
    expect(warnings).toHaveLength(1);
    // The message names BOTH possibilities honestly and points at the step.
    expect(warnings[0]?.message).toContain('attempt 2');
    expect(warnings[0]?.message).toContain('restarted');
    expect(warnings[0]?.message).toContain('never called heartbeat()');
    expect(warnings[0]?.fieldPaths).toEqual(['step.0.lastHeartbeatDetails']);
  });

  it('does not warn outside development mode', () => {
    const { internals, warnings } = buildWarningInternals({ development: false });
    warnIfRetryMissingHeartbeat(internals, 'wf-1', 0, 2);
    expect(warnings).toHaveLength(0);
  });

  it('does not warn for worker-executed activities (heartbeat is host-only there)', () => {
    const { internals, warnings } = buildWarningInternals({
      development: true,
      activityWorkerDispatcher: { execute: async () => ({ status: 'completed', value: null }) },
    });
    warnIfRetryMissingHeartbeat(internals, 'wf-1', 0, 2);
    expect(warnings).toHaveLength(0);
  });

  it('does not warn on the first attempt', () => {
    const { internals, warnings } = buildWarningInternals({ development: true });
    warnIfRetryMissingHeartbeat(internals, 'wf-1', 0, 1);
    expect(warnings).toHaveLength(0);
  });

  it('does not warn when the retry can read its prior heartbeat (resumption working)', () => {
    const { internals, warnings } = buildWarningInternals({ development: true });
    // The prior in-process attempt recorded a heartbeat for this step.
    recordLastHeartbeatForStep(internals, 'wf-1', 0, { progress: 0.5 });
    warnIfRetryMissingHeartbeat(internals, 'wf-1', 0, 2);
    expect(warnings).toHaveLength(0);
  });

  it('fires end-to-end on a real retry whose prior attempt never heartbeated', async () => {
    // The realistic footgun shape, through the real engine: an activity that
    // fails its first attempt without heartbeating retries, and attempt 2 reads
    // `undefined`. This proves the warning is wired at the activity-execution
    // boundary, not just callable in isolation.
    await using engine = new Engine({ development: true });
    const warnings: DevelopmentWarningEvent[] = [];
    engine.addEventListener(DevelopmentWarningEvent.type, (event) => {
      if (event instanceof DevelopmentWarningEvent) {
        warnings.push(event);
      }
    });

    let attempts = 0;
    const flaky = activity({
      name: 'flaky-no-heartbeat',
      retry: { maxAttempts: 3, initialBackoff: 0, backoffMultiplier: 1, maxBackoff: 0 },
      execute: async () => {
        attempts += 1;
        if (attempts === 1) {
          // Fail WITHOUT heartbeating, so the retry sees no resume payload.
          throw new Error('transient');
        }
        return 'ok';
      },
    });

    engine.register(
      workflow({ name: 'flaky-wf' })
        .activities({ 'flaky-no-heartbeat': flaky })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.run(flaky);
        }),
    );

    const handle = await engine.start('flaky-wf', null, { id: 'flaky-1' });
    await handle.result();

    // The retry (attempt 2) tripped the warning; the first attempt did not.
    expect(attempts).toBe(2);
    const stepWarnings = warnings.filter((event) => event.workflowId === 'flaky-1');
    expect(stepWarnings).toHaveLength(1);
    expect(stepWarnings[0]?.message).toContain('attempt 2');
  });
});

/**
 * Unit tests for the defensive bail-out branches of the finalizer drive
 * (`runWorkflowFinalizer`) and the `runFinalizerActivity` primitive (#446 Phase 2).
 * The happy-path, retry, dead-letter, crash-recovery, and interlock behaviors are
 * covered end-to-end in `src/core/__tests__/finalizer-teardown.test.ts`; this file
 * crafts durable markers directly to reach the guard branches that the public API
 * cannot easily provoke (malformed timer ids, stale tokens, a presumed-live running
 * claim, a vanished registration, missing finalizer state, a lost claim CAS, the
 * per-attempt timeout path, and the never-throw catch).
 */

import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../../storage/interface.ts';
import {
  advanceTimersByTime,
  restoreRealTimers,
  useFakeTimers,
} from '../../../testing/fake-timers.test-support.ts';
import { decode, encode } from '../../codec.ts';
import { Engine } from '../../engine.ts';
import type { WorkflowContext, WorkflowState } from '../../types.ts';
import { activity, workflow } from '../../types.ts';
import { recordFinalizerState } from '../finalizer-state.ts';
import { getInternals } from '../internals.ts';
import { createTeardownTimerId, type TeardownClaim } from '../state-utilities.ts';
import { runFinalizerActivity } from './finalizer-activity.ts';
import type { TeardownDeadLetterRecord } from './finalizer-claim.ts';
import { runWorkflowFinalizer, type FinalizerDriveCallbacks } from './finalizer.ts';

function terminalState(id: string, type: string): WorkflowState {
  return {
    id,
    type,
    status: 'cancelled',
    input: null,
    createdAt: 0,
    updatedAt: 0,
    versionTuple: { workflowVersion: '0' },
  };
}

function owedClaim(token: string, attempts = 0): TeardownClaim {
  return { status: 'owed', attempts, token };
}

function makeCallbacks(
  state: WorkflowState | null,
  events: Event[] = [],
  cleanupErrors: Array<{ source: string; error: unknown }> = [],
): FinalizerDriveCallbacks {
  return {
    loadWorkflowState: async () => state,
    dispatchEvent: (event) => void events.push(event),
    handleCleanupError: (source, error) => void cleanupErrors.push({ source, error }),
  };
}

/** Count the live `wf-teardown:` timer entries in storage (proves a re-arm happened). */
async function teardownTimerCount(internals: ReturnType<typeof getInternals>): Promise<number> {
  let count = 0;
  for await (const _entry of internals.storage.scan('wf-teardown:')) count += 1;
  return count;
}

describe('runWorkflowFinalizer — defensive bail-out branches', () => {
  it('returns without driving when the timer id is malformed', async () => {
    const engine = new Engine();
    const internals = getInternals(engine);
    const cleanupErrors: Array<{ source: string; error: unknown }> = [];

    await runWorkflowFinalizer(
      internals,
      'wf-malformed',
      'not-a-teardown-timer',
      makeCallbacks(terminalState('wf-malformed', 'any'), [], cleanupErrors),
    );

    expect(cleanupErrors).toEqual([]);
    engine[Symbol.dispose]();
  });

  it('clears the marker when the workflow state is gone', async () => {
    const engine = new Engine();
    const internals = getInternals(engine);
    const workflowId = 'wf-gone';
    const token = 'tok-gone';
    await internals.storage.put(KEYS.teardownOwed(workflowId), encode(owedClaim(token)));

    await runWorkflowFinalizer(
      internals,
      workflowId,
      createTeardownTimerId(token),
      makeCallbacks(null),
    );

    expect(await internals.storage.get(KEYS.teardownOwed(workflowId))).toBeNull();
    engine[Symbol.dispose]();
  });

  it('clears the marker when the workflow is no longer in a teardown-owed status', async () => {
    const engine = new Engine();
    const internals = getInternals(engine);
    const workflowId = 'wf-completed';
    const token = 'tok-completed';
    await internals.storage.put(KEYS.teardownOwed(workflowId), encode(owedClaim(token)));

    const completedState: WorkflowState = {
      ...terminalState(workflowId, 'any'),
      status: 'completed',
    };
    await runWorkflowFinalizer(
      internals,
      workflowId,
      createTeardownTimerId(token),
      makeCallbacks(completedState),
    );

    expect(await internals.storage.get(KEYS.teardownOwed(workflowId))).toBeNull();
    engine[Symbol.dispose]();
  });

  it('returns when the owed marker is already gone', async () => {
    const engine = new Engine();
    const internals = getInternals(engine);
    const workflowId = 'wf-no-marker';
    const cleanupErrors: Array<{ source: string; error: unknown }> = [];

    await runWorkflowFinalizer(
      internals,
      workflowId,
      createTeardownTimerId('tok-x'),
      makeCallbacks(terminalState(workflowId, 'any'), [], cleanupErrors),
    );

    expect(cleanupErrors).toEqual([]);
    engine[Symbol.dispose]();
  });

  it('returns (leaving the marker) when the timer token does not match the claim', async () => {
    const engine = new Engine();
    const internals = getInternals(engine);
    const workflowId = 'wf-stale-token';
    await internals.storage.put(KEYS.teardownOwed(workflowId), encode(owedClaim('live-token')));

    // A stale timer for an older token must NOT clear the live claim's marker.
    await runWorkflowFinalizer(
      internals,
      workflowId,
      createTeardownTimerId('stale-token'),
      makeCallbacks(terminalState(workflowId, 'any')),
    );

    const markerBytes = await internals.storage.get(KEYS.teardownOwed(workflowId));
    expect(markerBytes).not.toBeNull();
    engine[Symbol.dispose]();
  });

  it('clears a corrupt marker (one that does not decode to a claim) so it cannot block forever', async () => {
    const engine = new Engine();
    const internals = getInternals(engine);
    const workflowId = 'wf-bad-claim';
    await internals.storage.put(KEYS.teardownOwed(workflowId), encode({ not: 'a-claim' }));

    // A marker that decodes to a non-claim can never be driven — it would otherwise block
    // purge / start-new forever. The drive clears it (conditioned on the bytes it read).
    await runWorkflowFinalizer(
      internals,
      workflowId,
      createTeardownTimerId('tok'),
      makeCallbacks(terminalState(workflowId, 'any')),
    );

    expect(await internals.storage.get(KEYS.teardownOwed(workflowId))).toBeNull();
    engine[Symbol.dispose]();
  });

  it('leaves the marker and re-arms a timer when a fresh running claim is presumed live', async () => {
    // A `running` claim whose `claimedAt` is recent (well under the stale threshold) is a
    // genuine live sibling — the drive must NOT reclaim or clear it, and must re-arm a
    // future timer so the claim is not stranded after the fired timer is deleted.
    let clock = 1_000_000;
    const engine = new Engine({ getNow: () => clock });
    let finalizerRuns = 0;
    const provision = workflow({
      name: 'teardown-presumed-live',
      finalizer: activity({
        name: 'destroy-presumed-live',
        timeout: '1m',
        execute: async () => {
          finalizerRuns += 1;
        },
      }),
    }).execute(async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('never');
    });
    engine.register(provision);
    const internals = getInternals(engine);

    const workflowId = 'wf-presumed-live';
    const token = 'tok-running';
    const runningClaim: TeardownClaim = {
      status: 'running',
      attempts: 0,
      token,
      claimedAt: clock, // claimed "now" — fresh, so presumed live.
    };
    await internals.storage.put(KEYS.teardownOwed(workflowId), encode(runningClaim));
    await internals.storage.put(KEYS.finalizerState(workflowId), encode({ sandboxId: 'sbx' }));

    await runWorkflowFinalizer(
      internals,
      workflowId,
      createTeardownTimerId(token),
      makeCallbacks(terminalState(workflowId, 'teardown-presumed-live')),
    );

    // The live sibling's running marker is untouched, the finalizer did NOT run again,
    // and a fresh self-heal timer was armed.
    const markerBytes = await internals.storage.get(KEYS.teardownOwed(workflowId));
    expect(markerBytes).not.toBeNull();
    expect(decode(markerBytes!)).toMatchObject({ status: 'running' });
    expect(finalizerRuns).toBe(0);
    expect(await teardownTimerCount(internals)).toBe(1);
    engine[Symbol.dispose]();
  });

  it('reclaims a stale running claim left by a crashed holder', async () => {
    // A `running` claim whose `claimedAt` is older than the stale threshold is reclaimable
    // — the drive runs the finalizer (advancing the clock past timeout + margin first).
    let clock = 1_000_000;
    const engine = new Engine({ getNow: () => clock });
    let finalizerRuns = 0;
    const provision = workflow({
      name: 'teardown-stale-reclaim',
      finalizer: activity({
        name: 'destroy-stale-reclaim',
        timeout: '1m',
        execute: async () => {
          finalizerRuns += 1;
        },
      }),
    }).execute(async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('never');
    });
    engine.register(provision);
    const internals = getInternals(engine);

    const workflowId = 'wf-stale-reclaim';
    const token = 'tok-stale';
    const runningClaim: TeardownClaim = {
      status: 'running',
      attempts: 0,
      token,
      claimedAt: clock,
    };
    await internals.storage.put(KEYS.teardownOwed(workflowId), encode(runningClaim));
    await internals.storage.put(KEYS.finalizerState(workflowId), encode({ sandboxId: 'sbx' }));

    // Advance past the stale threshold (1m timeout + 30s margin = 90s).
    clock += 120_000;

    await runWorkflowFinalizer(
      internals,
      workflowId,
      createTeardownTimerId(token),
      makeCallbacks(terminalState(workflowId, 'teardown-stale-reclaim')),
    );

    expect(finalizerRuns).toBe(1);
    expect(await internals.storage.get(KEYS.teardownOwed(workflowId))).toBeNull();
    engine[Symbol.dispose]();
  });

  it('leaves the marker and re-arms when the workflow type no longer registers a finalizer', async () => {
    // A node that recovers without this workflow type registered cannot run the finalizer,
    // but the resource is still owed: the marker must remain and a timer must be re-armed so
    // a node that DOES register the type can run it later. (Junior MF1 / Codex MF1.)
    const engine = new Engine();
    const internals = getInternals(engine);
    const workflowId = 'wf-no-registration';
    const token = 'tok-noreg';
    await internals.storage.put(KEYS.teardownOwed(workflowId), encode(owedClaim(token)));

    await runWorkflowFinalizer(
      internals,
      workflowId,
      createTeardownTimerId(token),
      makeCallbacks(terminalState(workflowId, 'unregistered')),
    );

    expect(await internals.storage.get(KEYS.teardownOwed(workflowId))).not.toBeNull();
    expect(await teardownTimerCount(internals)).toBe(1);
    engine[Symbol.dispose]();
  });

  it('dead-letters (not clears) when the registration exists but no finalizer state was recorded', async () => {
    // An owed marker present but the `finalizerState` key absent means the recorded
    // resource is gone and the finalizer can never run with its input — dead-letter rather
    // than silently clearing (which would falsely report "torn down"). (Junior MF1 / Codex MF1.)
    const engine = new Engine();
    let finalizerRan = false;
    const provision = workflow({
      name: 'teardown-missing-state',
      finalizer: activity({
        name: 'destroy-missing-state',
        execute: async () => {
          finalizerRan = true;
        },
      }),
    }).execute(async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('never');
    });
    engine.register(provision);
    const internals = getInternals(engine);

    const workflowId = 'wf-missing-state';
    const token = 'tok-missing';
    await internals.storage.put(KEYS.teardownOwed(workflowId), encode(owedClaim(token, 2)));
    // Note: no KEYS.finalizerState written.

    const events: Event[] = [];
    await runWorkflowFinalizer(
      internals,
      workflowId,
      createTeardownTimerId(token),
      makeCallbacks(terminalState(workflowId, 'teardown-missing-state'), events),
    );

    expect(finalizerRan).toBe(false);
    expect(await internals.storage.get(KEYS.teardownOwed(workflowId))).toBeNull();
    const deadLetterBytes = await internals.storage.get(KEYS.teardownDeadLetter(workflowId));
    expect(deadLetterBytes).not.toBeNull();
    const record = decode(deadLetterBytes!) as TeardownDeadLetterRecord;
    expect(record.type).toBe('teardown-missing-state');
    expect(record.attempts).toBe(2);
    expect(record.lastError).toContain('finalizer state missing');
    expect('finalizerInput' in record).toBe(false);
    // The dead-lettered event fires for symmetry with the retry-horizon path, and carries
    // the `error` reason (present for every 'failed'/'dead-lettered' status — Copilot). It
    // matches the dead-letter record's `lastError`.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'workflow:teardown',
      status: 'dead-lettered',
      attempts: 2,
      error: record.lastError,
    });
    engine[Symbol.dispose]();
  });

  it('backs off when the reclaim CAS loses to a concurrent claimer', async () => {
    // Two concurrent drives race for the same owed marker. The reclaim CAS is
    // conditioned on the exact owed-marker bytes, so exactly one wins; the loser's
    // conditional batch fails its precondition and the drive re-arms without running
    // the finalizer a second time.
    const engine = new Engine();
    let finalizerRuns = 0;
    const provision = workflow({
      name: 'teardown-cas-race',
      finalizer: activity({
        name: 'destroy-cas-race',
        execute: async () => {
          finalizerRuns += 1;
        },
      }),
    }).execute(async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('never');
    });
    engine.register(provision);
    const internals = getInternals(engine);

    const workflowId = 'wf-cas-race';
    const token = 'tok-cas';
    await internals.storage.put(KEYS.teardownOwed(workflowId), encode(owedClaim(token)));
    await internals.storage.put(KEYS.finalizerState(workflowId), encode({ sandboxId: 'sbx-cas' }));

    const callbacks = makeCallbacks(terminalState(workflowId, 'teardown-cas-race'));
    const timerId = createTeardownTimerId(token);
    await Promise.all([
      runWorkflowFinalizer(internals, workflowId, timerId, callbacks),
      runWorkflowFinalizer(internals, workflowId, timerId, callbacks),
    ]);

    // Exactly one drive won the claim CAS and ran the finalizer.
    expect(finalizerRuns).toBe(1);
    engine[Symbol.dispose]();
  });

  it('never propagates — a thrown error from a callback is routed to handleCleanupError', async () => {
    const engine = new Engine();
    const internals = getInternals(engine);
    const workflowId = 'wf-throws';
    const token = 'tok-throws';
    // A valid marker must be present so the drive proceeds PAST the marker read into
    // loadWorkflowState (which throws); a marker-absent drive short-circuits to 'cleared'
    // before any callback runs.
    await internals.storage.put(KEYS.teardownOwed(workflowId), encode(owedClaim(token)));
    const cleanupErrors: Array<{ source: string; error: unknown }> = [];
    const throwingCallbacks: FinalizerDriveCallbacks = {
      loadWorkflowState: async () => {
        throw new Error('storage exploded');
      },
      dispatchEvent: () => {},
      handleCleanupError: (source, error) => void cleanupErrors.push({ source, error }),
    };

    // Must resolve, not reject — the scheduler treats a thrown callback as no-backoff retry.
    await runWorkflowFinalizer(
      internals,
      workflowId,
      createTeardownTimerId(token),
      throwingCallbacks,
    );

    expect(cleanupErrors).toHaveLength(1);
    expect(cleanupErrors[0]?.source).toBe('runWorkflowFinalizer');
    // The catch re-armed a self-heal timer so the marker is not stranded (Codex round-2 MF3).
    expect(await teardownTimerCount(internals)).toBe(1);
    engine[Symbol.dispose]();
  });
});

describe('terminal teardown gate — staged-but-not-durable finalizer state', () => {
  it('stages the owed marker when finalizer state is staged-only at cancel (no leak)', async () => {
    // Regression for the silent-leak path (Cursor Bugbot / Copilot): `ctx.setFinalizerState`
    // STAGES its `wf-finalizer-state:` put as a pending atomic side-effect that the terminal
    // batch flushes. If a cancel arrives before any checkpoint flushed that put, a pre-batch
    // `storage.get()` returns null — yet the staged put commits in the SAME terminal batch.
    // Reading durable storage ALONE would skip the teardown marker while the resource state
    // is durably written, leaking the external resource. The terminal path must also peek the
    // staged buffer. We reproduce the exact interleaving by staging the state directly (no
    // intervening checkpoint) on a seeded running workflow, then cancelling.
    const destroyed: unknown[] = [];
    const destroySandbox = activity({
      name: 'destroy-sandbox-staged',
      execute: async (input: unknown) => {
        destroyed.push(input);
      },
    });

    const now = 1_000_000;
    const engine = new Engine({ getNow: () => now });
    const provision = workflow({
      name: 'teardown-staged-state',
      finalizer: destroySandbox,
    }).execute(async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('never');
    });
    engine.register(provision);
    const internals = getInternals(engine);

    const workflowId = 'teardown-staged-1';
    const runningState: WorkflowState = {
      id: workflowId,
      type: 'teardown-staged-state',
      status: 'running',
      input: null,
      createdAt: now,
      updatedAt: now,
      versionTuple: { workflowVersion: '0' },
    };
    await internals.storage.put(KEYS.workflow(workflowId), encode(runningState));

    // Stage the finalizer state WITHOUT a checkpoint flush — this is the un-flushed window.
    recordFinalizerState(internals, workflowId, { sandboxId: 'sbx-staged' });
    // Proof the state is staged-only: it is NOT in durable storage yet.
    expect(await internals.storage.get(KEYS.finalizerState(workflowId))).toBeNull();

    await engine.cancel(workflowId);

    // The terminal batch staged the owed marker + flushed the finalizer state atomically —
    // peeking the staged buffer is what makes `finalizerStatePresent` true.
    expect(await internals.storage.get(KEYS.teardownOwed(workflowId))).not.toBeNull();
    expect(await internals.storage.get(KEYS.finalizerState(workflowId))).not.toBeNull();

    // And the finalizer actually drives with the recorded input — no leak.
    await engine.scheduler.tick(now);
    expect(destroyed).toEqual([{ sandboxId: 'sbx-staged' }]);
    expect(await internals.storage.get(KEYS.teardownOwed(workflowId))).toBeNull();

    engine[Symbol.dispose]();
  });
});

describe('runFinalizerActivity — primitive', () => {
  it('reports shutdown-aborted when a silent finalizer resolves under an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('engine disposed'));

    let sawAbortedSignal = false;
    const finalizer = {
      name: 'destroy-on-aborted',
      execute: async (
        _input: unknown,
        context?: { signal: AbortSignal; heartbeat: () => void },
      ) => {
        sawAbortedSignal = context?.signal.aborted === true;
        // This finalizer ignores its abort signal and resolves anyway — a silent
        // "success" under a shutdown. The drive must NOT treat that as a real
        // teardown; the engine never confirmed the resource is gone.
        // The finalizer may call heartbeat; it is a no-op post-terminal but must
        // not throw. Exercising it covers the ActivityContext heartbeat stub.
        context?.heartbeat();
      },
    };

    const result = await runFinalizerActivity(finalizer, null, 1, controller.signal);

    // A clean disposal must re-open the claim at the unchanged attempt count, so the
    // attempt is reported as shutdown-aborted (NOT ok), even though the body resolved.
    if (result.ok)
      throw new Error('expected the silent finalizer to be reported as shutdown-aborted');
    expect(result.abortedByShutdown).toBe(true);
    expect(sawAbortedSignal).toBe(true);
  });

  it('relays a shutdown abort that fires while the finalizer is running', async () => {
    const controller = new AbortController();
    const finalizer = {
      name: 'destroy-watching-signal',
      execute: (_input: unknown, context?: { signal: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => {
          context?.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    };

    const resultPromise = runFinalizerActivity(finalizer, null, 1, controller.signal);
    controller.abort(new Error('engine disposed'));
    const result = await resultPromise;

    if (result.ok) throw new Error('expected the aborted finalizer attempt to fail');
    expect(result.abortedByShutdown).toBe(true);
  });

  it('fails the attempt (not abortedByShutdown) when the per-attempt timeout fires', async () => {
    // A finalizer that declares a short `timeout` and never resolves must become a
    // retryable failure — `{ ok: false }`, the timeout error, NOT abortedByShutdown — so
    // the drive re-arms/backs off instead of hanging the teardown forever. (testing MF3.)
    // Driven on FAKE timers so the per-attempt deadline is advanced deterministically,
    // never a real wall-clock wait. (round-2 testing MF.)
    useFakeTimers();
    let result: Awaited<ReturnType<typeof runFinalizerActivity>>;
    try {
      const finalizer = {
        name: 'destroy-that-hangs',
        timeout: '20ms',
        execute: (_input: unknown, context?: { signal: AbortSignal }) =>
          new Promise<void>((_resolve, reject) => {
            // Cooperate with the per-attempt abort so the hung promise settles for cleanup.
            context?.signal.addEventListener('abort', () => reject(context.signal.reason), {
              once: true,
            });
          }),
      };

      const resultPromise = runFinalizerActivity(finalizer, null, 1, new AbortController().signal);
      // Advance past the 20ms per-attempt deadline so the timeout fires deterministically.
      await advanceTimersByTime(20);
      result = await resultPromise;
    } finally {
      restoreRealTimers();
    }

    if (result.ok) throw new Error('expected the timed-out finalizer attempt to fail');
    expect(result.abortedByShutdown).toBe(false);
    expect(String(result.error)).toContain('destroy-that-hangs');
  });

  it('rejects a finalizer that calls ctx.completeAsync (unsupported post-terminal)', async () => {
    const finalizer = {
      name: 'destroy-misusing-complete-async',
      execute: async (_input: unknown, context?: { completeAsync: () => never }) => {
        context?.completeAsync();
      },
    };

    const result = await runFinalizerActivity(finalizer, null, 1, new AbortController().signal);

    if (result.ok) throw new Error('expected the completeAsync misuse to fail the attempt');
    expect(String(result.error)).toContain('completeAsync');
  });
});

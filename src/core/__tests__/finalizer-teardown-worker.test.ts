/**
 * Worker-mode finalizer parity tests (#564 WS2).
 *
 * The finalizer drive (`runWorkflowFinalizer` / `runFinalizerActivity`) runs entirely on
 * the ENGINE HOST — it never touches `internals.inlineStrategy` and never dispatches
 * through `internals.activityWorkerDispatcher`. Removing the registration guard
 * (`assertFinalizerSupported`, now deleted) was the only change needed to allow
 * worker-mode engines to register finalizer-bearing workflows.
 *
 * These tests prove that the removal is correct end-to-end:
 *
 *   T1 — Registration: see `src/core/engine/registration.test.ts` (the
 *         "succeeds when registering a finalizer on a worker-mode engine (#564)" test at
 *         line 127). Duplicating it here would be a tautology.
 *
 *   T2 — Worker-mode cancel e2e: the workflow generator runs in a real Web Worker
 *         (proven by a signal-waiter observable), and after cancellation the finalizer
 *         runs to durable completion on the engine host.
 *
 *   T3 — Timeout path: intentionally omitted (rationale at the T3 marker below).
 *
 *   T4 — activityExecution negative-dispatch: a recording dispatcher installed through
 *         `setActivityWorkerDispatcherForTesting` must not receive any call during
 *         finalizer drive. Proves the finalizer is host-side even when an activity
 *         worker pool is configured.
 *
 *   T5 — Worker-turn ordering: the finalizer effect must not appear until AFTER the
 *         workflow is in a terminal state. Proven by asserting no effect on a pre-cancel
 *         tick and full effect on a post-cancel tick.
 *
 *   T6 — Worker-mode finalizer failure: a finalizer that throws on attempt 1 is retried
 *         through the engine's normal backoff schedule, proving failure is never silently
 *         swallowed in worker mode.
 *
 *   T7 — Worker-mode no recorded state: a worker-mode workflow that declares a finalizer
 *         but never records finalizer state stages no teardown marker and never drives the
 *         finalizer — the engine's "nothing to tear down" gate is execution-mode-neutral.
 *
 *   T8 — Worker-mode crash recovery: stage a worker-mode teardown, dispose the engine, then
 *         bring up a NEW worker-mode engine over the same storage and recover. The finalizer
 *         runs to durable completion on the restarted host — the strongest proof that the
 *         drive depends on durable storage, not on any live inline-strategy state.
 *
 * ### Why `ctx.setFinalizerState` cannot run in the Worker
 *
 * `ctx.setFinalizerState()` is inline-only: the context implementation checks that
 * `internals.recordFinalizerState` is defined (it is undefined in worker mode) and throws
 * if absent. The workflow generator runs in a Web Worker where that callback is
 * unavailable, so tests simulate it by writing the `KEYS.finalizerState` storage key
 * directly — exactly what the inline engine path would write atomically on park/suspend.
 * The finalizer drive reads that key on teardown, so the end-to-end path is identical.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import type {
  ActivityExecutionRequest,
  ActivityExecutionResult,
} from '../../workers/activity-runner.ts';
import type { ActivityWorkerDispatcher } from '../../workers/activity-worker-dispatcher.ts';
import { decode, encode } from '../codec.ts';
import { Engine } from '../engine.ts';
import { setActivityWorkerDispatcherForTesting } from '../engine/activity-worker-dispatcher.test-support.ts';
import {
  ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING,
  ENGINE_SIGNAL_WAITER_COUNT_FOR_TESTING,
} from '../engine/index.ts';
import { getInternals } from '../engine/internals.ts';
import { type TeardownClaim } from '../engine/state-utilities.ts';
import type { WorkflowTeardownStatus } from '../events.ts';
import type { WorkflowContext } from '../types.ts';
import { activity, workflow } from '../types.ts';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/**
 * The test-browser-worker registers `wait-signal-then-complete` as a workflow
 * that parks on a signal-wait operation, then returns `{ input, payload, workflowId }`.
 * This is distinct from any engine-side handler we register, which is the basis of the
 * worker-turn isolation observable (T2/T4/T5/T6).
 */
const workerUrl = new URL('../../workers/test-browser-worker.ts', import.meta.url);

// ---------------------------------------------------------------------------
// Worker-turn observable helpers
// ---------------------------------------------------------------------------

/**
 * Wait until the engine has exactly one signal waiter registered. In worker mode a
 * workflow parks by yielding a `signal-wait` operation FROM the Worker, which the engine
 * receives and registers as a `signalWaiter`. This is the cheapest available proof that
 * the workflow generator ran inside a Web Worker rather than in the engine isolate:
 * - `ENGINE_SIGNAL_WAITER_COUNT_FOR_TESTING() === 1` → Worker yielded the park;
 * - `ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING() === 0` → NOT an inline-strategy park.
 */
async function waitForWorkerPark(engine: Engine, label: string): Promise<void> {
  await waitForCondition(() => engine[ENGINE_SIGNAL_WAITER_COUNT_FOR_TESTING]() === 1, {
    timeoutMs: 5_000,
    intervalMs: 25,
    label: `${label}: worker-mode signal waiter registered`,
  });
}

async function waitForWorkerParkCleanup(engine: Engine, label: string): Promise<void> {
  await waitForCondition(() => engine[ENGINE_SIGNAL_WAITER_COUNT_FOR_TESTING]() === 0, {
    timeoutMs: 5_000,
    intervalMs: 25,
    label: `${label}: worker-mode signal waiter cleaned up`,
  });
}

// ---------------------------------------------------------------------------
// Finalizer and teardown helpers (mirrors finalizer-teardown.test.ts idioms)
// ---------------------------------------------------------------------------

/** Collect `workflow:teardown` events as `{ status, attempts, error }` tuples. */
function collectTeardownEvents(
  engine: Engine,
): Array<{ workflowId: string; status: WorkflowTeardownStatus; attempts: number; error?: string }> {
  const events: Array<{
    workflowId: string;
    status: WorkflowTeardownStatus;
    attempts: number;
    error?: string;
  }> = [];
  engine.addEventListener('workflow:teardown', (event) => {
    events.push({
      workflowId: event.workflowId,
      status: event.status,
      attempts: event.attempts,
      ...(event.error === undefined ? {} : { error: event.error }),
    });
  });
  return events;
}

/**
 * Write the `finalizerState` key directly to storage on behalf of a workflow that cannot
 * call `ctx.setFinalizerState()` from a Worker. This is the storage-level equivalent of
 * what the inline engine path would write on the `park` commit.
 */
async function writeFinalizerStateToStorage(
  storage: MemoryStorage,
  workflowId: string,
  value: unknown,
): Promise<void> {
  await storage.batch([
    { type: 'put', key: KEYS.finalizerState(workflowId), value: encode(value) },
  ]);
}

// ---------------------------------------------------------------------------
// Shared engine factory
// ---------------------------------------------------------------------------

/**
 * Build a worker-mode engine. Each test seeds its own monotonic `now` with a distinct
 * base value (1_000_000, 2_000_000, …) so scheduler timers staged by one test cannot
 * collide with another's when suites run in the same process.
 */
function createWorkerModeEngine(storage: MemoryStorage, getNow: () => number): Engine {
  return new Engine({
    storage,
    getNow,
    workflowExecutionMode: 'worker',
    workerExecution: { workerUrl, poolSize: 1, workflowTurnTimeoutMs: 30_000 },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('worker-mode finalizer teardown (#564 WS2)', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  // -------------------------------------------------------------------------
  // T2 — Worker-mode cancel e2e
  // -------------------------------------------------------------------------
  it('T2: runs the finalizer on the engine host after a worker-mode workflow is cancelled', async () => {
    const destroyed: unknown[] = [];
    const destroySandbox = activity({
      name: 'destroy-sandbox-worker-cancel',
      execute: async (input: unknown) => {
        destroyed.push(input);
      },
    });

    // Engine-side sentinel: the engine registers `wait-signal-then-complete` with a
    // handler that flips a flag. If the flag is ever set, the generator ran inline
    // (in the engine isolate) instead of in the Web Worker.
    let engineHandlerRan = false;
    const engineSideWorkflow = workflow({
      name: 'wait-signal-then-complete',
      finalizer: destroySandbox,
    }).execute(async function* (_ctx: WorkflowContext) {
      engineHandlerRan = true;
      return { ranIn: 'engine-isolate' };
    });

    const storage = new MemoryStorage();
    let now = 1_000_000;
    engine = createWorkerModeEngine(storage, () => now);
    engine.register(engineSideWorkflow);
    const events = collectTeardownEvents(engine);

    // Start the workflow. The Worker (test-browser-worker.ts) picks up
    // `wait-signal-then-complete` and parks on a `signal-wait` operation.
    const handle = await engine.start(
      'wait-signal-then-complete',
      { signalName: 'never' },
      {
        id: 'worker-finalizer-cancel-1',
      },
    );
    const resultPromise = handle.result();

    // WORKER-TURN OBSERVABLE: once the signal waiter is registered the Worker has run
    // its first turn and yielded the park — not the engine-side handler.
    await waitForWorkerPark(engine, 'T2');
    expect(engine[ENGINE_SIGNAL_WAITER_COUNT_FOR_TESTING]()).toBe(1);
    expect(engine[ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING]()).toBe(0); // not inline-parked

    // Write `finalizerState` directly to storage — simulates what `ctx.setFinalizerState`
    // would have written in inline mode. The finalizer drive reads this key on teardown.
    await writeFinalizerStateToStorage(storage, 'worker-finalizer-cancel-1', {
      sandboxId: 'sbx-worker-cancel',
    });

    // Cancel the workflow. The terminal batch reads the finalizerState key (already in
    // storage) and stages the teardownOwed marker + timer atomically.
    await engine.cancel(handle.id);
    await waitForWorkerParkCleanup(engine, 'T2');
    await expect(resultPromise).rejects.toThrow('Workflow cancelled');

    // The teardownOwed marker must be staged before the tick.
    expect(await storage.get(KEYS.teardownOwed('worker-finalizer-cancel-1'))).not.toBeNull();

    // Tick the scheduler — the teardown timer fires, the finalizer runs HOST-SIDE.
    await engine.scheduler.tick(now);

    // Same outcome assertions as the inline baseline in finalizer-teardown.test.ts.
    expect(destroyed).toEqual([{ sandboxId: 'sbx-worker-cancel' }]);
    expect(events).toEqual([
      { workflowId: 'worker-finalizer-cancel-1', status: 'completed', attempts: 1 },
    ]);
    expect(await storage.get(KEYS.teardownOwed('worker-finalizer-cancel-1'))).toBeNull();
    expect(await storage.get(KEYS.finalizerState('worker-finalizer-cancel-1'))).toBeNull();

    // The engine-side handler never stepped in the engine isolate — generator ran in Worker.
    expect(engineHandlerRan).toBe(false);
  });

  // -------------------------------------------------------------------------
  // T3 — Timeout path
  // -------------------------------------------------------------------------
  // SKIPPED: cancel and timeout both reach the finalizer drive through the same
  // `buildTeardownOperations` call in `termination/complete.ts`. The teardown code is
  // path-identical for both terminal statuses (`cancelled` / `timed-out`). Adding a
  // timeout variant here would duplicate T2 without exercising any new branch.

  // -------------------------------------------------------------------------
  // T4 — activityExecution negative-dispatch
  // -------------------------------------------------------------------------
  it('T4: the finalizer does not dispatch through the activity worker pool even when activityExecution is configured', async () => {
    // To make `dispatchCallCount === 0` a falsifiable proof, we construct the engine WITH
    // `activityExecution` so the engine's own constructor populates
    // `internals.activityWorkerDispatcher` with a real, pool-backed dispatcher through the
    // production path. We then dispose that real dispatcher (so the worker pool does not
    // leak) and overwrite the slot with this recording poison dispatcher. The slot is now
    // genuinely the one a configured activity pool would occupy: if the finalizer ever
    // dispatched through it, the recorder would be called (incrementing `dispatchCallCount`)
    // and would return a poison failure. A zero count therefore proves the finalizer drive
    // bypasses a configured activity pool, not merely that an empty slot was untouched.
    let dispatchCallCount = 0;
    const recordingDispatcher = {
      execute: async (_request: ActivityExecutionRequest): Promise<ActivityExecutionResult> => {
        dispatchCallCount++;
        return {
          operationId: _request.operationId,
          status: 'failed',
          error: 'POISON: finalizer must never reach the activity worker pool',
        };
      },
      get availableCount(): number {
        return 0;
      },
      get totalCount(): number {
        return 0;
      },
      get pendingCount(): number {
        return 0;
      },
      [Symbol.dispose](): void {},
      async [Symbol.asyncDispose](): Promise<void> {},
    } as unknown as ActivityWorkerDispatcher;

    const destroyed: unknown[] = [];
    const destroySandbox = activity({
      name: 'destroy-sandbox-no-dispatch',
      execute: async (input: unknown) => {
        destroyed.push(input);
      },
    });

    const engineSideWorkflow = workflow({
      name: 'wait-signal-then-complete',
      finalizer: destroySandbox,
    }).execute(async function* (_ctx: WorkflowContext) {
      return { ranIn: 'engine-isolate' };
    });

    const storage = new MemoryStorage();
    let now = 2_000_000;
    // Construct WITH activityExecution so the engine installs a real, pool-backed
    // dispatcher via the production path (the slot is genuinely non-null).
    engine = new Engine({
      storage,
      getNow: () => now,
      workflowExecutionMode: 'worker',
      workerExecution: { workerUrl, poolSize: 1, workflowTurnTimeoutMs: 30_000 },
      activityExecution: { workerUrl, poolSize: 1 },
    });
    engine.register(engineSideWorkflow);

    // The engine populated `internals.activityWorkerDispatcher` with a real pool-backed
    // dispatcher. Dispose it so the worker pool does not leak, then overwrite the slot with
    // the recording poison dispatcher — now any finalizer dispatch through the slot is
    // observable and fails.
    getInternals(engine).activityWorkerDispatcher?.[Symbol.dispose]();
    setActivityWorkerDispatcherForTesting(engine, recordingDispatcher);

    const handle = await engine.start(
      'wait-signal-then-complete',
      { signalName: 'never' },
      {
        id: 'worker-finalizer-no-dispatch-1',
      },
    );
    const resultPromise = handle.result();

    await waitForWorkerPark(engine, 'T4');

    // Write finalizerState so the teardown marker is staged on cancel.
    await writeFinalizerStateToStorage(storage, 'worker-finalizer-no-dispatch-1', {
      sandboxId: 'sbx-no-dispatch',
    });

    await engine.cancel(handle.id);
    await waitForWorkerParkCleanup(engine, 'T4');
    await expect(resultPromise).rejects.toThrow('Workflow cancelled');

    // Tick to drive the finalizer.
    await engine.scheduler.tick(now);

    // Finalizer ran host-side — correct output.
    expect(destroyed).toEqual([{ sandboxId: 'sbx-no-dispatch' }]);
    // The configured activity dispatcher was NEVER called — the finalizer did not go
    // through the activity pool even though `activityExecution` was configured.
    expect(dispatchCallCount).toBe(0);
    // Storage keys swept.
    expect(await storage.get(KEYS.teardownOwed('worker-finalizer-no-dispatch-1'))).toBeNull();
    expect(await storage.get(KEYS.finalizerState('worker-finalizer-no-dispatch-1'))).toBeNull();
  });

  // -------------------------------------------------------------------------
  // T5 — Worker-turn ordering
  // -------------------------------------------------------------------------
  it('T5: the finalizer host effect does not appear until after the workflow reaches a terminal state', async () => {
    // The finalizer drive's `resolveTeardownDrive` is gated on
    // `TERMINAL_STATUSES_OWED_TEARDOWN` (only `cancelled`/`timed-out`). A tick before
    // cancellation finds no teardownOwed marker and returns `'cleared'` immediately.
    // A tick after cancellation fires the staged marker and runs the finalizer.
    // This proves terminal-status gating: while the workflow is pre-terminal (its Worker
    // turn still live), no teardown marker exists, so the drive never starts and the
    // finalizer host effect cannot appear before the terminal transition.
    const destroyed: unknown[] = [];
    const destroySandbox = activity({
      name: 'destroy-sandbox-ordering',
      execute: async (input: unknown) => {
        destroyed.push(input);
      },
    });

    const engineSideWorkflow = workflow({
      name: 'wait-signal-then-complete',
      finalizer: destroySandbox,
    }).execute(async function* (_ctx: WorkflowContext) {
      return { ranIn: 'engine-isolate' };
    });

    const storage = new MemoryStorage();
    let now = 3_000_000;
    engine = createWorkerModeEngine(storage, () => now);
    engine.register(engineSideWorkflow);
    const events = collectTeardownEvents(engine);

    const handle = await engine.start(
      'wait-signal-then-complete',
      { signalName: 'never' },
      {
        id: 'worker-finalizer-ordering-1',
      },
    );
    const resultPromise = handle.result();

    await waitForWorkerPark(engine, 'T5');

    // PRE-CANCEL tick: no teardownOwed marker exists; drive returns 'cleared' immediately.
    // The finalizer must NOT have run.
    await engine.scheduler.tick(now);
    expect(destroyed).toEqual([]);
    expect(events).toEqual([]);

    // Write finalizerState so the terminal transition stages the teardown marker.
    await writeFinalizerStateToStorage(storage, 'worker-finalizer-ordering-1', {
      sandboxId: 'sbx-ordering',
    });

    // Cancel: terminal transition stages teardownOwed marker.
    await engine.cancel(handle.id);
    await waitForWorkerParkCleanup(engine, 'T5');
    await expect(resultPromise).rejects.toThrow('Workflow cancelled');

    // POST-CANCEL tick: teardownOwed marker present, workflow is terminal → drives finalizer.
    await engine.scheduler.tick(now);
    expect(destroyed).toEqual([{ sandboxId: 'sbx-ordering' }]);
    expect(events).toEqual([
      { workflowId: 'worker-finalizer-ordering-1', status: 'completed', attempts: 1 },
    ]);
  });

  // -------------------------------------------------------------------------
  // T6 — Worker-mode finalizer failure
  // -------------------------------------------------------------------------
  it('T6: a failing finalizer in worker mode is retried through the normal backoff schedule', async () => {
    let attempts = 0;
    const flakyDestroy = activity({
      name: 'destroy-sandbox-worker-flaky',
      execute: async () => {
        attempts += 1;
        if (attempts < 2) throw new Error('transient worker-mode finalizer failure');
      },
    });

    const engineSideWorkflow = workflow({
      name: 'wait-signal-then-complete',
      finalizer: flakyDestroy,
    }).execute(async function* (_ctx: WorkflowContext) {
      return { ranIn: 'engine-isolate' };
    });

    const storage = new MemoryStorage();
    let now = 4_000_000;
    engine = createWorkerModeEngine(storage, () => now);
    engine.register(engineSideWorkflow);
    const events = collectTeardownEvents(engine);

    const handle = await engine.start(
      'wait-signal-then-complete',
      { signalName: 'never' },
      {
        id: 'worker-finalizer-flaky-1',
      },
    );
    const resultPromise = handle.result();

    await waitForWorkerPark(engine, 'T6');

    await writeFinalizerStateToStorage(storage, 'worker-finalizer-flaky-1', {
      sandboxId: 'sbx-worker-flaky',
    });

    await engine.cancel(handle.id);
    await waitForWorkerParkCleanup(engine, 'T6');
    await expect(resultPromise).rejects.toThrow('Workflow cancelled');

    // First attempt: finalizer throws → failed event + owed marker re-armed.
    await engine.scheduler.tick(now);
    expect(events).toEqual([
      {
        workflowId: 'worker-finalizer-flaky-1',
        status: 'failed',
        attempts: 1,
        error: 'transient worker-mode finalizer failure',
      },
    ]);
    expect(await storage.get(KEYS.teardownOwed('worker-finalizer-flaky-1'))).not.toBeNull();
    expect(attempts).toBe(1);

    // Advance past the first backoff window (1m) so the rescheduled timer is due,
    // then tick again — the retry succeeds.
    now += 120_000;
    await engine.scheduler.tick(now);
    expect(events[1]).toEqual({
      workflowId: 'worker-finalizer-flaky-1',
      status: 'completed',
      attempts: 2,
    });
    expect(attempts).toBe(2);
    expect(await storage.get(KEYS.teardownOwed('worker-finalizer-flaky-1'))).toBeNull();
    expect(await storage.get(KEYS.finalizerState('worker-finalizer-flaky-1'))).toBeNull();
  });

  // -------------------------------------------------------------------------
  // T7 — Worker-mode no recorded state
  // -------------------------------------------------------------------------
  it('T7: a worker-mode workflow that records no finalizer state never drives the finalizer', async () => {
    // The "nothing to tear down" gate lives in `buildTeardownOperations`, keyed solely on
    // whether the `finalizerState` storage key is present — there is no execution-mode
    // branch. A worker-mode workflow that declares a finalizer but never records state must
    // therefore behave exactly like the inline baseline: no teardown marker, no drive.
    let finalizerRan = false;
    const destroySandbox = activity({
      name: 'destroy-sandbox-worker-unrecorded',
      execute: async () => {
        finalizerRan = true;
      },
    });

    const engineSideWorkflow = workflow({
      name: 'wait-signal-then-complete',
      finalizer: destroySandbox,
    }).execute(async function* (_ctx: WorkflowContext) {
      return { ranIn: 'engine-isolate' };
    });

    const storage = new MemoryStorage();
    const now = 5_000_000;
    engine = createWorkerModeEngine(storage, () => now);
    engine.register(engineSideWorkflow);
    const events = collectTeardownEvents(engine);

    const handle = await engine.start(
      'wait-signal-then-complete',
      { signalName: 'never' },
      { id: 'worker-finalizer-nostate-1' },
    );
    const resultPromise = handle.result();

    await waitForWorkerPark(engine, 'T7');

    // No `writeFinalizerStateToStorage` call here — nothing is recorded.
    await engine.cancel(handle.id);
    await waitForWorkerParkCleanup(engine, 'T7');
    await expect(resultPromise).rejects.toThrow('Workflow cancelled');

    // No teardown marker was staged because no finalizer state was recorded.
    expect(await storage.get(KEYS.teardownOwed('worker-finalizer-nostate-1'))).toBeNull();

    // Ticking the scheduler drives nothing — the finalizer never runs.
    await engine.scheduler.tick(now);
    expect(finalizerRan).toBe(false);
    expect(events).toEqual([]);
    expect(await storage.get(KEYS.teardownOwed('worker-finalizer-nostate-1'))).toBeNull();
  });

  // -------------------------------------------------------------------------
  // T8 — Worker-mode crash recovery
  // -------------------------------------------------------------------------
  it('T8: a staged worker-mode teardown is driven to completion by a restarted worker-mode engine', async () => {
    // The discriminating proof for #564: the finalizer drive reads everything it needs
    // (the registry entry, the `finalizerState` payload, the `teardownOwed` marker/timer)
    // from durable storage, so it cannot depend on any live inline-strategy state. We stage
    // the teardown on engine1 through the real worker-mode terminal path, then "crash" by
    // disposing engine1 with the marker still `owed`. A fresh worker-mode engine2 over the
    // same storage must recover and run the finalizer to durable completion — with no inline
    // strategy in either engine.
    const storage = new MemoryStorage();
    let now = 6_000_000;
    const destroyed: unknown[] = [];
    const destroySandbox = activity({
      name: 'destroy-sandbox-worker-recover',
      execute: async (input: unknown) => {
        destroyed.push(input);
      },
    });
    const engineSideWorkflow = workflow({
      name: 'wait-signal-then-complete',
      finalizer: destroySandbox,
    }).execute(async function* (_ctx: WorkflowContext) {
      return { ranIn: 'engine-isolate' };
    });

    // engine1: start in worker mode, record finalizer state, cancel to stage the teardown.
    const engine1 = createWorkerModeEngine(storage, () => now);
    engine1.register(engineSideWorkflow);
    const handle = await engine1.start(
      'wait-signal-then-complete',
      { signalName: 'never' },
      { id: 'worker-finalizer-recover-1' },
    );
    const resultPromise = handle.result();
    await waitForWorkerPark(engine1, 'T8/engine1');
    await writeFinalizerStateToStorage(storage, 'worker-finalizer-recover-1', {
      sandboxId: 'sbx-worker-recover',
    });
    await engine1.cancel(handle.id);
    await waitForWorkerParkCleanup(engine1, 'T8/engine1');
    await expect(resultPromise).rejects.toThrow('Workflow cancelled');

    // The teardown marker is staged and still `owed` — engine1 dies before any drive tick.
    const owedBytes = await storage.get(KEYS.teardownOwed('worker-finalizer-recover-1'));
    expect(owedBytes).not.toBeNull();
    expect((decode(owedBytes!) as TeardownClaim).status).toBe('owed');
    expect(destroyed).toEqual([]); // not driven yet
    engine1[Symbol.dispose](); // "crash" — no in-flight drive.

    // engine2: a brand-new worker-mode engine over the SAME storage recovers and drives it.
    engine = createWorkerModeEngine(storage, () => now);
    engine.register(engineSideWorkflow);
    const events = collectTeardownEvents(engine);
    await engine.recoverAll();

    await engine.scheduler.tick(now);

    // The finalizer ran on the restarted host with the recovered payload, and the durable
    // keys were swept — proving the drive is storage-driven, not inline-strategy-driven.
    expect(destroyed).toEqual([{ sandboxId: 'sbx-worker-recover' }]);
    expect(events).toEqual([
      { workflowId: 'worker-finalizer-recover-1', status: 'completed', attempts: 1 },
    ]);
    expect(await storage.get(KEYS.teardownOwed('worker-finalizer-recover-1'))).toBeNull();
    expect(await storage.get(KEYS.finalizerState('worker-finalizer-recover-1'))).toBeNull();
  });
});

import { sleepForTesting, waitForCondition } from '../testing/fake-timers.test-support.ts';
/**
 * End-to-end crash recovery tests.
 *
 * These tests verify the fundamental durable execution guarantee:
 * if the process crashes mid-workflow, a new engine with the same storage
 * resumes from the last checkpoint without re-executing completed steps.
 */

import { describe, expect, it } from 'bun:test';

import { encodeStorageKeyComponent, KEYS as STORAGE_KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { encode } from './codec.ts';
import { Engine, WorkflowTypeNotRegisteredForRecoveryError } from './engine.ts';
import { WorkflowRecoverySkippedEvent, WorkflowResumedEvent } from './events.ts';
import {
  CURRENT_PERSISTED_DATA_SCHEMA_VERSION,
  PERSISTED_DATA_SCHEMA_VERSION_KEY,
} from './persisted-data-incompatible-error.ts';
import type { WorkflowState, WorkflowStatus } from './types.ts';
import { activity } from './types.ts';
import { workflow } from './types/workflow-function.ts';

/** Drain microtasks so fire-and-forget work completes. */
async function flush(): Promise<void> {
  await sleepForTesting(10);
}

function createStoredWorkflowState(
  workflowId: string,
  workflowType: string,
  status: WorkflowStatus,
): WorkflowState {
  return {
    id: workflowId,
    type: workflowType,
    status,
    input: null,
    versionTuple: { workflowVersion: '1' },
    createdAt: 1,
    updatedAt: 1,
  };
}

async function seedStoredWorkflowState(
  storage: MemoryStorage,
  workflowId: string,
  workflowType: string,
  status: WorkflowStatus,
): Promise<void> {
  await storage.put(
    STORAGE_KEYS.workflow(workflowId),
    encode(createStoredWorkflowState(workflowId, workflowType, status)),
  );
  // Stamp the current schema-version sentinel so Engine.create opens the seeded
  // store and reaches recovery, rather than rejecting it at the schema gate.
  await storage.put(
    PERSISTED_DATA_SCHEMA_VERSION_KEY,
    new TextEncoder().encode(String(CURRENT_PERSISTED_DATA_SCHEMA_VERSION)),
  );
}

describe('crash recovery', () => {
  it('recoverAll fails in preflight before resuming any registered workflow when a running type is missing', async () => {
    const storage = new MemoryStorage();
    const firstEngine = new Engine({ storage });

    firstEngine.register(
      workflow({ name: 'preflight-known' }).execute(async function* (ctx) {
        yield* ctx.waitForSignal('go');
        return 'known-done';
      }),
    );
    await firstEngine.start('preflight-known', null, { id: 'preflight-known-id' });
    await flush();
    firstEngine[Symbol.dispose]();

    await seedStoredWorkflowState(storage, 'preflight-missing-id', 'preflight-missing', 'running');

    const recoveredEngine = new Engine({ storage });
    let resumedRunCount = 0;
    recoveredEngine.register(
      workflow({ name: 'preflight-known' }).execute(async function* (ctx) {
        resumedRunCount += 1;
        yield* ctx.waitForSignal('go');
        return 'known-done';
      }),
    );
    const resumedEvents: WorkflowResumedEvent[] = [];
    recoveredEngine.addEventListener(WorkflowResumedEvent.type, (event) => {
      resumedEvents.push(event);
    });

    const checkpointKey = STORAGE_KEYS.checkpoint('preflight-known-id');
    const stateKey = STORAGE_KEYS.workflow('preflight-known-id');
    const checkpointBefore = await storage.get(checkpointKey);
    const stateBefore = await storage.get(stateKey);
    expect(checkpointBefore).not.toBeNull();
    expect(stateBefore).not.toBeNull();

    await expect(recoveredEngine.recoverAll()).rejects.toBeInstanceOf(
      WorkflowTypeNotRegisteredForRecoveryError,
    );
    expect(resumedEvents).toHaveLength(0);
    expect(resumedRunCount).toBe(0);

    // Preflight is read-only — the throw must leave every persisted byte
    // identical so a follow-up `recoverAll()` (after registering the missing
    // type) sees the same state the first call started from.
    const checkpointAfter = await storage.get(checkpointKey);
    const stateAfter = await storage.get(stateKey);
    expect(checkpointAfter).toEqual(checkpointBefore);
    expect(stateAfter).toEqual(stateBefore);

    recoveredEngine[Symbol.dispose]();
  });

  it('recoverAll can acknowledge unknown workflow types and emits one skipped event per skipped workflow', async () => {
    const storage = new MemoryStorage();
    const firstEngine = new Engine({ storage });

    firstEngine.register(
      workflow({ name: 'acknowledged-known' }).execute(async function* (ctx) {
        const signal = yield* ctx.waitForSignal<string>('go');
        return `known:${signal}`;
      }),
    );
    await firstEngine.start('acknowledged-known', null, { id: 'acknowledged-known-id' });
    await flush();
    firstEngine[Symbol.dispose]();

    await seedStoredWorkflowState(
      storage,
      'acknowledged-missing-id',
      'acknowledged-missing',
      'running',
    );

    const recoveredEngine = new Engine({ storage });
    recoveredEngine.register(
      workflow({ name: 'acknowledged-known' }).execute(async function* (ctx) {
        const signal = yield* ctx.waitForSignal<string>('go');
        return `known:${signal}`;
      }),
    );
    const skippedEvents: WorkflowRecoverySkippedEvent[] = [];
    recoveredEngine.addEventListener(WorkflowRecoverySkippedEvent.type, (event) => {
      skippedEvents.push(event);
    });

    const handles = await recoveredEngine.recoverAll({ acknowledgeUnknownWorkflowTypes: true });

    expect(handles.map((handle) => handle.id)).toEqual(['acknowledged-known-id']);
    expect(skippedEvents).toHaveLength(1);
    expect(skippedEvents[0]).toMatchObject({
      workflowId: 'acknowledged-missing-id',
      workflowType: 'acknowledged-missing',
      reason: 'type-not-registered',
    });

    await recoveredEngine.signal('acknowledged-known-id', 'go', 'done');
    await expect(handles[0]!.result()).resolves.toBe('known:done');

    recoveredEngine[Symbol.dispose]();
  });

  it('recoverAll state matrix handles pending and registered running workflows while skipping or ignoring the rest', async () => {
    const storage = new MemoryStorage();
    const firstEngine = new Engine({ storage });

    firstEngine.register(
      workflow({ name: 'matrix-running' }).execute(async function* (ctx) {
        const signal = yield* ctx.waitForSignal<string>('go');
        return `matrix:${signal}`;
      }),
    );
    await firstEngine.start('matrix-running', null, { id: 'matrix-running-id' });
    await flush();
    firstEngine[Symbol.dispose]();

    await seedStoredWorkflowState(
      storage,
      'matrix-pending-id',
      'matrix-missing-pending',
      'pending',
    );
    await seedStoredWorkflowState(
      storage,
      'matrix-missing-running-id',
      'matrix-missing-running',
      'running',
    );
    await seedStoredWorkflowState(
      storage,
      'matrix-completed-id',
      'matrix-missing-completed',
      'completed',
    );
    await seedStoredWorkflowState(storage, 'matrix-failed-id', 'matrix-missing-failed', 'failed');
    await seedStoredWorkflowState(
      storage,
      'matrix-cancelled-id',
      'matrix-missing-cancelled',
      'cancelled',
    );
    await seedStoredWorkflowState(
      storage,
      'matrix-timed-out-id',
      'matrix-missing-timed-out',
      'timed-out',
    );
    // Registered-but-terminal cell: a completed workflow whose type IS
    // registered should still be silently ignored. Terminal status takes
    // precedence over registration; recovery only resumes records that need
    // their generator function back to make progress.
    await seedStoredWorkflowState(
      storage,
      'matrix-registered-completed-id',
      'matrix-running',
      'completed',
    );

    const recoveredEngine = new Engine({ storage });
    recoveredEngine.register(
      workflow({ name: 'matrix-running' }).execute(async function* (ctx) {
        const signal = yield* ctx.waitForSignal<string>('go');
        return `matrix:${signal}`;
      }),
    );
    const skippedEvents: WorkflowRecoverySkippedEvent[] = [];
    recoveredEngine.addEventListener(WorkflowRecoverySkippedEvent.type, (event) => {
      skippedEvents.push(event);
    });

    const handles = await recoveredEngine.recoverAll({ acknowledgeUnknownWorkflowTypes: true });

    expect(handles.map((handle) => handle.id).toSorted()).toEqual([
      'matrix-pending-id',
      'matrix-running-id',
    ]);
    expect(skippedEvents.map((event) => event.workflowId)).toEqual(['matrix-missing-running-id']);

    await recoveredEngine.signal('matrix-running-id', 'go', 'done');
    await expect(recoveredEngine.getHandle('matrix-running-id').result()).resolves.toBe(
      'matrix:done',
    );

    recoveredEngine[Symbol.dispose]();
  });

  it('recoverAll preserves storage-scan order across local and recoverable handles', async () => {
    // Regression test for #195: the preflight refactor must not group local
    // and recoverable handles into separate passes — that would change the
    // observable handle-array order from storage-scan order to "all locals
    // then all recoverables." MemoryStorage scans keys in lexicographic
    // order, so the chosen IDs interleave running and pending workflows
    // when sorted: a, b, c, d.
    const storage = new MemoryStorage();
    const firstEngine = new Engine({ storage });
    firstEngine.register(
      workflow({ name: 'order-known' }).execute(async function* (ctx) {
        yield* ctx.waitForSignal('go');
        return 'done';
      }),
    );

    await firstEngine.start('order-known', null, { id: 'order-a-running' });
    await flush();
    await seedStoredWorkflowState(storage, 'order-b-pending', 'order-known', 'pending');
    await firstEngine.start('order-known', null, { id: 'order-c-running' });
    await flush();
    await seedStoredWorkflowState(storage, 'order-d-pending', 'order-known', 'pending');
    firstEngine[Symbol.dispose]();

    const recoveredEngine = new Engine({ storage });
    recoveredEngine.register(
      workflow({ name: 'order-known' }).execute(async function* (ctx) {
        yield* ctx.waitForSignal('go');
        return 'done';
      }),
    );

    const handles = await recoveredEngine.recoverAll();
    expect(handles.map((handle) => handle.id)).toEqual([
      'order-a-running',
      'order-b-pending',
      'order-c-running',
      'order-d-pending',
    ]);

    recoveredEngine[Symbol.dispose]();
  });

  it('WorkflowTypeNotRegisteredForRecoveryError carries sorted full lists with capped samples and redacted messages', async () => {
    const storage = new MemoryStorage();
    for (let index = 0; index < 22; index += 1) {
      const typeIndex = String(index % 12).padStart(2, '0');
      const workflowIndex = String(index).padStart(2, '0');
      await seedStoredWorkflowState(
        storage,
        `shape-workflow-${workflowIndex}`,
        `shape-type-${typeIndex}`,
        'running',
      );
    }

    const engine = new Engine({ storage });
    engine.register(
      workflow({ name: 'registered-shape-type' }).execute(async function* () {
        return 'registered';
      }),
    );

    try {
      await engine.recoverAll();
      expect.unreachable('recoverAll should throw for unknown stored workflow types');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowTypeNotRegisteredForRecoveryError);
      const typedError = error as WorkflowTypeNotRegisteredForRecoveryError;
      expect(typedError.registeredTypes).toEqual(['registered-shape-type']);
      expect(typedError.missingTypes).toEqual([
        'shape-type-00',
        'shape-type-01',
        'shape-type-02',
        'shape-type-03',
        'shape-type-04',
        'shape-type-05',
        'shape-type-06',
        'shape-type-07',
        'shape-type-08',
        'shape-type-09',
        'shape-type-10',
        'shape-type-11',
      ]);
      expect(typedError.missingWorkflowCount).toBe(22);
      expect(typedError.missingWorkflowSamples).toHaveLength(20);
      expect(typedError.samplesTruncated).toBe(true);
      expect(typedError.message).toContain('shape-type-00');
      expect(typedError.message).toContain('+2 more');
      expect(typedError.message).not.toContain('shape-workflow-00');
    }

    engine[Symbol.dispose]();
  });

  it('resumes a multi-step workflow without re-executing completed steps', async () => {
    const storage = new MemoryStorage();
    let step1Calls = 0;
    let step2Calls = 0;
    let step3Calls = 0;

    const step1 = async (...args: unknown[]) => {
      step1Calls++;
      return `step1:${String(args[0])}`;
    };

    const step2 = async (...args: unknown[]) => {
      step2Calls++;
      return `step2:${String(args[0])}`;
    };

    const step3 = async (...args: unknown[]) => {
      step3Calls++;
      return `step3:${String(args[0])}`;
    };

    function makeWorkflow() {
      return workflow({ name: 'multi-step' }).execute(async function* (ctx, input: unknown) {
        const c = ctx;
        const { value } = input as { value: string };
        const r1 = yield* c.run(step1, value);
        const r2 = yield* c.run(step2, r1);
        const r3 = yield* c.run(step3, r2);
        return r3;
      });
    }

    // --- First engine: run step 1, then "crash" ---
    const engine1 = new Engine({ storage });
    engine1.register(makeWorkflow());

    const handle1 = await engine1.start('multi-step', { value: 'hello' });

    // Wait for step 1 to complete (the workflow will continue to completion
    // since activities run inline, so we let it finish and check the counts)
    const result1 = await handle1.result();
    expect(result1).toBe('step3:step2:step1:hello');
    expect(step1Calls).toBe(1);
    expect(step2Calls).toBe(1);
    expect(step3Calls).toBe(1);

    // "Crash" the engine
    engine1[Symbol.dispose]();

    // Reset call counts to detect re-execution
    step1Calls = 0;
    step2Calls = 0;
    step3Calls = 0;

    // --- Second engine: recover ---
    const engine2 = new Engine({ storage });
    engine2.register(makeWorkflow());

    // The workflow is completed, so recoverAll should not resume it
    const handles = await engine2.recoverAll();
    expect(handles).toHaveLength(0);

    // Steps should not have been called
    expect(step1Calls).toBe(0);
    expect(step2Calls).toBe(0);
    expect(step3Calls).toBe(0);

    engine2[Symbol.dispose]();
  });

  it('resumes a workflow mid-execution and skips completed steps', async () => {
    const storage = new MemoryStorage();
    let step1Calls = 0;
    let step2Calls = 0;

    const step1 = async (...args: unknown[]) => {
      step1Calls++;
      return `result1:${String(args[0])}`;
    };

    const step2 = async (...args: unknown[]) => {
      step2Calls++;
      return `result2:${String(args[0])}`;
    };

    function makeWorkflow() {
      return workflow({ name: 'resumable' }).execute(async function* (ctx, input: unknown) {
        const c = ctx;
        const r1 = yield* c.run(step1, input);
        // This signal wait will block, simulating a "crash point"
        const signal = yield* c.waitForSignal<string>('proceed');
        const r2 = yield* c.run(step2, `${r1}:${signal}`);
        return r2;
      });
    }

    // --- First engine: step1 completes, then waiting for signal ---
    const engine1 = new Engine({ storage });
    engine1.register(makeWorkflow());

    await engine1.start('resumable', 'hello', { id: 'wf-resume-mid' });
    await flush();

    expect(step1Calls).toBe(1);
    expect(step2Calls).toBe(0);

    // "Crash" while waiting for signal
    engine1[Symbol.dispose]();

    // Reset counters
    step1Calls = 0;
    step2Calls = 0;

    // --- Second engine: resume ---
    const engine2 = new Engine({ storage });
    engine2.register(makeWorkflow());

    const handles = await engine2.recoverAll();
    expect(handles).toHaveLength(1);

    const handle2 = handles[0]!;
    await flush();

    // Step 1 should NOT be re-executed (it was checkpointed)
    expect(step1Calls).toBe(0);

    // Send the signal to unblock the workflow
    await engine2.signal('wf-resume-mid', 'proceed', 'go');
    await flush();

    const result = await handle2.result();
    expect(result).toBe('result2:result1:hello:go');
    expect(step2Calls).toBe(1);

    engine2[Symbol.dispose]();
  });

  it('resumes after crash during signal wait', async () => {
    const storage = new MemoryStorage();

    function makeWorkflow() {
      return workflow({ name: 'signal-wait' }).execute(async function* (ctx) {
        const c = ctx;
        const approval = yield* c.waitForSignal<{ approved: boolean }>('approval');
        return { approved: approval.approved };
      });
    }

    // Start workflow, crash before signal
    const engine1 = new Engine({ storage });
    engine1.register(makeWorkflow());
    await engine1.start('signal-wait', null, { id: 'wf-signal' });
    await flush();
    engine1[Symbol.dispose]();

    // Recover and send signal
    const engine2 = new Engine({ storage });
    engine2.register(makeWorkflow());
    const handles = await engine2.recoverAll();
    expect(handles).toHaveLength(1);
    await flush();

    await engine2.signal('wf-signal', 'approval', { approved: true });
    const result = await handles[0]!.result();
    expect(result).toEqual({ approved: true });

    engine2[Symbol.dispose]();
  });

  it('does not re-consume a wait-signal that already won a ctx.race when recovering from a durable crash (#456)', async () => {
    // A ctx.race won by waitForSignal consumes the durable `sig:` record and
    // checkpoints the CONSUMED value (not the deferred-consume envelope, which
    // carries a function and cannot encode). After a full crash — a new Engine on
    // the same durable storage, with no in-memory cache — replay must short-circuit
    // the race from its checkpointed value, NOT re-run the branch. Re-running would
    // re-consume a now-deleted record and yield `undefined` (a different winner on
    // replay = non-determinism). This is the durable analogue of the in-memory
    // park/resume replay test in race-branches.test.ts.
    const storage = new MemoryStorage();

    function makeWorkflow() {
      return workflow({ name: 'race-signal-crash' }).execute(async function* (ctx) {
        const c = ctx;
        const winner = yield* c.race([c.waitForSignal<string>('ev'), c.sleep('30s')]);
        // Crash point: park on a second signal so the race is checkpointed before
        // the workflow can finish.
        const gate = yield* c.waitForSignal<string>('gate');
        return { winner, gate };
      });
    }

    // Detect a buffered `ev` signal record directly in durable storage (the
    // `sig:<encoded-id>:ev:` keyspace), so the assertions below do not reach into
    // engine internals from outside the engine module.
    const evSignalPrefix = `sig:${encodeStorageKeyComponent('wf-race-signal')}:${encodeStorageKeyComponent('ev')}:`;
    const hasBufferedEv = async () => {
      for await (const _entry of storage.scan(evSignalPrefix, { limit: 1 })) return true;
      return false;
    };

    // First engine: deliver `ev` so the race resolves and checkpoints, then crash
    // while parked on `gate`.
    const engine1 = new Engine({ storage });
    engine1.register(makeWorkflow());
    await engine1.start('race-signal-crash', null, { id: 'wf-race-signal' });
    await flush();
    await engine1.signal('wf-race-signal', 'ev', 'ev-payload');
    // Wait until the race has actually consumed `ev` and checkpointed — proving
    // the race settled BEFORE the crash, rather than racing two `flush()` calls.
    // The consumed `ev` record being gone is the durable evidence the race won and
    // committed; recovery therefore cannot pass by consuming the original `ev` for
    // the first time.
    await waitForCondition(async () => !(await hasBufferedEv()), {
      timeoutMs: 2000,
      label: 'race consumed the ev signal and checkpointed before the crash',
    });
    expect(await storage.get(STORAGE_KEYS.checkpoint('wf-race-signal'))).not.toBeNull();
    engine1[Symbol.dispose]();

    // Recover from durable storage: no in-memory accumulatedResults survives.
    const engine2 = new Engine({ storage });
    engine2.register(makeWorkflow());
    const handles = await engine2.recoverAll();
    expect(handles).toHaveLength(1);
    await flush();

    // Unblock the gate; the recovered run must report the race winner it already
    // consumed before the crash.
    await engine2.signal('wf-race-signal', 'gate', 'gate-payload');
    const result = (await handles[0]!.result()) as { winner: unknown; gate: unknown };
    // If recovery re-consumed the (now-deleted) record, winner would be undefined.
    expect(result.winner).toBe('ev-payload');
    expect(result.gate).toBe('gate-payload');

    engine2[Symbol.dispose]();
  });

  it('resumes after crash during sleep and completes when timer fires', async () => {
    const { TestEngine } = await import('../testing/test-engine.ts');

    const sleeperWorkflow = workflow({ name: 'sleeper' }).execute(async function* (ctx) {
      const c = ctx;
      yield* c.sleep(5000);
      return 'awake';
    });

    const engine1 = new TestEngine({ startTime: 1000 });
    engine1.register(sleeperWorkflow);

    await engine1.start('sleeper', null, { id: 'wf-sleep' });
    await flush();

    // Recover using TestEngine.recover() which copies storage
    const engine2 = engine1.recover();
    engine2.register(sleeperWorkflow);

    const handles = await engine2.recoverAll();
    expect(handles).toHaveLength(1);
    await flush();

    // Advance time past the sleep duration
    await engine2.advanceTime(6000);
    await flush();

    const result = await handles[0]!.result();
    expect(result).toBe('awake');

    engine1[Symbol.dispose]();
    engine2[Symbol.dispose]();
  });

  it('re-arms the same durable sleep timer on recovery instead of orphaning a second one', async () => {
    // Regression: the sleep operationId is minted once and persisted in
    // checkpointLocals so it is stable across replay. When a workflow crashes
    // while parked on ctx.sleep, the step never lands in accumulatedResults, so
    // recovery re-enters the sleep branch. If recovery minted a fresh id, it
    // would arm a SECOND durable timer under a new key while the original timer
    // is orphaned — the engine fires the orphaned timer, the replayed generator
    // waits on the new one, and the workflow hangs. Reading the persisted id back
    // re-arms the original key so exactly one timer survives.
    const storage = new MemoryStorage();
    let currentTime = 1000;

    const sleeper = workflow({ name: 'sleeper' }).execute(async function* (ctx) {
      yield* ctx.sleep(5000);
      return 'awake';
    });

    const engine1 = new Engine({ storage, getNow: () => currentTime });
    engine1.register(sleeper);
    await engine1.start('sleeper', null, { id: 'wf-sleep-deterministic' });
    await flush();

    const timerKeysBeforeCrash: string[] = [];
    for await (const [key] of storage.scan('timer-idx:sleep:')) {
      timerKeysBeforeCrash.push(key);
    }
    expect(timerKeysBeforeCrash).toHaveLength(1);

    // Crash while still parked — do NOT advance past the deadline, so recovery
    // re-arms the timer rather than taking the expired-timer fast path.
    engine1[Symbol.dispose]();

    // Fresh engine on the same storage; the in-memory sleep resolver is gone.
    const engine2 = new Engine({ storage, getNow: () => currentTime });
    engine2.register(sleeper);
    const handles = await engine2.recoverAll();
    expect(handles).toHaveLength(1);
    await flush();

    const timerKeysAfterRecovery: string[] = [];
    for await (const [key] of storage.scan('timer-idx:sleep:')) {
      timerKeysAfterRecovery.push(key);
    }
    expect(timerKeysAfterRecovery).toEqual(timerKeysBeforeCrash);

    // A single tick past the deadline must fire the re-armed timer and complete.
    currentTime = 7000;
    await engine2.scheduler.tick(currentTime);
    await flush();
    expect(await handles[0]!.result()).toBe('awake');

    engine2[Symbol.dispose]();
  });

  it('does not let a stale sleep timer from a terminated run resolve a start-new replacement early', async () => {
    // Regression (per-run nonce): a run cancelled while parked on ctx.sleep
    // leaves its durable timer behind (terminal cleanup only drops the in-memory
    // resolver; purge does not collect sleep timers). If the id is restarted with
    // onTerminalConflict: 'start-new' and the fresh run sleeps at the same step,
    // a `${workflowId}:${step}` operationId would give the new run the SAME timer
    // key — the stale timer firing would resolve the new run's sleep early. A
    // per-run nonce makes the ids differ so the stale timer cannot match.
    const storage = new MemoryStorage();
    let currentTime = 1000;

    const sleeper = workflow({ name: 'sleeper' }).execute(async function* (ctx) {
      yield* ctx.sleep(5000);
      return 'awake';
    });

    const engine = new Engine({ storage, getNow: () => currentTime });
    engine.register(sleeper);

    // First run parks on a durable sleep timer (deadline 1000 + 5000 = 6000).
    await engine.start('sleeper', null, { id: 'wf-restart' });
    await flush();

    // Cancel while parked. The durable timer must survive (otherwise the scenario
    // this guards is not reachable) — confirm it is still in storage.
    await engine.cancel('wf-restart');
    await flush();
    const staleTimers: string[] = [];
    for await (const [key] of storage.scan('timer-idx:sleep:')) staleTimers.push(key);
    expect(staleTimers).toHaveLength(1);

    // Restart the same id; the fresh run parks at the same step (deadline
    // 2000 + 5000 = 7000), distinct from the stale timer's 6000 deadline.
    currentTime = 2000;
    const replacement = await engine.start('sleeper', null, {
      id: 'wf-restart',
      onTerminalConflict: 'start-new',
    });
    await flush();

    // Fire the STALE timer (deadline 6000) — it must NOT resolve the fresh run,
    // whose own deadline (7000) has not elapsed.
    currentTime = 6500;
    await engine.scheduler.tick(currentTime);
    await flush();
    const stateAfterStaleTimer = await engine.get('wf-restart');
    expect(stateAfterStaleTimer?.status).toBe('running');

    // The fresh run's own timer fires at its deadline and completes it.
    currentTime = 7500;
    await engine.scheduler.tick(currentTime);
    await flush();
    expect(await replacement.result()).toBe('awake');

    engine[Symbol.dispose]();
  });

  it('resolves expired sleep immediately on resume via fast path', async () => {
    const { MemoryStorage: TestMemoryStorage } = await import('../storage/memory.ts');

    const storage = new TestMemoryStorage();
    let currentTime = 1000;

    const sleeperFastPath = workflow({ name: 'sleeper' }).execute(async function* (ctx) {
      const c = ctx;
      yield* c.sleep(5000);
      return 'fast-path-awake';
    });

    // First engine: start workflow, then "crash" while sleep is pending
    const engine1 = new Engine({ storage, getNow: () => currentTime });
    engine1.register(sleeperFastPath);

    await engine1.start('sleeper', null, { id: 'wf-sleep-fast' });
    await flush();

    // Workflow is now blocked on the sleep timer (scheduledFireAt = 1000 + 5000 = 6000).
    // Simulate crash by disposing without letting the timer fire.
    engine1[Symbol.dispose]();

    // Simulate time passing during the crash: restart well past the sleep deadline.
    currentTime = 20_000;

    // Second engine: resume with the same storage at a time after the sleep expired.
    const engine2 = new Engine({ storage, getNow: () => currentTime });
    engine2.register(sleeperFastPath);

    const handles = await engine2.recoverAll();
    expect(handles).toHaveLength(1);
    await flush();

    // The sleep should have resolved immediately via the expired-timer fast path
    // without needing to schedule or fire a new timer.
    const result = await handles[0]!.result();
    expect(result).toBe('fast-path-awake');

    engine2[Symbol.dispose]();
  });

  it('post-recovery sleeps use current time, not stale checkpoint time', async () => {
    const { MemoryStorage: TestMemoryStorage } = await import('../storage/memory.ts');

    const storage = new TestMemoryStorage();
    let currentTime = 1000;

    // Workflow: sleep 2s, then sleep 3s, return
    const twoSleepWorkflow = workflow({ name: 'two-sleep' }).execute(async function* (ctx) {
      const c = ctx;
      yield* c.sleep(2000);
      yield* c.sleep(3000);
      return 'both-done';
    });

    // First engine: start workflow, crash while the first sleep is pending.
    const engine1 = new Engine({ storage, getNow: () => currentTime });
    engine1.register(twoSleepWorkflow);

    await engine1.start('two-sleep', null, { id: 'wf-two-sleep' });
    await flush();

    engine1[Symbol.dispose]();

    // Simulate time passing during the crash: restart well past the first
    // sleep's deadline (1000 + 2000 = 3000) but NOT past a hypothetical
    // second sleep that starts at recovery time (10000 + 3000 = 13000).
    currentTime = 10_000;

    const engine2 = new Engine({ storage, getNow: () => currentTime });
    engine2.register(twoSleepWorkflow);

    const handles = await engine2.recoverAll();
    expect(handles).toHaveLength(1);
    await flush();

    // The first sleep should have resolved immediately via the fast path.
    // The second sleep should schedule at currentTime + 3000 = 13000.
    // Advance time past the second sleep's deadline.
    currentTime = 14_000;
    await engine2.scheduler.tick(currentTime);
    await flush();

    const result = await handles[0]!.result();
    expect(result).toBe('both-done');

    engine2[Symbol.dispose]();
  });

  it('does not resume completed workflows', async () => {
    const storage = new MemoryStorage();

    const engine1 = new Engine({ storage });
    engine1.register(
      workflow({ name: 'simple' }).execute(async function* (_ctx, input: unknown) {
        return `done:${String(input)}`;
      }),
    );

    const handle = await engine1.start('simple', 'test');
    await handle.result();
    engine1[Symbol.dispose]();

    // Recover — no running workflows to resume
    const engine2 = new Engine({ storage });
    engine2.register(
      workflow({ name: 'simple' }).execute(async function* () {
        return 'should not run';
      }),
    );

    const handles = await engine2.recoverAll();
    expect(handles).toHaveLength(0);

    engine2[Symbol.dispose]();
  });

  it('does not resume failed workflows', async () => {
    const storage = new MemoryStorage();

    const engine1 = new Engine({ storage });
    engine1.register(
      workflow({ name: 'failing' }).execute(async function* (ctx) {
        const c = ctx;
        yield* c.run(async () => {
          throw new Error('boom');
        });
      }),
    );

    const handle = await engine1.start('failing', null);
    await expect(handle.result()).rejects.toThrow('boom');
    engine1[Symbol.dispose]();

    // Recover — no running workflows
    const engine2 = new Engine({ storage });
    engine2.register(
      workflow({ name: 'failing' }).execute(async function* () {
        return 'should not run';
      }),
    );

    const handles = await engine2.recoverAll();
    expect(handles).toHaveLength(0);

    engine2[Symbol.dispose]();
  });

  it('dispatches WorkflowResumedEvent on resume', async () => {
    const storage = new MemoryStorage();

    function makeWorkflow() {
      return workflow({ name: 'event-test' }).execute(async function* (ctx) {
        const c = ctx;
        yield* c.waitForSignal('go');
        return 'done';
      });
    }

    const engine1 = new Engine({ storage });
    engine1.register(makeWorkflow());
    await engine1.start('event-test', null, { id: 'wf-event' });
    await flush();
    engine1[Symbol.dispose]();

    const engine2 = new Engine({ storage });
    engine2.register(makeWorkflow());

    const events: WorkflowResumedEvent[] = [];
    engine2.addEventListener(WorkflowResumedEvent.type, (event) => {
      events.push(event);
    });

    await engine2.recoverAll();
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0]!.workflowId).toBe('wf-event');
    // The workflow ran one activity (step 0) and checkpointed before blocking on
    // the signal, so recovery resumes from step 1 — pin the exact value rather
    // than a `>= 0` floor that would pass even if resume accounting regressed.
    expect(events[0]!.fromStep).toBe(1);

    // Clean up — send signal so workflow completes
    await engine2.signal('wf-event', 'go', null);
    await flush();

    engine2[Symbol.dispose]();
  });

  it('checkpoint step number advances correctly', async () => {
    const storage = new MemoryStorage();

    const engine = new Engine({ storage });
    engine.register(
      workflow({ name: 'stepping' }).execute(async function* (ctx) {
        const c = ctx;
        yield* c.run(async () => 'a');
        yield* c.run(async () => 'b');
        yield* c.run(async () => 'c');
        return 'done';
      }),
    );

    const handle = await engine.start('stepping', null, { id: 'wf-step' });
    await handle.result();

    // The checkpoint should reflect the final state
    const { deserializeCheckpoint } = await import('./checkpoint.ts');
    const { KEYS } = await import('../storage/interface.ts');
    const bytes = await storage.get(KEYS.checkpoint('wf-step'));
    expect(bytes).not.toBeNull();

    const checkpoint = deserializeCheckpoint(bytes!);
    // 3 activities = 3 yield boundaries, so the final checkpoint lands at exactly
    // step 3. Pin it: a `>= 3` floor would not catch an off-by-one that advanced
    // the step too far.
    expect(checkpoint.step).toBe(3);

    engine[Symbol.dispose]();
  });

  it('prunes consumed accumulated results from the checkpoint and recovers them from replay history', async () => {
    const storage = new MemoryStorage();
    let activityCalls = 0;
    const activityCount = 20;

    const engine = new Engine({ storage });
    engine.register(
      workflow({ name: 'accumulating' }).execute(async function* (ctx) {
        const results: string[] = [];
        for (let index = 0; index < activityCount; index += 1) {
          results.push(
            yield* ctx.run(async () => {
              activityCalls += 1;
              return `value-${index}`;
            }),
          );
        }
        const signal = yield* ctx.waitForSignal<string>('go');
        return { results, signal };
      }),
    );

    await engine.start('accumulating', null, { id: 'wf-accum' });
    await flush();
    expect(activityCalls).toBe(activityCount);

    const { deserializeCheckpoint } = await import('./checkpoint.ts');
    const { KEYS } = await import('../storage/interface.ts');
    const bytes = await storage.get(KEYS.checkpoint('wf-accum'));
    expect(bytes).not.toBeNull();

    const checkpoint = deserializeCheckpoint(bytes!);
    expect(checkpoint.accumulatedResults).toEqual([]);

    activityCalls = 0;
    engine[Symbol.dispose]();

    const recoveredEngine = new Engine({ storage });
    recoveredEngine.register(
      workflow({ name: 'accumulating' }).execute(async function* (ctx) {
        const results: string[] = [];
        for (let index = 0; index < activityCount; index += 1) {
          results.push(
            yield* ctx.run(async () => {
              activityCalls += 1;
              return `value-${index}`;
            }),
          );
        }
        const signal = yield* ctx.waitForSignal<string>('go');
        return { results, signal };
      }),
    );

    const handles = await recoveredEngine.recoverAll();
    expect(handles.map((handle) => handle.id)).toEqual(['wf-accum']);
    expect(activityCalls).toBe(0);

    await recoveredEngine.signal('wf-accum', 'go', 'resumed');
    await flush();
    await expect(recoveredEngine.getHandle('wf-accum').result()).resolves.toEqual({
      results: Array.from({ length: activityCount }, (_, index) => `value-${index}`),
      signal: 'resumed',
    });

    recoveredEngine[Symbol.dispose]();
  });

  it('keeps inline serialized checkpoints bounded by pending results instead of all completed steps', async () => {
    const storage = new MemoryStorage();
    const activityCount = 25;
    const activityResult = { value: 'x'.repeat(200) };

    const engine = new Engine({ storage, checkpointHistory: activityCount + 2 });
    engine.register(
      workflow({ name: 'bounded-inline-checkpoint' }).execute(async function* (ctx) {
        for (let index = 0; index < activityCount; index += 1) {
          yield* ctx.run(async () => activityResult);
        }
        yield* ctx.waitForSignal('go');
        return 'done';
      }),
    );

    await engine.start('bounded-inline-checkpoint', null, { id: 'wf-bounded-inline' });
    await flush();

    const { deserializeCheckpoint } = await import('./checkpoint.ts');
    const { KEYS } = await import('../storage/interface.ts');
    const historySizes: number[] = [];

    for await (const [, checkpointBytes] of storage.scan(
      `${KEYS.checkpoint('wf-bounded-inline')}:`,
    )) {
      const checkpoint = deserializeCheckpoint(checkpointBytes);
      expect(checkpoint.accumulatedResults.length).toBeLessThanOrEqual(1);
      historySizes.push(checkpointBytes.byteLength);
    }

    expect(historySizes.length).toBeGreaterThan(10);
    expect(Math.max(...historySizes)).toBeLessThan(1_500);

    await engine.signal('wf-bounded-inline', 'go', null);
    await flush();
    engine[Symbol.dispose]();
  });

  it('recovers old unpruned checkpoints that have no replay-history payloads', async () => {
    const storage = new MemoryStorage();
    await seedStoredWorkflowState(storage, 'wf-old-accum', 'old-accumulating', 'running');

    const { createCheckpoint, serializeCheckpoint } = await import('./checkpoint.ts');
    const { KEYS } = await import('../storage/interface.ts');
    await storage.put(
      KEYS.checkpoint('wf-old-accum'),
      serializeCheckpoint({
        ...createCheckpoint('wf-old-accum', '1'),
        step: 2,
        accumulatedResults: [[0, 'old-result']],
      }),
    );

    let activityCalls = 0;
    const recoveredEngine = new Engine({ storage });
    recoveredEngine.register(
      workflow({ name: 'old-accumulating' }).execute(async function* (ctx) {
        const result = yield* ctx.run(async () => {
          activityCalls += 1;
          return 'new-result';
        });
        const signal = yield* ctx.waitForSignal<string>('go');
        return { result, signal };
      }),
    );

    const handles = await recoveredEngine.recoverAll();
    expect(handles.map((handle) => handle.id)).toEqual(['wf-old-accum']);
    expect(activityCalls).toBe(0);

    await recoveredEngine.signal('wf-old-accum', 'go', 'resumed');
    await flush();
    await expect(recoveredEngine.getHandle('wf-old-accum').result()).resolves.toEqual({
      result: 'old-result',
      signal: 'resumed',
    });

    recoveredEngine[Symbol.dispose]();
  });

  it('recovers pruned checkpoints after event-log compaction folds replay payloads into the watermark', async () => {
    const storage = new MemoryStorage();
    let activityCalls = 0;
    const activityCount = 6;

    const engine = new Engine({ storage, history: { retentionWindow: 1 } });
    engine.register(
      workflow({ name: 'compacted-accumulating' }).execute(async function* (ctx) {
        const results: string[] = [];
        for (let index = 0; index < activityCount; index += 1) {
          results.push(
            yield* ctx.run(async () => {
              activityCalls += 1;
              return `compacted-${index}`;
            }),
          );
        }
        const signal = yield* ctx.waitForSignal<string>('go');
        return { results, signal };
      }),
    );

    await engine.start('compacted-accumulating', null, { id: 'wf-compacted-accum' });
    await flush();
    expect(activityCalls).toBe(activityCount);

    const { KEYS } = await import('../storage/interface.ts');
    expect(await storage.get(KEYS.event('wf-compacted-accum', 0))).toBeNull();

    activityCalls = 0;
    engine[Symbol.dispose]();

    const recoveredEngine = new Engine({ storage, history: { retentionWindow: 1 } });
    recoveredEngine.register(
      workflow({ name: 'compacted-accumulating' }).execute(async function* (ctx) {
        const results: string[] = [];
        for (let index = 0; index < activityCount; index += 1) {
          results.push(
            yield* ctx.run(async () => {
              activityCalls += 1;
              return `compacted-${index}`;
            }),
          );
        }
        const signal = yield* ctx.waitForSignal<string>('go');
        return { results, signal };
      }),
    );

    const handles = await recoveredEngine.recoverAll();
    expect(handles.map((handle) => handle.id)).toEqual(['wf-compacted-accum']);
    expect(activityCalls).toBe(0);

    await recoveredEngine.signal('wf-compacted-accum', 'go', 'resumed');
    await flush();
    await expect(recoveredEngine.getHandle('wf-compacted-accum').result()).resolves.toEqual({
      results: Array.from({ length: activityCount }, (_, index) => `compacted-${index}`),
      signal: 'resumed',
    });

    recoveredEngine[Symbol.dispose]();
  });

  it('restores event log head on resume so the next checkpoint does not overwrite prior entries', async () => {
    const storage = new MemoryStorage();

    // Workflow that blocks on a signal so we can inspect the event log mid-run.
    function makeWorkflow() {
      return workflow({ name: 'event-log-resume' }).execute(async function* (ctx) {
        const c = ctx;
        // Run one activity so a checkpoint is written before we crash.
        yield* c.run(async () => 'step-one');
        // Block here to simulate the engine crashing while still running.
        yield* c.waitForSignal<string>('resume-signal');
        return 'done';
      });
    }

    // --- Engine 1: start the workflow, let step-one checkpoint flush, then crash ---
    const engine1 = new Engine({ storage });
    engine1.register(makeWorkflow());
    await engine1.start('event-log-resume', null, { id: 'wf-el-resume' });
    await flush();
    engine1[Symbol.dispose]();

    // Read the event log head that engine1 wrote.
    const { EventLog: EventLogClass } = await import('./event-log.ts');
    const logBeforeRestart = new EventLogClass(storage, 'wf-el-resume');
    const headBeforeRestart = await logBeforeRestart.loadHead();

    // engine1 wrote one activity checkpoint before crashing: the start event is
    // sequence 0 and that checkpoint is sequence 1, so the head sits at exactly
    // 1. Pin it rather than a `>= 0` floor that any non-empty log would satisfy.
    expect(headBeforeRestart.sequence).toBe(1);

    // --- Engine 2: resume the same workflow ---
    const engine2 = new Engine({ storage });
    engine2.register(makeWorkflow());
    const handles = await engine2.recoverAll();
    expect(handles).toHaveLength(1);
    await flush();

    // Send the signal so the workflow runs to completion (writing another checkpoint).
    await engine2.signal('wf-el-resume', 'resume-signal', 'go');
    await flush();

    // Read the event log head after engine2 wrote its checkpoint.
    const logAfterResume = new EventLogClass(storage, 'wf-el-resume');
    const headAfterResume = await logAfterResume.loadHead();

    // The sequence must have advanced beyond what engine1 left behind.
    // Before the fix, engine2 would reset to sequence 0, overwriting entry 0.
    expect(headAfterResume.sequence).toBeGreaterThan(headBeforeRestart.sequence);

    // The hash chain must be intact across the restart boundary.
    const verifyResult = await logAfterResume.verify();
    expect(verifyResult.valid).toBe(true);

    engine2[Symbol.dispose]();
  });

  it('resume uses BunSQLiteStorage as backend', async () => {
    const { BunSQLiteStorage } = await import('../storage/bun-sql.ts');

    using storage = new BunSQLiteStorage(':memory:');

    function makeWorkflow() {
      return workflow({ name: 'sqlite-resume' }).execute(async function* (ctx) {
        const c = ctx;
        yield* c.waitForSignal('go');
        return 'sqlite-recovered';
      });
    }

    // Start and crash
    const engine1 = new Engine({ storage });
    engine1.register(makeWorkflow());
    await engine1.start('sqlite-resume', null, { id: 'wf-sqlite' });
    await flush();

    // Clear in-memory state (simulate crash) without disposing storage
    // We can't dispose engine1 because it would try to close storage
    // Instead, create engine2 with the same storage directly
    const engine2 = new Engine({ storage });
    engine2.register(makeWorkflow());

    const handles = await engine2.recoverAll();
    expect(handles).toHaveLength(1);
    await flush();

    await engine2.signal('wf-sqlite', 'go', null);
    const result = await handles[0]!.result();
    expect(result).toBe('sqlite-recovered');
  });

  it('Engine.create recovers by default against durable storage and resumes a parked workflow', async () => {
    const { BunSQLiteStorage } = await import('../storage/bun-sql.ts');

    using storage = new BunSQLiteStorage(':memory:');

    // The post-signal activity is the *observable resumed effect*: it only
    // fires if the second engine actually drove the workflow past the park
    // point, not if it merely read stored state.
    let postSignalActivityCalls = 0;
    function makeWorkflow() {
      return workflow({ name: 'default-recover-parked' }).execute(async function* (ctx) {
        const c = ctx;
        const release = yield* c.waitForSignal<string>('release');
        return yield* c.run(async () => {
          postSignalActivityCalls += 1;
          return `resumed:${release}`;
        });
      });
    }

    // First engine via Engine.create stamps the schema-version sentinel so the
    // recovering engine opens the store through the current schema gate. Set
    // recover: false because the store is empty and there is nothing to resume yet.
    const engine1 = await Engine.create({
      storage,
      workflows: { 'default-recover-parked': makeWorkflow() },
      recover: false,
    });
    await engine1.start('default-recover-parked', null, { id: 'wf-default-recover' });
    await flush();
    expect(postSignalActivityCalls).toBe(0);
    engine1[Symbol.dispose]();

    // Second engine via Engine.create with NO `recover` field — recovery is the
    // default, so the parked workflow must resume on construction.
    const recovered = await Engine.create({
      storage,
      workflows: { 'default-recover-parked': makeWorkflow() },
    });
    await recovered.signal('wf-default-recover', 'release', 'go');
    const result = await recovered.getHandle('wf-default-recover').result();
    expect(result).toBe('resumed:go');
    // The resumed effect actually executed exactly once.
    expect(postSignalActivityCalls).toBe(1);
    recovered[Symbol.dispose]();
  });

  it('Engine.create({ recover: false }) leaves a parked workflow dormant without executing its next step', async () => {
    const { BunSQLiteStorage } = await import('../storage/bun-sql.ts');

    using storage = new BunSQLiteStorage(':memory:');

    let postSignalActivityCalls = 0;
    function makeWorkflow() {
      return workflow({ name: 'opt-out-parked' }).execute(async function* (ctx) {
        const c = ctx;
        const release = yield* c.waitForSignal<string>('release');
        return yield* c.run(async () => {
          postSignalActivityCalls += 1;
          return `resumed:${release}`;
        });
      });
    }

    const engine1 = await Engine.create({
      storage,
      workflows: { 'opt-out-parked': makeWorkflow() },
      recover: false,
    });
    await engine1.start('opt-out-parked', null, { id: 'wf-opt-out' });
    await flush();
    engine1[Symbol.dispose]();

    // recover: false opts out — the workflow stays running in storage and no
    // resumed effect fires, even though the engine registered the type.
    const resumedEvents: WorkflowResumedEvent[] = [];
    const inspecting = await Engine.create({
      storage,
      workflows: { 'opt-out-parked': makeWorkflow() },
      recover: false,
    });
    inspecting.addEventListener(WorkflowResumedEvent.type, (event) => {
      resumedEvents.push(event);
    });
    await flush();
    const dormantState = await inspecting.get('wf-opt-out');
    expect(dormantState?.status).toBe('running');
    // No WorkflowResumedEvent proves the engine did not call recoverAll() at
    // all — even a resume that re-parks at the signal would emit this event.
    // postSignalActivityCalls === 0 alone would not distinguish "no recovery"
    // from "recovered but still parked."
    expect(resumedEvents).toHaveLength(0);
    expect(postSignalActivityCalls).toBe(0);
    inspecting[Symbol.dispose]();
  });

  it('Engine.create recovering by default throws on an unregistered stored type, suppressible with acknowledgeUnknownWorkflowTypes', async () => {
    const storage = new MemoryStorage();
    await seedStoredWorkflowState(storage, 'unknown-default-id', 'unknown-default-type', 'running');

    // No `recover` field: recovery runs by default and the unregistered stored
    // type makes the boot fail loudly rather than silently abandoning it.
    await expect(Engine.create({ storage })).rejects.toBeInstanceOf(
      WorkflowTypeNotRegisteredForRecoveryError,
    );

    // The escape hatch suppresses the throw and skips the unknown workflow.
    const acknowledged = await Engine.create({
      storage,
      acknowledgeUnknownWorkflowTypes: true,
    });
    expect(await acknowledged.get('unknown-default-id')).not.toBeNull();
    acknowledged[Symbol.dispose]();
  });

  it('does not re-execute a keyed activity (idempotencyKey) when recovering from a durable crash (#444)', async () => {
    // Per-activity `idempotencyKey` is the shipped tool-level cross-crash dedup
    // primitive. This pins the recovery contract: an activity that completed
    // before the crash returns its cached result on recovery WITHOUT running the
    // side effect a second time. The activity parks the workflow on a signal AFTER
    // it completes, so recovery re-enters the run while the activity result is
    // already durably recorded — exactly the at-least-once re-drive window where a
    // non-idempotent tool would double-execute.
    const storage = new MemoryStorage();
    let executeCount = 0;
    const sideEffect = activity({
      name: 'side-effect',
      execute: async () => {
        executeCount += 1;
        return `executed-${executeCount}`;
      },
    });

    const buildEngine = () => {
      const engine = new Engine({ storage });
      engine.register(
        workflow({ name: 'idem-crash' })
          .activities({ 'side-effect': sideEffect })
          .execute(async function* (ctx) {
            const first = yield* ctx.run(sideEffect, undefined, { idempotencyKey: 'order:1' });
            // Park AFTER the keyed activity completes so the crash window straddles
            // a recovered run whose activity result is already durable.
            yield* ctx.waitForSignal('gate');
            return first;
          }),
      );
      return engine;
    };

    const firstEngine = buildEngine();
    await firstEngine.start('idem-crash', null, { id: 'idem-crash-444' });
    // The activity executed once and the workflow is parked on 'gate'.
    await waitForCondition(
      async () => {
        const state = await firstEngine.get('idem-crash-444');
        return state?.status === 'running' && executeCount === 1;
      },
      { timeoutMs: 2000, label: 'keyed activity completed and workflow parked' },
    );
    expect(executeCount).toBe(1);
    firstEngine[Symbol.dispose]();

    // Recover on the SAME storage. The keyed activity must NOT re-execute.
    const recoveredEngine = buildEngine();
    await recoveredEngine.recoverAll();
    await recoveredEngine.signal('idem-crash-444', 'gate', null);
    await waitForCondition(
      async () => {
        const state = await recoveredEngine.get('idem-crash-444');
        return state?.status === 'completed';
      },
      { timeoutMs: 2000, label: 'recovered workflow completed' },
    );

    const recovered = await recoveredEngine.get('idem-crash-444');
    expect(recovered?.status).toBe('completed');
    expect(recovered?.result).toBe('executed-1');
    // The side effect ran EXACTLY once across the crash boundary.
    expect(executeCount).toBe(1);
    recoveredEngine[Symbol.dispose]();
  });

  it('measures scheduleToCloseTimeout from the original dispatch across a crash, firing the top-of-loop check on recovery (#449)', async () => {
    // The honest crash scenario the top-of-loop budget check exists for: the
    // backoff sleep is scheduled (catch-branch check passes because the budget is
    // far from exhausted), the workflow parks ON that sleep, then the process is
    // down long past the deadline. On recovery the past-due backoff replays and the
    // TOP-of-loop check fires before attempt 2 is dispatched — because the
    // `dispatchedAt` anchor (T0) survived in the checkpoint, the budget is measured
    // from the original dispatch, NOT reset to the recovery clock.
    const storage = new MemoryStorage();
    const T0 = 1_000_000;
    let executeCount = 0;
    const flaky = activity({
      name: 'flaky',
      // 60s budget, 2s backoff: on engine 1 (clock fixed at T0) the catch-branch
      // check `T0 + 2000 - T0 = 2000 >= 60000` is false, so the 2s backoff IS
      // scheduled and the workflow parks on it. The fixed clock never advances, so
      // the sleep never expires — the crash window stays open until we dispose.
      retry: { maxAttempts: 5, initialBackoff: '2s', backoffMultiplier: 1, maxBackoff: '2s' },
      scheduleToCloseTimeout: 60_000,
      execute: async () => {
        executeCount += 1;
        throw new Error('always-fails');
      },
    });

    const buildEngine = (now: number) => {
      const engine = new Engine({ storage, getNow: () => now });
      engine.register(
        workflow({ name: 'stc-crash' })
          .activities({ flaky })
          .execute(async function* (ctx) {
            return yield* ctx.run(flaky);
          }),
      );
      return engine;
    };

    // Engine 1: attempt 1 fails, the 2s backoff is scheduled, the workflow parks on
    // it (clock frozen at T0 so the timer never fires), and the retry checkpoint —
    // including the dispatchedAt anchor at T0 — is committed.
    const firstEngine = buildEngine(T0);
    await firstEngine.start('stc-crash', null, { id: 'stc-crash-449' });
    await waitForCondition(
      async () => {
        const state = await firstEngine.get('stc-crash-449');
        return state?.status === 'running' && executeCount === 1;
      },
      { timeoutMs: 2000, label: 'attempt 1 failed and the workflow parked on the backoff sleep' },
    );
    expect(executeCount).toBe(1);
    firstEngine[Symbol.dispose]();

    // Engine 2: recover with the clock jumped 120s past T0 — well beyond the 60s
    // budget. The past-due backoff sleep replays and fires immediately, then the
    // top-of-loop check throws (`(T0 + 120_000) - T0 = 120_000 >= 60_000`) before
    // attempt 2 dispatches. If the anchor had been reset to the recovery clock, the
    // budget would measure 0ms elapsed and the activity would wrongly retry.
    const recoveredEngine = buildEngine(T0 + 120_000);
    await recoveredEngine.recoverAll();
    await waitForCondition(
      async () => {
        const state = await recoveredEngine.get('stc-crash-449');
        return state?.status === 'failed';
      },
      { timeoutMs: 2000, label: 'recovered workflow failed at the schedule-to-close boundary' },
    );

    const recovered = await recoveredEngine.get('stc-crash-449');
    expect(recovered?.status).toBe('failed');
    expect(recovered?.failureCategory).toBe('timeout');
    // The activity did NOT run a second time on the recovered engine — the budget
    // (anchored at T0) was already exhausted, so attempt 2 never dispatched.
    expect(executeCount).toBe(1);
    recoveredEngine[Symbol.dispose]();
  });
});

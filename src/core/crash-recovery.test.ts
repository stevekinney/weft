import { sleepForTesting } from '../testing/fake-timers.test-support.ts';
/**
 * End-to-end crash recovery tests.
 *
 * These tests verify the fundamental durable execution guarantee:
 * if the process crashes mid-workflow, a new engine with the same storage
 * resumes from the last checkpoint without re-executing completed steps.
 */

import { describe, expect, it } from 'bun:test';

import { KEYS as STORAGE_KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { encode } from './codec.ts';
import { Engine, WorkflowTypeNotRegisteredForRecoveryError } from './engine.ts';
import { WorkflowRecoverySkippedEvent, WorkflowResumedEvent } from './events.ts';
import type { WorkflowState, WorkflowStatus } from './types.ts';
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
    version: '1',
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
      resumedEvents.push(event as WorkflowResumedEvent);
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
      skippedEvents.push(event as WorkflowRecoverySkippedEvent);
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
      skippedEvents.push(event as WorkflowRecoverySkippedEvent);
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
      events.push(event as WorkflowResumedEvent);
    });

    await engine2.recoverAll();
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0]!.workflowId).toBe('wf-event');
    expect(events[0]!.fromStep).toBeGreaterThanOrEqual(0);

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
    // 3 activities = 3 yield boundaries = step should be >= 3
    expect(checkpoint.step).toBeGreaterThanOrEqual(3);

    engine[Symbol.dispose]();
  });

  it('persists accumulated results in checkpoint', async () => {
    const storage = new MemoryStorage();

    const engine = new Engine({ storage });
    engine.register(
      workflow({ name: 'accumulating' }).execute(async function* (ctx) {
        const c = ctx;
        yield* c.run(async () => 'first');
        // Wait for signal to block the workflow mid-execution
        yield* c.waitForSignal('go');
        return 'done';
      }),
    );

    await engine.start('accumulating', null, { id: 'wf-accum' });
    await flush();

    // Check the checkpoint contains accumulated results
    const { deserializeCheckpoint } = await import('./checkpoint.ts');
    const { KEYS } = await import('../storage/interface.ts');
    const bytes = await storage.get(KEYS.checkpoint('wf-accum'));
    expect(bytes).not.toBeNull();

    const checkpoint = deserializeCheckpoint(bytes!);
    // Should have at least the result from step 0 (the ctx.run)
    expect(checkpoint.accumulatedResults.length).toBeGreaterThan(0);

    // The first accumulated result should be 'first'
    const resultMap = new Map(checkpoint.accumulatedResults);
    expect(resultMap.get(0)).toBe('first');

    // Clean up
    await engine.signal('wf-accum', 'go', null);
    await flush();

    engine[Symbol.dispose]();
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

    // There must be at least one event from engine1's checkpoint write.
    expect(headBeforeRestart.sequence).toBeGreaterThanOrEqual(0);

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
});

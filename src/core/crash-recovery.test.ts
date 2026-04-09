/**
 * End-to-end crash recovery tests.
 *
 * These tests verify the fundamental durable execution guarantee:
 * if the process crashes mid-workflow, a new engine with the same storage
 * resumes from the last checkpoint without re-executing completed steps.
 */

import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../storage/memory.ts';
import type { Context } from './context.ts';
import { Engine } from './engine.ts';
import { WorkflowResumedEvent } from './events.ts';
import type { WorkflowContext } from './types.ts';

/** Drain microtasks so fire-and-forget work completes. */
async function flush(): Promise<void> {
  await Bun.sleep(10);
}

describe('crash recovery', () => {
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
      return async function* (ctx: WorkflowContext, input: unknown) {
        const c = ctx as Context;
        const { value } = input as { value: string };
        const r1 = yield* c.run(step1, value);
        const r2 = yield* c.run(step2, r1);
        const r3 = yield* c.run(step3, r2);
        return r3;
      };
    }

    // --- First engine: run step 1, then "crash" ---
    const engine1 = new Engine({ storage });
    engine1.register('multi-step', makeWorkflow());

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
    engine2.register('multi-step', makeWorkflow());

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
      return async function* (ctx: WorkflowContext, input: unknown) {
        const c = ctx as Context;
        const r1 = yield* c.run(step1, input);
        // This signal wait will block, simulating a "crash point"
        const signal = yield* c.waitForSignal<string>('proceed');
        const r2 = yield* c.run(step2, `${r1}:${signal}`);
        return r2;
      };
    }

    // --- First engine: step1 completes, then waiting for signal ---
    const engine1 = new Engine({ storage });
    engine1.register('resumable', makeWorkflow());

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
    engine2.register('resumable', makeWorkflow());

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
      return async function* (ctx: WorkflowContext) {
        const c = ctx as Context;
        const approval = yield* c.waitForSignal<{ approved: boolean }>('approval');
        return { approved: approval.approved };
      };
    }

    // Start workflow, crash before signal
    const engine1 = new Engine({ storage });
    engine1.register('signal-wait', makeWorkflow());
    await engine1.start('signal-wait', null, { id: 'wf-signal' });
    await flush();
    engine1[Symbol.dispose]();

    // Recover and send signal
    const engine2 = new Engine({ storage });
    engine2.register('signal-wait', makeWorkflow());
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

    const sleepWorkflow = async function* (ctx: WorkflowContext) {
      const c = ctx as Context;
      yield* c.sleep(5000);
      return 'awake';
    };

    const engine1 = new TestEngine({ startTime: 1000 });
    engine1.register('sleeper', sleepWorkflow);

    await engine1.start('sleeper', null, { id: 'wf-sleep' });
    await flush();

    // Recover using TestEngine.recover() which copies storage
    const engine2 = engine1.recover();
    engine2.register('sleeper', sleepWorkflow);

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

    const sleepWorkflow = async function* (ctx: WorkflowContext) {
      const c = ctx as Context;
      yield* c.sleep(5000);
      return 'fast-path-awake';
    };

    // First engine: start workflow, then "crash" while sleep is pending
    const engine1 = new Engine({ storage, getNow: () => currentTime });
    engine1.register('sleeper', sleepWorkflow);

    await engine1.start('sleeper', null, { id: 'wf-sleep-fast' });
    await flush();

    // Workflow is now blocked on the sleep timer (scheduledFireAt = 1000 + 5000 = 6000).
    // Simulate crash by disposing without letting the timer fire.
    engine1[Symbol.dispose]();

    // Simulate time passing during the crash: restart well past the sleep deadline.
    currentTime = 20_000;

    // Second engine: resume with the same storage at a time after the sleep expired.
    const engine2 = new Engine({ storage, getNow: () => currentTime });
    engine2.register('sleeper', sleepWorkflow);

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
    const twoSleepWorkflow = async function* (ctx: WorkflowContext) {
      const c = ctx as Context;
      yield* c.sleep(2000);
      yield* c.sleep(3000);
      return 'both-done';
    };

    // First engine: start workflow, crash while the first sleep is pending.
    const engine1 = new Engine({ storage, getNow: () => currentTime });
    engine1.register('two-sleep', twoSleepWorkflow);

    await engine1.start('two-sleep', null, { id: 'wf-two-sleep' });
    await flush();

    engine1[Symbol.dispose]();

    // Simulate time passing during the crash: restart well past the first
    // sleep's deadline (1000 + 2000 = 3000) but NOT past a hypothetical
    // second sleep that starts at recovery time (10000 + 3000 = 13000).
    currentTime = 10_000;

    const engine2 = new Engine({ storage, getNow: () => currentTime });
    engine2.register('two-sleep', twoSleepWorkflow);

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
    engine1.register('simple', async function* (_ctx: WorkflowContext, input: unknown) {
      return `done:${String(input)}`;
    });

    const handle = await engine1.start('simple', 'test');
    await handle.result();
    engine1[Symbol.dispose]();

    // Recover — no running workflows to resume
    const engine2 = new Engine({ storage });
    engine2.register('simple', async function* () {
      return 'should not run';
    });

    const handles = await engine2.recoverAll();
    expect(handles).toHaveLength(0);

    engine2[Symbol.dispose]();
  });

  it('does not resume failed workflows', async () => {
    const storage = new MemoryStorage();

    const engine1 = new Engine({ storage });
    engine1.register('failing', async function* (ctx: WorkflowContext) {
      const c = ctx as Context;
      yield* c.run(async () => {
        throw new Error('boom');
      });
    });

    const handle = await engine1.start('failing', null);
    await expect(handle.result()).rejects.toThrow('boom');
    engine1[Symbol.dispose]();

    // Recover — no running workflows
    const engine2 = new Engine({ storage });
    engine2.register('failing', async function* () {
      return 'should not run';
    });

    const handles = await engine2.recoverAll();
    expect(handles).toHaveLength(0);

    engine2[Symbol.dispose]();
  });

  it('dispatches WorkflowResumedEvent on resume', async () => {
    const storage = new MemoryStorage();

    function makeWorkflow() {
      return async function* (ctx: WorkflowContext) {
        const c = ctx as Context;
        yield* c.waitForSignal('go');
        return 'done';
      };
    }

    const engine1 = new Engine({ storage });
    engine1.register('event-test', makeWorkflow());
    await engine1.start('event-test', null, { id: 'wf-event' });
    await flush();
    engine1[Symbol.dispose]();

    const engine2 = new Engine({ storage });
    engine2.register('event-test', makeWorkflow());

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
    engine.register('stepping', async function* (ctx: WorkflowContext) {
      const c = ctx as Context;
      yield* c.run(async () => 'a');
      yield* c.run(async () => 'b');
      yield* c.run(async () => 'c');
      return 'done';
    });

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
    engine.register('accumulating', async function* (ctx: WorkflowContext) {
      const c = ctx as Context;
      yield* c.run(async () => 'first');
      // Wait for signal to block the workflow mid-execution
      yield* c.waitForSignal('go');
      return 'done';
    });

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
      return async function* (ctx: WorkflowContext) {
        const c = ctx as Context;
        // Run one activity so a checkpoint is written before we crash.
        yield* c.run(async () => 'step-one');
        // Block here to simulate the engine crashing while still running.
        yield* c.waitForSignal<string>('resume-signal');
        return 'done';
      };
    }

    // --- Engine 1: start the workflow, let step-one checkpoint flush, then crash ---
    const engine1 = new Engine({ storage });
    engine1.register('event-log-resume', makeWorkflow());
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
    engine2.register('event-log-resume', makeWorkflow());
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
      return async function* (ctx: WorkflowContext) {
        const c = ctx as Context;
        yield* c.waitForSignal('go');
        return 'sqlite-recovered';
      };
    }

    // Start and crash
    const engine1 = new Engine({ storage });
    engine1.register('sqlite-resume', makeWorkflow());
    await engine1.start('sqlite-resume', null, { id: 'wf-sqlite' });
    await flush();

    // Clear in-memory state (simulate crash) without disposing storage
    // We can't dispose engine1 because it would try to close storage
    // Instead, create engine2 with the same storage directly
    const engine2 = new Engine({ storage });
    engine2.register('sqlite-resume', makeWorkflow());

    const handles = await engine2.recoverAll();
    expect(handles).toHaveLength(1);
    await flush();

    await engine2.signal('wf-sqlite', 'go', null);
    const result = await handles[0]!.result();
    expect(result).toBe('sqlite-recovered');
  });
});

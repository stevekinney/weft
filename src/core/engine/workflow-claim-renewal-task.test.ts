import { describe, expect, it } from 'bun:test';

import { createDeferred, flushMicrotasks } from '../../testing/fake-timers.test-support.ts';
import type { OwnerSideSignalPollTarget } from './owner-side-signal-poll.ts';
import {
  createWorkflowClaimRenewalTask,
  type WorkflowClaimReclaimAttemptResult,
  type WorkflowClaimReclaimTarget,
  type WorkflowClaimRenewalIntervalScheduler,
  type WorkflowClaimRenewalPassResult,
  type WorkflowClaimRenewalTarget,
} from './workflow-claim-renewal-task.ts';

/** A controllable clock whose value the test advances explicitly. */
function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

/**
 * A fake `WorkflowClaimRenewalTarget` whose `renewWorkflowClaim` outcome per
 * workflow id is fully controllable: resolve, reject, or stay pending until
 * explicitly resolved/rejected. Also records every call for assertions.
 */
function createFakeTarget(initialIds: readonly string[] = []): WorkflowClaimRenewalTarget & {
  ids: string[];
  calls: string[];
  listCalls: number;
  /** Force the next call for `workflowId` to reject with `error`. */
  failNext(workflowId: string, error: unknown): void;
  /**
   * Force the NEXT call for `workflowId` to stay pending until resolved or
   * rejected through the returned handle. Single-shot: once that call has
   * been dispatched, later calls for the same id proceed normally again.
   */
  deferNext(workflowId: string): { resolve: () => void; reject: (error: unknown) => void };
  /** Force `listHeldWorkflowIds()` itself to throw on its next call. */
  failNextList(error: unknown): void;
} {
  const ids = [...initialIds];
  const calls: string[] = [];
  const failures = new Map<string, unknown>();
  const pendingDeferrals = new Map<string, ReturnType<typeof createDeferred<void>>>();
  let listCalls = 0;
  let listFailure: { error: unknown } | null = null;

  return {
    ids,
    calls,
    get listCalls() {
      return listCalls;
    },
    listHeldWorkflowIds() {
      listCalls += 1;
      if (listFailure !== null) {
        const { error } = listFailure;
        listFailure = null;
        throw error;
      }
      return [...ids];
    },
    renewWorkflowClaim(workflowId: string) {
      calls.push(workflowId);
      const pending = pendingDeferrals.get(workflowId);
      if (pending !== undefined) {
        // Single-shot: this dispatch consumes the deferral so a later call
        // for the same id (e.g. from an explicit runOnce()) is not deferred.
        pendingDeferrals.delete(workflowId);
        return pending.promise;
      }
      if (failures.has(workflowId)) {
        const error = failures.get(workflowId);
        failures.delete(workflowId);
        return Promise.reject(error);
      }
      return Promise.resolve();
    },
    failNext(workflowId, error) {
      failures.set(workflowId, error);
    },
    deferNext(workflowId) {
      const deferred = createDeferred();
      pendingDeferrals.set(workflowId, deferred);
      return {
        resolve: () => deferred.resolve(),
        reject: (error: unknown) => deferred.reject(error),
      };
    },
    failNextList(error) {
      listFailure = { error };
    },
  };
}

/**
 * A scheduler test double that never touches real timers: `setInterval`
 * records the callback and hands back an opaque handle; `clearInterval`
 * records that the handle was cleared. Tests invoke `fire()` to run the
 * captured callback synchronously instead of waiting on real time.
 */
function createFakeScheduler(): WorkflowClaimRenewalIntervalScheduler & {
  fire(): void;
  activeCount: number;
  clearedHandles: unknown[];
} {
  let nextHandle = 1;
  const callbacksByHandle = new Map<number, () => void>();
  const clearedHandles: unknown[] = [];

  return {
    clearedHandles,
    get activeCount() {
      return callbacksByHandle.size;
    },
    setInterval(callback) {
      const handle = nextHandle;
      nextHandle += 1;
      callbacksByHandle.set(handle, callback);
      return handle;
    },
    clearInterval(handle) {
      clearedHandles.push(handle);
      if (typeof handle === 'number') callbacksByHandle.delete(handle);
    },
    fire() {
      for (const callback of callbacksByHandle.values()) callback();
    },
  };
}

describe('createWorkflowClaimRenewalTask · runOnce', () => {
  it('resolves an empty pass when no claims are held', async () => {
    const clock = makeClock();
    const target = createFakeTarget([]);
    const task = createWorkflowClaimRenewalTask({ target, getNow: clock.now, intervalMs: 1_000 });

    const result = await task.runOnce();

    expect(result.outcomes).toEqual([]);
    expect(result.renewedCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(result.startedAt).toBe(result.finishedAt);
    expect(target.listCalls).toBe(1);
  });

  it('renews every held claim in a pass', async () => {
    const clock = makeClock();
    const target = createFakeTarget(['workflow-a', 'workflow-b', 'workflow-c']);
    const task = createWorkflowClaimRenewalTask({ target, getNow: clock.now, intervalMs: 1_000 });

    const result = await task.runOnce();

    expect(result.outcomes).toEqual([
      { workflowId: 'workflow-a', status: 'renewed' },
      { workflowId: 'workflow-b', status: 'renewed' },
      { workflowId: 'workflow-c', status: 'renewed' },
    ]);
    expect(result.renewedCount).toBe(3);
    expect(result.failedCount).toBe(0);
    expect(target.calls).toEqual(['workflow-a', 'workflow-b', 'workflow-c']);
  });

  it('continues past a failing workflow so the others still renew', async () => {
    const clock = makeClock();
    const target = createFakeTarget(['workflow-a', 'workflow-b', 'workflow-c']);
    const lostClaimError = new Error('lost the claim');
    target.failNext('workflow-b', lostClaimError);
    const task = createWorkflowClaimRenewalTask({ target, getNow: clock.now, intervalMs: 1_000 });

    const result = await task.runOnce();

    expect(result.outcomes).toEqual([
      { workflowId: 'workflow-a', status: 'renewed' },
      { workflowId: 'workflow-b', status: 'failed', error: lostClaimError },
      { workflowId: 'workflow-c', status: 'renewed' },
    ]);
    expect(result.renewedCount).toBe(2);
    expect(result.failedCount).toBe(1);
    // Every workflow was still attempted, including the one after the failure.
    expect(target.calls).toEqual(['workflow-a', 'workflow-b', 'workflow-c']);
  });

  it('reports every held claim as failed when all renewals reject', async () => {
    const clock = makeClock();
    const target = createFakeTarget(['workflow-a', 'workflow-b']);
    target.failNext('workflow-a', new Error('a'));
    target.failNext('workflow-b', new Error('b'));
    const task = createWorkflowClaimRenewalTask({ target, getNow: clock.now, intervalMs: 1_000 });

    const result = await task.runOnce();

    expect(result.renewedCount).toBe(0);
    expect(result.failedCount).toBe(2);
  });

  it('stamps startedAt/finishedAt from the injected clock, never the wall clock', async () => {
    const clock = makeClock(5_000);
    const target = createFakeTarget(['workflow-a']);
    const task = createWorkflowClaimRenewalTask({
      target,
      getNow: clock.now,
      intervalMs: 1_000,
    });
    clock.advance(42);

    const result = await task.runOnce();

    expect(result.startedAt).toBe(5_042);
    expect(result.finishedAt).toBe(5_042);
  });

  it('snapshots the held ids at the start of the pass rather than re-reading mid-pass', async () => {
    const clock = makeClock();
    const target = createFakeTarget(['workflow-a']);
    const task = createWorkflowClaimRenewalTask({ target, getNow: clock.now, intervalMs: 1_000 });

    // Mutate the underlying id list mid-pass via the renewal call itself.
    const originalRenew = target.renewWorkflowClaim.bind(target);
    target.renewWorkflowClaim = async (workflowId: string) => {
      target.ids.push('workflow-b');
      await originalRenew(workflowId);
    };

    const result = await task.runOnce();

    expect(result.outcomes).toEqual([{ workflowId: 'workflow-a', status: 'renewed' }]);
    expect(target.listCalls).toBe(1);
  });

  it('invokes onPassComplete with the same result runOnce returns', async () => {
    const clock = makeClock();
    const target = createFakeTarget(['workflow-a']);
    const reported: WorkflowClaimRenewalPassResult[] = [];
    const task = createWorkflowClaimRenewalTask({
      target,
      getNow: clock.now,
      intervalMs: 1_000,
      onPassComplete: (result) => reported.push(result),
    });

    const result = await task.runOnce();

    expect(reported).toEqual([result]);
  });

  it('does not require onPassComplete to be provided', async () => {
    const clock = makeClock();
    const target = createFakeTarget(['workflow-a']);
    const task = createWorkflowClaimRenewalTask({ target, getNow: clock.now, intervalMs: 1_000 });

    await expect(task.runOnce()).resolves.toMatchObject({ renewedCount: 1 });
  });

  it('survives a throwing onPassComplete sink: the pass still resolves and the failure is reported', async () => {
    const clock = makeClock();
    const target = createFakeTarget(['workflow-a']);
    const sinkError = new Error('sink exploded');
    const consoleErrors: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args);
    };

    try {
      const task = createWorkflowClaimRenewalTask({
        target,
        getNow: clock.now,
        intervalMs: 1_000,
        onPassComplete: () => {
          throw sinkError;
        },
      });

      // The renewal itself already committed before the sink ran, so a broken
      // observability sink must not surface as a failed pass.
      await expect(task.runOnce()).resolves.toMatchObject({ renewedCount: 1, failedCount: 0 });
    } finally {
      console.error = originalConsoleError;
    }

    expect(consoleErrors).toHaveLength(1);
    expect(consoleErrors[0]?.[1]).toBe(sinkError);
  });

  it('rejects when listHeldWorkflowIds itself throws, without swallowing it', async () => {
    const clock = makeClock();
    const target = createFakeTarget([]);
    const boom = new Error('registry unavailable');
    target.failNextList(boom);
    const task = createWorkflowClaimRenewalTask({ target, getNow: clock.now, intervalMs: 1_000 });

    await expect(task.runOnce()).rejects.toBe(boom);
  });
});

/** A fake `WorkflowClaimReclaimTarget` with fully controllable per-candidate outcomes. */
function createFakeReclaimTarget(initialIds: readonly string[] = []): WorkflowClaimReclaimTarget & {
  calls: string[];
  results: Map<string, WorkflowClaimReclaimAttemptResult>;
  failNext(workflowId: string, error: unknown): void;
  failNextList(error: unknown): void;
} {
  const ids = [...initialIds];
  const calls: string[] = [];
  const results = new Map<string, WorkflowClaimReclaimAttemptResult>();
  const failures = new Map<string, unknown>();
  let listFailure: { error: unknown } | null = null;

  return {
    calls,
    results,
    async listReclaimCandidateWorkflowIds() {
      if (listFailure !== null) {
        const { error } = listFailure;
        listFailure = null;
        throw error;
      }
      return [...ids];
    },
    async attemptWorkflowClaimTakeover(workflowId) {
      calls.push(workflowId);
      if (failures.has(workflowId)) {
        const error = failures.get(workflowId);
        failures.delete(workflowId);
        throw error;
      }
      return results.get(workflowId) ?? { status: 'not-eligible' };
    },
    failNext(workflowId, error) {
      failures.set(workflowId, error);
    },
    failNextList(error) {
      listFailure = { error };
    },
  };
}

/** A fake `OwnerSideSignalPollTarget` with fully controllable buffered/wake state. */
function createFakeSignalPollTarget(
  waits: readonly { workflowId: string; signalName: string }[] = [],
): OwnerSideSignalPollTarget & {
  wokenIds: string[];
  bufferedFor: Set<string>;
  failHasBufferedNext(error: unknown): void;
} {
  const bufferedFor = new Set<string>();
  const wokenIds: string[] = [];
  let hasBufferedFailure: { error: unknown } | null = null;

  return {
    wokenIds,
    bufferedFor,
    listParkedSignalWaits: () => [...waits],
    async hasBufferedSignal(workflowId) {
      if (hasBufferedFailure !== null) {
        const { error } = hasBufferedFailure;
        hasBufferedFailure = null;
        throw error;
      }
      return bufferedFor.has(workflowId);
    },
    async wakeWorkflow(workflowId) {
      wokenIds.push(workflowId);
    },
    failHasBufferedNext(error) {
      hasBufferedFailure = { error };
    },
  };
}

describe('createWorkflowClaimRenewalTask · runOnce · reclaim pass', () => {
  it('leaves result.reclaim undefined when no reclaimTarget is configured', async () => {
    const clock = makeClock();
    const target = createFakeTarget([]);
    const task = createWorkflowClaimRenewalTask({ target, getNow: clock.now, intervalMs: 1_000 });

    const result = await task.runOnce();

    expect(result.reclaim).toBeUndefined();
  });

  it('attempts every candidate and reports a mix of outcomes', async () => {
    const clock = makeClock();
    const target = createFakeTarget([]);
    const reclaimTarget = createFakeReclaimTarget(['wf-a', 'wf-b', 'wf-c', 'wf-d']);
    reclaimTarget.results.set('wf-a', { status: 'reclaimed' });
    reclaimTarget.results.set('wf-b', { status: 'not-eligible' });
    reclaimTarget.results.set('wf-c', { status: 'backoff-skipped' });
    reclaimTarget.results.set('wf-d', { status: 'lost-race' });
    const task = createWorkflowClaimRenewalTask({
      target,
      reclaimTarget,
      getNow: clock.now,
      intervalMs: 1_000,
    });

    const result = await task.runOnce();

    expect(result.reclaim).toEqual({
      status: 'completed',
      outcomes: [
        { workflowId: 'wf-a', status: 'reclaimed' },
        { workflowId: 'wf-b', status: 'not-eligible' },
        { workflowId: 'wf-c', status: 'backoff-skipped' },
        { workflowId: 'wf-d', status: 'lost-race' },
      ],
      reclaimedCount: 1,
    });
    expect(reclaimTarget.calls).toEqual(['wf-a', 'wf-b', 'wf-c', 'wf-d']);
  });

  it('continues past a per-candidate throw, recording an error outcome', async () => {
    const clock = makeClock();
    const target = createFakeTarget([]);
    const reclaimTarget = createFakeReclaimTarget(['wf-a', 'wf-b']);
    const boom = new Error('takeover blew up');
    reclaimTarget.failNext('wf-a', boom);
    reclaimTarget.results.set('wf-b', { status: 'reclaimed' });
    const task = createWorkflowClaimRenewalTask({
      target,
      reclaimTarget,
      getNow: clock.now,
      intervalMs: 1_000,
    });

    const result = await task.runOnce();

    expect(result.reclaim).toEqual({
      status: 'completed',
      outcomes: [
        { workflowId: 'wf-a', status: 'error', error: boom },
        { workflowId: 'wf-b', status: 'reclaimed' },
      ],
      reclaimedCount: 1,
    });
  });

  it('reports discovery-failed, without rejecting the pass, when listing candidates throws', async () => {
    const clock = makeClock();
    const target = createFakeTarget(['workflow-a']);
    const reclaimTarget = createFakeReclaimTarget([]);
    const boom = new Error('storage scan failed');
    reclaimTarget.failNextList(boom);
    const task = createWorkflowClaimRenewalTask({
      target,
      reclaimTarget,
      getNow: clock.now,
      intervalMs: 1_000,
    });

    const result = await task.runOnce();

    // Renewal (an independent sub-step) still committed and is unaffected.
    expect(result.renewedCount).toBe(1);
    expect(result.reclaim).toEqual({ status: 'discovery-failed', error: boom });
  });
});

describe('createWorkflowClaimRenewalTask · runOnce · owner-side signal poll', () => {
  it('leaves result.signalPoll undefined when no signalPollTarget is configured', async () => {
    const clock = makeClock();
    const target = createFakeTarget([]);
    const task = createWorkflowClaimRenewalTask({ target, getNow: clock.now, intervalMs: 1_000 });

    const result = await task.runOnce();

    expect(result.signalPoll).toBeUndefined();
  });

  it('wakes a parked workflow whose awaited signal has been buffered by another engine', async () => {
    const clock = makeClock();
    const target = createFakeTarget([]);
    const signalPollTarget = createFakeSignalPollTarget([
      { workflowId: 'wf-parked', signalName: 'approval' },
    ]);
    signalPollTarget.bufferedFor.add('wf-parked'); // "another engine" durably buffered this signal
    const task = createWorkflowClaimRenewalTask({
      target,
      signalPollTarget,
      getNow: clock.now,
      intervalMs: 1_000,
    });

    const result = await task.runOnce();

    expect(result.signalPoll).toEqual({
      status: 'completed',
      result: {
        startedAt: expect.any(Number),
        finishedAt: expect.any(Number),
        outcomes: [{ workflowId: 'wf-parked', signalName: 'approval', status: 'woken' }],
        wokenCount: 1,
      },
    });
    expect(signalPollTarget.wokenIds).toEqual(['wf-parked']);
  });

  it('reports failed, without rejecting the pass, when the poll itself throws', async () => {
    const clock = makeClock();
    const target = createFakeTarget(['workflow-a']);
    const signalPollTarget = createFakeSignalPollTarget([
      { workflowId: 'wf-parked', signalName: 'approval' },
    ]);
    const boom = new Error('signal buffer probe failed');
    signalPollTarget.failHasBufferedNext(boom);
    const task = createWorkflowClaimRenewalTask({
      target,
      signalPollTarget,
      getNow: clock.now,
      intervalMs: 1_000,
    });

    const result = await task.runOnce();

    // Renewal (an independent sub-step) still committed and is unaffected.
    expect(result.renewedCount).toBe(1);
    expect(result.signalPoll).toEqual({ status: 'failed', error: boom });
  });
});

describe('createWorkflowClaimRenewalTask · runOnce · all three sub-steps in one pass', () => {
  it('runs renewal, reclaim, and owner-side signal polling together from one awaited call', async () => {
    const clock = makeClock();
    const target = createFakeTarget(['workflow-a']);
    const reclaimTarget = createFakeReclaimTarget(['wf-stranded']);
    reclaimTarget.results.set('wf-stranded', { status: 'reclaimed' });
    const signalPollTarget = createFakeSignalPollTarget([
      { workflowId: 'wf-parked', signalName: 'approval' },
    ]);
    signalPollTarget.bufferedFor.add('wf-parked');
    const task = createWorkflowClaimRenewalTask({
      target,
      reclaimTarget,
      signalPollTarget,
      getNow: clock.now,
      intervalMs: 1_000,
    });

    // A single awaited call is exactly what `backgroundTasks: 'manual'`
    // hosts drive from `Engine#runMaintenance()` — this is that same call.
    const result = await task.runOnce();

    expect(result.renewedCount).toBe(1);
    expect(result.reclaim).toMatchObject({ status: 'completed', reclaimedCount: 1 });
    expect(result.signalPoll).toMatchObject({ status: 'completed', result: { wokenCount: 1 } });
  });
});

describe('createWorkflowClaimRenewalTask · start/stop (interval mode, no real timers)', () => {
  it('starts an interval and renews on every fired tick', async () => {
    const clock = makeClock();
    const target = createFakeTarget(['workflow-a']);
    const scheduler = createFakeScheduler();
    const task = createWorkflowClaimRenewalTask({
      target,
      getNow: clock.now,
      intervalMs: 1_000,
      scheduler,
    });

    task.start();
    scheduler.fire();
    // Let the fire-and-forget tick's microtasks settle before asserting.
    await flushMicrotasks();

    expect(target.calls).toEqual(['workflow-a']);
  });

  it('is idempotent: calling start twice does not create a second interval', () => {
    const clock = makeClock();
    const target = createFakeTarget([]);
    const scheduler = createFakeScheduler();
    const task = createWorkflowClaimRenewalTask({
      target,
      getNow: clock.now,
      intervalMs: 1_000,
      scheduler,
    });

    task.start();
    task.start();

    expect(scheduler.activeCount).toBe(1);
  });

  it('is idempotent: calling stop twice does not throw', () => {
    const clock = makeClock();
    const target = createFakeTarget([]);
    const scheduler = createFakeScheduler();
    const task = createWorkflowClaimRenewalTask({
      target,
      getNow: clock.now,
      intervalMs: 1_000,
      scheduler,
    });

    task.start();
    task.stop();
    expect(() => task.stop()).not.toThrow();
    expect(scheduler.clearedHandles).toEqual([1]);
  });

  it('calling stop before start does not throw and never starts an interval', () => {
    const clock = makeClock();
    const target = createFakeTarget([]);
    const scheduler = createFakeScheduler();
    const task = createWorkflowClaimRenewalTask({
      target,
      getNow: clock.now,
      intervalMs: 1_000,
      scheduler,
    });

    expect(() => task.stop()).not.toThrow();
    expect(scheduler.activeCount).toBe(0);
  });

  it('stop prevents further passes: a tick fired after stop does nothing', async () => {
    const clock = makeClock();
    const target = createFakeTarget(['workflow-a']);
    const scheduler = createFakeScheduler();
    const task = createWorkflowClaimRenewalTask({
      target,
      getNow: clock.now,
      intervalMs: 1_000,
      scheduler,
    });

    task.start();
    task.stop();
    // The fake scheduler's clearInterval removed the callback, so firing now
    // is a no-op — mirroring what stop() guarantees against a real timer.
    scheduler.fire();
    await flushMicrotasks();

    expect(target.calls).toEqual([]);
    expect(target.listCalls).toBe(0);
  });

  it('restarting after stop starts a fresh interval that renews again', async () => {
    const clock = makeClock();
    const target = createFakeTarget(['workflow-a']);
    const scheduler = createFakeScheduler();
    const task = createWorkflowClaimRenewalTask({
      target,
      getNow: clock.now,
      intervalMs: 1_000,
      scheduler,
    });

    task.start();
    task.stop();
    task.start();
    scheduler.fire();
    await flushMicrotasks();

    expect(target.calls).toEqual(['workflow-a']);
  });

  it('skips an overlapping tick while the previous interval-driven pass is still in flight', async () => {
    const clock = makeClock();
    const target = createFakeTarget(['workflow-a']);
    const scheduler = createFakeScheduler();
    const task = createWorkflowClaimRenewalTask({
      target,
      getNow: clock.now,
      intervalMs: 1_000,
      scheduler,
    });
    const deferred = target.deferNext('workflow-a');

    task.start();
    scheduler.fire(); // starts a pass that hangs on workflow-a
    await flushMicrotasks();
    scheduler.fire(); // should be skipped: a pass is still in flight
    await flushMicrotasks();

    expect(target.calls).toEqual(['workflow-a']);

    deferred.resolve();
    await flushMicrotasks();

    // Once the first pass finished, a later tick starts a fresh pass.
    scheduler.fire();
    await flushMicrotasks();

    expect(target.calls).toEqual(['workflow-a', 'workflow-a']);
  });

  describe('renewal keeps its own cadence independent of a slow reclaim/poll sub-pass (WFT-79 Finding 2)', () => {
    it('renewal fires on a later tick even while the reclaim scan from an earlier tick is still in flight', async () => {
      const clock = makeClock();
      const target = createFakeTarget(['workflow-a']);
      const reclaimTarget = createFakeReclaimTarget(['wf-stranded']);
      const scheduler = createFakeScheduler();
      const task = createWorkflowClaimRenewalTask({
        target,
        reclaimTarget,
        getNow: clock.now,
        intervalMs: 1_000,
        scheduler,
      });
      // The reclaim scan's candidate listing hangs — modeling an unbounded
      // store-wide scan on a large or high-latency shared store that runs
      // well past `intervalMs`.
      const hangingList = createDeferred<readonly string[]>();
      reclaimTarget.listReclaimCandidateWorkflowIds = () => hangingList.promise;

      task.start();
      scheduler.fire(); // tick 1: starts renewal (resolves fast) and reclaim (hangs)
      await flushMicrotasks();

      expect(target.calls).toEqual(['workflow-a']);

      scheduler.fire(); // tick 2: reclaim from tick 1 is STILL in flight
      await flushMicrotasks();

      // The bug this regresses: renewal was gated behind the shared
      // single-flight slot the reclaim scan also occupied, so this second
      // tick's renewal would have been silently skipped. With renewal on its
      // own slot, it fires again regardless of the still-hanging reclaim scan.
      expect(target.calls).toEqual(['workflow-a', 'workflow-a']);

      // Clean up the still-hanging reclaim scan so it does not leak into a
      // later test.
      hangingList.resolve([]);
      await flushMicrotasks();
    });

    it('a slow reclaim scan does not delay the renewed-claim outcome reported to onPassComplete', async () => {
      const clock = makeClock();
      const target = createFakeTarget(['workflow-a']);
      const reclaimTarget = createFakeReclaimTarget([]);
      const scheduler = createFakeScheduler();
      const reported: WorkflowClaimRenewalPassResult[] = [];
      const task = createWorkflowClaimRenewalTask({
        target,
        reclaimTarget,
        getNow: clock.now,
        intervalMs: 1_000,
        scheduler,
        onPassComplete: (result) => reported.push(result),
      });
      const hangingList = createDeferred<readonly string[]>();
      reclaimTarget.listReclaimCandidateWorkflowIds = () => hangingList.promise;

      task.start();
      scheduler.fire();
      await flushMicrotasks();

      // The renewal sub-pass already reported completion — it did not wait on
      // the still-hanging reclaim sub-pass.
      const renewalReport = reported.find((result) => result.outcomes.length > 0);
      expect(renewalReport).toMatchObject({ renewedCount: 1 });
      expect(renewalReport?.reclaim).toBeUndefined();

      hangingList.resolve([]);
      await flushMicrotasks();
    });

    it('the reclaim-plus-poll sub-pass has its own single-flight slot, independent of renewal', async () => {
      const clock = makeClock();
      const target = createFakeTarget([]);
      const reclaimTarget = createFakeReclaimTarget(['wf-stranded']);
      const scheduler = createFakeScheduler();
      const task = createWorkflowClaimRenewalTask({
        target,
        reclaimTarget,
        getNow: clock.now,
        intervalMs: 1_000,
        scheduler,
      });
      const hangingList = createDeferred<readonly string[]>();
      let listCalls = 0;
      reclaimTarget.listReclaimCandidateWorkflowIds = () => {
        listCalls += 1;
        return listCalls === 1 ? hangingList.promise : Promise.resolve([]);
      };

      task.start();
      scheduler.fire(); // starts a reclaim sub-pass that hangs
      await flushMicrotasks();
      scheduler.fire(); // should be skipped: the reclaim sub-pass is still in flight
      await flushMicrotasks();

      expect(listCalls).toBe(1);

      hangingList.resolve([]);
      await flushMicrotasks();

      scheduler.fire(); // the slot is free again: a fresh reclaim sub-pass starts
      await flushMicrotasks();

      expect(listCalls).toBe(2);
    });
  });

  it('does not leak an unhandled rejection when an interval-driven pass rejects, and recovers on the next tick', async () => {
    const clock = makeClock();
    const target = createFakeTarget([]);
    const boom = new Error('registry unavailable');
    target.failNextList(boom);
    const scheduler = createFakeScheduler();
    const task = createWorkflowClaimRenewalTask({
      target,
      getNow: clock.now,
      intervalMs: 1_000,
      scheduler,
    });

    task.start();
    scheduler.fire();
    await flushMicrotasks();

    expect(target.listCalls).toBe(1);

    // The in-flight slot must have been cleared despite the rejection, so a
    // later tick tries again rather than being permanently wedged.
    scheduler.fire();
    await flushMicrotasks();

    expect(target.listCalls).toBe(2);
  });

  it('runOnce bypasses the interval single-flight guard even while a tick-driven pass is in flight', async () => {
    const clock = makeClock();
    const target = createFakeTarget(['workflow-a', 'workflow-b']);
    const scheduler = createFakeScheduler();
    const task = createWorkflowClaimRenewalTask({
      target,
      getNow: clock.now,
      intervalMs: 1_000,
      scheduler,
    });
    const deferred = target.deferNext('workflow-a');

    task.start();
    scheduler.fire(); // hangs on workflow-a
    await flushMicrotasks();

    // An explicit runOnce() call still runs its own full pass immediately,
    // even though the tick-driven pass above is still parked on workflow-a.
    const explicitResult = await task.runOnce();
    // Release the tick-driven pass so it does not leak a pending promise.
    deferred.resolve();
    await flushMicrotasks();

    expect(explicitResult.renewedCount).toBe(2);
  });

  it('uses the real setInterval/clearInterval when no scheduler is injected, without waiting on real time', () => {
    const clock = makeClock();
    const target = createFakeTarget([]);
    const task = createWorkflowClaimRenewalTask({ target, getNow: clock.now, intervalMs: 1_000 });

    // Exercises the default scheduler's setInterval (including the unref?.()
    // branch) and clearInterval wrappers synchronously — the interval is
    // created and cleared before it could ever fire, so no real waiting.
    expect(() => {
      task.start();
      task.stop();
    }).not.toThrow();
  });
});

/**
 * COR-1482: a schedule's `revision` counts changes to the schedule itself (its status and its
 * definition), and `expectedRevision` on `pauseSchedule`, `resumeSchedule`, `cancelSchedule`, and
 * `updateSchedule` is compared inside the schedule's serialized write.
 */
import { describe, expect, it, spyOn } from 'bun:test';

import {
  type BatchOperation,
  type ConditionalBatchCondition,
  MemoryStorage,
} from "../../embedded/storage/src/index.ts";
import { createDeferred, drainMicrotasks } from "../../../test-support/embedded/testing/src/fake-timers.ts";
import { throwingRejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { KEYS } from '../../storage/keys.ts';
import { decode, encode } from '../codec.ts';
import { Engine } from '../engine.ts';
import type { ScheduleState, WorkflowContext } from '../types.ts';
import { handleScheduledWorkflowTerminalForEngine } from './callback-creators-schedule.ts';
import { ScheduleStaleRevisionError } from './schedule-stale-revision-error.ts';
import {
  createEngine,
  drainEngine,
  listRunningWorkflowIds,
  MINUTE,
  registerWorkflow,
  requireNextFireAt,
  START,
  tickEngine,
} from './schedule.test-support.ts';
import { decodeScheduleState } from './validation/schedule-decode.ts';

async function openSchedule(options: { id?: string; overlap?: 'skip' | 'queue' } = {}) {
  const clock = { now: START };
  const storage = new MemoryStorage();
  const engine = createEngine(clock, storage);
  registerWorkflow(engine, 'revision-workflow', async function* () {
    return 'done';
  });
  const id = options.id ?? 'revision-schedule';
  const handle = await engine.schedule('revision-workflow', null, '* * * * *', {
    id,
    ...(options.overlap === undefined ? {} : { overlap: options.overlap }),
  });
  return { clock, storage, engine, handle, id };
}

async function revisionOf(engine: Engine, id: string): Promise<number | undefined> {
  const summary = await engine.getSchedule(id);
  return summary?.revision;
}

describe('the schedule revision counts changes to the schedule itself', () => {
  it('is 1 when a schedule is created, and every summary carries it', async () => {
    const { engine, id } = await openSchedule();
    try {
      expect(await revisionOf(engine, id)).toBe(1);
      const listed = await engine.listSchedules();
      expect(listed.items.map((item) => item.revision)).toEqual([1]);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('goes up by exactly one for each of update, pause, resume, and cancel', async () => {
    const { engine, id } = await openSchedule();
    try {
      await engine.updateSchedule(id, '*/5 * * * *');
      expect(await revisionOf(engine, id)).toBe(2);
      await engine.pauseSchedule(id);
      expect(await revisionOf(engine, id)).toBe(3);
      await engine.resumeSchedule(id);
      expect(await revisionOf(engine, id)).toBe(4);
      await engine.cancelSchedule(id);
      expect(await revisionOf(engine, id)).toBe(5);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('is left as it was by a call that changes nothing', async () => {
    const { engine, id } = await openSchedule();
    try {
      await engine.resumeSchedule(id);
      expect(await revisionOf(engine, id)).toBe(1);
      await engine.pauseSchedule(id);
      await engine.pauseSchedule(id);
      expect(await revisionOf(engine, id)).toBe(2);
      await engine.cancelSchedule(id);
      await engine.cancelSchedule(id);
      expect(await revisionOf(engine, id)).toBe(3);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('is left as it was by a fire, its terminal bookkeeping, and a skipped occurrence', async () => {
    const { clock, engine, handle, id } = await openSchedule();
    try {
      const summary = await handle.describe();
      await tickEngine(engine, clock, requireNextFireAt(summary));
      const fired = await engine.getSchedule(id);
      expect(fired?.lastFireAt).toBeDefined();
      expect(fired?.revision).toBe(1);
      // A second tick far behind the schedule is a missed fire, not a change.
      await tickEngine(engine, clock, requireNextFireAt(fired!) + 10_000);
      expect(await revisionOf(engine, id)).toBe(1);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('goes up by one when a timer failure pauses the schedule', async () => {
    class ScheduleRunStartFailureStorage extends MemoryStorage {
      failing = false;
      #fail(operations: BatchOperation[]): void {
        if (
          this.failing &&
          operations.some(
            (operation) => operation.type === 'put' && operation.key.startsWith('schedule-run:'),
          )
        ) {
          throw new Error('simulated schedule start failure');
        }
      }
      override async batch(operations: BatchOperation[]): Promise<void> {
        this.#fail(operations);
        return super.batch(operations);
      }
      override async conditionalBatch(
        conditions: ConditionalBatchCondition[],
        operations: BatchOperation[],
      ): Promise<boolean> {
        this.#fail(operations);
        return super.conditionalBatch(conditions, operations);
      }
    }
    const storage = new ScheduleRunStartFailureStorage();
    const clock = { now: START };
    const engine = createEngine(clock, storage);
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    try {
      registerWorkflow(engine, 'revision-workflow', async function* () {
        return 'done';
      });
      const handle = await engine.schedule('revision-workflow', null, '* * * * *', {
        id: 'failing',
      });
      const summary = await handle.describe();
      storage.failing = true;
      await tickEngine(engine, clock, requireNextFireAt(summary));
      const paused = await engine.getSchedule('failing');
      expect(paused?.status).toBe('paused');
      expect(paused?.revision).toBe(2);
    } finally {
      consoleError.mockRestore();
      engine[Symbol.dispose]();
    }
  });

  it('reads as 0 on a stored schedule that has none, and refuses an invalid one', () => {
    const state = {
      id: 'legacy',
      workflowType: 'workflow',
      input: null,
      status: 'active',
      overlap: 'skip',
      backfill: false,
      revisionPolicy: 'active-at-fire',
      createdAt: 1,
      updatedAt: 1,
      nextFireAt: 60_000,
      cronExpression: '* * * * *',
      missedFireCount: 0,
      skippedCount: 0,
      queuedRuns: [],
    };
    expect(decodeScheduleState(encode(state))?.revision).toBe(0);
    expect(decodeScheduleState(encode({ ...state, revision: 7 }))?.revision).toBe(7);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const revision of [-1, 1.5, '2', null, Number.MAX_SAFE_INTEGER + 1]) {
        expect(decodeScheduleState(encode({ ...state, revision }))).toBeNull();
      }
      expect(warn).toHaveBeenCalledTimes(5);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('expectedRevision', () => {
  it('lets a transition through when it matches, and refuses a stale one without writing', async () => {
    const { engine, id, storage } = await openSchedule();
    try {
      await engine.pauseSchedule(id, { expectedRevision: 1 });
      expect(await revisionOf(engine, id)).toBe(2);

      const before = await storage.get(KEYS.schedule(id));
      for (const attempt of [
        () => engine.resumeSchedule(id, { expectedRevision: 1 }),
        () => engine.cancelSchedule(id, { expectedRevision: 1 }),
        () => engine.updateSchedule(id, '*/5 * * * *', { expectedRevision: 1 }),
      ]) {
        const error = await (async () => {
          try {
            await attempt();
          } catch (thrown) {
            return thrown;
          }
          return undefined;
        })();
        expect(error).toBeInstanceOf(ScheduleStaleRevisionError);
        expect(error).toMatchObject({
          scheduleId: id,
          expectedRevision: 1,
          currentRevision: 2,
          code: 'ScheduleStaleRevisionError',
        });
      }
      expect(await storage.get(KEYS.schedule(id))).toEqual(before);
      const stillPaused = await engine.getSchedule(id);
      expect(stillPaused?.status).toBe('paused');
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('is compared before a no-op decides it has nothing to do', async () => {
    const { engine, id } = await openSchedule();
    try {
      await engine.pauseSchedule(id);
      expect(await throwingRejectionOf(engine.pauseSchedule(id, { expectedRevision: 1 }))).toThrow(
        ScheduleStaleRevisionError,
      );
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('refuses a stale transition without committing the caller’s own operations', async () => {
    const { engine, id, storage } = await openSchedule();
    try {
      await engine.pauseSchedule(id);
      await engine
        .resumeSchedule(id, {
          expectedRevision: 1,
          additionalOperations: [{ type: 'put', key: 'app:projection', value: encode('x') }],
        })
        .catch(() => undefined);
      expect(await storage.get('app:projection')).toBeNull();
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('rejects a value that is not a non-negative integer', async () => {
    const { engine, id } = await openSchedule();
    try {
      for (const expectedRevision of [-1, 1.5, Number.NaN, '1' as unknown as number]) {
        expect(await throwingRejectionOf(engine.pauseSchedule(id, { expectedRevision }))).toThrow(
          'expectedRevision must be a non-negative integer',
        );
        expect(
          await throwingRejectionOf(engine.updateSchedule(id, '* * * * *', { expectedRevision })),
        ).toThrow('expectedRevision must be a non-negative integer');
      }
      expect(await revisionOf(engine, id)).toBe(1);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('lets exactly one of two concurrent transitions with the same expectedRevision through', async () => {
    const { engine, id } = await openSchedule();
    try {
      const outcomes = await Promise.allSettled([
        engine.pauseSchedule(id, { expectedRevision: 1 }),
        engine.updateSchedule(id, '*/5 * * * *', { expectedRevision: 1 }),
      ]);
      expect(outcomes.map((outcome) => outcome.status).toSorted()).toEqual([
        'fulfilled',
        'rejected',
      ]);
      const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
      expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(ScheduleStaleRevisionError);
      expect(await revisionOf(engine, id)).toBe(2);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('does not let a refused transition fail the one queued behind it', async () => {
    const { engine, id } = await openSchedule();
    try {
      await engine.pauseSchedule(id);
      const [stale, next] = await Promise.allSettled([
        engine.cancelSchedule(id, { expectedRevision: 1 }),
        engine.resumeSchedule(id, { expectedRevision: 2 }),
      ]);
      expect(stale.status).toBe('rejected');
      expect(next.status).toBe('fulfilled');
      const resumed = await engine.getSchedule(id);
      expect(resumed?.status).toBe('active');
      expect(await revisionOf(engine, id)).toBe(3);
    } finally {
      engine[Symbol.dispose]();
    }
  });
});

/**
 * A storage whose first read of a schedule record, once armed, stops until released: the point
 * between a handler's load of the record and its write.
 */
class GatedScheduleReadStorage extends MemoryStorage {
  #armedKey: string | null = null;
  readonly loaded = createDeferred();
  readonly release = createDeferred();

  arm(scheduleId: string): void {
    this.#armedKey = KEYS.schedule(scheduleId);
  }

  override async get(key: string): Promise<Uint8Array | null> {
    const value = await super.get(key);
    if (this.#armedKey !== null && key === this.#armedKey) {
      this.#armedKey = null;
      this.loaded.resolve();
      await this.release.promise;
    }
    return value;
  }
}

describe('the terminal handler of a scheduled run applies its change to the current state', () => {
  async function openOccupiedSchedule(options: { queued?: boolean } = {}) {
    const storage = new GatedScheduleReadStorage();
    const clock = { now: START };
    const engine = createEngine(clock, storage);
    registerWorkflow(engine, 'revision-workflow', async function* () {
      return 'done';
    });
    const id = 'occupied';
    await engine.schedule('revision-workflow', null, '* * * * *', {
      id,
      ...(options.queued === true ? { overlap: 'queue' as const } : {}),
    });
    const workflowId = 'finished-run';
    const bytes = (await storage.get(KEYS.schedule(id)))!;
    const state = decode(bytes) as ScheduleState;
    await storage.put(
      KEYS.schedule(id),
      encode({
        ...state,
        currentWorkflowId: workflowId,
        ...(options.queued === true
          ? { queuedRuns: [{ workflowId: 'queued-run', queuedAt: START }] }
          : {}),
      }),
    );
    await storage.put(KEYS.scheduleRun(workflowId), encode({ id }));
    return { storage, engine, id, workflowId };
  }

  it('keeps a pause committed between its load and its write, and the pause’s revision with it', async () => {
    const { storage, engine, id, workflowId } = await openOccupiedSchedule();
    try {
      storage.arm(id);
      const terminal = handleScheduledWorkflowTerminalForEngine(engine, workflowId);
      await storage.loaded.promise;

      const pause = engine.pauseSchedule(id);
      // The pause is a promise-chain transition on in-memory storage: it queues behind the held
      // terminal handler without waiting on anything but microtasks.
      await drainMicrotasks();
      storage.release.resolve();
      await Promise.all([terminal, pause]);

      const stored = decodeScheduleState((await storage.get(KEYS.schedule(id)))!);
      expect(stored?.status).toBe('paused');
      expect(stored?.revision).toBe(2);
      expect(stored?.currentWorkflowId).toBeUndefined();
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('does the same when it drains a queued run instead of clearing the slot', async () => {
    const { storage, engine, id, workflowId } = await openOccupiedSchedule({ queued: true });
    try {
      storage.arm(id);
      const terminal = handleScheduledWorkflowTerminalForEngine(engine, workflowId);
      await storage.loaded.promise;

      const pause = engine.pauseSchedule(id);
      // The pause is a promise-chain transition on in-memory storage: it queues behind the held
      // terminal handler without waiting on anything but microtasks.
      await drainMicrotasks();
      storage.release.resolve();
      await Promise.all([terminal, pause]);
      await drainEngine();

      const stored = decodeScheduleState((await storage.get(KEYS.schedule(id)))!);
      expect(stored?.status).toBe('paused');
      expect(stored?.revision).toBe(2);
    } finally {
      engine[Symbol.dispose]();
    }
  });
});

/**
 * The terminal handler now waits its turn behind the timer callback that may be waiting for the
 * run it is handling. These are the paths on which that could hang: a replacement that cancels
 * the running run, a queue that drains one run into the next, and a backfill that settles each
 * run inside the tick. Each completes, and none changes the revision.
 */
describe('serializing the terminal handler does not wait on itself', () => {
  it('lets cancel-running replace a parked run', async () => {
    const clock = { now: START };
    const engine = createEngine(clock);
    try {
      registerWorkflow(engine, 'parked', async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('release');
        return 'released';
      });
      const handle = await engine.schedule('parked', null, '* * * * *', {
        id: 'replace',
        overlap: 'cancel-running',
      });
      await tickEngine(engine, clock, requireNextFireAt(await handle.describe()));
      const [first] = await listRunningWorkflowIds(engine);
      await tickEngine(engine, clock, requireNextFireAt(await handle.describe()));
      const [second] = await listRunningWorkflowIds(engine);
      expect(second).toBeDefined();
      expect(second).not.toBe(first);
      expect(await handle.describe()).toMatchObject({ currentWorkflowId: second, revision: 1 });
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('drains a queue whose runs finish as soon as they start', async () => {
    const clock = { now: START };
    const engine = createEngine(clock);
    try {
      const started = new Set<string>();
      registerWorkflow(engine, 'queued', async function* (ctx: WorkflowContext) {
        const first = started.size === 0;
        started.add(ctx.workflowId);
        if (first) yield* ctx.waitForSignal('release');
        return 'done';
      });
      const handle = await engine.schedule('queued', null, '* * * * *', {
        id: 'chain',
        overlap: 'queue',
      });
      for (let tick = 0; tick < 3; tick += 1) {
        await tickEngine(engine, clock, requireNextFireAt(await handle.describe()));
      }
      const queued = await handle.describe();
      expect(queued.queuedRuns).toHaveLength(2);
      const [first] = await listRunningWorkflowIds(engine);
      await engine.signal(first!, 'release');
      await drainEngine();
      await drainEngine();
      expect(started.size).toBe(3);
      expect(await handle.describe()).toMatchObject({ queuedRuns: [], revision: 1 });
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('settles every backfilled run inside the tick', async () => {
    const clock = { now: START };
    const engine = createEngine(clock);
    try {
      let started = 0;
      registerWorkflow(engine, 'backfilled', async function* () {
        started += 1;
        return 'done';
      });
      const handle = await engine.schedule('backfilled', null, '* * * * *', {
        id: 'catch-up',
        backfill: true,
        overlap: 'allow',
      });
      const first = requireNextFireAt(await handle.describe());
      await tickEngine(engine, clock, first + 3 * MINUTE);
      expect(started).toBeGreaterThanOrEqual(3);
      expect(await handle.describe()).toMatchObject({ revision: 1 });
    } finally {
      engine[Symbol.dispose]();
    }
  });
});

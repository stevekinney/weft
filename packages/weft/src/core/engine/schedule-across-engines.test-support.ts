/**
 * Fixtures for the tests of a schedule's writes across engines that share a store (COR-1594): two
 * engines over one store, each behind a handle that can park one of its writes, and the reads and
 * ticks the tests make around them.
 */
import type { BatchOperation, Storage } from "../../embedded/storage/src/index.ts";
import { BunSQLiteStorage } from "../../embedded/storage-bun-sqlite/src/index.ts";
import { KEYS } from '../../storage/keys.ts';
import type { Engine } from '../engine.ts';
import type { ScheduleOptions, ScheduleState } from '../types.ts';
import {
  createEngine,
  drainEngine,
  MINUTE,
  registerWorkflow,
  START,
} from './schedule.test-support.ts';
import { decodeScheduleState } from './validation/schedule-decode.ts';

export const SCHEDULE_ID = 'across-engines';

/** Whether a write removes a timer, as a pause or a cancel of an active schedule does. */
function removesTimer(operations: readonly BatchOperation[]): boolean {
  return operations.some(
    (operation) => operation.type === 'delete' && operation.key.startsWith('timer-idx:'),
  );
}

/** What a held write is: the first one that puts a schedule's key (each test has one schedule). */
function putsScheduleKey(operations: readonly BatchOperation[]): boolean {
  return operations.some(
    (operation) => operation.type === 'put' && operation.key.startsWith(KEYS.schedule('')),
  );
}

export type Hold = { readonly reached: Promise<void>; release(): void };

/**
 * One engine's handle on the shared store. `holdScheduleWrite()` parks the next write that puts
 * the schedule key until `release()`; `failRunStarts` makes a write that creates a scheduled run
 * throw, as a storage fault does. `capConditionalBatches` bounds a retry that would never end, so
 * a test of one fails instead of hanging.
 */
export function engineStorage(shared: Storage) {
  let armed:
    | {
        reached: () => void;
        open: Promise<void>;
        matches: (operations: readonly BatchOperation[]) => boolean;
      }
    | undefined;
  let failRunStarts = false;
  let failScheduleWrites = false;
  let conditionalBatchCap: number | undefined;
  let conditionalBatches = 0;
  const hold = (matches: (operations: readonly BatchOperation[]) => boolean): Hold => {
    const reached = Promise.withResolvers<void>();
    const open = Promise.withResolvers<void>();
    armed = { reached: reached.resolve, open: open.promise, matches };
    return { reached: reached.promise, release: open.resolve };
  };
  const storage = new Proxy(shared, {
    get(target, property) {
      const member = Reflect.get(target, property, target) as unknown;
      if (typeof member !== 'function' || typeof property !== 'string') return member;
      return (...args: unknown[]) => {
        const call = () => (member as (...a: unknown[]) => unknown).apply(target, args);
        if (property !== 'batch' && property !== 'conditionalBatch') return call();
        if (property === 'conditionalBatch') {
          conditionalBatches += 1;
          if (conditionalBatchCap !== undefined && conditionalBatches > conditionalBatchCap) {
            return Promise.reject(new Error('conditional batch cap exceeded'));
          }
        }
        const operations = (property === 'batch' ? args[0] : args[1]) as BatchOperation[];
        if (
          failRunStarts &&
          operations.some(
            (operation) => operation.type === 'put' && operation.key.startsWith('schedule-run:'),
          )
        ) {
          return Promise.reject(new Error('simulated schedule start failure'));
        }
        if (failScheduleWrites && putsScheduleKey(operations)) {
          return Promise.reject(new Error('simulated schedule write failure'));
        }
        if (armed?.matches(operations)) {
          const held = armed;
          armed = undefined;
          held.reached();
          return held.open.then(call);
        }
        return call();
      };
    },
  });
  return {
    storage,
    holdScheduleWrite(): Hold {
      return hold(putsScheduleKey);
    },
    holdTimerRemoval(): Hold {
      return hold(removesTimer);
    },
    failRunStarts(): void {
      failRunStarts = true;
    },
    /** Makes every write that puts the schedule key throw, as a storage fault does. */
    failScheduleWrites(): void {
      failScheduleWrites = true;
    },
    /** Bounds a write that would otherwise retry without end: past `limit` batches it rejects. */
    capConditionalBatches(limit: number): void {
      conditionalBatchCap = limit;
    },
    get conditionalBatches(): number {
      return conditionalBatches;
    },
  };
}

const closers: Array<() => void> = [];

/** Disposes the engines the test opened; each test file passes it to `afterEach`. */
export function closeOpenedEngines(): void {
  for (const close of closers.splice(0)) close();
}

/**
 * Two engines over one store, each counting the services its resolver is asked for (COR-1925):
 * `resolved.a` and `resolved.b` hold the workflow ids, in order.
 */
export async function openEngines(
  scheduleOptions: Pick<ScheduleOptions, 'backfill' | 'overlap'> = {},
) {
  const clock = { now: START };
  const shared = new BunSQLiteStorage(':memory:');
  const a = engineStorage(shared);
  const b = engineStorage(shared);
  const resolved = { a: [] as string[], b: [] as string[] };
  const resolverFor = (ids: string[]) => async (info: { workflowId: string }) => {
    ids.push(info.workflowId);
    return { status: 'available' as const, services: {} };
  };
  const engineA = createEngine(clock, a.storage, {
    resolveWorkflowServices: resolverFor(resolved.a),
  });
  const engineB = createEngine(clock, b.storage, {
    resolveWorkflowServices: resolverFor(resolved.b),
  });
  closers.push(
    () => engineA[Symbol.dispose](),
    () => engineB[Symbol.dispose](),
  );
  for (const engine of [engineA, engineB]) {
    registerWorkflow(engine, 'across-workflow', async function* (ctx) {
      yield* ctx.waitForSignal('release');
      return 'done';
    });
  }
  await engineA.schedule('across-workflow', null, '* * * * *', {
    id: SCHEDULE_ID,
    ...scheduleOptions,
  });
  return { clock, shared, a, b, engineA, engineB, resolved };
}

export async function stateOf(shared: Storage): Promise<ScheduleState> {
  const bytes = await shared.get(KEYS.schedule(SCHEDULE_ID));
  const state = bytes === null ? null : decodeScheduleState(bytes);
  if (state === null) throw new Error('The schedule is missing.');
  return state;
}

/** Ticks engine B at the schedule's first occurrence; the tick resolves once its write is let go. */
export async function tickB(
  clock: { now: number },
  engineB: Engine,
  shared: Storage,
  lateByMilliseconds = 0,
) {
  const { nextFireAt } = await stateOf(shared);
  clock.now = nextFireAt! + lateByMilliseconds;
  return engineB.scheduler.tick(clock.now);
}

/**
 * A backfilled `queue` schedule with three occurrences overdue, and engine A's tick parked at the
 * drain its resumed section makes (COR-1925): the run now that held the slot has ended, the first
 * occurrence queued behind it, and the run's schedule record is gone, as when another engine's
 * terminal handler or tick refreshed it first. `first` is the first occurrence.
 */
export async function parkResumedSectionDrain() {
  const opened = await openEngines({ overlap: 'queue', backfill: true });
  const { clock, shared, a, engineA } = opened;
  const triggered = await engineA.triggerSchedule(SCHEDULE_ID);
  if (triggered.outcome !== 'started') throw new Error('The run now should start.');
  const { nextFireAt } = await stateOf(shared);
  const first = nextFireAt!;
  await shared.delete(KEYS.scheduleRun(triggered.workflowId));
  // The first occurrence finds the run still going and queues, and that write is parked.
  const queuing = a.holdScheduleWrite();
  clock.now = first + 2 * MINUTE;
  const tickingA = engineA.scheduler.tick(clock.now);
  await queuing.reached;
  await engineA.signal(triggered.workflowId, 'release');
  await drainEngine();
  // Armed in the same turn as the release, so it parks the drain the resumed section makes.
  const draining = a.holdScheduleWrite();
  queuing.release();
  await draining.reached;
  return { ...opened, first, tickingA, draining };
}

/** Whether the schedule's next occurrence has a timer entry in the store. */
export async function nextTimerArmed(shared: Storage): Promise<boolean> {
  const { nextFireAt } = await stateOf(shared);
  return (
    nextFireAt !== null && (await shared.get(KEYS.scheduleTick(nextFireAt, SCHEDULE_ID))) !== null
  );
}

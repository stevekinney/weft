/**
 * A durable sleep keeps its original deadline when a workflow parked on it is
 * replayed before the deadline. Each step below is a fresh `Engine.create()`
 * over one shared `MemoryStorage`, the shape of an invocation-driven host: a
 * process starts the workflow and exits while it is parked, and later
 * processes wake it with `runMaintenance(now)` or `recoverAll()`.
 *
 * Replaying the parked workflow (the claim takeover inside `runMaintenance`,
 * or `recoverAll`) re-runs `ctx.sleep` and commits a new checkpoint. The sleep
 * once recomputed its deadline from that checkpoint's `createdAt`, so every
 * wake-up before the deadline moved it later by the time already elapsed and a
 * wake-up cadence shorter than the sleep kept it from ever firing.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { decode } from '../codec.ts';
import type { TimerEntry } from '../types.ts';
import { activity, workflow } from '../types.ts';
import { Engine } from './index.ts';

const SLEEP_MS = 60_000;
const STARTED_AT = 1_000_000;
const ORIGINAL_DEADLINE = STARTED_AT + SLEEP_MS;

const activityRuns: string[] = [];

const charge = activity({
  name: 'sleep-deadline-replay-charge',
  execute: async (order: string) => {
    activityRuns.push(`charge:${order}`);
    return `charged ${order}`;
  },
});

const finish = activity({
  name: 'sleep-deadline-replay-finish',
  execute: async (order: string) => {
    activityRuns.push(`finish:${order}`);
    return `finished ${order}`;
  },
});

const order = workflow({ name: 'sleep-deadline-replay-order' }).execute(async function* (
  ctx,
  input: string,
) {
  const charged = yield* ctx.run(charge, input);
  yield* ctx.sleep(SLEEP_MS);
  const finished = yield* ctx.run(finish, input);
  return `${charged}; ${finished}`;
});

/** One invocation's engine: its own fixed clock, nothing running in the background. */
function createInvocationEngine(storage: MemoryStorage, now: number) {
  return Engine.create({
    storage,
    workflows: { 'sleep-deadline-replay-order': order },
    activities: { [charge.name]: charge, [finish.name]: finish },
    ownership: 'workflow-lease',
    workflowClaimTtl: 1000,
    workflowClaimRenewInterval: 250,
    backgroundTasks: 'manual',
    getNow: () => now,
    recover: false,
  });
}

async function storedSleepDeadlines(storage: MemoryStorage, workflowId: string): Promise<number[]> {
  const deadlines: number[] = [];
  for await (const [, value] of storage.scan('wf-deadline:')) {
    const entry = decode(value) as TimerEntry;
    if (entry.kind === 'sleep' && entry.workflowId === workflowId) deadlines.push(entry.fireAt);
  }
  return deadlines;
}

async function waitUntilParkedOnSleep(storage: MemoryStorage, workflowId: string): Promise<void> {
  await waitForCondition(
    async () => {
      const deadlines = await storedSleepDeadlines(storage, workflowId);
      return deadlines.length > 0;
    },
    {
      label: `"${workflowId}" parked on its sleep`,
      timeoutMs: 2_000,
    },
  );
}

/** Invocation 1: start the workflow at `STARTED_AT` and exit once it is parked on the sleep. */
async function startAndPark(storage: MemoryStorage, workflowId: string): Promise<void> {
  const engine = await createInvocationEngine(storage, STARTED_AT);
  await engine.start('sleep-deadline-replay-order', workflowId, { id: workflowId });
  await waitUntilParkedOnSleep(storage, workflowId);
  await engine.shutdown();
  expect(await storedSleepDeadlines(storage, workflowId)).toEqual([ORIGINAL_DEADLINE]);
}

type InvocationEngine = Awaited<ReturnType<typeof createInvocationEngine>>;

/** The replay committed a checkpoint that parks on the sleep again at `now`. */
async function reparkedAt(engine: InvocationEngine, workflowId: string, now: number) {
  const timeline = await engine.getTimeline(workflowId);
  return timeline.some((entry) => entry.operationType === 'sleep' && entry.timestamp === now);
}

/** A later invocation: one maintenance pass at `now`, then wait until `settled`. */
async function maintainAt(
  storage: MemoryStorage,
  workflowId: string,
  now: number,
  settled: (engine: InvocationEngine) => Promise<boolean>,
) {
  const engine = await createInvocationEngine(storage, now);
  await engine.runMaintenance(now);
  await waitForCondition(() => settled(engine), {
    label: `"${workflowId}" settled at ${now}`,
    timeoutMs: 2_000,
  });
  const state = await engine.get(workflowId);
  await engine.shutdown();
  return state;
}

async function completed(engine: InvocationEngine, workflowId: string) {
  const state = await engine.get(workflowId);
  return state?.status === 'completed';
}

describe('a parked durable sleep replayed before its deadline', () => {
  it('fires at its original deadline under a maintenance cadence shorter than the sleep', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'sleep-deadline-replay-maintenance';
    await startAndPark(storage, workflowId);

    // Halfway through the sleep: the pass takes over the unclaimed workflow and
    // replays it onto the sleep, committing a checkpoint created now.
    const halfwayAt = STARTED_AT + SLEEP_MS / 2;
    const halfway = await maintainAt(storage, workflowId, halfwayAt, (engine) =>
      reparkedAt(engine, workflowId, halfwayAt),
    );
    expect(halfway?.status).toBe('running');
    expect(await storedSleepDeadlines(storage, workflowId)).toEqual([ORIGINAL_DEADLINE]);

    const due = await maintainAt(storage, workflowId, ORIGINAL_DEADLINE, (engine) =>
      completed(engine, workflowId),
    );
    expect(due?.status).toBe('completed');
    expect(due?.result).toBe(`charged ${workflowId}; finished ${workflowId}`);
    expect(activityRuns.filter((run) => run.endsWith(`:${workflowId}`))).toEqual([
      `charge:${workflowId}`,
      `finish:${workflowId}`,
    ]);
  });

  it('fires at its original deadline after recoverAll replays it early', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'sleep-deadline-replay-recover-all';
    await startAndPark(storage, workflowId);

    const recoveredAt = STARTED_AT + SLEEP_MS / 2;
    const recovering = await createInvocationEngine(storage, recoveredAt);
    await recovering.recoverAll();
    await waitForCondition(() => reparkedAt(recovering, workflowId, recoveredAt), {
      label: `"${workflowId}" recovered`,
      timeoutMs: 2_000,
    });
    await recovering.shutdown();
    expect(await storedSleepDeadlines(storage, workflowId)).toEqual([ORIGINAL_DEADLINE]);

    const due = await maintainAt(storage, workflowId, ORIGINAL_DEADLINE, (engine) =>
      completed(engine, workflowId),
    );
    expect(due?.status).toBe('completed');
    expect(activityRuns.filter((run) => run.endsWith(`:${workflowId}`))).toEqual([
      `charge:${workflowId}`,
      `finish:${workflowId}`,
    ]);
  });
});

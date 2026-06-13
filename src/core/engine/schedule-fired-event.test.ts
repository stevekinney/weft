import { afterEach, describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { yieldToEventLoop } from '../../testing/fake-timers.test-support.ts';
import { Engine } from '../engine.ts';
import { ScheduleFiredEvent } from '../events/schedule-events.ts';
import {
  workflow as defineWorkflow,
  type ScheduleSummary,
  type WorkflowContext,
  type WorkflowFunction,
} from '../types.ts';

type Clock = { now: number };

type FiredRecord = {
  scheduleId: string;
  workflowId: string;
  firedAt: number;
  occurrence: number | undefined;
};

const MINUTE = 60_000;
const START = Date.UTC(2026, 0, 1, 0, 0, 0);

function createEngine(clock: Clock, storage = new MemoryStorage()): Engine {
  return new Engine({ storage, getNow: () => clock.now });
}

function recordFiredEvents(engine: Engine): FiredRecord[] {
  const fired: FiredRecord[] = [];
  engine.addEventListener('schedule:fired', (event: Event) => {
    const e = event as ScheduleFiredEvent;
    fired.push({
      scheduleId: e.scheduleId,
      workflowId: e.workflowId,
      firedAt: e.firedAt,
      occurrence: e.occurrence,
    });
  });
  return fired;
}

function registerWorkflow<TInput, TOutput>(
  engine: Engine,
  name: string,
  handler: WorkflowFunction<TInput, TOutput>,
): void {
  const definition = defineWorkflow({ name }).execute(handler as WorkflowFunction);
  (engine.register as (workflow: typeof definition) => unknown)(definition);
}

async function drainEngine(): Promise<void> {
  await yieldToEventLoop();
  await yieldToEventLoop();
}

function requireNextFireAt(summary: ScheduleSummary): number {
  if (summary.nextFireAt === null) {
    throw new Error(`Schedule "${summary.id}" does not have a next fire time`);
  }
  return summary.nextFireAt;
}

async function tickEngine(engine: Engine, clock: Clock, nextNow: number): Promise<void> {
  clock.now = nextNow;
  await engine.scheduler.tick(clock.now);
  await drainEngine();
}

async function tickToNextFire(
  engine: Engine,
  clock: Clock,
  handle: { describe(): Promise<ScheduleSummary | null> },
): Promise<void> {
  const summary = await handle.describe();
  if (summary === null) {
    throw new Error('Schedule no longer exists');
  }
  await tickEngine(engine, clock, requireNextFireAt(summary));
}

async function listRunningWorkflowIds(engine: Engine): Promise<string[]> {
  const result = await engine.list({ status: 'running' });
  return result.items.map((item) => item.id).toSorted();
}

async function releaseRunningWorkflows(engine: Engine): Promise<void> {
  for (const workflowId of await listRunningWorkflowIds(engine)) {
    await engine.signal(workflowId, 'release');
  }
  await drainEngine();
}

describe('schedule:fired event', () => {
  let engine: Engine;

  afterEach(() => {
    engine[Symbol.dispose]();
  });

  it('fires once per interval occurrence with the scheduled grid timestamp', async () => {
    const clock = { now: START };
    engine = createEngine(clock);
    const fired = recordFiredEvents(engine);
    registerWorkflow(engine, 'fired-interval', async function* () {
      return 'done';
    });

    const handle = await engine.schedule('fired-interval', null, { every: '5m' }, { id: 'iv' });
    await tickToNextFire(engine, clock, handle);
    await tickToNextFire(engine, clock, handle);

    expect(fired).toHaveLength(2);
    expect(fired[0]).toMatchObject({ scheduleId: 'iv', occurrence: START + 5 * MINUTE });
    expect(fired[1]).toMatchObject({ scheduleId: 'iv', occurrence: START + 10 * MINUTE });
    // firedAt is the engine's injected clock at launch (the tick time).
    expect(fired[0]!.firedAt).toBe(START + 5 * MINUTE);
    // The reported workflowId is a real, listable run.
    const states = await Promise.all(fired.map((f) => engine.get(f.workflowId)));
    expect(states.every((state) => state !== null)).toBe(true);
  });

  it('fires for a cron occurrence with the due grid timestamp', async () => {
    const clock = { now: START };
    engine = createEngine(clock);
    const fired = recordFiredEvents(engine);
    registerWorkflow(engine, 'fired-cron', async function* () {
      return 'done';
    });

    // Every hour on the hour.
    const handle = await engine.schedule('fired-cron', null, '0 * * * *', { id: 'cr' });
    await tickToNextFire(engine, clock, handle);

    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ scheduleId: 'cr', occurrence: START + 60 * MINUTE });
  });

  it('fires for every occurrence under the allow overlap policy', async () => {
    const clock = { now: START };
    engine = createEngine(clock);
    const fired = recordFiredEvents(engine);
    registerWorkflow(engine, 'fired-allow', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('release');
      return 'released';
    });

    const handle = await engine.schedule(
      'fired-allow',
      null,
      { every: '1m' },
      { id: 'allow', overlap: 'allow' },
    );

    await tickToNextFire(engine, clock, handle);
    await tickToNextFire(engine, clock, handle);

    // Two overlapping runs launched → two fires.
    expect(fired).toHaveLength(2);
    expect(new Set(fired.map((f) => f.workflowId)).size).toBe(2);
    await releaseRunningWorkflows(engine);
  });

  it('does NOT fire at queue-time under skip while a run is active, and fires only the launched run', async () => {
    const clock = { now: START };
    engine = createEngine(clock);
    const fired = recordFiredEvents(engine);
    registerWorkflow(engine, 'fired-skip', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('release');
      return 'released';
    });

    const handle = await engine.schedule(
      'fired-skip',
      null,
      { every: '1m' },
      { id: 'skip', overlap: 'skip' },
    );

    await tickToNextFire(engine, clock, handle);
    expect(fired).toHaveLength(1); // first occurrence launched
    // Second boundary while the first run is blocked → skip launches nothing.
    await tickToNextFire(engine, clock, handle);
    expect(fired).toHaveLength(1); // still one — the skipped occurrence did not fire

    await releaseRunningWorkflows(engine);
  });

  it('does NOT fire at queue-time under queue, but fires the queued run at drain with occurrence undefined', async () => {
    const clock = { now: START };
    engine = createEngine(clock);
    const fired = recordFiredEvents(engine);
    registerWorkflow(engine, 'fired-queue', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('release');
      return 'released';
    });

    const handle = await engine.schedule(
      'fired-queue',
      null,
      { every: '1m' },
      { id: 'queue', overlap: 'queue' },
    );

    // First occurrence launches.
    await tickToNextFire(engine, clock, handle);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.occurrence).toBe(START + MINUTE);

    // Second occurrence fires while the first run is active → queued, not launched.
    await tickToNextFire(engine, clock, handle);
    expect(fired).toHaveLength(1);

    // Release the active run; the queued occurrence now drains and launches.
    await releaseRunningWorkflows(engine);
    expect(fired).toHaveLength(2);
    // The queued run's original grid timestamp is not retained.
    expect(fired[1]!.occurrence).toBeUndefined();
    expect(fired[1]!.workflowId).not.toBe(fired[0]!.workflowId);

    await releaseRunningWorkflows(engine);
  });

  it('fires for the replacement run under the cancel-running overlap policy', async () => {
    const clock = { now: START };
    engine = createEngine(clock);
    const fired = recordFiredEvents(engine);
    registerWorkflow(engine, 'fired-cancel', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('release');
      return 'released';
    });

    const handle = await engine.schedule(
      'fired-cancel',
      null,
      { every: '1m' },
      { id: 'cancel', overlap: 'cancel-running' },
    );

    await tickToNextFire(engine, clock, handle);
    expect(fired).toHaveLength(1);
    // Second boundary cancels the first run and launches a replacement → fires again.
    await tickToNextFire(engine, clock, handle);
    expect(fired).toHaveLength(2);
    expect(fired[1]!.workflowId).not.toBe(fired[0]!.workflowId);
    expect(fired[1]!.occurrence).toBe(START + 2 * MINUTE);

    await releaseRunningWorkflows(engine);
  });

  it('fires once per launched occurrence during backfill catch-up on recovery', async () => {
    const storage = new MemoryStorage();
    const clock = { now: START };

    const firstEngine = createEngine(clock, storage);
    registerWorkflow(firstEngine, 'fired-backfill', async function* (_ctx, input: string) {
      return input;
    });
    const handle = await firstEngine.schedule(
      'fired-backfill',
      'catch-up',
      { every: '1m' },
      { id: 'backfill', backfill: true, overlap: 'allow' },
    );
    const created = await handle.describe();
    firstEngine[Symbol.dispose]();

    // Recover and jump three intervals forward in one tick.
    engine = createEngine(clock, storage);
    const fired = recordFiredEvents(engine);
    registerWorkflow(engine, 'fired-backfill', async function* (_ctx, input: string) {
      return input;
    });

    await tickEngine(engine, clock, START + 3 * MINUTE);

    // Three backfilled occurrences launched → three fires, each with its grid timestamp.
    expect(fired).toHaveLength(3);
    expect(fired.map((f) => f.occurrence)).toEqual([
      START + MINUTE,
      START + 2 * MINUTE,
      START + 3 * MINUTE,
    ]);
    // firedAt is the catch-up launch time (the recovery tick), distinct from each
    // occurrence's original grid slot — the precise reason both fields exist.
    expect(fired.map((f) => f.firedAt)).toEqual([
      START + 3 * MINUTE,
      START + 3 * MINUTE,
      START + 3 * MINUTE,
    ]);
    expect(created.id).toBe('backfill');
  });

  it('fires schedule:fired before workflow:failed when services are unavailable', async () => {
    const clock = { now: START };
    // A resolver that reports services unavailable drives startScheduledRun's
    // start-then-fail path: the run launches (so the occurrence fired), then
    // fails. schedule:fired must precede workflow:failed.
    engine = new Engine({
      storage: new MemoryStorage(),
      getNow: () => clock.now,
      resolveWorkflowServices: () => ({ status: 'unavailable' as const, reason: 'no config' }),
    });
    const order: string[] = [];
    engine.addEventListener('schedule:fired', () => order.push('fired'));
    engine.addEventListener('workflow:failed', () => order.push('failed'));
    registerWorkflow(engine, 'fired-services', async function* () {
      return 'done';
    });

    const handle = await engine.schedule('fired-services', null, { every: '1m' }, { id: 'svc' });
    await tickToNextFire(engine, clock, handle);

    expect(order).toEqual(['fired', 'failed']);
  });
});

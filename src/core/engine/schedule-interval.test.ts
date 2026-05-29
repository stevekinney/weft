import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { yieldToEventLoop } from '../../testing/fake-timers.test-support.ts';
import { Engine } from '../engine.ts';
import { getNextIntervalOccurrence } from '../schedule/interval-occurrence.ts';
import {
  schedule as defineSchedule,
  workflow as defineWorkflow,
  type ScheduleSummary,
  type WorkflowContext,
  type WorkflowFunction,
} from '../types.ts';

type Clock = { now: number };

const MINUTE = 60_000;
const START = Date.UTC(2026, 0, 1, 0, 0, 0);

function createEngine(clock: Clock, storage = new MemoryStorage()): Engine {
  return new Engine({ storage, getNow: () => clock.now });
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

describe('interval schedules', () => {
  it('createSchedule accepts an interval spec and computes the first fire one period after creation', async () => {
    const clock = { now: START };
    const engine = createEngine(clock);
    registerWorkflow(engine, 'interval-echo', async function* () {
      return 'done';
    });

    const handle = await engine.schedule(
      'interval-echo',
      null,
      { every: '5m' },
      { id: 'every-5m' },
    );
    const summary = await handle.describe();

    expect(summary).toMatchObject({
      id: 'every-5m',
      workflowType: 'interval-echo',
      intervalMs: 5 * MINUTE,
      status: 'active',
    });
    expect(summary.cronExpression).toBeUndefined();
    expect(summary.nextFireAt).toBe(START + 5 * MINUTE);

    engine[Symbol.dispose]();
  });

  it('fires at successive interval boundaries under TestEngine-style virtual time control', async () => {
    const clock = { now: START };
    const engine = createEngine(clock);
    const fired: number[] = [];

    registerWorkflow(engine, 'interval-tick', async function* () {
      fired.push(clock.now);
      return 'done';
    });

    const handle = await engine.schedule('interval-tick', null, { every: '5m' }, { id: 'ticker' });

    let summary = await handle.describe();
    await tickEngine(engine, clock, requireNextFireAt(summary));
    summary = await handle.describe();
    await tickEngine(engine, clock, requireNextFireAt(summary));
    summary = await handle.describe();
    await tickEngine(engine, clock, requireNextFireAt(summary));

    expect(fired).toEqual([START + 5 * MINUTE, START + 10 * MINUTE, START + 15 * MINUTE]);
    const finalSummary = await handle.describe();
    expect(finalSummary.nextFireAt).toBe(START + 20 * MINUTE);

    engine[Symbol.dispose]();
  });

  it('accepts a numeric millisecond interval', async () => {
    const clock = { now: START };
    const engine = createEngine(clock);
    registerWorkflow(engine, 'interval-ms', async function* () {
      return 'done';
    });

    const handle = await engine.schedule('interval-ms', null, { every: 90_000 }, { id: 'ms' });
    const summary = await handle.describe();
    expect(summary.nextFireAt).toBe(START + 90_000);

    engine[Symbol.dispose]();
  });

  it('honors the skip overlap policy without a separate code path', async () => {
    const clock = { now: START };
    const engine = createEngine(clock);

    registerWorkflow(engine, 'interval-overlap-skip', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('release');
      return 'released';
    });

    const handle = await engine.schedule(
      'interval-overlap-skip',
      null,
      { every: '1m' },
      {
        id: 'interval-skip',
        overlap: 'skip',
      },
    );

    await tickToNextFire(engine, clock, handle);
    expect(await listRunningWorkflowIds(engine)).toHaveLength(1);

    // Second boundary fires while the first run is still blocked → skip keeps one.
    await tickToNextFire(engine, clock, handle);
    expect(await listRunningWorkflowIds(engine)).toHaveLength(1);

    await releaseRunningWorkflows(engine);
    engine[Symbol.dispose]();
  });

  it('honors the allow overlap policy without a separate code path', async () => {
    const clock = { now: START };
    const engine = createEngine(clock);

    registerWorkflow(engine, 'interval-overlap-allow', async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('release');
      return 'released';
    });

    const handle = await engine.schedule(
      'interval-overlap-allow',
      null,
      { every: '1m' },
      {
        id: 'interval-allow',
        overlap: 'allow',
      },
    );

    await tickToNextFire(engine, clock, handle);
    expect(await listRunningWorkflowIds(engine)).toHaveLength(1);

    await tickToNextFire(engine, clock, handle);
    expect(await listRunningWorkflowIds(engine)).toHaveLength(2);

    await releaseRunningWorkflows(engine);
    engine[Symbol.dispose]();
  });

  it('honors backfill on recovery using the same machinery cron uses', async () => {
    const storage = new MemoryStorage();
    const clock = { now: START };
    const executions: string[] = [];

    const firstEngine = createEngine(clock, storage);
    registerWorkflow(firstEngine, 'interval-backfill', async function* (_ctx, input: string) {
      executions.push(input);
      return input;
    });

    const handle = await firstEngine.schedule(
      'interval-backfill',
      'catch-up',
      { every: '1m' },
      {
        id: 'interval-backfill',
        backfill: true,
        overlap: 'allow',
      },
    );
    const created = await handle.describe();
    firstEngine[Symbol.dispose]();

    // Recover and jump three intervals forward in one tick.
    const secondEngine = createEngine(clock, storage);
    registerWorkflow(secondEngine, 'interval-backfill', async function* (_ctx, input: string) {
      executions.push(input);
      return input;
    });

    await tickEngine(secondEngine, clock, START + 3 * MINUTE);

    expect(executions.filter((input) => input === 'catch-up')).toHaveLength(3);
    const recovered = await secondEngine.getSchedule(created.id);
    expect(recovered?.nextFireAt).toBe(START + 4 * MINUTE);

    secondEngine[Symbol.dispose]();
  });

  it('accepts an interval through the declarative schedule definition helper', async () => {
    const clock = { now: START };
    const engine = createEngine(clock);
    const executions: string[] = [];

    const scheduledWorkflow = defineWorkflow({ name: 'interval-definition' }).execute(
      async function* (_ctx: WorkflowContext, input: string) {
        executions.push(input);
        return input;
      },
    );
    engine.register(scheduledWorkflow);

    const handle = await engine.schedule(
      defineSchedule({
        workflow: scheduledWorkflow,
        input: 'from-definition',
        every: '2m',
        id: 'definition-interval',
      }),
    );
    const summary = await handle.describe();
    expect(summary).toMatchObject({ id: 'definition-interval', intervalMs: 2 * MINUTE });

    await tickEngine(engine, clock, requireNextFireAt(summary));
    expect(executions).toEqual(['from-definition']);

    engine[Symbol.dispose]();
  });

  it('pause and resume recompute the interval next fire from the current time', async () => {
    const clock = { now: START };
    const engine = createEngine(clock);
    registerWorkflow(engine, 'interval-pause', async function* () {
      return 'done';
    });

    const handle = await engine.schedule(
      'interval-pause',
      null,
      { every: '10m' },
      {
        id: 'interval-pause',
      },
    );

    clock.now = START + 3 * MINUTE;
    await handle.pause();
    const paused = await handle.describe();
    expect(paused.status).toBe('paused');
    // Pausing re-anchors from the schedule's createdAt, so the next boundary is
    // still the first interval after creation.
    expect(paused.nextFireAt).toBe(getNextIntervalOccurrence(START, 10 * MINUTE, clock.now));

    clock.now = START + 12 * MINUTE;
    await handle.resume();
    const resumed = await handle.describe();
    expect(resumed.status).toBe('active');
    expect(resumed.nextFireAt).toBe(getNextIntervalOccurrence(START, 10 * MINUTE, clock.now));

    engine[Symbol.dispose]();
  });

  it('update switches a cron schedule to an interval and back, replacing the cadence cleanly', async () => {
    const clock = { now: START };
    const engine = createEngine(clock);
    registerWorkflow(engine, 'interval-update', async function* () {
      return 'done';
    });

    const handle = await engine.schedule('interval-update', null, '*/5 * * * *', {
      id: 'interval-update',
    });
    const asCronInitial = await handle.describe();
    expect(asCronInitial.cronExpression).toBe('*/5 * * * *');

    clock.now = START + MINUTE;
    await handle.update({ every: '3m' });
    const asInterval = await handle.describe();
    expect(asInterval.cronExpression).toBeUndefined();
    expect(asInterval.intervalMs).toBe(3 * MINUTE);
    expect(asInterval.nextFireAt).toBe(getNextIntervalOccurrence(clock.now, 3 * MINUTE, clock.now));

    await handle.update('0 * * * *');
    const asCron = await handle.describe();
    expect(asCron.intervalMs).toBeUndefined();
    expect(asCron.cronExpression).toBe('0 * * * *');

    engine[Symbol.dispose]();
  });

  it('rejects an invalid interval spec', async () => {
    const clock = { now: START };
    const engine = createEngine(clock);
    registerWorkflow(engine, 'interval-invalid', async function* () {
      return 'done';
    });

    await expect(
      engine.schedule('interval-invalid', null, { every: 'not-a-duration' }),
    ).rejects.toThrow('Invalid schedule interval "every"');

    await expect(engine.schedule('interval-invalid', null, { every: 0 })).rejects.toThrow(
      'Schedule interval "every" must resolve to a positive number of milliseconds',
    );

    engine[Symbol.dispose]();
  });
});

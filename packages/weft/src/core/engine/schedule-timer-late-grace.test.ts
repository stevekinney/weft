import { afterEach, describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { Engine } from '../engine.ts';
import { ScheduleMissedFireEvent } from '../events/schedule-events.ts';
import { DEFAULT_POLL_INTERVAL_MS } from '../types/constants.ts';
import {
  createEngine,
  registerWorkflow,
  requireNextFireAt,
  START,
  tickEngine,
  type Clock,
} from './schedule.test-support.ts';

// The scheduler sees a schedule's occurrence only when a poll tick lands after it, so a tick
// can reach a due occurrence up to a whole poll interval late, plus whatever the tick itself
// drifted (COR-1616). That lateness is the engine's own, not a missed fire.

function recordMissedFires(engine: Engine): ScheduleMissedFireEvent[] {
  const missed: ScheduleMissedFireEvent[] = [];
  engine.addEventListener(ScheduleMissedFireEvent.type, (event) => {
    missed.push(event);
  });
  return missed;
}

async function scheduleEveryFiveSeconds(engine: Engine, clock: Clock, executions: number[]) {
  registerWorkflow(engine, 'late-grace-workflow', async function* () {
    executions.push(clock.now);
    return 'done';
  });
  return engine.schedule('late-grace-workflow', null, { every: '5s' }, { id: 'late-grace' });
}

describe('schedule timer late grace', () => {
  let engine: Engine;

  afterEach(() => {
    engine[Symbol.dispose]();
  });

  it('fires an occurrence the next poll tick reaches 1001 ms late after a tick 1 ms before it was due', async () => {
    const clock = { now: START };
    engine = createEngine(clock);
    const executions: number[] = [];
    const missed = recordMissedFires(engine);
    const handle = await scheduleEveryFiveSeconds(engine, clock, executions);
    const dueAt = requireNextFireAt(await handle.describe());

    await tickEngine(engine, clock, dueAt - 1);
    expect(executions).toEqual([]);

    await tickEngine(engine, clock, dueAt + DEFAULT_POLL_INTERVAL_MS + 1);

    expect(executions).toEqual([dueAt + DEFAULT_POLL_INTERVAL_MS + 1]);
    expect(missed).toHaveLength(0);
    const description = await handle.describe();
    expect(description.lastFireAt).toBe(dueAt);
    expect(description.missedFireCount).toBe(0);
    expect(description.lastMissedFireAt).toBeUndefined();
    expect(description.nextFireAt).toBe(dueAt + 5_000);
  });

  it('still skips an occurrence a tick reaches more than a poll interval and a second late', async () => {
    const clock = { now: START };
    engine = createEngine(clock);
    const executions: number[] = [];
    const missed = recordMissedFires(engine);
    const handle = await scheduleEveryFiveSeconds(engine, clock, executions);
    const dueAt = requireNextFireAt(await handle.describe());

    await tickEngine(engine, clock, dueAt + DEFAULT_POLL_INTERVAL_MS + 1_001);

    expect(executions).toEqual([]);
    expect(missed).toHaveLength(1);
    const description = await handle.describe();
    expect(description.missedFireCount).toBe(1);
    expect(description.lastMissedFireAt).toBe(dueAt);
    expect(description.lastFireAt).toBeUndefined();
    expect(description.nextFireAt).toBe(dueAt + 5_000);
  });

  it('scales the grace with a configured scheduler poll interval', async () => {
    const clock = { now: START };
    engine = new Engine({
      storage: new MemoryStorage(),
      getNow: () => clock.now,
      schedulerPollIntervalMs: 3_000,
    });
    const executions: number[] = [];
    const missed = recordMissedFires(engine);
    const handle = await scheduleEveryFiveSeconds(engine, clock, executions);
    const dueAt = requireNextFireAt(await handle.describe());

    await tickEngine(engine, clock, dueAt + 3_999);

    expect(executions).toEqual([dueAt + 3_999]);
    expect(missed).toHaveLength(0);
  });
});

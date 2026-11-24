import { afterEach, describe, expect, it } from 'bun:test';

import { createOperationRegistry } from "../../embedded/backchannel/src/internals.ts";
import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { Engine } from '../../core/engine.ts';
import { workflow } from '../../core/types.ts';
import { handleRequestAsLocalUser as handleRequest } from '../local-user-request.test-support.ts';
import {
  listScheduleMissedFiresOperation,
  listScheduleMissedFiresRestBinding,
} from './list-schedule-missed-fires.ts';
import { skipNextScheduleOperation, skipNextScheduleRestBinding } from './skip-next-schedule.ts';
import { triggerScheduleOperation, triggerScheduleRestBinding } from './trigger-schedule.ts';
import { unskipScheduleOperation, unskipScheduleRestBinding } from './unskip-schedule.ts';

// COR-1829, COR-2018: the schedule controls over REST. Each is the engine method behind it, with the
// engine's refusals mapped to the faults the other schedule operations answer.

const registry = createOperationRegistry([
  skipNextScheduleOperation,
  unskipScheduleOperation,
  triggerScheduleOperation,
  listScheduleMissedFiresOperation,
]);
const bindings = [
  skipNextScheduleRestBinding,
  unskipScheduleRestBinding,
  triggerScheduleRestBinding,
  listScheduleMissedFiresRestBinding,
];

async function summaryOf(engine: Engine, id: string) {
  const summary = await engine.getSchedule(id);
  if (summary === null) throw new Error(`Schedule "${id}" does not exist`);
  return summary;
}

async function skipOf(engine: Engine): Promise<number | undefined> {
  const { skippedOccurrences } = await summaryOf(engine, 'hourly');
  expect((skippedOccurrences ?? []).length).toBeLessThanOrEqual(1);
  return skippedOccurrences?.[0];
}

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register(
    workflow({ name: 'echo' }).execute(async function* (_ctx, input: unknown) {
      return input;
    }),
  );
  return engine;
}

async function statusOf(response: Promise<Response>): Promise<number> {
  const settled = await response;
  return settled.status;
}

function post(engine: Engine, path: string, body?: string): Promise<Response> {
  const init: RequestInit =
    body === undefined
      ? { method: 'POST' }
      : { method: 'POST', body, headers: { 'content-type': 'application/json' } };
  return handleRequest(new Request(`http://localhost${path}`, init), engine, {
    operationRegistry: registry,
    restBindings: bindings,
  });
}

function get(engine: Engine, path: string): Promise<Response> {
  return handleRequest(new Request(`http://localhost${path}`), engine, {
    operationRegistry: registry,
    restBindings: bindings,
  });
}

describe('the schedule control operations', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('skips the next run and answers 204, also for a paused schedule, then 409 for a cancelled one and 404 for a missing one', async () => {
    engine = createEngine();
    await engine.schedule('echo', null, '0 * * * *', { id: 'hourly' });

    expect(await statusOf(post(engine, '/v1/schedules/hourly/skip-next'))).toBe(204);
    const skipped = await engine.getSchedule('hourly');
    expect(skipped?.skippedOccurrences).toEqual([skipped!.nextFireAt!]);

    await engine.pauseSchedule('hourly');
    const next = skipped!.nextFireAt!;
    const paused = await post(
      engine,
      '/v1/schedules/hourly/skip-next',
      JSON.stringify({ occurrence: next + 60 * 60_000 }),
    );
    expect(paused.status).toBe(204);
    const pausedSummary = await summaryOf(engine, 'hourly');
    expect(pausedSummary.skippedOccurrences).toEqual([next, next + 60 * 60_000]);

    await engine.cancelSchedule('hourly');
    const conflict = await post(engine, '/v1/schedules/hourly/skip-next');
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).not.toHaveProperty('weftCode');
    expect(await statusOf(post(engine, '/v1/schedules/nope/skip-next'))).toBe(404);
  });

  it('skips the run its body names, the next or a later one, and refuses one that is not upcoming, writing nothing', async () => {
    engine = createEngine();
    await engine.schedule('echo', null, '0 * * * *', { id: 'hourly' });
    const { nextFireAt: next } = await summaryOf(engine, 'hourly');
    if (next === null) throw new Error('The schedule has no next run.');
    const hour = 60 * 60_000;

    for (const occurrence of [next - hour, next + 1, next + hour / 2]) {
      const refused = await post(
        engine,
        '/v1/schedules/hourly/skip-next',
        JSON.stringify({ occurrence }),
      );
      expect(refused.status).toBe(409);
      // `weftCode` is what tells this refusal from the Conflict of a cancelled schedule.
      expect(await refused.json()).toMatchObject({
        error: expect.stringContaining(`no upcoming run at ${String(occurrence)}`),
        weftCode: 'ScheduleOccurrenceNotNextError',
      });
      expect(await skipOf(engine)).toBeUndefined();
    }

    const later = await post(
      engine,
      '/v1/schedules/hourly/skip-next',
      JSON.stringify({ occurrence: next + hour }),
    );
    expect(later.status).toBe(204);
    expect(await skipOf(engine)).toBe(next + hour);
  });

  it('takes a skip back and answers 204, 409 for a run that has passed, and 404 for a missing schedule', async () => {
    engine = createEngine();
    await engine.schedule('echo', null, '0 * * * *', { id: 'hourly' });
    const { nextFireAt: next } = await summaryOf(engine, 'hourly');
    if (next === null) throw new Error('The schedule has no next run.');
    await engine.skipNextScheduleOccurrence('hourly', { occurrence: next });

    const unskipped = await post(
      engine,
      '/v1/schedules/hourly/unskip',
      JSON.stringify({ occurrence: next }),
    );
    expect(unskipped.status).toBe(204);
    expect(await skipOf(engine)).toBeUndefined();

    const passed = await post(
      engine,
      '/v1/schedules/hourly/unskip',
      JSON.stringify({ occurrence: next - 60 * 60_000 }),
    );
    expect(passed.status).toBe(409);
    expect(await passed.json()).toMatchObject({ weftCode: 'ScheduleOccurrenceNotNextError' });
    const missing = await post(
      engine,
      '/v1/schedules/nope/unskip',
      JSON.stringify({ occurrence: next }),
    );
    expect(missing.status).toBe(404);
    for (const body of [JSON.stringify({}), JSON.stringify({ occurrence: 'soon' }), '{not json']) {
      expect(await statusOf(post(engine, '/v1/schedules/hourly/unskip', body))).toBe(400);
    }
  });

  it('refuses a skip whose expectedRevision is stale with a StaleRevision fault, before the occurrence', async () => {
    engine = createEngine();
    await engine.schedule('echo', null, '0 * * * *', { id: 'hourly' });

    const stale = await post(
      engine,
      '/v1/schedules/hourly/skip-next',
      JSON.stringify({ expectedRevision: 7, occurrence: 1 }),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      data: { expectedRevision: 7, currentRevision: 1 },
    });
    expect(await skipOf(engine)).toBeUndefined();

    const current = await post(
      engine,
      '/v1/schedules/hourly/skip-next',
      JSON.stringify({ expectedRevision: 1 }),
    );
    expect(current.status).toBe(204);
  });

  it('answers 400 for an occurrence that is not a non-negative integer or a body that is not an object', async () => {
    engine = createEngine();
    await engine.schedule('echo', null, '0 * * * *', { id: 'hourly' });

    for (const body of [
      JSON.stringify({ occurrence: 'soon' }),
      JSON.stringify({ occurrence: -1 }),
      JSON.stringify({ occurrence: 1.5 }),
      JSON.stringify({ expectedRevision: -1 }),
      JSON.stringify([]),
      '{not json',
    ]) {
      expect(await statusOf(post(engine, '/v1/schedules/hourly/skip-next', body))).toBe(400);
    }
    expect(await skipOf(engine)).toBeUndefined();
  });

  it('runs a schedule now and answers what the overlap policy did', async () => {
    engine = createEngine();
    await engine.schedule('echo', null, '0 * * * *', { id: 'hourly', overlap: 'allow' });

    const response = await post(engine, '/v1/schedules/hourly/run-now');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'started', workflowId: expect.any(String) });
    await engine.cancelSchedule('hourly');
    expect(await statusOf(post(engine, '/v1/schedules/hourly/run-now'))).toBe(409);
    expect(await statusOf(post(engine, '/v1/schedules/nope/run-now'))).toBe(404);
  });

  it('lists the rows a schedule missed, honoring limit, and refuses a limit that is not a positive integer', async () => {
    engine = createEngine();
    await engine.schedule('echo', null, '0 * * * *', { id: 'hourly' });

    const empty = await get(engine, '/v1/schedules/hourly/missed?limit=5');
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ missed: [] });
    expect(await statusOf(get(engine, '/v1/schedules/hourly/missed?limit=0'))).toBe(400);
    expect(await statusOf(get(engine, '/v1/schedules/nope/missed'))).toBe(404);
  });
});

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { throwingRejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { KEYS } from '../../storage/keys.ts';
import { decode, encode } from '../codec.ts';
import { Engine } from '../engine.ts';
import {
  createEngine,
  drainEngine,
  registerWorkflow,
  START,
  tickToNextFire,
} from './schedule.test-support.ts';
import { decodeScheduleState } from './validation/schedule-decode.ts';

// A schedule keeps a plain JSON object its caller chose, such as who owns it (COR-2546). Weft stores
// it whole, returns it with the schedule, and never reads it.

/** The metadata schedule `id` reads back with. */
async function metadataOf(opened: Engine, id: string): Promise<unknown> {
  const summary = await opened.getSchedule(id);
  return summary?.metadata;
}

describe('schedule metadata', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  function open(): Engine {
    engine = new Engine({ storage: new MemoryStorage() });
    registerWorkflow(engine, 'report', async function* () {
      return 'ok';
    });
    return engine;
  }

  it('stores the metadata a schedule is created with and returns it from get and list', async () => {
    const opened = open();
    await opened.schedule('report', null, '0 9 * * *', {
      id: 'owned',
      metadata: { owner: { kind: 'user', id: 'ada' }, tags: ['a', 1, null, true] },
    });

    const expected = { owner: { kind: 'user', id: 'ada' }, tags: ['a', 1, null, true] };
    expect(await metadataOf(opened, 'owned')).toEqual(expected);
    const listed = await opened.listSchedules();
    expect(listed.items[0]?.metadata).toEqual(expected);
  });

  it('gives a schedule created without metadata none', async () => {
    const opened = open();
    await opened.schedule('report', null, '0 9 * * *', { id: 'plain' });

    const stored = await opened.getSchedule('plain');
    expect(stored && 'metadata' in stored).toBe(false);
  });

  it('replaces the metadata whole on an update that names it, and keeps it on one that does not', async () => {
    const opened = open();
    await opened.schedule('report', null, '0 9 * * *', { id: 'owned', metadata: { a: 1, b: 2 } });

    await opened.updateSchedule('owned', '0 10 * * *', { description: 'renamed' });
    expect(await metadataOf(opened, 'owned')).toEqual({ a: 1, b: 2 });

    await opened.updateSchedule('owned', '0 10 * * *', { metadata: { c: 3 } });
    expect(await metadataOf(opened, 'owned')).toEqual({ c: 3 });
  });

  it('keeps the metadata through a pause, a resume and a status transition', async () => {
    const opened = open();
    await opened.schedule('report', null, '0 9 * * *', { id: 'owned', metadata: { a: 1 } });

    await opened.pauseSchedule('owned');
    expect(await metadataOf(opened, 'owned')).toEqual({ a: 1 });
    await opened.resumeSchedule('owned');
    expect(await metadataOf(opened, 'owned')).toEqual({ a: 1 });
  });

  it('keeps the metadata through every writer: a cadence fire, a manual run, a skip, an input replacement and a cancel', async () => {
    const clock = { now: START };
    const timed = createEngine(clock);
    engine = timed;
    registerWorkflow(timed, 'report', async function* () {
      return 'ok';
    });
    const handle = await timed.schedule(
      'report',
      null,
      { every: '1m' },
      {
        id: 'owned',
        metadata: { owner: 'ada' },
      },
    );
    const metadataNow = () => metadataOf(timed, 'owned');

    await tickToNextFire(timed, clock, handle);
    const fired = await timed.getSchedule('owned');
    expect(fired?.lastFireAt).toBeDefined();
    expect(await metadataNow()).toEqual({ owner: 'ada' });

    await timed.triggerSchedule('owned');
    await drainEngine();
    expect(await metadataNow()).toEqual({ owner: 'ada' });

    await timed.skipNextScheduleOccurrence('owned');
    expect(await metadataNow()).toEqual({ owner: 'ada' });

    const replaceable = await timed.getSchedule('owned');
    await timed.replaceScheduleInput(
      'owned',
      { fresh: true },
      {
        expectedRevision: replaceable!.revision,
        status: 'active',
      },
    );
    expect(await metadataNow()).toEqual({ owner: 'ada' });

    await timed.cancelSchedule('owned');
    expect(await metadataNow()).toEqual({ owner: 'ada' });
  });

  it('refuses metadata that is not a plain JSON object', async () => {
    const opened = open();
    class Owner {
      readonly id = 'ada';
    }

    for (const metadata of [
      [],
      'ada',
      7,
      null,
      new Owner(),
      { fn: () => 1 },
      { nan: Number.NaN },
    ]) {
      expect(
        await throwingRejectionOf(
          opened.schedule('report', null, '0 9 * * *', {
            id: 'refused',
            metadata: metadata as never,
          }),
        ),
      ).toThrow('options.metadata must be a plain JSON object');
    }
    expect(await opened.getSchedule('refused')).toBeNull();

    await opened.schedule('report', null, '0 9 * * *', { id: 'owned' });
    expect(
      await throwingRejectionOf(
        opened.updateSchedule('owned', '0 9 * * *', { metadata: [] as never }),
      ),
    ).toThrow('options.metadata must be a plain JSON object');
  });

  it('stores the metadata as it was validated, never as the caller changes it while the write is pending', async () => {
    const opened = open();

    const created = { owner: { id: 'ada' }, count: 1 };
    const creating = opened.schedule('report', null, '0 9 * * *', {
      id: 'owned',
      metadata: created,
    });
    created.count = Number.NaN;
    created.owner.id = 'mallory';
    await creating;
    expect(await metadataOf(opened, 'owned')).toEqual({ owner: { id: 'ada' }, count: 1 });

    const updated = { owner: { id: 'grace' }, count: 2 };
    const updating = opened.updateSchedule('owned', '0 10 * * *', { metadata: updated });
    updated.count = Number.NaN;
    updated.owner.id = 'mallory';
    await updating;
    expect(await metadataOf(opened, 'owned')).toEqual({ owner: { id: 'grace' }, count: 2 });
    expect(await opened.listSchedules()).toMatchObject({
      items: [{ id: 'owned', metadata: { owner: { id: 'grace' }, count: 2 } }],
    });
  });

  describe('a persisted record', () => {
    async function persistedRecord(): Promise<Record<string, unknown>> {
      const opened = open();
      await opened.schedule('report', null, '0 9 * * *', { id: 'stored', metadata: { a: 1 } });
      const bytes = await opened.storage.get(KEYS.schedule('stored'));
      return decode(bytes!) as Record<string, unknown>;
    }

    it('reads a record stored before schedules had metadata as having none', async () => {
      const { metadata: _dropped, ...legacy } = await persistedRecord();

      const state = decodeScheduleState(encode(legacy));

      expect(state).not.toBeNull();
      expect(state && 'metadata' in state).toBe(false);
    });

    it('reads the metadata it was written with', async () => {
      expect(decodeScheduleState(encode(await persistedRecord()))?.metadata).toEqual({ a: 1 });
    });

    it('rejects a record whose metadata is not a plain JSON object', async () => {
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const record = await persistedRecord();
        for (const metadata of ['ada', 7, ['a'], null]) {
          expect(decodeScheduleState(encode({ ...record, metadata }))).toBeNull();
        }
        expect(warn).toHaveBeenCalledWith(
          '[weft] Ignoring malformed schedule "stored" with invalid metadata.',
        );
      } finally {
        warn.mockRestore();
      }
    });
  });
});

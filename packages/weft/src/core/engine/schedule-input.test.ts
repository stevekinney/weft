import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { expect, it } from 'bun:test';
import { KEYS } from '../../storage/keys.ts';
import { decode, encode } from '../codec.ts';
import { Engine } from './index.ts';
import { registerWorkflow } from './schedule.test-support.ts';

it('replaces future input once, pauses atomically, and commits caller audit with the same revision', async () => {
  const storage = new MemoryStorage();
  using engine = new Engine({ storage, ownership: 'none' });
  registerWorkflow(engine, 'report', async function* () {
    return 'done';
  });
  await engine.schedule('report', { actor: 'old' }, { every: '24h' }, { id: 'report' });
  const before = (await engine.getSchedule('report'))!;
  await engine.replaceScheduleInput(
    'report',
    { actor: 'new' },
    {
      expectedRevision: before.revision,
      additionalOperations: [
        { type: 'put', key: 'audit:assignment', value: encode({ actor: 'new' }) },
      ],
    },
  );
  expect(await engine.getSchedule('report')).toMatchObject({
    status: 'paused',
    revision: before.revision + 1,
  });
  expect(decode((await storage.get(KEYS.schedule('report')))!)).toMatchObject({
    input: { actor: 'new' },
  });
  expect(decode((await storage.get('audit:assignment'))!)).toEqual({ actor: 'new' });
  const retry = await engine
    .replaceScheduleInput('report', { actor: 'other' }, { expectedRevision: before.revision })
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(retry).toBeInstanceOf(Error);
  expect(decode((await storage.get(KEYS.schedule('report')))!)).toMatchObject({
    input: { actor: 'new' },
  });
  await engine.replaceScheduleInput(
    'report',
    { actor: 'third' },
    { expectedRevision: before.revision + 1 },
  );
  expect(await engine.getSchedule('report')).toMatchObject({
    status: 'paused',
    revision: before.revision + 2,
  });
});

it('creates a paused schedule in its first commit and rejects invalid initial states', async () => {
  const storage = new MemoryStorage();
  using engine = new Engine({ storage, ownership: 'none' });
  registerWorkflow(engine, 'report', async function* () {
    return 'done';
  });
  await engine.schedule('report', {}, { every: '24h' }, { id: 'held', initialStatus: 'paused' });
  expect(await engine.getSchedule('held')).toMatchObject({ status: 'paused', revision: 1 });
  const timers = [];
  for await (const [key] of storage.scan('timer:')) timers.push(key);
  expect(timers).toEqual([]);
  const denied = await engine
    .schedule('report', {}, { every: '24h' }, { initialStatus: 'invalid' as 'paused' })
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(denied).toBeInstanceOf(Error);
  expect(String(denied)).toContain('initialStatus');
});

it('refuses missing revision, invalid status, and cancelled replacement without changing persisted input', async () => {
  const storage = new MemoryStorage();
  using engine = new Engine({ storage, ownership: 'none' });
  registerWorkflow(engine, 'report', async function* () {
    return 'done';
  });
  await engine.schedule('report', { actor: 'original' }, { every: '24h' }, { id: 'report' });
  for (const options of [{}, { expectedRevision: 1, status: 'cancelled' }]) {
    const failure = await engine
      .replaceScheduleInput('report', { actor: 'new' }, options as { expectedRevision: number })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(Error);
  }
  await engine.replaceScheduleInput(
    'report',
    { actor: 'resumed' },
    { expectedRevision: 1, status: 'active' },
  );
  expect(await engine.getSchedule('report')).toMatchObject({ status: 'active', revision: 2 });
  await engine.cancelSchedule('report');
  const cancelled = (await engine.getSchedule('report'))!;
  const failure = await engine
    .replaceScheduleInput('report', { actor: 'new' }, { expectedRevision: cancelled.revision })
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(failure).toBeInstanceOf(Error);
  expect(decode((await storage.get(KEYS.schedule('report')))!)).toMatchObject({
    input: { actor: 'resumed' },
    status: 'cancelled',
  });
});

it('keeps workflow observables available when schedule operations initialize before atomic state', async () => {
  using engine = new Engine({ storage: new MemoryStorage(), ownership: 'none' });
  registerWorkflow(engine, 'report', async function* () {
    return 'done';
  });
  const handle = await engine.start('report', {});
  expect(typeof handle[Symbol.observable]).toBe('function');
  await handle.result();
});

it('replaces persisted schedule input before the reopened engine catalog has initialized', async () => {
  const storage = new MemoryStorage();
  using first = new Engine({ storage, ownership: 'none' });
  registerWorkflow(first, 'report', async function* () {
    return 'done';
  });
  await first.schedule('report', { actor: 'original' }, { every: '24h' }, { id: 'report' });
  using reopened = new Engine({ storage, ownership: 'none' });
  await reopened.replaceScheduleInput('report', { actor: 'replacement' }, { expectedRevision: 1 });
  expect(await reopened.getSchedule('report')).toMatchObject({ status: 'paused', revision: 2 });
  expect(decode((await storage.get(KEYS.schedule('report')))!)).toMatchObject({
    input: { actor: 'replacement' },
  });
});

it('preserves the caller condition error callback while snapshotting input replacement', async () => {
  const storage = new MemoryStorage();
  using engine = new Engine({ storage, ownership: 'none' });
  registerWorkflow(engine, 'report', async function* () {
    return 'done';
  });
  await engine.schedule('report', { actor: 'original' }, { every: '24h' }, { id: 'report' });
  await storage.put('caller:guard', new Uint8Array([1]));
  const conflict = new Error('Caller guard changed');
  const failure = await engine
    .replaceScheduleInput(
      'report',
      { actor: 'new' },
      {
        expectedRevision: 1,
        extraConditions: [{ key: 'caller:guard', expectedValue: null }],
        onExtraConditionsLost: () => conflict,
      },
    )
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(failure).toBe(conflict);
  expect(await engine.getSchedule('report')).toMatchObject({ revision: 1 });
  await engine.replaceScheduleInput(
    'report',
    { actor: 'new' },
    {
      expectedRevision: 1,
      extraConditions: [{ key: 'caller:guard', expectedValue: new Uint8Array([1]) }],
      onExtraConditionsLost: () => conflict,
    },
  );
  expect(await engine.getSchedule('report')).toMatchObject({ revision: 2, status: 'paused' });
});

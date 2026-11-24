/**
 * COR-1988. A timeline entry carries `stepIndex`, the durable step index its operation occupies,
 * which is the value a `ctx.log` line's `step` carries. The entry's `step` is the checkpoint key
 * and counts checkpoints, so it cannot place a log line; `stepIndex` can. The seven cases below
 * are the ones where counting entries or checkpoints goes wrong: a signal resume, a retry, a
 * group of branches (`runAll`, `all`, `race`, nested), a speculation that commits or rolls back,
 * session state writes, a repeated memo key, and a fork.
 *
 * A log line's `step` is the index of the NEXT durable operation, because logging consumes none.
 * So a line sits immediately in front of the entry whose `stepIndex` equals the line's `step`.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";

import { settleInlineLaunches } from '../../testing/inline-launch-settle.test-support.ts';
import { Engine } from '../engine.ts';
import { activity } from '../types.ts';
import { workflow } from '../types/workflow-function.ts';
import { createWorkflowLogStore } from '../workflow-log-store.ts';

const noop = activity({ name: 'noop', execute: async (input: string) => input });

function createEngine(
  storage = new MemoryStorage(),
  extra: ConstructorParameters<typeof Engine>[0] = {},
) {
  const logs = createWorkflowLogStore(storage);
  return new Engine({ storage, onLog: logs.sink, workflowLogs: logs, ...extra });
}

/**
 * The timeline as `[operationType, stepIndex]` pairs. A signal wait is recorded again each time
 * the run is relaunched to wait on it, so back-to-back entries that agree on both values are one
 * wait: how many times it was recorded is not under test, but a repeat that disagrees about its
 * `stepIndex` is, and survives.
 */
async function entriesOf(engine: Engine, id: string): Promise<Array<[string, number | undefined]>> {
  const timeline = await engine.getTimeline(id);
  const pairs: Array<[string, number | undefined]> = [];
  for (const entry of timeline) {
    const previous = pairs.at(-1);
    if (
      previous !== undefined &&
      previous[0] === 'wait-signal' &&
      previous[0] === entry.operationType &&
      previous[1] === entry.stepIndex
    ) {
      continue;
    }
    pairs.push([entry.operationType, entry.stepIndex]);
  }
  return pairs;
}

async function linesOf(engine: Engine, id: string): Promise<Array<[string, number | null]>> {
  const result = await engine.getLogs(id);
  return result.lines.map((line) => [line.message, line.step]);
}

describe('timeline entry stepIndex', () => {
  it('matches the step of the line logged in front of its operation', async () => {
    await using engine = createEngine();
    engine.register(
      workflow({ name: 'basic' })
        .activities({ noop })
        .execute(async function* (ctx) {
          ctx.log?.info('first');
          yield* ctx.run('noop', 'a');
          return 'done';
        }),
    );
    const handle = await engine.start('basic', null, { id: 'basic-1' });
    await handle.result();

    const timeline = await engine.getTimeline('basic-1');
    const { lines } = await engine.getLogs('basic-1');
    expect(lines[0]?.step).toBe(0);
    expect(timeline[0]?.stepIndex).toBe(lines[0]?.step ?? -1);
    expect(timeline[0]?.stepIndex).toBe(0);
  });

  it('survives a signal resume: the lines after the wait sit in front of the step after it', async () => {
    await using engine = createEngine();
    engine.register(
      workflow({ name: 'signal-resume' })
        .activities({ noop })
        .execute(async function* (ctx) {
          ctx.log?.info('before-wait');
          const value = yield* ctx.waitForSignal<string>('go');
          ctx.log?.info('after-wait');
          yield* ctx.run('noop', value);
          ctx.log?.info('end');
          return value;
        }),
    );
    const handle = await engine.start('signal-resume', null, { id: 'resume-1' });
    await settleInlineLaunches();
    await engine.signal('resume-1', 'go', 'v');
    await handle.result();

    expect(await entriesOf(engine, 'resume-1')).toEqual([
      ['wait-signal', 0],
      ['activity', 1],
    ]);
    expect(await linesOf(engine, 'resume-1')).toEqual([
      ['before-wait', 0],
      ['after-wait', 1],
      ['end', 2],
    ]);
  });

  it('survives a recovered run that resumes from a parked signal wait', async () => {
    const storage = new MemoryStorage();
    const build = (engine: Engine) =>
      engine.register(
        workflow({ name: 'signal-recover' })
          .activities({ noop })
          .execute(async function* (ctx) {
            ctx.log?.info('before-step');
            yield* ctx.run('noop', 'x');
            const value = yield* ctx.waitForSignal<string>('go');
            ctx.log?.info('after-wait');
            yield* ctx.run('noop', value);
            return value;
          }),
      );
    {
      await using first = createEngine(storage);
      build(first);
      await first.start('signal-recover', null, { id: 'recover-1' });
      await settleInlineLaunches();
    }
    await using recovered = createEngine(storage);
    build(recovered);
    const [handle] = await recovered.recoverAll();
    await settleInlineLaunches();
    await recovered.signal('recover-1', 'go', 'v');
    await handle!.result();

    expect(await entriesOf(recovered, 'recover-1')).toEqual([
      ['activity', 0],
      ['wait-signal', 1],
      ['activity', 2],
    ]);
    expect(await linesOf(recovered, 'recover-1')).toEqual([
      ['before-step', 0],
      ['after-wait', 2],
    ]);
  });

  it('gives a retried activity, and the sleep between attempts, the slot each occupies', async () => {
    let attempts = 0;
    const flaky = activity({
      name: 'flaky',
      retry: { maxAttempts: 3, initialBackoff: 0, backoffMultiplier: 1, maxBackoff: 0 },
      execute: async (_input: null) => {
        attempts += 1;
        if (attempts < 3) throw new Error(`attempt ${String(attempts)}`);
        return 'ok';
      },
    });
    await using engine = createEngine();
    engine.register(
      workflow({ name: 'retry' })
        .activities({ flaky, noop })
        .execute(async function* (ctx) {
          ctx.log?.info('before-flaky');
          yield* ctx.run(flaky, null);
          ctx.log?.info('after-flaky');
          yield* ctx.run('noop', 'x');
          return 'done';
        }),
    );
    const handle = await engine.start('retry', null, { id: 'retry-1' });
    await handle.result();

    // Attempt one and attempt two and three all occupy slot 0; each retry sleep takes the next
    // slot, so the step after the retries is slot 3.
    expect(await entriesOf(engine, 'retry-1')).toEqual([
      ['activity', 0],
      ['sleep', 1],
      ['activity', 0],
      ['sleep', 2],
      ['activity', 0],
      ['activity', 3],
    ]);
    expect(await linesOf(engine, 'retry-1')).toEqual([
      ['before-flaky', 0],
      ['after-flaky', 3],
    ]);
  });

  it('gives a group its own slot, however many slots its branches take, nested to depth two', async () => {
    await using engine = createEngine();
    engine.register(
      workflow({ name: 'groups' })
        .activities({ noop })
        .execute(async function* (ctx) {
          ctx.log?.info('before-all');
          yield* ctx.all([ctx.run('noop', 'a'), ctx.run('noop', 'b')]);
          ctx.log?.info('before-run-all');
          yield* ctx.runAll({
            first: [async () => 1],
            second: [async () => 2],
          });
          ctx.log?.info('before-race');
          yield* ctx.race([ctx.run('noop', 'c'), ctx.run('noop', 'd'), ctx.run('noop', 'e')]);
          ctx.log?.info('before-nested');
          yield* ctx.all([
            ctx.all([ctx.run('noop', 'f'), ctx.all([ctx.run('noop', 'g'), ctx.run('noop', 'h')])]),
            ctx.run('noop', 'i'),
          ]);
          ctx.log?.info('before-last');
          yield* ctx.run('noop', 'j');
          ctx.log?.info('end');
          return 'done';
        }),
    );
    const handle = await engine.start('groups', null, { id: 'groups-1' });
    await handle.result();

    // `all` and `race` take one slot for themselves and one for each branch they prime, nested
    // groups included; `runAll` runs plain functions and takes only its own slot. So the step
    // after the first `all` is 0 + 1 + 2, after `runAll` 3 + 1, after `race` 4 + 1 + 3, and after
    // the nested groups 8 + 1 + 6.
    expect(await entriesOf(engine, 'groups-1')).toEqual([
      ['parallel', 0],
      ['run-all', 3],
      ['race', 4],
      ['parallel', 8],
      ['activity', 15],
    ]);
    expect(await linesOf(engine, 'groups-1')).toEqual([
      ['before-all', 0],
      ['before-run-all', 3],
      ['before-race', 4],
      ['before-nested', 8],
      ['before-last', 15],
      ['end', 16],
    ]);
  });

  it('puts a committed and a rolled-back speculation at the slot of the speculate call', async () => {
    await using engine = createEngine();
    engine.register(
      workflow({ name: 'speculation' })
        .activities({ noop })
        .execute(async function* (ctx) {
          ctx.log?.info('before-commit');
          yield* ctx.speculate(async function* (branch) {
            branch.log?.info('inside-commit');
            yield* branch.run('noop', 'a');
            yield* branch.run('noop', 'b');
            return 'kept';
          });
          ctx.log?.info('before-rollback');
          try {
            yield* ctx.speculate(async function* (branch) {
              branch.log?.info('inside-rollback');
              yield* branch.run('noop', 'c');
              throw new Error('abandon');
            });
          } catch {
            // the rollback is the case under test
          }
          ctx.log?.info('before-last');
          yield* ctx.run('noop', 'd');
          return 'done';
        }),
    );
    const handle = await engine.start('speculation', null, { id: 'speculation-1' });
    await handle.result();

    expect(await entriesOf(engine, 'speculation-1')).toEqual([
      ['speculate', 0],
      ['speculate', 3],
      ['activity', 4],
    ]);
    // A line inside a speculation carries the slot of the speculate call that owns it.
    expect(await linesOf(engine, 'speculation-1')).toEqual([
      ['before-commit', 0],
      ['inside-commit', 0],
      ['before-rollback', 3],
      ['inside-rollback', 3],
      ['before-last', 4],
    ]);
  });

  it('leaves a gap for session state writes, which take a slot and write no entry', async () => {
    await using engine = createEngine();
    engine.register(
      workflow({ name: 'session' })
        .activities({ noop })
        .execute(async function* (ctx) {
          const counter = ctx.state.session<number>('counter', { initial: 0 });
          ctx.log?.info('before-writes');
          counter.set(1);
          counter.update((value) => (value ?? 0) + 1);
          ctx.log?.info('after-writes');
          yield* ctx.run('noop', 'a');
          return 'done';
        }),
    );
    const handle = await engine.start('session', null, { id: 'session-1' });
    await handle.result();

    expect(await entriesOf(engine, 'session-1')).toEqual([['activity', 2]]);
    expect(await linesOf(engine, 'session-1')).toEqual([
      ['before-writes', 0],
      ['after-writes', 2],
    ]);
  });

  it('leaves a gap for a repeated memo key, which takes a slot and writes no entry', async () => {
    await using engine = createEngine();
    engine.register(
      workflow({ name: 'memo' })
        .activities({ noop })
        .execute(async function* (ctx) {
          ctx.log?.info('before-memo');
          yield* ctx.memo('key', () => 'value');
          ctx.log?.info('between-memos');
          yield* ctx.memo('key', () => 'other');
          ctx.log?.info('after-memos');
          yield* ctx.run('noop', 'a');
          return 'done';
        }),
    );
    const handle = await engine.start('memo', null, { id: 'memo-1' });
    await handle.result();

    expect(await entriesOf(engine, 'memo-1')).toEqual([
      ['memo', 0],
      ['activity', 2],
    ]);
    expect(await linesOf(engine, 'memo-1')).toEqual([
      ['before-memo', 0],
      ['between-memos', 1],
      ['after-memos', 2],
    ]);
  });

  it('gives a fork the step index of the lines it logs, from the step it replays to', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    engine.register(
      workflow({ name: 'forkable' })
        .activities({ noop })
        .execute(async function* (ctx) {
          ctx.log?.info('before-first');
          yield* ctx.run('noop', 'a');
          ctx.log?.info('before-wait');
          const value = yield* ctx.waitForSignal<string>('go');
          ctx.log?.info('after-wait');
          yield* ctx.run('noop', value);
          return value;
        }),
    );
    await engine.start('forkable', null, { id: 'source' });
    await settleInlineLaunches();
    const fork = await engine.fork('source');
    await settleInlineLaunches();
    await engine.signal(fork.id, 'go', 'v');
    await fork.result();

    expect(await entriesOf(engine, fork.id)).toEqual([
      ['wait-signal', 1],
      ['activity', 2],
    ]);
    expect(await linesOf(engine, fork.id)).toEqual([
      ['before-wait', 1],
      ['after-wait', 2],
    ]);
  });
});

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { sleepForTesting } from '../../testing/fake-timers.test-support.ts';
import { Engine } from '../engine.ts';
import { activity } from '../types.ts';
import type { WorkflowLogRecord } from '../types/workflow-context.ts';
import { workflow } from '../types/workflow-function.ts';

/**
 * Engine-level replay-safety tests for `ctx.log`. Unlike the unit tests in
 * `workflow-logger.test.ts` (which hand-build internal replay state), these run
 * real workflows through a genuine crash/recover cycle so they prove the engine
 * actually reconstructs replay state and suppresses duplicate logs — and that the
 * `ctx.all` frontier reconciliation holds for a real parallel step.
 */

async function flush(): Promise<void> {
  await sleepForTesting(10);
}

/** Capture every console.{debug,info,warn,error} record. */
function captureConsole(): { records: WorkflowLogRecord[]; restore: () => void } {
  const records: WorkflowLogRecord[] = [];
  const originals = {
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  for (const method of ['debug', 'info', 'warn', 'error'] as const) {
    console[method] = mock((record: unknown) => records.push(record as WorkflowLogRecord));
  }
  return {
    records,
    restore: () => {
      console.debug = originals.debug;
      console.info = originals.info;
      console.warn = originals.warn;
      console.error = originals.error;
    },
  };
}

/** Messages emitted at our marker levels, in order (ignores engine debug noise). */
function loggedMessages(records: WorkflowLogRecord[], type: string): string[] {
  return records
    .filter((r) => r.workflowType === type && r.message.startsWith('marker:'))
    .map((r) => r.message);
}

describe('ctx.log engine-level replay safety', () => {
  let captured: ReturnType<typeof captureConsole>;
  beforeEach(() => {
    captured = captureConsole();
  });
  afterEach(() => {
    captured.restore();
  });

  it('suppresses a log before a committed step on recovery but lets a post-resume log emit', async () => {
    const storage = new MemoryStorage();
    const noop = activity({ name: 'noop', execute: async (input: string) => input });
    const build = (engine: Engine) =>
      engine.register(
        workflow({ name: 'log-recover' })
          .activities({ noop })
          .execute(async function* (ctx) {
            // The log sits BEFORE a committed activity step, so its position is
            // cached after the first run. (A log before an unsatisfied
            // `waitForSignal` would NOT be suppressed: a parked-but-unconsumed
            // signal commits no result, leaving its step at the live frontier.)
            ctx.log?.info('marker:before-step');
            yield* ctx.run('noop', 'x');
            const value = yield* ctx.waitForSignal<string>('go');
            ctx.log?.info('marker:after-resume');
            return value;
          }),
      );

    // The first engine is scoped to a block so `using` disposes it at the block's
    // end — the crash boundary — even if an assertion throws first.
    {
      using first = new Engine({ storage });
      build(first);
      await first.start('log-recover', null, { id: 'log-recover-id' });
      await flush();
      // Fresh run logged the pre-step marker once, ran the activity, then parked.
      expect(loggedMessages(captured.records, 'log-recover')).toEqual(['marker:before-step']);
    }

    // Recover: the engine replays the body to rebuild state. The pre-step log
    // sits before the cached `noop('x')` step → suppressed. Nothing new emits
    // until the signal resumes the run past the replayed prefix.
    captured.restore();
    captured = captureConsole();
    using recovered = new Engine({ storage });
    build(recovered);
    const [handle] = await recovered.recoverAll();
    await flush();
    expect(loggedMessages(captured.records, 'log-recover')).toEqual([]);

    // Resume past the replayed prefix: the post-resume log is now at the live
    // frontier and emits.
    await recovered.signal('log-recover-id', 'go', 'done');
    await expect(handle!.result()).resolves.toBe('done');
    expect(loggedMessages(captured.records, 'log-recover')).toEqual(['marker:after-resume']);
  });

  it('suppresses a log placed after a real ctx.all block once a later step commits', async () => {
    const storage = new MemoryStorage();
    const noop = activity({ name: 'noop', execute: async (input: string) => input });
    const build = (engine: Engine) =>
      engine.register(
        workflow({ name: 'log-after-all' })
          .activities({ noop })
          .execute(async function* (ctx) {
            // A real parallel step with two sub-operations. Its frontier
            // reconciliation (parent + sub-ops, see parallel-operations.ts) is
            // what positions the following log.
            yield* ctx.all([ctx.run('noop', 'a'), ctx.run('noop', 'b')]);
            ctx.log?.info('marker:after-all');
            // A COMMITTED step after the log: its cached result moves the frontier
            // past the log's position, so on replay the log sits at an
            // already-cached step and is suppressed. (Without a committed step
            // after it, the log would be at the live frontier and re-fire — the
            // after-last-step caveat, proven separately below.)
            yield* ctx.run('noop', 'c');
            ctx.log?.info('marker:tail');
            yield* ctx.waitForSignal<string>('go');
            return 'done';
          }),
      );

    {
      using first = new Engine({ storage });
      build(first);
      await first.start('log-after-all', null, { id: 'log-after-all-id' });
      await flush();
      // Fresh run: ctx.all settled, both post-block logs emitted, then parked.
      expect(loggedMessages(captured.records, 'log-after-all')).toEqual([
        'marker:after-all',
        'marker:tail',
      ]);
    }

    // Recover: the body replays through the cached ctx.all AND the committed
    // `noop('c')` step. `marker:after-all` sits before that cached step →
    // suppressed. `marker:tail` sits right after it, before the uncommitted
    // signal park → at the live frontier → re-fires. This is the discriminating
    // proof that the peek tracks the real post-parallel frontier (a hand-set
    // index could not distinguish these two positions).
    captured.restore();
    captured = captureConsole();
    using recovered = new Engine({ storage });
    build(recovered);
    const [handle] = await recovered.recoverAll();
    await flush();
    expect(loggedMessages(captured.records, 'log-after-all')).toEqual(['marker:tail']);

    await recovered.signal('log-after-all-id', 'go', 'go');
    await expect(handle!.result()).resolves.toBe('done');
  });

  it('re-fires a log placed after the last committed step on recovery (documented caveat)', async () => {
    const storage = new MemoryStorage();
    const noop = activity({ name: 'noop', execute: async (input: string) => input });
    const build = (engine: Engine) =>
      engine.register(
        workflow({ name: 'log-after-last' })
          .activities({ noop })
          .execute(async function* (ctx) {
            yield* ctx.run('noop', 'x');
            // This log is AFTER the last committed step and BEFORE the next park.
            // On recovery there is no cached step at this frontier to suppress it,
            // so it re-fires — the after-last-step caveat the docs call out.
            ctx.log?.debug('marker:after-last');
            yield* ctx.waitForSignal<string>('go');
            return 'done';
          }),
      );

    {
      using first = new Engine({ storage });
      build(first);
      await first.start('log-after-last', null, { id: 'log-after-last-id' });
      await flush();
      expect(loggedMessages(captured.records, 'log-after-last')).toEqual(['marker:after-last']);
    }

    captured.restore();
    captured = captureConsole();
    using recovered = new Engine({ storage });
    build(recovered);
    const [handle] = await recovered.recoverAll();
    await flush();
    // The debug log re-fires on recovery (caveat) and routes through console.debug.
    expect(loggedMessages(captured.records, 'log-after-last')).toEqual(['marker:after-last']);

    await recovered.signal('log-after-last-id', 'go', 'go');
    await expect(handle!.result()).resolves.toBe('done');
  });
});

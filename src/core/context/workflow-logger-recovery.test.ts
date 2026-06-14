import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { sleepForTesting, waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { captureWorkflowLogConsole } from '../../testing/workflow-log-capture.test-support.ts';
import { Engine } from '../engine.ts';
import { activity } from '../types.ts';
import { workflow } from '../types/workflow-function.ts';
import type { WorkflowLogRecord } from '../types/workflow-log.ts';

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

/** Messages emitted at our marker levels, in order (ignores engine debug noise). */
function loggedMessages(records: WorkflowLogRecord[], type: string): string[] {
  return records
    .filter((r) => r.workflowType === type && r.message.startsWith('marker:'))
    .map((r) => r.message);
}

describe('ctx.log engine-level replay safety', () => {
  let captured: ReturnType<typeof captureWorkflowLogConsole>;
  beforeEach(() => {
    captured = captureWorkflowLogConsole();
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
    captured = captureWorkflowLogConsole();
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
    captured = captureWorkflowLogConsole();
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
    captured = captureWorkflowLogConsole();
    using recovered = new Engine({ storage });
    build(recovered);
    const [handle] = await recovered.recoverAll();
    await flush();
    // The debug log re-fires on recovery (caveat) and routes through console.debug.
    expect(loggedMessages(captured.records, 'log-after-last')).toEqual(['marker:after-last']);

    await recovered.signal('log-after-last-id', 'go', 'go');
    await expect(handle!.result()).resolves.toBe('done');
  });

  it('delivers a recovered-run live-frontier log to the host sink at parity with the console (#549)', async () => {
    // A plain `ctx.log` after the last committed step is at the live frontier on
    // recovery, so it re-fires (the documented caveat above). The host
    // `EngineOptions.onLog` sink must receive it exactly as many times as the console
    // path does across the cycle — the recovery-path Context must carry the sink, or
    // the record reaches console but never the sink (#549). The criterion is PARITY,
    // not a reduced count: the re-fire on recovery is the existing caveat, and the fix
    // makes the sink match it rather than changing how often it fires.
    const noop = activity({ name: 'noop', execute: async (input: string) => input });
    const build = (engine: Engine) =>
      engine.register(
        workflow({ name: 'log-sink-frontier' })
          .activities({ noop })
          .execute(async function* (ctx) {
            yield* ctx.run('noop', 'x');
            ctx.log?.info('marker:frontier');
            yield* ctx.waitForSignal<string>('go');
            return 'done';
          }),
      );

    // No-sink run: count console markers across the recovered phase. Re-capture after
    // the fresh block so the count covers only the recovered span.
    const consoleStorage = new MemoryStorage();
    {
      using first = new Engine({ storage: consoleStorage });
      build(first);
      await first.start('log-sink-frontier', null, { id: 'log-sink-frontier-id' });
      await flush();
    }
    captured.restore();
    captured = captureWorkflowLogConsole();
    using consoleRecovered = new Engine({ storage: consoleStorage });
    build(consoleRecovered);
    const [consoleHandle] = await consoleRecovered.recoverAll();
    await flush();
    await consoleRecovered.signal('log-sink-frontier-id', 'go', 'go');
    await expect(consoleHandle!.result()).resolves.toBe('done');
    const consoleMarkers = loggedMessages(captured.records, 'log-sink-frontier');

    // With-sink run: count sink markers across the recovered phase of an identical cycle.
    // Only the recovered engine has a sink; the fresh-start engine has none, so every
    // record in `sink` came from the recovered phase (no slice needed).
    const sinkStorage = new MemoryStorage();
    const sink: WorkflowLogRecord[] = [];
    {
      using first = new Engine({ storage: sinkStorage });
      build(first);
      await first.start('log-sink-frontier', null, { id: 'log-sink-frontier-id' });
      await flush();
    }
    using sinkRecovered = new Engine({ storage: sinkStorage, onLog: (record) => sink.push(record) });
    build(sinkRecovered);
    const [sinkHandle] = await sinkRecovered.recoverAll();
    await flush();
    await sinkRecovered.signal('log-sink-frontier-id', 'go', 'go');
    await expect(sinkHandle!.result()).resolves.toBe('done');
    const sinkMarkers = loggedMessages(sink, 'log-sink-frontier');

    // Parity: the sink saw the recovered-run live-frontier log exactly as often as the
    // console path did. (Concretely the caveat re-fires it on both recovery replays, so
    // the current count is 2; the assertion pins parity, not that specific number, so it
    // stays correct if the replay count ever changes.) The `> 0` guard keeps parity from
    // passing vacuously when both paths are empty.
    expect(sinkMarkers).toEqual(consoleMarkers);
    expect(consoleMarkers.length).toBeGreaterThan(0);
  });

  it('delivers a forked-run live-frontier log to the host sink (#549, checkpoint-launch path)', async () => {
    // The sibling recovery path: `engine.fork()` launches the forked run from the source
    // checkpoint through `launchInlineWorkflowFromCheckpoint` (transition.ts), a different
    // Context constructor than the resume path above. It had the same missing-`logSink`
    // omission, so a log at the forked run's live frontier reached the console but never
    // the host sink. Fork drives the generator forward on its own (no signal needed), so
    // the frontier log itself is the observable — we do not signal or await the fork.
    const noop = activity({ name: 'noop', execute: async (input: string) => input });
    const sink: WorkflowLogRecord[] = [];
    using engine = new Engine({ onLog: (record) => sink.push(record) });
    engine.register(
      workflow({ name: 'fork-sink-frontier' })
        .activities({ noop })
        .execute(async function* (ctx) {
          yield* ctx.run('noop', 'x');
          ctx.log?.info('marker:frontier');
          yield* ctx.waitForSignal<string>('go');
          return 'done';
        }),
    );

    await engine.start('fork-sink-frontier', null, { id: 'fork-sink-parent' });
    await flush();
    const sinkBeforeFork = loggedMessages(sink, 'fork-sink-frontier').length;

    // Forking replays the cached `run` step and re-emits the live-frontier log on the
    // forked run; it must reach the sink. (No signal / no result await — those hang on a
    // just-forked run, and the frontier emission alone is what this guards.)
    await engine.fork('fork-sink-parent');
    await waitForCondition(
      () => loggedMessages(sink, 'fork-sink-frontier').length > sinkBeforeFork,
      { label: 'forked run logged its live-frontier marker to the host sink' },
    );

    expect(loggedMessages(sink, 'fork-sink-frontier').length).toBeGreaterThan(sinkBeforeFork);
  });
});

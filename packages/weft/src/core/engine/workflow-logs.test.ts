import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";

import { KEYS } from '../../storage/keys.ts';
import { settleInlineLaunches } from '../../testing/inline-launch-settle.test-support.ts';
import { captureWorkflowLogConsole } from '../../testing/workflow-log-capture.test-support.ts';
import { Engine } from '../engine.ts';
import { activity } from '../types.ts';
import { workflow } from '../types/workflow-function.ts';
import type { WorkflowLogLine, WorkflowLogsResult } from '../workflow-log-codec.ts';
import { createWorkflowLogStore, type WorkflowLogStore } from '../workflow-log-store.ts';

/**
 * Engine-level tests for persisted `ctx.log` lines (COR-1811): the store handed to the engine
 * as `workflowLogs` is fed by `onLog`, read through `Engine.getLogs`, flushed on shutdown, and
 * emptied of a run when the run is purged.
 */

function linesOf(result: WorkflowLogsResult): WorkflowLogLine[] {
  return result.lines;
}
function messagesOf(result: WorkflowLogsResult): string[] {
  return result.lines.map((line) => line.message);
}
function steppedMessagesOf(result: WorkflowLogsResult): Array<[number | null, string]> {
  return result.lines.map((line) => [line.step, line.message]);
}

const noop = activity({ name: 'noop', execute: async (input: string) => input });

function stepsWorkflow(name: string) {
  return workflow({ name })
    .activities({ noop })
    .execute(async function* (ctx) {
      ctx.log?.info('marker:before-first', { tenant: 'acme' });
      yield* ctx.run('noop', 'x');
      ctx.log?.warn('marker:before-second');
      yield* ctx.run('noop', 'y');
      ctx.log?.error('marker:before-third');
      return 'done';
    });
}

function createEngine(storage: MemoryStorage, logs: WorkflowLogStore): Engine {
  return new Engine({ storage, onLog: logs.sink, workflowLogs: logs });
}

describe('Engine.getLogs', () => {
  it('serves a run’s lines per run and per step after the run ends, and after a restart', async () => {
    const storage = new MemoryStorage();
    {
      await using engine = createEngine(storage, createWorkflowLogStore(storage));
      engine.register(stepsWorkflow('logged'));
      const handle = await engine.start('logged', null, { id: 'run-1' });
      expect(await handle.result()).toBe('done');

      const all = await engine.getLogs('run-1');
      expect(all.dropped).toBe(0);
      expect(all.lines.map((line) => [line.step, line.level, line.message])).toEqual([
        [0, 'info', 'marker:before-first'],
        [1, 'warn', 'marker:before-second'],
        [2, 'error', 'marker:before-third'],
      ]);
      expect(all.lines[0]?.attributes).toEqual({ tenant: 'acme' });
      expect(all.lines[0]?.workflowType).toBe('logged');
      expect(messagesOf(await engine.getLogs('run-1', { step: 1 }))).toEqual([
        'marker:before-second',
      ]);
      expect(linesOf(await engine.getLogs('other-run'))).toEqual([]);
    }

    // A new engine and a new store over the same storage: only what was persisted remains.
    await using restarted = createEngine(storage, createWorkflowLogStore(storage));
    const after = await restarted.getLogs('run-1');
    expect(after.lines.map((line) => line.message)).toEqual([
      'marker:before-first',
      'marker:before-second',
      'marker:before-third',
    ]);
  });

  it('writes nothing for a replayed step when the run recovers', async () => {
    const storage = new MemoryStorage();
    const build = (engine: Engine) =>
      engine.register(
        workflow({ name: 'logged-recover' })
          .activities({ noop })
          .execute(async function* (ctx) {
            ctx.log?.info('marker:before-step');
            yield* ctx.run('noop', 'x');
            const value = yield* ctx.waitForSignal<string>('go');
            ctx.log?.info('marker:after-resume');
            return value;
          }),
      );
    {
      await using first = createEngine(storage, createWorkflowLogStore(storage));
      build(first);
      await first.start('logged-recover', null, { id: 'run-recover' });
      await settleInlineLaunches();
      expect(messagesOf(await first.getLogs('run-recover'))).toEqual(['marker:before-step']);
    }

    await using recovered = createEngine(storage, createWorkflowLogStore(storage));
    build(recovered);
    const [handle] = await recovered.recoverAll();
    await settleInlineLaunches();
    expect(messagesOf(await recovered.getLogs('run-recover'))).toEqual(['marker:before-step']);

    await recovered.signal('run-recover', 'go', 'done');
    expect(await handle!.result()).toBe('done');
    expect(steppedMessagesOf(await recovered.getLogs('run-recover'))).toEqual([
      [0, 'marker:before-step'],
      [2, 'marker:after-resume'],
    ]);
  });

  it('flushes the store on shutdown', async () => {
    const storage = new MemoryStorage();
    const store = createWorkflowLogStore(storage);
    let flushes = 0;
    const counting: WorkflowLogStore = {
      ...store,
      flush: () => {
        flushes += 1;
        return store.flush();
      },
    };
    const engine = createEngine(storage, counting);
    engine.register(stepsWorkflow('logged-shutdown'));
    const handle = await engine.start('logged-shutdown', null, { id: 'run-shutdown' });
    await handle.result();
    const before = flushes;
    await engine.shutdown();

    expect(flushes).toBeGreaterThan(before);
    const persisted = createWorkflowLogStore(storage);
    expect(linesOf(await persisted.read('run-shutdown'))).toHaveLength(3);
  });

  it('removes a run’s lines and counter when the run is purged', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage, createWorkflowLogStore(storage));
    engine.register(stepsWorkflow('logged-purge'));
    engine.register(stepsWorkflow('logged-kept'));
    const handle = await engine.start('logged-purge', null, { id: 'run-purge' });
    await handle.result();
    const kept = await engine.start('logged-kept', null, { id: 'run-kept' });
    await kept.result();
    expect(linesOf(await engine.getLogs('run-purge'))).toHaveLength(3);
    expect(await storage.get(KEYS.workflowLogCounter('run-purge'))).not.toBeNull();

    await engine.purge({ type: 'logged-purge' });

    expect(linesOf(await engine.getLogs('run-purge'))).toEqual([]);
    expect(await storage.get(KEYS.workflowLogCounter('run-purge'))).toBeNull();
    const remaining: string[] = [];
    for await (const [key] of storage.scan(KEYS.workflowLogPrefix('run-purge'))) {
      remaining.push(key);
    }
    expect(remaining).toEqual([]);
    expect(linesOf(await engine.getLogs('run-kept'))).toHaveLength(3);
  });

  it('writes a still-buffered line before it purges the run, so none outlives the run', async () => {
    const storage = new MemoryStorage();
    const store = createWorkflowLogStore(storage);
    await using engine = createEngine(storage, store);
    engine.register(stepsWorkflow('logged-late'));
    const handle = await engine.start('logged-late', null, { id: 'run-late' });
    await handle.result();
    // A line logged just before the purge, not yet written.
    store.sink({
      level: 'info',
      message: 'late',
      workflowId: 'run-late',
      workflowType: 'logged-late',
      timestamp: 1,
      step: 3,
    });

    await engine.purge({ type: 'logged-late' });

    const remaining: string[] = [];
    for await (const [key] of storage.scan('log')) remaining.push(key);
    expect(remaining).toEqual([]);
  });

  it('answers no lines for an engine without a log store', async () => {
    const captured = captureWorkflowLogConsole();
    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(stepsWorkflow('logged-none'));
    const handle = await engine.start('logged-none', null, { id: 'run-none' });
    await handle.result();

    try {
      expect(await engine.getLogs('run-none')).toEqual({ lines: [], dropped: 0 });
    } finally {
      captured.restore();
    }
  });
});

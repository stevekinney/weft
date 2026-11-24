/**
 * `EngineOptions.runConcurrency`: the cap on counted top-level runs an engine executes at once.
 * A start past the cap is committed but its first turn waits, oldest first, until a counted run
 * ends; children and runs `counts` leaves out are never held.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { waitUntil } from "../../../test-support/embedded/testing/src/wait-until.ts";
import { workflow, type WorkflowContext } from '../types.ts';
import { Engine } from './index.ts';

/** A workflow that runs until it is sent `go`, and records that its first turn ran. */
function gatedWorkflow(name: string, started: Set<string>) {
  return workflow({ name }).execute(async function* (ctx: WorkflowContext) {
    started.add(ctx.workflowId);
    yield* ctx.waitForSignal('go');
    return ctx.workflowId;
  });
}

describe('engine runConcurrency', () => {
  it('holds a counted start until a counted run ends, then launches the oldest waiting one', async () => {
    const started = new Set<string>();
    await using engine = new Engine({
      storage: new MemoryStorage(),
      inlineLaunchScheduling: 'manual',
      runConcurrency: { max: 2 },
    });
    engine.register(gatedWorkflow('gated', started));

    const first = await engine.start('gated', null, { id: 'run-1' });
    await engine.start('gated', null, { id: 'run-2' });
    await engine.start('gated', null, { id: 'run-3' });
    await engine.start('gated', null, { id: 'run-4' });
    await engine.flushInlineLaunches();

    expect([...started]).toEqual(['run-1', 'run-2']);
    expect(engine.runConcurrency()).toEqual({
      max: 2,
      running: ['run-1', 'run-2'],
      waiting: ['run-3', 'run-4'],
    });
    // A held start is committed and reads as pending until its first turn.
    const held = await engine.get('run-3');
    expect(held?.status).toBe('pending');

    await engine.signal('run-1', 'go');
    expect(await first.result()).toBe('run-1');
    await engine.flushInlineLaunches();

    expect([...started]).toEqual(['run-1', 'run-2', 'run-3']);
    expect(engine.runConcurrency()).toEqual({
      max: 2,
      running: ['run-2', 'run-3'],
      waiting: ['run-4'],
    });
  });

  it('launches a waiting start on its own once a slot is given back', async () => {
    const started = new Set<string>();
    await using engine = new Engine({
      storage: new MemoryStorage(),
      runConcurrency: { max: 1 },
    });
    engine.register(gatedWorkflow('gated', started));

    const first = await engine.start('gated', null, { id: 'first' });
    await engine.start('gated', null, { id: 'second' });
    await waitUntil(() => started.has('first') && engine.runConcurrency()?.waiting.length === 1, {
      message: 'the first run to start and the second to wait',
    });
    expect(started.has('second')).toBe(false);

    await engine.signal('first', 'go');
    expect(await first.result()).toBe('first');
    await waitUntil(() => started.has('second'), { message: 'the second run to start' });
    expect(engine.runConcurrency()).toEqual({ max: 1, running: ['second'], waiting: [] });
  });

  it('never holds a run that does not count, or a child of a counted run', async () => {
    const started = new Set<string>();
    await using engine = new Engine({
      storage: new MemoryStorage(),
      runConcurrency: { max: 1, counts: (workflowType) => workflowType !== 'uncounted' },
    });
    engine.register(gatedWorkflow('gated', started));
    engine.register(gatedWorkflow('uncounted', started));
    engine.register(
      workflow({ name: 'parent' }).execute(async function* (ctx: WorkflowContext) {
        started.add(ctx.workflowId);
        return yield* ctx.startChild('gated', null, { id: 'child' });
      }),
    );

    await engine.start('parent', null, { id: 'parent' });
    await waitUntil(() => started.has('parent'), { message: 'the parent to start' });
    await engine.start('uncounted', null, { id: 'uncounted' });
    await engine.start('gated', null, { id: 'held' });

    // The parent holds the one slot; its child and the uncounted run start anyway.
    await waitUntil(() => started.has('child') && started.has('uncounted'), {
      message: 'the child and the uncounted run to start',
    });
    expect(started.has('held')).toBe(false);
    expect(engine.runConcurrency()).toEqual({ max: 1, running: ['parent'], waiting: ['held'] });
  });

  it('drops a held start that is cancelled before it launches', async () => {
    const started = new Set<string>();
    await using engine = new Engine({
      storage: new MemoryStorage(),
      inlineLaunchScheduling: 'manual',
      runConcurrency: { max: 1 },
    });
    engine.register(gatedWorkflow('gated', started));

    await engine.start('gated', null, { id: 'running' });
    await engine.start('gated', null, { id: 'held' });
    await engine.flushInlineLaunches();
    await engine.cancel('held');

    expect(engine.runConcurrency()?.waiting).toEqual([]);
    const cancelled = await engine.get('held');
    expect(cancelled?.status).toBe('cancelled');
    expect(started.has('held')).toBe(false);
  });

  it('reports no cap for an engine built without one', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    expect(engine.runConcurrency()).toBeNull();
  });

  it('refuses a cap that is not a positive safe integer, a counts that is not a function, and worker mode', () => {
    expect(() => new Engine({ runConcurrency: 4 as unknown as { max: number } })).toThrow(
      'options.runConcurrency must be an object when provided',
    );
    expect(() => new Engine({ runConcurrency: null as unknown as { max: number } })).toThrow(
      'options.runConcurrency must be an object when provided',
    );
    expect(() => new Engine({ runConcurrency: { max: 0 } })).toThrow(
      'options.runConcurrency.max must be a positive safe integer',
    );
    expect(() => new Engine({ runConcurrency: { max: 1.5 } })).toThrow(
      'options.runConcurrency.max must be a positive safe integer',
    );
    expect(
      () =>
        new Engine({
          runConcurrency: { max: 1, counts: 'gated' as unknown as (type: string) => boolean },
        }),
    ).toThrow('options.runConcurrency.counts must be a function when provided');
    expect(
      () =>
        new Engine({
          runConcurrency: { max: 1 },
          workflowExecutionMode: 'worker',
          workerExecution: { workerUrl: new URL('file:///worker.ts') },
        }),
    ).toThrow('options.runConcurrency is only supported in inline execution mode, not "worker"');
  });
});

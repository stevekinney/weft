import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { captureWorkflowLogConsole } from '../../testing/workflow-log-capture.test-support.ts';
import { Engine } from '../engine.ts';
import { workflow } from '../types/workflow-function.ts';
import type { WorkflowLogRecord } from '../types/workflow-log.ts';

/**
 * Engine-level tests for the `EngineOptions.onLog` host sink (#491 Part 1, hardened
 * in #533). These run real workflows through a genuine engine so they prove the sink
 * is plumbed end-to-end (construction → inline strategy → context → `ctx.log`), routes
 * records away from the console, survives a throwing sink, reaches speculative
 * children, and inherits the replay-suppression contract. `ctx.log` emits
 * synchronously during generator execution, which completes before `handle.result()`
 * resolves, so assertions need no post-result sleep.
 */

describe('EngineOptions.onLog host sink', () => {
  let captured: ReturnType<typeof captureWorkflowLogConsole>;
  beforeEach(() => {
    captured = captureWorkflowLogConsole();
  });
  afterEach(() => {
    captured.restore();
  });

  it('routes inline ctx.log records to the host sink instead of the console', async () => {
    const sunk: WorkflowLogRecord[] = [];
    await using engine = new Engine({ onLog: (record) => sunk.push(record) });
    engine.register(
      workflow({ name: 'sink-wf' }).execute(async function* (ctx) {
        ctx.log?.info('marker:hello', { tenant: 'acme' });
        return 'ok';
      }),
    );

    const handle = await engine.start('sink-wf', null, { id: 'sink-1' });
    await expect(handle.result()).resolves.toBe('ok');

    const marker = sunk.find((r) => r.message === 'marker:hello');
    expect(marker).toBeDefined();
    expect(marker).toMatchObject({
      level: 'info',
      workflowId: 'sink-1',
      workflowType: 'sink-wf',
      attributes: { tenant: 'acme' },
    });
    // The sink took over: the marker record never reached the console.
    expect(captured.records.some((r) => r.message === 'marker:hello')).toBe(false);
  });

  it('falls back to the console when no onLog sink is configured', async () => {
    await using engine = new Engine();
    engine.register(
      workflow({ name: 'console-wf' }).execute(async function* (ctx) {
        ctx.log?.info('marker:console');
        return 'ok';
      }),
    );

    const handle = await engine.start('console-wf', null, { id: 'console-1' });
    await expect(handle.result()).resolves.toBe('ok');

    expect(captured.records.some((r) => r.message === 'marker:console')).toBe(true);
  });

  it('does not fail the workflow when the host sink throws; the record falls back to console', async () => {
    // A logger must never crash the thing it is logging. A throwing onLog (a
    // serialization error, a transport failure, a bug in the callback) must be
    // swallowed and the record routed to console — the run still completes.
    let sinkCalls = 0;
    await using engine = new Engine({
      onLog: () => {
        sinkCalls += 1;
        throw new Error('sink boom');
      },
    });
    engine.register(
      workflow({ name: 'throwing-sink-wf' }).execute(async function* (ctx) {
        ctx.log?.info('marker:throwing');
        return 'ok';
      }),
    );

    const handle = await engine.start('throwing-sink-wf', null, { id: 'throwing-1' });
    // The throw from the sink does NOT surface as a workflow application failure.
    await expect(handle.result()).resolves.toBe('ok');

    expect(sinkCalls).toBeGreaterThanOrEqual(1);
    // The record was not lost: it fell back to the console.
    expect(captured.records.some((r) => r.message === 'marker:throwing')).toBe(true);
  });

  it('routes ctx.log inside a ctx.speculate branch to the host sink', async () => {
    const sunk: WorkflowLogRecord[] = [];
    await using engine = new Engine({ onLog: (record) => sunk.push(record) });
    engine.register(
      workflow({ name: 'speculate-sink-wf' }).execute(async function* (ctx) {
        const value = yield* ctx.speculate(async function* (branch) {
          branch.log?.info('marker:speculated', { in: 'branch' });
          return 42;
        });
        return value;
      }),
    );

    const handle = await engine.start('speculate-sink-wf', null, { id: 'speculate-1' });
    await expect(handle.result()).resolves.toBe(42);

    const marker = sunk.find((r) => r.message === 'marker:speculated');
    expect(marker).toBeDefined();
    expect(marker).toMatchObject({
      level: 'info',
      workflowId: 'speculate-1',
      workflowType: 'speculate-sink-wf',
      attributes: { in: 'branch' },
    });
    // The speculative branch honored the sink; its record never hit the console.
    expect(captured.records.some((r) => r.message === 'marker:speculated')).toBe(false);
  });

  it('a throwing sink inside a ctx.speculate branch still completes the run (record on console)', async () => {
    // The combined failure mode that motivated both #533 fixes: the sink reaches the
    // speculative branch (fix 2) AND a throw there does not fail the run (fix 1).
    let sinkCalls = 0;
    await using engine = new Engine({
      onLog: () => {
        sinkCalls += 1;
        throw new Error('speculative sink boom');
      },
    });
    engine.register(
      workflow({ name: 'speculate-throwing-wf' }).execute(async function* (ctx) {
        return yield* ctx.speculate(async function* (branch) {
          branch.log?.info('marker:speculate-throwing');
          return 7;
        });
      }),
    );

    const handle = await engine.start('speculate-throwing-wf', null, {
      id: 'speculate-throwing-1',
    });
    await expect(handle.result()).resolves.toBe(7);

    // The sink was reached from inside the branch (fix 2), threw, and the throw was
    // swallowed (fix 1) — the record fell back to console and the run completed.
    expect(sinkCalls).toBeGreaterThanOrEqual(1);
    expect(captured.records.some((r) => r.message === 'marker:speculate-throwing')).toBe(true);
  });
});

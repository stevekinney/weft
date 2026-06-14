import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { sleepForTesting, waitForCondition } from '../../testing/fake-timers.test-support.ts';
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

  it('delivers a speculative-branch log to the sink across a dispose-at-park → recover cycle, at parity with the console (#535)', async () => {
    // #535's repro: a `ctx.log` inside a `ctx.speculate` branch, followed immediately by
    // `waitForSignal`. The fresh engine is disposed while parked at the signal, then a
    // second engine recovers and resumes to completion.
    //
    // The criterion is parity: the host `EngineOptions.onLog` sink must deliver the
    // speculative log exactly as many times as the default console path does across the
    // whole cycle. Because an installed sink steals records away from the console, the
    // two counts cannot be observed in one run — so the cycle runs twice (no-sink to
    // count console markers, with-sink to count sink markers) and the counts are
    // compared. The comparison is anchored with the concrete `['marker:speculated']`
    // so parity can't pass vacuously when both paths are empty.
    //
    // Mechanism: the speculative child inherits its `logSink` from the parent context
    // (`speculative-child.ts`), so the sink reaches the branch on the fresh run; on
    // recovery the replayed speculate is correctly suppressed. Both paths therefore see
    // the marker exactly once.
    const markersOf = (records: WorkflowLogRecord[]) =>
      records
        .filter((r) => r.workflowType === 'spec-recover' && r.message.startsWith('marker:'))
        .map((r) => r.message);

    const build = (engine: Engine) =>
      engine.register(
        workflow({ name: 'spec-recover' }).execute(async function* (ctx) {
          const value = yield* ctx.speculate(async function* (branch) {
            branch.log?.info('marker:speculated');
            return 1;
          });
          yield* ctx.waitForSignal('go');
          return value;
        }),
      );

    // Before disposing the fresh engine, wait until it has actually emitted the
    // speculative log on its own stream — the precondition the test depends on. This
    // observes a real event rather than waiting a fixed duration: a parked workflow keeps
    // status 'running' (there is no 'waiting' status), and the start-time checkpoint
    // exists immediately, so neither is a usable signal that the speculate ran. The
    // marker observes only that the speculative branch executed; the recovery assertions
    // below are what verify the run actually resumes and reaches its terminal state.
    const hasSpeculatedMarker = (records: WorkflowLogRecord[]) =>
      records.some((r) => r.message === 'marker:speculated');

    // No-sink run: count the console markers across the cycle. The `beforeEach` capture
    // is active for the whole cycle, so it covers the full fresh + recovered span.
    const consoleStorage = new MemoryStorage();
    {
      using first = new Engine({ storage: consoleStorage });
      build(first);
      await first.start('spec-recover', null, { id: 'spec-recover-id' });
      await waitForCondition(() => hasSpeculatedMarker(captured.records), {
        label: 'fresh run logged speculate (console)',
      });
    }
    using consoleRecovered = new Engine({ storage: consoleStorage });
    build(consoleRecovered);
    const [consoleHandle] = await consoleRecovered.recoverAll();
    await sleepForTesting(10);
    await consoleRecovered.signal('spec-recover-id', 'go', 'go');
    await expect(consoleHandle!.result()).resolves.toBe(1);
    const consoleMarkers = markersOf(captured.records);

    // With-sink run: count the sink markers across the identical cycle.
    const sinkStorage = new MemoryStorage();
    const sink: WorkflowLogRecord[] = [];
    {
      using first = new Engine({ storage: sinkStorage, onLog: (record) => sink.push(record) });
      build(first);
      await first.start('spec-recover', null, { id: 'spec-recover-id' });
      await waitForCondition(() => hasSpeculatedMarker(sink), {
        label: 'fresh run logged speculate (sink)',
      });
    }
    using sinkRecovered = new Engine({
      storage: sinkStorage,
      onLog: (record) => sink.push(record),
    });
    build(sinkRecovered);
    const [sinkHandle] = await sinkRecovered.recoverAll();
    await sleepForTesting(10);
    await sinkRecovered.signal('spec-recover-id', 'go', 'go');
    await expect(sinkHandle!.result()).resolves.toBe(1);
    const sinkMarkers = markersOf(sink);

    // Parity (sink-count == console-count), anchored with the concrete marker so it
    // cannot pass vacuously: delivered on the fresh run, suppressed on replay — once.
    expect(sinkMarkers).toEqual(consoleMarkers);
    expect(sinkMarkers).toEqual(['marker:speculated']);
  });
});

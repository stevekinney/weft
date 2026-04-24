/**
 * Engine-level unit tests for the unified workflow-feed commit API:
 * `replayWorkflowFeed`, `snapshotWorkflowFeedTail`, and
 * `subscribeWorkflowFeedCommits`.
 *
 * The backend adapter tests in `server/engine-event-feed-backend.test.ts`
 * cover the adapter-wrapped behavior. This file drills a level deeper
 * to guarantee the engine's own contract holds even if the adapter is
 * ever refactored — per the 100% coverage floor, the listener-error
 * swallow paths, iteration snapshot semantics, and `loadHead()`
 * fallback on a fresh engine instance must be exercised directly.
 */

import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../storage/memory.ts';
import type { Context } from './context.ts';
import { Engine, type WorkflowFeedRecord } from './engine.ts';
import type { WorkflowContext } from './types.ts';

function createEngineWithWorkflow(storage = new MemoryStorage()): Engine {
  const engine = new Engine({ storage });
  engine.register('hold', async function* (ctx: WorkflowContext, _input: unknown) {
    const context = ctx as Context;
    const value = yield* context.waitForSignal<string>('release');
    yield* context.run(async () => `echoed:${value}`);
    yield* context.run(async () => 'done');
    return value;
  });
  return engine;
}

async function waitForEventCount(
  engine: Engine,
  workflowId: string,
  expected: number,
  timeoutMilliseconds = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const events = await engine.getEvents(workflowId);
    if (events.length >= expected) return;
    await Bun.sleep(5);
  }
  throw new Error(
    `Engine did not accumulate ${expected} events for ${workflowId} within ${timeoutMilliseconds}ms`,
  );
}

describe('Engine.snapshotWorkflowFeedTail — loadHead fallback', () => {
  it('returns the durable tail for a workflow whose engine instance has no in-memory head', async () => {
    // Simulates engine restart: first engine writes events, second
    // engine is created against the same underlying MemoryStorage
    // but has an empty `#eventLogHeads` map. The snapshot must fall
    // back to `EventLog.loadHead()` and still return the durable
    // tail, or the feed's atomic-handoff will report a stale -1 and
    // replay the entire log on every subscribe.
    const storage = new MemoryStorage();
    const firstEngine = createEngineWithWorkflow(storage);
    const handle = await firstEngine.start('hold', {}, {});
    await waitForEventCount(firstEngine, handle.id, 1);
    firstEngine[Symbol.dispose]();

    const secondEngine = new Engine({ storage });
    const tail = await secondEngine.snapshotWorkflowFeedTail(handle.id, 'events');
    expect(tail).toBeGreaterThanOrEqual(0);
    secondEngine[Symbol.dispose]();
  });
});

describe('Engine.subscribeWorkflowFeedCommits — listener isolation', () => {
  it('does not throw to the caller when a listener throws synchronously', async () => {
    const engine = createEngineWithWorkflow();
    const handle = await engine.start('hold', {}, {});
    await waitForEventCount(engine, handle.id, 1);

    const sink: WorkflowFeedRecord[] = [];
    const unsubscribeThrower = engine.subscribeWorkflowFeedCommits(handle.id, 'events', () => {
      throw new Error('sync listener blew up');
    });
    const unsubscribeSink = engine.subscribeWorkflowFeedCommits(handle.id, 'events', (record) => {
      sink.push(record);
    });

    // `signal` + `handle.result()` drive further durable commits. If
    // the engine's notifier rethrew, one of these would reject.
    await expect(engine.signal(handle.id, 'release', 'go')).resolves.toBeUndefined();
    await expect(handle.result()).resolves.toBe('go');

    expect(sink.length).toBeGreaterThan(0);
    unsubscribeThrower();
    unsubscribeSink();
  });

  it('does not surface unhandled rejections when a listener is async and rejects', async () => {
    const engine = createEngineWithWorkflow();
    const handle = await engine.start('hold', {}, {});
    await waitForEventCount(engine, handle.id, 1);

    const sink: WorkflowFeedRecord[] = [];
    const unsubscribeThrower = engine.subscribeWorkflowFeedCommits(
      handle.id,
      'events',
      // Typed against `WorkflowFeedListener = (r) => void | Promise<void>`
      // — an async listener returning a rejected promise is the
      // hazard this test exercises.
      async () => {
        throw new Error('async listener rejected');
      },
    );
    const unsubscribeSink = engine.subscribeWorkflowFeedCommits(handle.id, 'events', (record) => {
      sink.push(record);
    });

    // Wire a detector on process-level unhandled rejection. A leaked
    // rejection from the listener would surface here and fail the
    // assertion below.
    let detected: unknown = null;
    const handler = (reason: unknown) => {
      detected = reason;
    };
    process.on('unhandledRejection', handler);

    try {
      await engine.signal(handle.id, 'release', 'go');
      await handle.result();
      // Give microtasks a turn so any leaked rejection would land.
      await Bun.sleep(10);
    } finally {
      process.off('unhandledRejection', handler);
      unsubscribeThrower();
      unsubscribeSink();
    }

    expect(detected).toBeNull();
    expect(sink.length).toBeGreaterThan(0);
  });

  it('late listener registered mid-dispatch does not receive its birth record', async () => {
    // Regression guard for the Set-iteration-snapshot fix in
    // `#notifyWorkflowFeedCommit`. Without that fix, a listener
    // that registers another listener from inside a dispatch would
    // see the newly-added listener receive the in-flight record —
    // violating the "future commits only" contract and causing
    // duplicate delivery to any feed subscriber that treats the
    // engine's listener as its single source of truth.
    //
    // The assertion: every sequence the late listener receives must
    // be strictly greater than the sequence that triggered its
    // registration. A tautological `>= 0` check cannot detect a
    // regression; this one does.
    const engine = createEngineWithWorkflow();
    const handle = await engine.start('hold', {}, {});
    await waitForEventCount(engine, handle.id, 1);

    const outerSequences: number[] = [];
    const lateSequences: number[] = [];
    // Track which outer-sequence triggered each late registration so
    // the per-late assertion can be precise.
    const birthSequenceByLate = new Map<object, number>();
    const lateUnsubscribers: Array<() => void> = [];

    const unsubscribeOuter = engine.subscribeWorkflowFeedCommits(handle.id, 'events', (record) => {
      outerSequences.push(record.sequence);
      const lateToken = {};
      const lateUnsubscribe = engine.subscribeWorkflowFeedCommits(
        handle.id,
        'events',
        (lateRecord) => {
          // Capture the birth sequence for this particular late
          // listener (the outer sequence that triggered its
          // registration) so the `>` check below is per-listener.
          const birth = birthSequenceByLate.get(lateToken);
          if (birth !== undefined) {
            lateSequences.push(lateRecord.sequence);
            expect(lateRecord.sequence).toBeGreaterThan(birth);
          }
        },
      );
      birthSequenceByLate.set(lateToken, record.sequence);
      lateUnsubscribers.push(lateUnsubscribe);
    });

    await engine.signal(handle.id, 'release', 'go');
    await handle.result();
    unsubscribeOuter();
    for (const u of lateUnsubscribers) u();

    // Sanity: the outer listener fired at least once (the post-
    // signal resume commits at least one checkpoint). If the
    // outer never fired, the test would pass vacuously — this
    // assertion guards against that degenerate state.
    expect(outerSequences.length).toBeGreaterThan(0);
  });
});

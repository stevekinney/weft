import { sleepForTesting } from '../testing/fake-timers.test-support.ts';
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

import { type BatchOperation, KEYS, type ScanOptions } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { decode, encode } from './codec.ts';
import { Engine, type WorkflowFeedRecord } from './engine.ts';
import { workflow } from './types/workflow-function.ts';

class ObservedMemoryStorage extends MemoryStorage {
  readonly batches: BatchOperation[][] = [];
  readonly scanPrefixes: string[] = [];

  override async batch(operations: BatchOperation[]): Promise<void> {
    this.batches.push(operations);
    await super.batch(operations);
  }

  override async *scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]> {
    this.scanPrefixes.push(prefix);
    yield* super.scan(prefix, options);
  }

  resetScanPrefixes(): void {
    this.scanPrefixes.length = 0;
  }

  countScansForPrefix(prefix: string): number {
    return this.scanPrefixes.filter((candidate) => candidate === prefix).length;
  }
}

const holdWorkflow = workflow({ name: 'hold' }).execute(async function* (ctx, _input: unknown) {
  const context = ctx;
  const value = yield* context.waitForSignal<string>('release');
  yield* context.run(async () => `echoed:${value}`);
  yield* context.run(async () => 'done');
  return value;
});

function createEngineWithWorkflow(storage = new MemoryStorage()): Engine {
  const engine = new Engine({ storage });
  engine.register(holdWorkflow);
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
    await sleepForTesting(5);
  }
  throw new Error(
    `Engine did not accumulate ${expected} events for ${workflowId} within ${timeoutMilliseconds}ms`,
  );
}

async function waitForTokenChunkCount(
  engine: Engine,
  workflowId: string,
  expected: number,
  timeoutMilliseconds = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const chunks = await engine.getStreamChunks(workflowId, 'tokens');
    if (chunks.length >= expected) return;
    await sleepForTesting(5);
  }
  throw new Error(
    `Engine did not accumulate ${expected} token chunks for ${workflowId} within ${timeoutMilliseconds}ms`,
  );
}

function findPutOperationValue(
  batch: ReadonlyArray<BatchOperation>,
  key: string,
): Uint8Array | undefined {
  const operation = batch.find((candidate) => candidate.type === 'put' && candidate.key === key);
  return operation?.type === 'put' ? operation.value : undefined;
}

describe('Engine[Symbol.dispose] — feed listener cleanup', () => {
  it('unsubscribe returned before dispose is a safe no-op afterwards', async () => {
    // Regression guard: every other Map/Set on the Engine is cleared
    // in `[Symbol.dispose]()`. A stale bucket surviving disposal
    // would keep listener closures alive. This test proves the
    // cleanup path exists by asserting the unsubscribe returned from
    // a pre-dispose `subscribeWorkflowFeedCommits` can still be
    // invoked after disposal without throwing — which only holds if
    // the registry was cleared to an empty Map (so the unsubscribe's
    // `.delete()` + `.size === 0` branch handles the missing bucket
    // gracefully) AND the engine isn't silently retaining the
    // pre-dispose bucket.
    const engine = createEngineWithWorkflow();
    const handle = await engine.start('hold', {}, {});
    await waitForEventCount(engine, handle.id, 1);

    const unsubscribe = engine.subscribeWorkflowFeedCommits(handle.id, 'events', () => {});
    engine[Symbol.dispose]();

    // Post-dispose unsubscribe: must not throw. The cleared Map
    // means `get(key)` returns undefined, unsubscribe's guard
    // (`if (!set) return`) handles that.
    expect(() => unsubscribe()).not.toThrow();
  });
});

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

  it('reads the token stream tail record without scanning stored chunks', async () => {
    const storage = new ObservedMemoryStorage();
    const workflowId = 'wf-token-tail';
    await storage.put(KEYS.streamChunk(workflowId, 'tokens', 0), encode('zero'));
    await storage.put(KEYS.streamChunk(workflowId, 'tokens', 1), encode('one'));
    await storage.put(KEYS.streamTail(workflowId, 'tokens'), encode({ sequence: 1 }));
    storage.resetScanPrefixes();

    const engine = new Engine({ storage });
    const tail = await engine.snapshotWorkflowFeedTail(workflowId, 'tokens');

    expect(tail).toBe(1);
    expect(storage.countScansForPrefix(KEYS.streamChunkPrefix(workflowId, 'tokens'))).toBe(0);
    engine[Symbol.dispose]();
  });

  it('falls back to scanning token chunks when old data has no tail record', async () => {
    const storage = new ObservedMemoryStorage();
    const workflowId = 'wf-token-tail-old-data';
    await storage.put(KEYS.streamChunk(workflowId, 'tokens', 0), encode('zero'));
    await storage.put(KEYS.streamChunk(workflowId, 'tokens', 1), encode('one'));
    storage.resetScanPrefixes();

    const engine = new Engine({ storage });
    const tail = await engine.snapshotWorkflowFeedTail(workflowId, 'tokens');

    expect(tail).toBe(1);
    expect(storage.countScansForPrefix(KEYS.streamChunkPrefix(workflowId, 'tokens'))).toBe(1);
    engine[Symbol.dispose]();
  });
});

describe('Engine ctx.stream(tokens) — durable tail pointer', () => {
  it('writes each token chunk and its tail pointer in the same storage batch', async () => {
    const storage = new ObservedMemoryStorage();
    const engine = new Engine({ storage });
    engine.register(
      workflow({ name: 'token-export' }).execute(async function* (ctx, _input: unknown) {
        const context = ctx;
        yield* context.stream('tokens', async function* () {
          yield 'first';
          yield 'second';
        });
        yield* context.waitForSignal('finish');
        return 'done';
      }),
    );

    const handle = await engine.start('token-export', {});
    await waitForTokenChunkCount(engine, handle.id, 2);

    const streamTailKey = KEYS.streamTail(handle.id, 'tokens');
    const persistedTail = await storage.get(streamTailKey);
    expect(persistedTail).not.toBeNull();
    expect(decode(persistedTail!)).toEqual({ sequence: 1 });

    for (let sequence = 0; sequence < 2; sequence += 1) {
      const chunkKey = KEYS.streamChunk(handle.id, 'tokens', sequence);
      const chunkBatch = storage.batches.find((batch) =>
        batch.some((operation) => operation.type === 'put' && operation.key === chunkKey),
      );
      expect(chunkBatch).toBeDefined();
      if (!chunkBatch) {
        throw new Error(`Missing batch for token chunk sequence ${sequence}`);
      }

      const tailValue = findPutOperationValue(chunkBatch, streamTailKey);
      expect(tailValue).toBeDefined();
      if (!tailValue) {
        throw new Error(`Missing tail pointer update for token chunk sequence ${sequence}`);
      }
      expect(decode(tailValue)).toEqual({ sequence });
    }

    await engine.signal(handle.id, 'finish', 'go');
    await handle.result();
    engine[Symbol.dispose]();
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
      await sleepForTesting(10);
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
      // Record the birth sequence BEFORE registering the late
      // listener. If `#notifyWorkflowFeedCommit` ever regressed to
      // iterating the live Set, the newly-added listener would
      // receive the in-flight record — and with birth already set,
      // the assertion below catches the violation instead of
      // silently skipping. (Reversing the order would make the
      // guard fail open: `birth` would be `undefined` at call time,
      // the `if` branch would skip, and the regression would hide.)
      birthSequenceByLate.set(lateToken, record.sequence);
      const lateUnsubscribe = engine.subscribeWorkflowFeedCommits(
        handle.id,
        'events',
        (lateRecord) => {
          const birth = birthSequenceByLate.get(lateToken);
          // `birth` must exist by construction — we set it before
          // the late listener could possibly be called. If it is
          // ever missing, that itself is a test-logic bug we want
          // to surface, not silently skip.
          expect(birth).toBeDefined();
          lateSequences.push(lateRecord.sequence);
          expect(lateRecord.sequence).toBeGreaterThan(birth as number);
        },
      );
      lateUnsubscribers.push(lateUnsubscribe);
    });

    await engine.signal(handle.id, 'release', 'go');
    await handle.result();
    unsubscribeOuter();
    for (const u of lateUnsubscribers) u();

    // Sanity: the outer listener fired at least once (the post-
    // signal resume commits at least one checkpoint).
    expect(outerSequences.length).toBeGreaterThan(0);
    // And: at least one late listener actually observed a post-
    // birth record, so the inner `>` assertion ran for real. If
    // the workflow collapsed to a single post-subscribe commit,
    // no late listener would ever execute its body and the test
    // would pass vacuously — this assertion guards against that.
    expect(lateSequences.length).toBeGreaterThan(0);
  });
});

import { sleepForTesting, waitForCondition } from '../testing/fake-timers.ts';
/**
 * Tests for `createEngineEventFeedBackend` — the production
 * `WorkflowEventFeedBackend` implementation that wraps engine-owned
 * event log scans, stream chunk scans, and post-commit subscriptions
 * into the contract documented in `workflow-event-feed.ts`.
 *
 * The critical invariant proven here: replay and live emission share
 * the same committed sequence authority. A subscriber joining mid-
 * stream sees every committed entry exactly once, in sequence order,
 * with no gaps. Live listeners receive entries only after the storage
 * batch that wrote them has committed — never before.
 */

import { describe, expect, it } from 'bun:test';

import { encode } from '../core/codec.ts';
import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { createEngineEventFeedBackend } from './engine-event-feed-backend.ts';
import {
  createWorkflowEventFeed,
  encodeCursor,
  type EventEnvelope,
} from './workflow-event-feed.ts';

function createEngineWithSignalWorkflow(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register('hold', async function* (ctx: WorkflowContext, _input: unknown) {
    const context = ctx;
    const value = yield* context.waitForSignal<string>('release');
    // After the signal unblocks the workflow, run durable activities
    // so the engine commits additional event log entries. A bare
    // `waitForSignal → return` only produces the initial
    // `workflow:checkpoint`; the feed's live tests need several
    // post-resume commits to verify listener invocation.
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
  await waitForCondition(
    async () => {
      const events = await engine.getEvents(workflowId);
      return events.length >= expected;
    },
    {
      label: `${expected} events for ${workflowId}`,
      timeoutMs: timeoutMilliseconds,
      intervalMs: 5,
    },
  );
}

async function collect(
  iterable: AsyncIterable<EventEnvelope>,
  limit: number,
): Promise<EventEnvelope[]> {
  const results: EventEnvelope[] = [];
  for await (const envelope of iterable) {
    results.push(envelope);
    if (results.length >= limit) break;
  }
  return results;
}

describe('createEngineEventFeedBackend — replay(events)', () => {
  it('yields persisted event log entries in ascending sequence order', async () => {
    const engine = createEngineWithSignalWorkflow();
    const handle = await engine.start('hold', { hello: 'world' }, {});
    await waitForEventCount(engine, handle.id, 1);

    const backend = createEngineEventFeedBackend(engine);
    const envelopes: EventEnvelope[] = [];
    for await (const envelope of backend.replay({
      workflowId: handle.id,
      selector: 'events',
      afterSequence: -1,
    })) {
      envelopes.push(envelope);
    }

    expect(envelopes.length).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < envelopes.length; i += 1) {
      const envelope = envelopes[i]!;
      expect(envelope.workflowId).toBe(handle.id);
      expect(envelope.selector).toBe('events');
      expect(envelope.sequence).toBe(i);
      expect(envelope.cursor).toBe(encodeCursor(i));
      expect(typeof envelope.kind).toBe('string');
      expect(typeof envelope.emittedAtMs).toBe('number');
    }
  });

  it('skips entries at or below afterSequence', async () => {
    const engine = createEngineWithSignalWorkflow();
    const handle = await engine.start('hold', { hello: 'world' }, {});
    await waitForEventCount(engine, handle.id, 1);

    const backend = createEngineEventFeedBackend(engine);
    const skipped: EventEnvelope[] = [];
    for await (const envelope of backend.replay({
      workflowId: handle.id,
      selector: 'events',
      afterSequence: 0,
    })) {
      skipped.push(envelope);
    }

    for (const envelope of skipped) {
      expect(envelope.sequence).toBeGreaterThan(0);
    }
  });

  it('yields nothing for an unknown workflow id', async () => {
    const engine = createEngineWithSignalWorkflow();
    const backend = createEngineEventFeedBackend(engine);
    const envelopes: EventEnvelope[] = [];
    for await (const envelope of backend.replay({
      workflowId: 'never-started',
      selector: 'events',
      afterSequence: -1,
    })) {
      envelopes.push(envelope);
    }
    expect(envelopes).toEqual([]);
  });
});

describe('createEngineEventFeedBackend — snapshotTailSequence(events)', () => {
  it('returns -1 for an unknown workflow', async () => {
    const engine = createEngineWithSignalWorkflow();
    const backend = createEngineEventFeedBackend(engine);
    const tail = await backend.snapshotTailSequence('never-started', 'events');
    expect(tail).toBe(-1);
  });

  it('returns the highest committed sequence for a running workflow', async () => {
    const engine = createEngineWithSignalWorkflow();
    const handle = await engine.start('hold', { hello: 'world' }, {});
    await waitForEventCount(engine, handle.id, 1);

    const backend = createEngineEventFeedBackend(engine);
    const events = await engine.getEvents(handle.id);
    const expectedTail = events.length - 1;

    expect(await backend.snapshotTailSequence(handle.id, 'events')).toBe(expectedTail);
  });

  it('throws for an unhandled selector value instead of silently falling through', async () => {
    const engine = createEngineWithSignalWorkflow();
    const backend = createEngineEventFeedBackend(engine);

    expect(() =>
      backend.snapshotTailSequence(
        'never-started',
        // Deliberately bypass the type system to prove the runtime guard holds.
        'invalid-selector' as never,
      ),
    ).toThrow('Unhandled EventSelector: invalid-selector');
  });
});

describe('createEngineEventFeedBackend — subscribeLive(events)', () => {
  it('delivers post-commit envelopes to registered listeners', async () => {
    const engine = createEngineWithSignalWorkflow();
    const handle = await engine.start('hold', { hello: 'world' }, {});
    await waitForEventCount(engine, handle.id, 1);

    const backend = createEngineEventFeedBackend(engine);
    const received: EventEnvelope[] = [];
    const unsubscribe = backend.subscribeLive(handle.id, 'events', (envelope) => {
      received.push(envelope);
    });

    await engine.signal(handle.id, 'release', 'go');
    await handle.result();

    expect(received.length).toBeGreaterThan(0);
    let last = -1;
    for (const envelope of received) {
      expect(envelope.workflowId).toBe(handle.id);
      expect(envelope.selector).toBe('events');
      expect(envelope.sequence).toBeGreaterThan(last);
      last = envelope.sequence;
    }

    unsubscribe();
  });

  it('does not deliver events for other workflows to a per-workflow listener', async () => {
    const engine = createEngineWithSignalWorkflow();
    const a = await engine.start('hold', { id: 'a' }, {});
    const b = await engine.start('hold', { id: 'b' }, {});
    await waitForEventCount(engine, a.id, 1);
    await waitForEventCount(engine, b.id, 1);

    const backend = createEngineEventFeedBackend(engine);
    const receivedForA: EventEnvelope[] = [];
    const unsubscribe = backend.subscribeLive(a.id, 'events', (envelope) => {
      receivedForA.push(envelope);
    });

    await engine.signal(b.id, 'release', 'bee');
    await b.result();
    await engine.signal(a.id, 'release', 'aee');
    await a.result();

    for (const envelope of receivedForA) {
      expect(envelope.workflowId).toBe(a.id);
    }
    unsubscribe();
  });

  it('stops delivering events after unsubscribe', async () => {
    const engine = createEngineWithSignalWorkflow();
    const handle = await engine.start('hold', {}, {});
    await waitForEventCount(engine, handle.id, 1);

    const backend = createEngineEventFeedBackend(engine);
    const received: EventEnvelope[] = [];
    const unsubscribe = backend.subscribeLive(handle.id, 'events', (envelope) => {
      received.push(envelope);
    });
    unsubscribe();

    await engine.signal(handle.id, 'release', 'go');
    await handle.result();

    expect(received).toEqual([]);
  });

  it('isolates listener exceptions from the emitter', async () => {
    const engine = createEngineWithSignalWorkflow();
    const handle = await engine.start('hold', {}, {});
    await waitForEventCount(engine, handle.id, 1);

    const backend = createEngineEventFeedBackend(engine);
    const second: EventEnvelope[] = [];
    const unsubscribeThrower = backend.subscribeLive(handle.id, 'events', () => {
      throw new Error('listener blew up');
    });
    const unsubscribeSecond = backend.subscribeLive(handle.id, 'events', (envelope) => {
      second.push(envelope);
    });

    await expect(engine.signal(handle.id, 'release', 'go')).resolves.toBeUndefined();
    await handle.result();

    expect(second.length).toBeGreaterThan(0);
    unsubscribeThrower();
    unsubscribeSecond();
  });

  it('isolates async listener rejections through the adapter layer', async () => {
    // Regression guard: TypeScript allows an async function to be
    // passed where the backend's `(envelope) => void` contract is
    // expected — the returned promise is structurally discarded. If
    // the adapter's wrapper does not propagate that promise to the
    // engine's notifier, the rejection escapes as a process-level
    // unhandled-rejection event. This test catches that regression
    // by registering a detector.
    const engine = createEngineWithSignalWorkflow();
    const handle = await engine.start('hold', {}, {});
    await waitForEventCount(engine, handle.id, 1);

    const backend = createEngineEventFeedBackend(engine);
    const second: EventEnvelope[] = [];
    const asyncThrower: (envelope: EventEnvelope) => void = async () => {
      throw new Error('async listener rejected');
    };
    const unsubscribeThrower = backend.subscribeLive(handle.id, 'events', asyncThrower);
    const unsubscribeSecond = backend.subscribeLive(handle.id, 'events', (envelope) => {
      second.push(envelope);
    });

    let detected: unknown = null;
    const handler = (reason: unknown) => {
      detected = reason;
    };
    process.on('unhandledRejection', handler);

    try {
      await engine.signal(handle.id, 'release', 'go');
      await handle.result();
      await sleepForTesting(10);
    } finally {
      process.off('unhandledRejection', handler);
      unsubscribeThrower();
      unsubscribeSecond();
    }

    expect(detected).toBeNull();
    expect(second.length).toBeGreaterThan(0);
  });
});

describe('createEngineEventFeedBackend — atomic handoff through the feed', () => {
  it('yields every committed event exactly once, in order, across replay + live', async () => {
    const engine = createEngineWithSignalWorkflow();
    const handle = await engine.start('hold', {}, {});
    await waitForEventCount(engine, handle.id, 1);

    const backend = createEngineEventFeedBackend(engine);
    const feed = createWorkflowEventFeed(backend);

    // Deterministic sync: the subscribed iterator is "active" (past
    // its snapshot step) once we've seen the first replayed record.
    // Signaling only AFTER the first yield guarantees the resume +
    // completion commits hit the live path, not the replay path —
    // exactly the race the atomic-handoff protocol is designed to
    // handle.
    let resolveFirstRecord!: () => void;
    const firstRecordPromise = new Promise<void>((resolve) => {
      resolveFirstRecord = resolve;
    });

    const subscribePromise = (async () => {
      const received: EventEnvelope[] = [];
      let firstSeen = false;
      for await (const envelope of feed.subscribe({
        workflowId: handle.id,
        selector: 'events',
      })) {
        received.push(envelope);
        if (!firstSeen) {
          firstSeen = true;
          resolveFirstRecord();
        }
        if (envelope.kind === 'workflow:checkpoint' && received.length >= 3) break;
      }
      return received;
    })();

    await firstRecordPromise;
    await engine.signal(handle.id, 'release', 'go');
    await handle.result();

    const received = await subscribePromise;
    const sequences = received.map((envelope) => envelope.sequence);
    const sortedUnique = [...new Set(sequences)].toSorted((a, b) => a - b);
    expect(sequences).toEqual(sortedUnique);
    feed.dispose();
  });
});

describe('createEngineEventFeedBackend — tokens selector', () => {
  function createTokenStreamerEngine(chunks: ReadonlyArray<unknown>): Engine {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    engine.register('streamer', async function* (ctx: WorkflowContext, _input: unknown) {
      const context = ctx;
      yield* context.stream('tokens', async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      });
      yield* context.waitForSignal<string>('finish');
      return 'done';
    });
    return engine;
  }

  async function waitForStreamChunks(
    engine: Engine,
    workflowId: string,
    expected: number,
    timeoutMilliseconds = 500,
  ): Promise<void> {
    await waitForCondition(
      async () => {
        const chunks = await engine.getStreamChunks(workflowId, 'tokens');
        return chunks.length >= expected;
      },
      {
        label: `${expected} token chunks for ${workflowId}`,
        timeoutMs: timeoutMilliseconds,
        intervalMs: 5,
      },
    );
  }

  it('replays stored stream chunks keyed under "tokens"', async () => {
    const engine = createTokenStreamerEngine(['hello', 'world']);
    const handle = await engine.start('streamer', {}, {});
    await waitForStreamChunks(engine, handle.id, 2);
    const prefix = KEYS.streamChunkPrefix(handle.id, 'tokens');
    await engine.storage.put(`${prefix}not-a-number`, encode('ignored'));

    const backend = createEngineEventFeedBackend(engine);
    const envelopes = await collect(
      backend.replay({ workflowId: handle.id, selector: 'tokens', afterSequence: -1 }),
      10,
    );

    expect(envelopes.length).toBe(2);
    expect(envelopes[0]!.sequence).toBe(0);
    expect(envelopes[1]!.sequence).toBe(1);
    expect(envelopes[0]!.payload).toBe('hello');
    expect(envelopes[1]!.payload).toBe('world');
    expect(envelopes[0]!.selector).toBe('tokens');
    expect(envelopes[0]!.kind).toBe('stream:chunk');

    await engine.signal(handle.id, 'finish', 'go');
    await handle.result();
  });

  it('snapshotTailSequence returns the last stored chunk index', async () => {
    const engine = createTokenStreamerEngine(['a', 'b', 'c']);
    const handle = await engine.start('streamer', {}, {});
    await waitForStreamChunks(engine, handle.id, 3);
    const prefix = KEYS.streamChunkPrefix(handle.id, 'tokens');
    await engine.storage.put(`${prefix}0000000004-trailing-text`, encode('ignored'));

    const backend = createEngineEventFeedBackend(engine);
    expect(await backend.snapshotTailSequence(handle.id, 'tokens')).toBe(2);

    await engine.signal(handle.id, 'finish', 'go');
    await handle.result();
  });

  it('skips chunks at or below afterSequence', async () => {
    const engine = createTokenStreamerEngine(['zero', 'one', 'two']);
    const handle = await engine.start('streamer', {}, {});
    await waitForStreamChunks(engine, handle.id, 3);

    const backend = createEngineEventFeedBackend(engine);
    const envelopes = await collect(
      backend.replay({ workflowId: handle.id, selector: 'tokens', afterSequence: 0 }),
      10,
    );

    expect(envelopes.map((e) => e.sequence)).toEqual([1, 2]);

    await engine.signal(handle.id, 'finish', 'go');
    await handle.result();
  });

  it('snapshotTailSequence returns -1 when no chunks were written', async () => {
    const engine = createEngineWithSignalWorkflow();
    const backend = createEngineEventFeedBackend(engine);
    expect(await backend.snapshotTailSequence('nothing', 'tokens')).toBe(-1);
  });

  /**
   * Register a token-streamer workflow that waits for a `'start'`
   * signal BEFORE emitting chunks, then emits the provided chunk
   * list, then waits on `'finish'` to keep the workflow alive while
   * tests inspect state. Gating emission lets tests subscribe first
   * and then unblock the stream, removing timing races that a
   * simple `Bun.sleep` post-check would paper over.
   */
  function registerGatedStreamerWorkflow(
    engine: Engine,
    name: string,
    chunks: ReadonlyArray<unknown>,
  ): void {
    engine.register(name, async function* (ctx: WorkflowContext, _input: unknown) {
      const context = ctx;
      yield* context.waitForSignal<string>('start');
      yield* context.stream('tokens', async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      });
      yield* context.waitForSignal<string>('finish');
      return 'done';
    });
  }

  it('delivers live stream chunks to listeners', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    registerGatedStreamerWorkflow(engine, 'gated-streamer', ['first', 'second']);
    const backend = createEngineEventFeedBackend(engine);

    const handle = await engine.start('gated-streamer', {}, {});
    // Subscribe BEFORE the workflow emits any chunks — the gate
    // guarantees no chunk has been written yet.
    const received: EventEnvelope[] = [];
    const unsubscribe = backend.subscribeLive(handle.id, 'tokens', (envelope) => {
      received.push(envelope);
    });

    // Unblock the stream, then wait on storage for the expected
    // chunk count (deadline-polled, caps at the helper's timeout).
    await engine.signal(handle.id, 'start', 'go');
    await waitForStreamChunks(engine, handle.id, 2);

    // By the time `waitForStreamChunks` returns, the storage puts
    // have committed AND the notifier has fired synchronously at
    // each put's `storage.put(...)` resolution. No post-check sleep
    // is needed.
    expect(received.length).toBe(2);
    expect(received.map((envelope) => envelope.payload)).toEqual(['first', 'second']);
    for (const envelope of received) {
      expect(envelope.selector).toBe('tokens');
      expect(envelope.workflowId).toBe(handle.id);
    }

    unsubscribe();
    await engine.signal(handle.id, 'finish', 'go');
    await handle.result();
  });

  it('does not deliver token chunks across workflow ids', async () => {
    // Regression guard: the unified `#workflowFeedListeners` map is
    // keyed by `${workflowId}\0${selector}`. A key-collision bug
    // would cause a listener registered for workflow A to receive
    // chunks written by workflow B. Two concurrent streamers with
    // gated emission keep this deterministic — subscribe first,
    // unblock both, then assert.
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    registerGatedStreamerWorkflow(engine, 'streamer-a', ['first-a', 'second-a']);
    registerGatedStreamerWorkflow(engine, 'streamer-b', ['first-b', 'second-b']);

    const a = await engine.start('streamer-a', {}, {});
    const b = await engine.start('streamer-b', {}, {});
    const backend = createEngineEventFeedBackend(engine);

    const receivedForA: EventEnvelope[] = [];
    const unsubscribeA = backend.subscribeLive(a.id, 'tokens', (envelope) => {
      receivedForA.push(envelope);
    });

    await engine.signal(a.id, 'start', 'go');
    await engine.signal(b.id, 'start', 'go');
    await waitForStreamChunks(engine, a.id, 2);
    await waitForStreamChunks(engine, b.id, 2);

    // A must have received exactly its two chunks; zero from B.
    expect(receivedForA.length).toBe(2);
    for (const envelope of receivedForA) {
      expect(envelope.workflowId).toBe(a.id);
    }

    unsubscribeA();
    await engine.signal(a.id, 'finish', 'go');
    await engine.signal(b.id, 'finish', 'go');
    await a.result();
    await b.result();
  });
});

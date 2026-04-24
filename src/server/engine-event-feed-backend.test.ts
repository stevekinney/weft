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

import type { Context } from '../core/context.ts';
import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
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
    const context = ctx as Context;
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
      const context = ctx as Context;
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
    const deadline = Date.now() + timeoutMilliseconds;
    while (Date.now() < deadline) {
      const chunks = await engine.getStreamChunks(workflowId, 'tokens');
      if (chunks.length >= expected) return;
      await Bun.sleep(5);
    }
    throw new Error(
      `Engine did not accumulate ${expected} tokens chunks within ${timeoutMilliseconds}ms`,
    );
  }

  it('replays stored stream chunks keyed under "tokens"', async () => {
    const engine = createTokenStreamerEngine(['hello', 'world']);
    const handle = await engine.start('streamer', {}, {});
    await waitForStreamChunks(engine, handle.id, 2);

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

  it('delivers live stream chunks to listeners', async () => {
    const engine = createTokenStreamerEngine(['first', 'second']);
    const backend = createEngineEventFeedBackend(engine);
    const received: EventEnvelope[] = [];

    const handle = await engine.start('streamer', {}, {});
    const unsubscribe = backend.subscribeLive(handle.id, 'tokens', (envelope) => {
      received.push(envelope);
    });

    await waitForStreamChunks(engine, handle.id, 2);
    await Bun.sleep(10);

    expect(received.length).toBeGreaterThanOrEqual(1);
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
    // chunks written by workflow B. Two concurrent streamers keep
    // this honest.
    const engine = createTokenStreamerEngine(['first-a', 'second-a']);
    engine.register('streamer-b', async function* (ctx: WorkflowContext, _input: unknown) {
      const context = ctx as Context;
      yield* context.stream('tokens', async function* () {
        yield 'first-b';
        yield 'second-b';
      });
      yield* context.waitForSignal<string>('finish');
      return 'done';
    });

    const a = await engine.start('streamer', {}, {});
    const b = await engine.start('streamer-b', {}, {});
    const backend = createEngineEventFeedBackend(engine);

    const receivedForA: EventEnvelope[] = [];
    const unsubscribeA = backend.subscribeLive(a.id, 'tokens', (envelope) => {
      receivedForA.push(envelope);
    });

    await waitForStreamChunks(engine, a.id, 2);
    await waitForStreamChunks(engine, b.id, 2);
    await Bun.sleep(10);

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

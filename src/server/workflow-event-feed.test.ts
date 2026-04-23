/**
 * Tests for `WorkflowEventFeed` — the transport-neutral event-replay
 * plus live-tail abstraction that REST SSE, WebSocket watch/stream,
 * and JSON-RPC subscribe all consume.
 *
 * The critical invariant under test is the atomic handoff ordering:
 *   1. Register a live listener into a bounded buffer (listener active
 *      from this moment — no events can arrive without being captured).
 *   2. Snapshot the current live-tail sequence `S`.
 *   3. Replay storage strictly above the caller's `fromCursor` up to `S`.
 *   4. Drain the buffer, dropping anything whose sequence <= `S`
 *      (already covered by replay), emitting the rest.
 *   5. Transition to live-only delivery for subsequent events.
 *
 * The property the test suite proves: given events at sequences 1..N
 * emitted concurrently with `subscribe`, the subscriber sees every
 * sequence exactly once, in sequence order, with no gaps.
 *
 * Per Track 8 design decision 6, the cursor is opaque. The feed owns
 * `encodeCursor(sequence)` / `decodeCursor(cursor)`. This test imports
 * those helpers and asserts round-trip identity without assuming a
 * specific encoding.
 */

import { describe, expect, it } from 'bun:test';

import {
  createInMemoryEventBackend,
  createWorkflowEventFeed,
  decodeCursor,
  encodeCursor,
  type EventEnvelope,
  type WorkflowEventFeedBackend,
} from './workflow-event-feed.ts';

function makeEnvelope(overrides: Partial<EventEnvelope> & { sequence: number }): EventEnvelope {
  // Spread overrides FIRST so the explicit `sequence` + derived
  // `cursor` win over any caller-supplied defaults. Earlier form
  // had `...overrides` last, which triggered TS2783 (sequence is
  // specified more than once).
  return {
    ...overrides,
    kind: overrides.kind ?? 'workflow:started',
    workflowId: overrides.workflowId ?? 'wf-1',
    selector: overrides.selector ?? 'events',
    sequence: overrides.sequence,
    cursor: overrides.cursor ?? encodeCursor(overrides.sequence),
    emittedAtMs: overrides.emittedAtMs ?? Date.now(),
    payload: overrides.payload ?? { type: 'started' },
  };
}

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a non-negative sequence number', () => {
    for (const value of [0, 1, 42, 1000, Number.MAX_SAFE_INTEGER]) {
      expect(decodeCursor(encodeCursor(value))).toBe(value);
    }
  });

  it('returns null for a malformed cursor (never throws)', () => {
    expect(decodeCursor('garbage')).toBeNull();
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor('-2')).toBeNull();
    expect(decodeCursor('1.5')).toBeNull();
  });

  it('decodes the initial cursor sentinel as before the first sequence', () => {
    expect(decodeCursor('-1')).toBe(-1);
  });

  it('encodeCursor returns a stable string for the same input', () => {
    expect(encodeCursor(42)).toBe(encodeCursor(42));
  });
});

describe('WorkflowEventFeed — replay', () => {
  it('yields every stored event above fromCursor in order', async () => {
    const backend = createInMemoryEventBackend();
    for (let seq = 0; seq < 5; seq += 1) {
      await backend.append(makeEnvelope({ sequence: seq }));
    }
    const feed = createWorkflowEventFeed(backend);
    const received: number[] = [];
    for await (const envelope of feed.replay({ workflowId: 'wf-1', selector: 'events' })) {
      received.push(envelope.sequence);
    }
    expect(received).toEqual([0, 1, 2, 3, 4]);
  });

  it('skips events at or below fromCursor', async () => {
    const backend = createInMemoryEventBackend();
    for (let seq = 0; seq < 5; seq += 1) {
      await backend.append(makeEnvelope({ sequence: seq }));
    }
    const feed = createWorkflowEventFeed(backend);
    const received: number[] = [];
    for await (const envelope of feed.replay({
      workflowId: 'wf-1',
      selector: 'events',
      fromCursor: encodeCursor(2),
    })) {
      received.push(envelope.sequence);
    }
    expect(received).toEqual([3, 4]);
  });

  it('respects the limit parameter', async () => {
    const backend = createInMemoryEventBackend();
    for (let seq = 0; seq < 10; seq += 1) {
      await backend.append(makeEnvelope({ sequence: seq }));
    }
    const feed = createWorkflowEventFeed(backend);
    const received: number[] = [];
    for await (const envelope of feed.replay({
      workflowId: 'wf-1',
      selector: 'events',
      limit: 3,
    })) {
      received.push(envelope.sequence);
    }
    expect(received).toEqual([0, 1, 2]);
  });

  it('yields nothing for a workflow with no events', async () => {
    const backend = createInMemoryEventBackend();
    const feed = createWorkflowEventFeed(backend);
    const received: number[] = [];
    for await (const envelope of feed.replay({ workflowId: 'wf-empty', selector: 'events' })) {
      received.push(envelope.sequence);
    }
    expect(received).toEqual([]);
  });

  it('filters by selector (events vs tokens)', async () => {
    const backend = createInMemoryEventBackend();
    await backend.append(makeEnvelope({ sequence: 0, selector: 'events' }));
    await backend.append(makeEnvelope({ sequence: 1, selector: 'tokens' }));
    await backend.append(makeEnvelope({ sequence: 2, selector: 'events' }));
    const feed = createWorkflowEventFeed(backend);
    const events: number[] = [];
    for await (const envelope of feed.replay({ workflowId: 'wf-1', selector: 'events' })) {
      events.push(envelope.sequence);
    }
    expect(events).toEqual([0, 2]);
  });

  it('rejects a malformed fromCursor by falling back to "from the start"', async () => {
    const backend = createInMemoryEventBackend();
    for (let seq = 0; seq < 3; seq += 1) {
      await backend.append(makeEnvelope({ sequence: seq }));
    }
    const feed = createWorkflowEventFeed(backend);
    const received: number[] = [];
    for await (const envelope of feed.replay({
      workflowId: 'wf-1',
      selector: 'events',
      fromCursor: 'not-a-cursor',
    })) {
      received.push(envelope.sequence);
    }
    expect(received).toEqual([0, 1, 2]);
  });
});

describe('WorkflowEventFeed — subscribe (live + replay)', () => {
  it('delivers live events after replay with no duplicates', async () => {
    const backend = createInMemoryEventBackend();
    await backend.append(makeEnvelope({ sequence: 0 }));
    await backend.append(makeEnvelope({ sequence: 1 }));
    const feed = createWorkflowEventFeed(backend);

    const received: number[] = [];
    const iterable = feed.subscribe({ workflowId: 'wf-1', selector: 'events' });
    const iterator = iterable[Symbol.asyncIterator]();

    // Pull the replayed events first.
    for (let index = 0; index < 2; index += 1) {
      const result = await iterator.next();
      if (result.done) throw new Error('unexpected done');
      received.push(result.value.sequence);
    }
    expect(received).toEqual([0, 1]);

    // Now emit a live event and assert the subscriber picks it up.
    await backend.emitLive(makeEnvelope({ sequence: 2 }));
    const next = await iterator.next();
    if (next.done) throw new Error('unexpected done');
    expect(next.value.sequence).toBe(2);

    await iterator.return?.();
  });

  it('handles live events that arrive DURING replay (atomic handoff)', async () => {
    // The critical invariant: live events emitted while replay is
    // in flight MUST reach the subscriber, without duplicating any
    // event that is also in storage. `emitLive` bypasses storage —
    // the feed's live-listener captures it; the buffer drains after
    // replay and ignores duplicates by sequence.
    const backend = createInMemoryEventBackend();
    for (let seq = 0; seq < 5; seq += 1) {
      await backend.append(makeEnvelope({ sequence: seq }));
    }
    const feed = createWorkflowEventFeed(backend);

    const iterable = feed.subscribe({ workflowId: 'wf-1', selector: 'events' });
    const iterator = iterable[Symbol.asyncIterator]();

    // Pull first two replayed events, then inject a live event that
    // was ALSO persisted to storage (a real engine would do both).
    const a = await iterator.next();
    const b = await iterator.next();
    await backend.append(makeEnvelope({ sequence: 5 }));
    await backend.emitLive(makeEnvelope({ sequence: 5 }));

    // Pull the rest — expect 2, 3, 4, 5 (live 5 deduped with storage 5).
    const received: number[] = [];
    if (!a.done) received.push(a.value.sequence);
    if (!b.done) received.push(b.value.sequence);
    for (let index = 0; index < 4; index += 1) {
      const next = await iterator.next();
      if (next.done) break;
      received.push(next.value.sequence);
      if (next.value.sequence >= 5) break;
    }
    await iterator.return?.();
    expect(received).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('closes the iterable with a SubscriptionOverflow fault when the buffer overflows', async () => {
    // A slow consumer + fast producer can exceed the bounded buffer.
    // The feed must close the iterable cleanly with a fault marker
    // rather than silently dropping events or unbounded-memory-growing.
    const backend = createInMemoryEventBackend();
    // Tiny buffer so overflow is observable in a unit test.
    const feed = createWorkflowEventFeed(backend, { liveBufferSize: 2 });
    const iterable = feed.subscribe({ workflowId: 'wf-1', selector: 'events' });
    const iterator = iterable[Symbol.asyncIterator]();

    // Don't consume — keep pushing live events past the buffer bound.
    for (let seq = 0; seq < 10; seq += 1) {
      await backend.emitLive(makeEnvelope({ sequence: seq }));
    }

    // Drain — the first two succeed, then an overflow ends the
    // iterable. The `sawDone` flag is critical: without it a
    // silent-drop regression would still pass the length check.
    const received: number[] = [];
    let sawDone = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const next = await iterator.next();
      if (next.done) {
        sawDone = true;
        break;
      }
      received.push(next.value.sequence);
    }
    expect(sawDone).toBe(true);
    expect(received.length).toBeLessThanOrEqual(2);
  });

  it('captures live-only events emitted between subscribeLive and snapshotTailSequence', async () => {
    // This is the actual race the atomic-handoff sequence exists to
    // close: a backend can fire a live event AFTER the listener is
    // registered (step 1) but BEFORE the snapshot resolves (step 2).
    // If the feed registered the listener inside the async generator
    // body (lazy), the event would fall into the gap. With eager
    // registration the listener captures it; the drain step then
    // delivers it alongside the replayed events.
    //
    // Intercepted backend injects a live-only event during the
    // snapshot call — single-threaded JS makes this deterministic.
    const real = createInMemoryEventBackend();
    await real.append(makeEnvelope({ sequence: 0 }));

    let liveInjected = false;
    const backend: WorkflowEventFeedBackend = {
      replay: real.replay.bind(real),
      subscribeLive: real.subscribeLive.bind(real),
      async snapshotTailSequence(workflowId, selector) {
        if (!liveInjected) {
          liveInjected = true;
          // seq=1 fires live but is NOT in storage — only the buffer
          // can capture it. Must appear in the subscriber's output.
          await real.emitLive(makeEnvelope({ sequence: 1 }));
        }
        return real.snapshotTailSequence(workflowId, selector);
      },
    };

    const feed = createWorkflowEventFeed(backend);
    const received: number[] = [];
    for await (const envelope of feed.subscribe({ workflowId: 'wf-1', selector: 'events' })) {
      received.push(envelope.sequence);
      if (envelope.sequence >= 1) break;
    }
    expect(received).toEqual([0, 1]);
  });

  it('serves two concurrent subscribers independently', async () => {
    // Two subscribers on the same workflow: both must receive every
    // event, neither's buffer should interfere with the other's.
    const backend = createInMemoryEventBackend();
    const feed = createWorkflowEventFeed(backend);

    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const receivedA: number[] = [];
    const receivedB: number[] = [];

    const pumpA = (async () => {
      for await (const envelope of feed.subscribe({
        workflowId: 'wf-1',
        selector: 'events',
        signal: controllerA.signal,
      })) {
        receivedA.push(envelope.sequence);
        if (receivedA.length >= 3) controllerA.abort();
      }
    })();

    const pumpB = (async () => {
      for await (const envelope of feed.subscribe({
        workflowId: 'wf-1',
        selector: 'events',
        signal: controllerB.signal,
      })) {
        receivedB.push(envelope.sequence);
        if (receivedB.length >= 3) controllerB.abort();
      }
    })();

    // Let both subscribers register their listeners before emitting.
    await Bun.sleep(0);
    for (let seq = 0; seq < 3; seq += 1) {
      await backend.emitLive(makeEnvelope({ sequence: seq }));
    }

    await pumpA;
    await pumpB;
    expect(receivedA).toEqual([0, 1, 2]);
    expect(receivedB).toEqual([0, 1, 2]);
  });

  it('resume-after-overflow: reopening with last cursor replays the missed events from storage', async () => {
    // Primary recovery story: buffer overflows → iterable closes →
    // caller reopens with its last delivered cursor → missed events
    // replay cleanly. Without this test the overflow contract is
    // undocumented at the behavioral level.
    const backend = createInMemoryEventBackend();
    const feed = createWorkflowEventFeed(backend, { liveBufferSize: 2 });

    // Session 1: overflow after consuming one event.
    await backend.append(makeEnvelope({ sequence: 0 }));
    const session1 = feed.subscribe({ workflowId: 'wf-1', selector: 'events' });
    const iter1 = session1[Symbol.asyncIterator]();
    const firstPull = await iter1.next();
    if (firstPull.done) throw new Error('expected replayed seq 0');
    const lastDeliveredCursor = firstPull.value.cursor;

    // Fill and overflow.
    for (let seq = 1; seq <= 5; seq += 1) {
      await backend.append(makeEnvelope({ sequence: seq }));
      await backend.emitLive(makeEnvelope({ sequence: seq }));
    }
    // Drain until done.
    let sawDone1 = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const next = await iter1.next();
      if (next.done) {
        sawDone1 = true;
        break;
      }
    }
    expect(sawDone1).toBe(true);

    // Session 2: resubscribe with the last cursor; missed events must
    // replay from storage.
    const received: number[] = [];
    const session2 = feed.subscribe({
      workflowId: 'wf-1',
      selector: 'events',
      fromCursor: lastDeliveredCursor,
    });
    const iter2 = session2[Symbol.asyncIterator]();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const next = await iter2.next();
      if (next.done) break;
      received.push(next.value.sequence);
      if (received.length >= 5) break;
    }
    await iter2.return?.();
    // Events after seq 0 (the last delivered) should all appear.
    expect(received).toEqual([1, 2, 3, 4, 5]);
  });

  it('AbortSignal.abort() stops the subscription cleanly', async () => {
    const backend = createInMemoryEventBackend();
    await backend.append(makeEnvelope({ sequence: 0 }));
    const feed = createWorkflowEventFeed(backend);

    const controller = new AbortController();
    const iterable = feed.subscribe({
      workflowId: 'wf-1',
      selector: 'events',
      signal: controller.signal,
    });
    const iterator = iterable[Symbol.asyncIterator]();

    // Consume the replayed event.
    const first = await iterator.next();
    if (first.done) throw new Error('unexpected done');

    // Abort the subscription; the next iteration must resolve `done`.
    controller.abort();
    const second = await iterator.next();
    expect(second.done).toBe(true);
  });
});

describe('WorkflowEventFeed — dispose', () => {
  it('idempotent — multiple dispose() calls do not throw', () => {
    const backend = createInMemoryEventBackend();
    const feed = createWorkflowEventFeed(backend);
    expect(() => feed.dispose()).not.toThrow();
    expect(() => feed.dispose()).not.toThrow();
  });
});

describe('WorkflowEventFeedBackend contract', () => {
  it('in-memory backend returns storage events in sequence order', async () => {
    const backend = createInMemoryEventBackend();
    // Intentionally append out of order — backend must NOT reorder
    // (the sequence number on the envelope is the source of truth).
    await backend.append(makeEnvelope({ sequence: 2 }));
    await backend.append(makeEnvelope({ sequence: 0 }));
    await backend.append(makeEnvelope({ sequence: 1 }));
    const ordered: number[] = [];
    for await (const envelope of backend.replay({
      workflowId: 'wf-1',
      selector: 'events',
      afterSequence: -1,
    })) {
      ordered.push(envelope.sequence);
    }
    expect(ordered).toEqual([0, 1, 2]);
  });

  it('backend satisfies WorkflowEventFeedBackend shape', () => {
    const backend: WorkflowEventFeedBackend = createInMemoryEventBackend();
    expect(typeof backend.replay).toBe('function');
    expect(typeof backend.snapshotTailSequence).toBe('function');
    expect(typeof backend.subscribeLive).toBe('function');
  });
});

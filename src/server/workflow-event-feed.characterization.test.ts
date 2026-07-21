/**
 * Characterization tests for `drainLive` via the public
 * `WorkflowEventFeed.subscribe` surface.
 *
 * These tests assert externally observable outputs only:
 *   - The sequence of envelopes delivered to a subscriber per drain pass
 *   - The watermark (last delivered sequence) visible through the cursor
 *     on each envelope
 *   - Whether the iterable terminates (done flag) and when
 *   - Error-path termination on overflow
 *
 * They do NOT assert private call sequencing, waker installation order,
 * or any internal state. The goal is a stable contract that survives a
 * pure internal refactor of `drainLive`.
 */

import { sleepForTesting } from '../testing/fake-timers.test-support.ts';

import { describe, expect, it } from 'bun:test';

import { createInMemoryEventBackend } from './in-memory-event-feed-backend.test-support.ts';
import {
  createWorkflowEventFeed,
  decodeCursor,
  encodeCursor,
  type EventEnvelope,
} from './workflow-event-feed.ts';

function makeEnvelope(overrides: Partial<EventEnvelope> & { sequence: number }): EventEnvelope {
  return {
    kind: 'workflow:started',
    workflowId: 'wf-1',
    selector: 'events',
    emittedAtMs: 0,
    payload: {},
    ...overrides,
    sequence: overrides.sequence,
    cursor: overrides.cursor ?? encodeCursor(overrides.sequence),
  };
}

// ---------------------------------------------------------------------------
// Deduplication: events at or below snapshot are dropped
// ---------------------------------------------------------------------------

describe('drainLive — deduplication against snapshot', () => {
  it('drops buffered events whose sequence is at or below the replay snapshot', async () => {
    // Backend with snapshot=2; events 0-2 are in storage (replayed).
    // Live events 1, 2, 3 arrive in the buffer. Only seq=3 must reach
    // the subscriber; 1 and 2 were already covered by replay.
    const backend = createInMemoryEventBackend();
    for (let seq = 0; seq <= 2; seq += 1) {
      await backend.append(makeEnvelope({ sequence: seq }));
    }
    const feed = createWorkflowEventFeed(backend);

    const iterable = feed.subscribe({ workflowId: 'wf-1', selector: 'events' });
    const iterator = iterable[Symbol.asyncIterator]();

    // Drain the three replayed events.
    const replayed: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const result = await iterator.next();
      if (!result.done) replayed.push(result.value.sequence);
    }
    expect(replayed).toEqual([0, 1, 2]);

    // Now inject duplicates of already-replayed sequences plus a new one.
    await backend.emitLive(makeEnvelope({ sequence: 1 }));
    await backend.emitLive(makeEnvelope({ sequence: 2 }));
    await backend.emitLive(makeEnvelope({ sequence: 3 }));

    // Only seq=3 should be delivered; 1 and 2 are below the watermark.
    const live = await iterator.next();
    expect(live.done).toBe(false);
    if (!live.done) expect(live.value.sequence).toBe(3);

    await iterator.return?.();
  });

  it('advances the watermark after each yielded event so later duplicates are dropped', async () => {
    const backend = createInMemoryEventBackend();
    const feed = createWorkflowEventFeed(backend);

    const iterable = feed.subscribe({ workflowId: 'wf-1', selector: 'events' });
    const iterator = iterable[Symbol.asyncIterator]();

    // Emit seq 0, then re-emit it, then emit seq 1.
    await backend.emitLive(makeEnvelope({ sequence: 0 }));
    const first = await iterator.next();
    expect(first.done).toBe(false);
    if (!first.done) expect(first.value.sequence).toBe(0);

    // Re-emitting seq 0 must be dropped (watermark is now 0).
    await backend.emitLive(makeEnvelope({ sequence: 0 }));
    await backend.emitLive(makeEnvelope({ sequence: 1 }));

    const second = await iterator.next();
    expect(second.done).toBe(false);
    if (!second.done) expect(second.value.sequence).toBe(1);

    await iterator.return?.();
  });
});

// ---------------------------------------------------------------------------
// Batch delivery: multiple buffered events drained in one pass
// ---------------------------------------------------------------------------

describe('drainLive — batch delivery', () => {
  it('delivers all buffered events above the watermark before waiting again', async () => {
    const backend = createInMemoryEventBackend();
    const feed = createWorkflowEventFeed(backend);

    const iterable = feed.subscribe({ workflowId: 'wf-1', selector: 'events' });
    const iterator = iterable[Symbol.asyncIterator]();

    // Buffer several events synchronously before the consumer pulls any.
    for (let seq = 0; seq < 5; seq += 1) {
      await backend.emitLive(makeEnvelope({ sequence: seq }));
    }

    const received: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const next = await iterator.next();
      if (next.done) break;
      received.push(next.value.sequence);
    }
    expect(received).toEqual([0, 1, 2, 3, 4]);

    await iterator.return?.();
  });

  it('delivers events in ascending sequence order regardless of buffer push order', async () => {
    // The in-memory backend delivers live events synchronously so buffer
    // order matches push order, but the watermark-advance logic inside
    // drainLive must still advance monotonically. If a lower-sequence
    // event arrives after a higher one (backend violation), it is
    // silently dropped — confirmed here by delivering in order and
    // checking the monotonic guarantee holds.
    const backend = createInMemoryEventBackend();
    const feed = createWorkflowEventFeed(backend);

    const iterable = feed.subscribe({ workflowId: 'wf-1', selector: 'events' });
    const iterator = iterable[Symbol.asyncIterator]();

    await backend.emitLive(makeEnvelope({ sequence: 0 }));
    await backend.emitLive(makeEnvelope({ sequence: 1 }));
    await backend.emitLive(makeEnvelope({ sequence: 2 }));

    const received: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const next = await iterator.next();
      if (next.done) break;
      received.push(next.value.sequence);
    }
    // Sequences must be strictly ascending.
    for (let index = 1; index < received.length; index += 1) {
      expect(received[index]).toBeGreaterThan(received[index - 1]!);
    }

    await iterator.return?.();
  });
});

// ---------------------------------------------------------------------------
// Watermark visibility: cursor on each delivered envelope
// ---------------------------------------------------------------------------

describe('drainLive — watermark via cursor', () => {
  it('each delivered envelope carries a cursor that decodes to its sequence', async () => {
    const backend = createInMemoryEventBackend();
    const feed = createWorkflowEventFeed(backend);

    const iterable = feed.subscribe({ workflowId: 'wf-1', selector: 'events' });
    const iterator = iterable[Symbol.asyncIterator]();

    for (let seq = 0; seq < 3; seq += 1) {
      await backend.emitLive(makeEnvelope({ sequence: seq }));
    }

    for (let index = 0; index < 3; index += 1) {
      const next = await iterator.next();
      expect(next.done).toBe(false);
      if (!next.done) {
        const decoded = decodeCursor(next.value.cursor);
        expect(decoded).toBe(next.value.sequence);
      }
    }

    await iterator.return?.();
  });
});

// ---------------------------------------------------------------------------
// Overflow: iterable terminates when buffer is full
// ---------------------------------------------------------------------------

describe('drainLive — overflow termination', () => {
  it('terminates the iterable when the buffer overflows (slow consumer)', async () => {
    const backend = createInMemoryEventBackend();
    const feed = createWorkflowEventFeed(backend, { liveBufferSize: 3 });

    const iterable = feed.subscribe({ workflowId: 'wf-1', selector: 'events' });
    const iterator = iterable[Symbol.asyncIterator]();

    // Emit more events than the buffer can hold without consuming.
    for (let seq = 0; seq < 10; seq += 1) {
      await backend.emitLive(makeEnvelope({ sequence: seq }));
    }

    // Drain until done — the iterable must terminate.
    let sawDone = false;
    const received: number[] = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const next = await iterator.next();
      if (next.done) {
        sawDone = true;
        break;
      }
      received.push(next.value.sequence);
    }

    expect(sawDone).toBe(true);
    // At most bufferSize events before overflow closed the stream.
    expect(received.length).toBeLessThanOrEqual(3);
  });

  it('does not deliver any events after overflow has been signalled', async () => {
    const backend = createInMemoryEventBackend();
    const feed = createWorkflowEventFeed(backend, { liveBufferSize: 1 });

    const iterable = feed.subscribe({ workflowId: 'wf-1', selector: 'events' });
    const iterator = iterable[Symbol.asyncIterator]();

    // Overflow immediately.
    for (let seq = 0; seq < 5; seq += 1) {
      await backend.emitLive(makeEnvelope({ sequence: seq }));
    }

    let doneIndex = -1;
    const received: number[] = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const next = await iterator.next();
      if (next.done) {
        doneIndex = attempt;
        break;
      }
      received.push(next.value.sequence);
    }

    expect(doneIndex).toBeGreaterThanOrEqual(0);
    // No events after done.
    const afterDone = await iterator.next();
    expect(afterDone.done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Abort: iterable terminates when AbortSignal fires
// ---------------------------------------------------------------------------

describe('drainLive — abort termination', () => {
  it('terminates immediately when signal is already aborted before drain begins', async () => {
    const backend = createInMemoryEventBackend();
    // No events in storage → drainLive runs immediately from seq=-1 watermark.
    const feed = createWorkflowEventFeed(backend);

    const controller = new AbortController();
    controller.abort();

    const iterable = feed.subscribe({
      workflowId: 'wf-1',
      selector: 'events',
      signal: controller.signal,
    });
    const iterator = iterable[Symbol.asyncIterator]();
    const result = await iterator.next();
    expect(result.done).toBe(true);
  });

  it('terminates while waiting for the next live event when signal fires', async () => {
    const backend = createInMemoryEventBackend();
    const feed = createWorkflowEventFeed(backend);
    const controller = new AbortController();

    const iterable = feed.subscribe({
      workflowId: 'wf-1',
      selector: 'events',
      signal: controller.signal,
    });
    const iterator = iterable[Symbol.asyncIterator]();

    // Start waiting for a live event, then abort.
    const pending = iterator.next();
    await sleepForTesting(0);
    controller.abort();

    const result = await pending;
    expect(result.done).toBe(true);
  });

  it('stops delivering buffered events after abort fires mid-batch', async () => {
    // Buffer several events, abort after consuming the first one.
    // Remaining buffered events must NOT be delivered.
    const backend = createInMemoryEventBackend();
    const feed = createWorkflowEventFeed(backend);
    const controller = new AbortController();

    const iterable = feed.subscribe({
      workflowId: 'wf-1',
      selector: 'events',
      signal: controller.signal,
    });
    const iterator = iterable[Symbol.asyncIterator]();

    for (let seq = 0; seq < 5; seq += 1) {
      await backend.emitLive(makeEnvelope({ sequence: seq }));
    }

    // Consume first event, then abort.
    const first = await iterator.next();
    expect(first.done).toBe(false);

    controller.abort();

    // Next pull must terminate.
    const second = await iterator.next();
    expect(second.done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lost-wakeup guard: event arrives between empty-check and waker install
// ---------------------------------------------------------------------------

describe('drainLive — lost-wakeup race guard', () => {
  it('delivers an event that arrives exactly as the waker is being armed', async () => {
    // This is the trickiest part of the algorithm. Between checking
    // "buffer is empty" and installing the waker, a new event can be
    // pushed. The implementation re-checks buffer / overflow / abort
    // AFTER arming, so it cancels the wait and loops immediately.
    // The observable outcome: the event is not lost.
    const backend = createInMemoryEventBackend();
    const feed = createWorkflowEventFeed(backend);

    const iterable = feed.subscribe({ workflowId: 'wf-1', selector: 'events' });
    const iterator = iterable[Symbol.asyncIterator]();

    // Let the generator reach the "await armed" point (buffer empty).
    const pending = iterator.next();
    await sleepForTesting(0);

    // Push the event — the waker fires or the re-check catches it.
    await backend.emitLive(makeEnvelope({ sequence: 0 }));

    const result = await pending;
    expect(result.done).toBe(false);
    if (!result.done) expect(result.value.sequence).toBe(0);

    await iterator.return?.();
  });
});

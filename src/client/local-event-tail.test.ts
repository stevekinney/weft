import { describe, expect, it } from 'bun:test';
import type { Engine } from '../core/engine.ts';
import { createWorkflowHandleEventIterator } from '../core/engine/handle-iteration.ts';
import { SignalReceivedEvent, WorkflowCompletedEvent } from '../core/events.ts';
import type { WorkflowEvent, WorkflowState } from '../core/types.ts';
import { sleepForTesting } from '../testing/fake-timers.test-support.ts';
import { createLocalWorkflowEventTail } from './local-event-tail.ts';

function event(type: string, data: Record<string, unknown> = {}): WorkflowEvent {
  return { type, timestamp: 1, data };
}

async function drain(tail: {
  [Symbol.asyncIterator](): AsyncIterator<WorkflowEvent>;
}): Promise<string[]> {
  const seen: string[] = [];
  const consume = (async () => {
    for await (const e of tail) seen.push(e.type);
  })();
  await Promise.race([
    consume,
    new Promise<never>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error(`tail did not terminate; seen=${JSON.stringify(seen)}`)),
        1000,
      ),
    ),
  ]);
  return seen;
}

/**
 * A faithful stand-in for the engine's {@link WorkflowHandle} event stream: an
 * `EventTarget` whose `[Symbol.asyncIterator]` wraps the real
 * {@link createWorkflowHandleEventIterator} exactly as `WorkflowHandle` does
 * (`async *() { yield* createWorkflowHandleEventIterator(...) }`). That wrapping
 * is the crux of the bug under test — the generator body, and thus its
 * `addEventListener` calls, only run when iteration starts — so the fake must
 * reproduce it rather than attach listeners eagerly itself.
 */
class FakeWorkflowHandle extends EventTarget {
  #persisted: WorkflowState | null = null;

  setPersisted(state: WorkflowState | null): void {
    this.#persisted = state;
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<Event> {
    yield* createWorkflowHandleEventIterator(
      this,
      async () => this.#persisted,
      (state) =>
        state.status === 'completed'
          ? new WorkflowCompletedEvent('wf-finished', state.result, 0)
          : null,
    );
  }
}

function fakeEngine(
  handle: FakeWorkflowHandle,
  options: {
    history?: WorkflowEvent[];
    getEventsError?: Error;
    onFetchStart?: () => void;
    gate?: Promise<void>;
  } = {},
): Engine {
  // The local tail calls `engine.getHandle(id)` and `engine.getEvents(id)`;
  // everything else is unused. A test-only structural stand-in keeps the test
  // focused on the tail's catch-up/eager-attach behavior rather than spinning a
  // full engine. `onFetchStart`/`gate` let a test deterministically buffer live
  // frames while the history fetch is in flight.
  return {
    getHandle: () => handle,
    getEvents: async () => {
      options.onFetchStart?.();
      if (options.gate) await options.gate;
      if (options.getEventsError) throw options.getEventsError;
      return options.history ?? [];
    },
  } as unknown as Engine;
}

describe('createLocalWorkflowEventTail', () => {
  it('does not miss events emitted between tail creation and the start of for-await', async () => {
    // Regression (Finding 5): the engine handle iterator is an async generator
    // whose body — including the listener attachment — only runs when iteration
    // begins. With the documented pattern
    // `const tail = client.tail(id); await tail.whenConnected(); …; for await`,
    // an event dispatched before the `for await` loop starts would be missed
    // unless the tail attaches listeners and buffers eagerly at creation. The
    // HTTP tail buffers from construction; LocalClient must match that contract.
    const handle = new FakeWorkflowHandle();
    const tail = createLocalWorkflowEventTail(fakeEngine(handle), 'wf-eager');

    // Mirror the documented usage: wait for the tail to be live, then dispatch
    // an event BEFORE iteration begins. The eager pump must have already
    // attached the handle's listeners and buffered this event.
    await tail.whenConnected();
    handle.dispatchEvent(new SignalReceivedEvent('wf-eager', 'continue', 'go'));
    handle.dispatchEvent(new WorkflowCompletedEvent('wf-eager', 'done', 1));

    // Only now begin iterating. The pre-iteration signal must still be delivered
    // (it was buffered, not dropped), followed by the terminal completion that
    // ends the tail cleanly.
    const seen: string[] = [];
    const consume = (async () => {
      for await (const event of tail) seen.push(event.type);
    })();
    await Promise.race([
      consume,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`tail did not terminate; seen=${JSON.stringify(seen)}`)),
          1000,
        ),
      ),
    ]);

    expect(seen).toEqual(['signal:received', 'workflow:completed']);
  });

  it('serializes engine events into transport-neutral WorkflowEvent records', async () => {
    const handle = new FakeWorkflowHandle();
    const tail = createLocalWorkflowEventTail(fakeEngine(handle), 'wf-serialize');

    await tail.whenConnected();
    handle.dispatchEvent(new SignalReceivedEvent('wf-serialize', 'approve', { userId: 42 }));
    handle.dispatchEvent(new WorkflowCompletedEvent('wf-serialize', { ok: true }, 5));

    const events = [];
    for await (const event of tail) events.push(event);

    expect(events[0]?.type).toBe('signal:received');
    expect(events[0]?.data).toMatchObject({ signalName: 'approve', payload: { userId: 42 } });
    expect(events[1]?.type).toBe('workflow:completed');
    expect(events[1]?.data).toMatchObject({ result: { ok: true } });
  });

  it('drops undefined-valued properties to match the server JSON round-trip', async () => {
    // Regression (Copilot follow-up): a signal delivered with no payload must not
    // leave a `payload: undefined` key in the local tail's `data` — the HTTP tail
    // has no such key (JSON.stringify drops it on the wire), and the unified
    // contract promises identical records.
    const handle = new FakeWorkflowHandle();
    const tail = createLocalWorkflowEventTail(fakeEngine(handle), 'wf-undef');

    await tail.whenConnected();
    handle.dispatchEvent(new SignalReceivedEvent('wf-undef', 'continue', undefined));
    handle.dispatchEvent(new WorkflowCompletedEvent('wf-undef', 'ok', 1));

    const events = [];
    for await (const e of tail) events.push(e);

    expect(events[0]?.type).toBe('signal:received');
    // No `payload` key at all (not `payload: undefined`), matching the wire shape.
    expect(events[0]?.data).not.toHaveProperty('payload');
    expect(events[0]?.data).toMatchObject({ signalName: 'continue' });
  });

  it('terminates immediately when the workflow has already finished (synthesized terminal)', async () => {
    const handle = new FakeWorkflowHandle();
    // The persisted state is terminal before iteration, so the iterator
    // synthesizes the terminal event and the tail ends without any live frame.
    handle.setPersisted({
      status: 'completed',
      result: 'already-done',
    } as unknown as WorkflowState);
    const tail = createLocalWorkflowEventTail(fakeEngine(handle), 'wf-finished');

    await tail.whenConnected();
    const seen: string[] = [];
    const consume = (async () => {
      for await (const event of tail) seen.push(event.type);
    })();
    await Promise.race([
      consume,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('tail did not terminate for finished workflow')), 1000),
      ),
    ]);

    // The synthesizer emits the terminal event for the already-finished
    // workflow, so the tail delivers it once and then ends — it must terminate
    // rather than hang waiting for live frames that will never arrive.
    expect(seen).toEqual(['workflow:completed']);
  });

  it('close() before iteration stops the tail cleanly', async () => {
    const handle = new FakeWorkflowHandle();
    const tail = createLocalWorkflowEventTail(fakeEngine(handle), 'wf-close');

    await tail.whenConnected();
    tail.close();

    const seen: string[] = [];
    for await (const event of tail) seen.push(event.type);
    expect(seen).toEqual([]);
  });

  it('whenConnected() resolves on close even while the catch-up fetch is still pending', async () => {
    // Regression (Copilot follow-up): the contract says whenConnected resolves
    // when the tail terminates. close() must settle it rather than leave the
    // caller hanging on a never-resolving getEvents.
    const handle = new FakeWorkflowHandle();
    const neverResolves = new Promise<void>(() => {});
    const tail = createLocalWorkflowEventTail(
      fakeEngine(handle, { gate: neverResolves }),
      'wf-close-pending',
    );

    tail.close();
    // Must resolve (from close), not hang on the gated fetch.
    await Promise.race([
      tail.whenConnected(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('whenConnected hung after close')), 1000),
      ),
    ]);
  });

  it('close() while idle terminates the tail promptly (pump does not hang)', async () => {
    // Regression (Cursor Bugbot follow-up): if the engine iterator is parked with
    // no events arriving, close() must unblock the pump (it races next() against a
    // close signal) so iteration ends rather than hanging on a next() that never
    // settles.
    const handle = new FakeWorkflowHandle();
    const tail = createLocalWorkflowEventTail(fakeEngine(handle), 'wf-idle-close');

    await tail.whenConnected();
    // No events have been (or will be) dispatched; the pump is parked. Begin
    // iterating, then close — the iteration must end promptly.
    const seen: string[] = [];
    const consume = (async () => {
      for await (const e of tail) seen.push(e.type);
    })();
    tail.close();
    await Promise.race([
      consume,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('idle close did not terminate iteration')), 1000),
      ),
    ]);
    expect(seen).toEqual([]);
  });

  it('replays persisted history on connect (events emitted before the tail opened)', async () => {
    // Regression (Copilot follow-up): the local tail must replay persisted
    // history like the HTTP tail, so a tail opened after events were already
    // persisted still delivers them. The unified tail contract promises both
    // transports deliver the same records.
    const handle = new FakeWorkflowHandle();
    const tail = createLocalWorkflowEventTail(
      fakeEngine(handle, {
        history: [event('workflow:started'), event('activity:started'), event('signal:received')],
      }),
      'wf-history',
    );

    await tail.whenConnected();
    // A live terminal frame after catch-up ends the tail.
    handle.dispatchEvent(new WorkflowCompletedEvent('wf-history', 'ok', 1));

    const seen = await drain(tail);
    expect(seen).toEqual([
      'workflow:started',
      'activity:started',
      'signal:received',
      'workflow:completed',
    ]);
  });

  it('dedups the overlap between replayed history and buffered live frames', async () => {
    // History already contains the live frame that lands during the fetch, so it
    // must be delivered exactly once. The fetch is gated so the frame is provably
    // buffered in #pendingLive before catch-up drains. The history record's `data`
    // matches how `serializeEngineEvent` renders a live SignalReceivedEvent (own
    // props minus `type`; `payload: undefined` dropped by JSON; the DOM Event base
    // contributes `isTrusted`), so the overlap is recognized.
    const handle = new FakeWorkflowHandle();
    const fetchStarted = Promise.withResolvers<void>();
    const releaseFetch = Promise.withResolvers<void>();
    const tail = createLocalWorkflowEventTail(
      fakeEngine(handle, {
        history: [
          event('workflow:started'),
          event('signal:received', { workflowId: 'wf-overlap', signalName: 'a', isTrusted: false }),
        ],
        onFetchStart: () => fetchStarted.resolve(),
        gate: releaseFetch.promise,
      }),
      'wf-overlap',
    );

    // Wait until the catch-up fetch is in flight, then dispatch the overlapping
    // live frame (buffered in #pendingLive) plus a genuinely new completion.
    await fetchStarted.promise;
    handle.dispatchEvent(new SignalReceivedEvent('wf-overlap', 'a', undefined));
    handle.dispatchEvent(new WorkflowCompletedEvent('wf-overlap', 'ok', 1));
    // Let the pump cycle the dispatched events into #pendingLive before the
    // catch-up drains (the engine iterator delivers them across microtasks).
    await sleepForTesting(5);
    releaseFetch.resolve();

    const seen = await drain(tail);
    // The overlapping signal appears once (deduped), the new completion once.
    expect(seen.filter((t) => t === 'signal:received')).toHaveLength(1);
    expect(seen).toContain('workflow:started');
    expect(seen).toContain('workflow:completed');
  });

  it('does not drop a legitimate repeated signal delivered after catch-up', async () => {
    // Regression (Copilot follow-up): the post-catch-up path must NOT keep
    // deduping against history. A signal identical to one already in the
    // replayed history, but delivered as a fresh live event after whenConnected,
    // is a genuinely new occurrence and must be delivered — not dropped as a
    // false overlap (the HTTP tail only dedups the in-flight fetch window).
    const handle = new FakeWorkflowHandle();
    const tail = createLocalWorkflowEventTail(
      fakeEngine(handle, {
        history: [
          event('signal:received', {
            workflowId: 'wf-repeat',
            signalName: 'tick',
            isTrusted: false,
          }),
        ],
      }),
      'wf-repeat',
    );

    await tail.whenConnected();
    // A fresh, identical signal AFTER catch-up — must be delivered, not deduped.
    handle.dispatchEvent(new SignalReceivedEvent('wf-repeat', 'tick', undefined));
    handle.dispatchEvent(new WorkflowCompletedEvent('wf-repeat', 'ok', 1));

    const seen = await drain(tail);
    // Two signal:received: one replayed from history, one fresh live repeat.
    expect(seen.filter((t) => t === 'signal:received')).toHaveLength(2);
    expect(seen).toContain('workflow:completed');
  });

  it('survives a failed history fetch and still delivers live frames', async () => {
    const handle = new FakeWorkflowHandle();
    const tail = createLocalWorkflowEventTail(
      fakeEngine(handle, { getEventsError: new Error('history unavailable') }),
      'wf-history-fail',
    );

    await tail.whenConnected();
    handle.dispatchEvent(new SignalReceivedEvent('wf-history-fail', 'ping', undefined));
    handle.dispatchEvent(new WorkflowCompletedEvent('wf-history-fail', 'ok', 1));

    const seen = await drain(tail);
    expect(seen).toEqual(['signal:received', 'workflow:completed']);
  });

  it('terminates from history alone when the persisted log ends with a terminal event', async () => {
    const handle = new FakeWorkflowHandle();
    const tail = createLocalWorkflowEventTail(
      fakeEngine(handle, {
        history: [event('workflow:started'), event('workflow:completed', { result: 'done' })],
      }),
      'wf-history-terminal',
    );

    const seen = await drain(tail);
    expect(seen).toEqual(['workflow:started', 'workflow:completed']);
  });
});

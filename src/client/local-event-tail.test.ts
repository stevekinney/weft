import { describe, expect, it } from 'bun:test';
import type { Engine } from '../core/engine.ts';
import { createWorkflowHandleEventIterator } from '../core/engine/handle-iteration.ts';
import { SignalReceivedEvent, WorkflowCompletedEvent } from '../core/events.ts';
import type { WorkflowState } from '../core/types.ts';
import { createLocalWorkflowEventTail } from './local-event-tail.ts';

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

function fakeEngine(handle: FakeWorkflowHandle): Engine {
  // The local tail only calls `engine.getHandle(id)`; everything else is unused.
  // A test-only structural stand-in is sufficient and keeps the test focused on
  // the eager-attach behavior rather than spinning a full engine.
  return { getHandle: () => handle } as unknown as Engine;
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
});

import { describe, expect, it } from 'bun:test';

import { encodeCursor } from "../embedded/backchannel/src/index.ts";
import { createInMemoryEventBackend } from './in-memory-event-feed-backend.test-support.ts';
import { type EventEnvelope } from './workflow-event-feed.ts';

function envelope(sequence: number): EventEnvelope {
  return {
    kind: 'workflow:started',
    workflowId: 'wf-1',
    selector: 'events',
    sequence,
    cursor: encodeCursor(sequence),
    emittedAtMs: 1,
    payload: { type: 'started' },
  };
}

describe('createInMemoryEventBackend live delivery', () => {
  it('keeps delivering to later subscribers and finishes the append when a listener throws', async () => {
    const backend = createInMemoryEventBackend();
    const delivered: number[] = [];
    backend.subscribeLive('wf-1', 'events', () => {
      throw new Error('listener failed');
    });
    backend.subscribeLive('wf-1', 'events', (item) => delivered.push(item.sequence));

    await backend.append(envelope(0));
    await backend.emitLive(envelope(1));

    expect(delivered).toEqual([0, 1]);
    expect(await backend.snapshotTailSequence('wf-1', 'events')).toBe(0);
  });

  it('stops delivering to a listener once it unsubscribes', async () => {
    const backend = createInMemoryEventBackend();
    const delivered: number[] = [];
    const unsubscribe = backend.subscribeLive('wf-1', 'events', (item) =>
      delivered.push(item.sequence),
    );

    await backend.emitLive(envelope(0));
    unsubscribe();
    await backend.emitLive(envelope(1));

    expect(delivered).toEqual([0]);
  });
});

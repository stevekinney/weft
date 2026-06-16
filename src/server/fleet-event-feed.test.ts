import { describe, expect, it } from 'bun:test';

import { encode } from '../core/codec.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { createFleetEventFeed, type FleetEventEnvelope } from './fleet-event-feed.ts';

class FailingTailReadStorage extends MemoryStorage {
  failNextTailRead = true;

  override async get(key: string): Promise<Uint8Array | null> {
    if (key === KEYS.fleetEventTail() && this.failNextTailRead) {
      this.failNextTailRead = false;
      throw new Error('tail read failed');
    }
    return super.get(key);
  }
}

async function collect(
  iterable: AsyncIterable<FleetEventEnvelope>,
  limit: number,
): Promise<FleetEventEnvelope[]> {
  const results: FleetEventEnvelope[] = [];
  for await (const envelope of iterable) {
    results.push(envelope);
    if (results.length >= limit) break;
  }
  return results;
}

describe('createFleetEventFeed', () => {
  it('replays persisted fleet events after the supplied cursor', async () => {
    const feed = createFleetEventFeed(new MemoryStorage());
    await feed.append({
      kind: 'workflow:started',
      workflowId: 'wf-a',
      emittedAtMs: 1,
      payload: { workflowId: 'wf-a' },
    });
    const second = await feed.append({
      kind: 'workflow:completed',
      workflowId: 'wf-b',
      emittedAtMs: 2,
      payload: { workflowId: 'wf-b' },
    });

    const replayed = await collect(feed.replay({ fromCursor: '0' }), 10);

    expect(replayed).toEqual([second]);
    expect(second.sequence).toBe(1);
    expect(second.cursor).toBe('1');
  });

  it('subscribes with replay then live events under one cursor space', async () => {
    const feed = createFleetEventFeed(new MemoryStorage());
    await feed.append({
      kind: 'workflow:started',
      workflowId: 'wf-a',
      emittedAtMs: 1,
      payload: { workflowId: 'wf-a' },
    });

    const controller = new AbortController();
    const subscription = collect(feed.subscribe({ signal: controller.signal }), 2);
    await feed.append({
      kind: 'workflow:completed',
      workflowId: 'wf-b',
      emittedAtMs: 2,
      payload: { workflowId: 'wf-b' },
    });

    const envelopes = await subscription;
    controller.abort();

    expect(envelopes.map((envelope) => envelope.workflowId)).toEqual(['wf-a', 'wf-b']);
    expect(envelopes.map((envelope) => envelope.sequence)).toEqual([0, 1]);
  });

  it('recovers the next sequence from event keys when the tail marker is malformed', async () => {
    const storage = new MemoryStorage();
    await storage.put(
      KEYS.fleetEvent(4),
      encode({
        kind: 'workflow:started',
        workflowId: 'wf-existing',
        sequence: 4,
        cursor: '4',
        emittedAtMs: 1,
        payload: { workflowId: 'wf-existing' },
      }),
    );
    await storage.put(KEYS.fleetEventTail(), encode({ sequence: 'not-a-number' }));

    const feed = createFleetEventFeed(storage);
    const appended = await feed.append({
      kind: 'workflow:completed',
      workflowId: 'wf-new',
      emittedAtMs: 2,
      payload: { workflowId: 'wf-new' },
    });

    expect(appended.sequence).toBe(5);
    expect(appended.cursor).toBe('5');
    feed.dispose();
  });

  it('resets sequence initialization after a transient tail read failure', async () => {
    const storage = new FailingTailReadStorage();
    const feed = createFleetEventFeed(storage);

    await expect(
      feed.append({
        kind: 'workflow:started',
        workflowId: 'wf-fail',
        emittedAtMs: 1,
        payload: { workflowId: 'wf-fail' },
      }),
    ).rejects.toThrow('tail read failed');

    const appended = await feed.append({
      kind: 'workflow:started',
      workflowId: 'wf-recovered',
      emittedAtMs: 2,
      payload: { workflowId: 'wf-recovered' },
    });

    expect(appended.sequence).toBe(0);
    expect(appended.cursor).toBe('0');
    feed.dispose();
  });

  it('falls back to fleet event keys when the tail marker cannot be decoded', async () => {
    const storage = new MemoryStorage();
    await storage.put(
      KEYS.fleetEvent(2),
      encode({
        kind: 'workflow:started',
        workflowId: 'wf-existing',
        sequence: 2,
        cursor: '2',
        emittedAtMs: 1,
        payload: { workflowId: 'wf-existing' },
      }),
    );
    await storage.put(KEYS.fleetEventTail(), new Uint8Array([0xc1]));

    const feed = createFleetEventFeed(storage);
    const appended = await feed.append({
      kind: 'workflow:completed',
      workflowId: 'wf-new',
      emittedAtMs: 2,
      payload: { workflowId: 'wf-new' },
    });

    expect(appended.sequence).toBe(3);
    expect(appended.cursor).toBe('3');
    feed.dispose();
  });
});

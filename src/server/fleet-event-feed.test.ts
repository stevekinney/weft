import { describe, expect, it } from 'bun:test';

import { encode } from '../core/codec.ts';
import { KEYS, type BatchOperation, type ScanOptions } from '../storage/interface.ts';
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

class FailingFleetBatchStorage extends MemoryStorage {
  failNextFleetBatch = true;

  override async batch(operations: BatchOperation[]): Promise<void> {
    if (
      this.failNextFleetBatch &&
      operations.some((operation) => operation.key.startsWith(KEYS.fleetEventPrefix()))
    ) {
      this.failNextFleetBatch = false;
      throw new Error('fleet batch failed');
    }
    await super.batch(operations);
  }
}

class RecordingScanStorage extends MemoryStorage {
  readonly scanCalls: Array<{ prefix: string; options: ScanOptions | undefined }> = [];

  override scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]> {
    this.scanCalls.push({ prefix, options });
    return super.scan(prefix, options);
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

  it('indexes workflow-owned fleet events for purge', async () => {
    const storage = new MemoryStorage();
    const feed = createFleetEventFeed(storage);
    await feed.append({
      kind: 'workflow:started',
      workflowId: 'wf-indexed',
      emittedAtMs: 1,
      payload: { workflowId: 'wf-indexed' },
    });
    await feed.append({
      kind: 'worker:connected',
      emittedAtMs: 2,
      payload: { workerId: 'worker-a' },
    });

    expect(await storage.get(KEYS.fleetEventByWorkflow('wf-indexed', 0))).not.toBeNull();
    expect(await storage.get(KEYS.fleetEventByWorkflow('wf-indexed', 1))).toBeNull();
    feed.dispose();
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

  it('does not advance the next sequence when durable append fails', async () => {
    const storage = new FailingFleetBatchStorage();
    const feed = createFleetEventFeed(storage);

    await expect(
      feed.append({
        kind: 'workflow:started',
        workflowId: 'wf-fail',
        emittedAtMs: 1,
        payload: { workflowId: 'wf-fail' },
      }),
    ).rejects.toThrow('fleet batch failed');

    const appended = await feed.append({
      kind: 'workflow:started',
      workflowId: 'wf-recovered',
      emittedAtMs: 2,
      payload: { workflowId: 'wf-recovered' },
    });

    expect(appended.sequence).toBe(0);
    expect(appended.cursor).toBe('0');
    await expect(feed.snapshotTailSequence()).resolves.toBe(0);
    feed.dispose();
  });

  it('uses a lower-bound scan when replaying after a cursor', async () => {
    const storage = new RecordingScanStorage();
    const feed = createFleetEventFeed(storage);

    for (let index = 0; index < 5; index += 1) {
      await feed.append({
        kind: 'workflow:started',
        workflowId: `wf-${index}`,
        emittedAtMs: index,
        payload: { workflowId: `wf-${index}` },
      });
    }

    const replayed = await collect(feed.replay({ fromCursor: '2' }), 10);

    expect(replayed.map((envelope) => envelope.sequence)).toEqual([3, 4]);
    expect(storage.scanCalls).toContainEqual({
      prefix: KEYS.fleetEventPrefix(),
      options: { gt: KEYS.fleetEvent(2) },
    });
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

  it('scans past malformed high keys when recovering the tail sequence', async () => {
    const storage = new MemoryStorage();
    await storage.put(
      KEYS.fleetEvent(7),
      encode({
        kind: 'workflow:started',
        workflowId: 'wf-existing',
        sequence: 7,
        cursor: '7',
        emittedAtMs: 1,
        payload: { workflowId: 'wf-existing' },
      }),
    );
    await storage.put(`${KEYS.fleetEventPrefix()}zzzz`, encode({ ignored: true }));
    await storage.put(KEYS.fleetEventTail(), new Uint8Array([0xc1]));

    const feed = createFleetEventFeed(storage);
    const appended = await feed.append({
      kind: 'workflow:completed',
      workflowId: 'wf-new',
      emittedAtMs: 2,
      payload: { workflowId: 'wf-new' },
    });

    expect(appended.sequence).toBe(8);
    expect(appended.cursor).toBe('8');
    feed.dispose();
  });
});

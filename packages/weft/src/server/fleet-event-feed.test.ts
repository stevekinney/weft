import { describe, expect, it } from 'bun:test';

import { encode } from '../core/codec.ts';
import { PersistedDataCorruptError } from '../core/persisted-data-incompatible-error.ts';
import {
  KEYS,
  type BatchOperation,
  type ConditionalBatchCondition,
  type ScanOptions,
} from '../storage/interface.ts';
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

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    if (
      this.failNextFleetBatch &&
      operations.some((operation) => operation.key.startsWith(KEYS.fleetEventPrefix()))
    ) {
      this.failNextFleetBatch = false;
      throw new Error('fleet batch failed');
    }
    return super.conditionalBatch(conditions, operations);
  }
}

class FailingVirginSentinelStorage extends MemoryStorage {
  failNextSentinelWrite = true;

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    const tailCondition = conditions.find(
      (condition) => condition.key === KEYS.fleetEventTail() && condition.expectedValue === null,
    );
    if (
      tailCondition !== undefined &&
      this.failNextSentinelWrite &&
      operations.some((operation) => operation.key === KEYS.fleetEventTail())
    ) {
      this.failNextSentinelWrite = false;
      throw new Error('sentinel persist failed');
    }
    return super.conditionalBatch(conditions, operations);
  }
}

class RecordingScanStorage extends MemoryStorage {
  readonly scanCalls: Array<{ prefix: string; options: ScanOptions | undefined }> = [];

  override scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]> {
    this.scanCalls.push({ prefix, options });
    return super.scan(prefix, options);
  }
}

class PurgingConditionalBatchStorage extends MemoryStorage {
  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    const workflowCondition = conditions.find(
      (condition) => condition.key === KEYS.workflow('wf-race'),
    );
    if (workflowCondition !== undefined) {
      await super.delete(workflowCondition.key);
    }
    return super.conditionalBatch(conditions, operations);
  }
}

class UpdatingConditionalBatchStorage extends MemoryStorage {
  conditionalBatchCalls = 0;

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    this.conditionalBatchCalls += 1;
    const workflowCondition = conditions.find(
      (condition) => condition.key === KEYS.workflow('wf-updated'),
    );
    if (workflowCondition !== undefined && this.conditionalBatchCalls === 1) {
      await super.put(workflowCondition.key, encode({ status: 'running', step: 1 }));
    }
    return super.conditionalBatch(conditions, operations);
  }
}

class ContendedConditionalBatchStorage extends MemoryStorage {
  conditionalBatchCalls = 0;

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    const workflowCondition = conditions.find(
      (condition) => condition.key === KEYS.workflow('wf-contended'),
    );
    if (workflowCondition !== undefined) {
      this.conditionalBatchCalls += 1;
      return false;
    }
    return super.conditionalBatch(conditions, operations);
  }
}

class AdvancingTailDuringScanStorage extends MemoryStorage {
  advanceOnNextReverseScan = false;

  override async *scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]> {
    if (prefix === KEYS.fleetEventPrefix() && options?.reverse && this.advanceOnNextReverseScan) {
      this.advanceOnNextReverseScan = false;
      const envelope = {
        kind: 'worker:connected',
        sequence: 1,
        cursor: '1',
        emittedAtMs: 1,
        payload: { workerId: 'racing-worker' },
      };
      await super.conditionalBatch(
        [{ key: KEYS.fleetEventTail(), expectedValue: encode({ sequence: 0 }) }],
        [
          { type: 'put', key: KEYS.fleetEvent(1), value: encode(envelope) },
          { type: 'put', key: KEYS.fleetEventTail(), value: encode({ sequence: 1 }) },
        ],
      );
    }
    yield* super.scan(prefix, options);
  }
}

class CommittingFirstEventDuringScanStorage extends MemoryStorage {
  commitOnNextReverseScan = true;

  override async *scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]> {
    if (prefix === KEYS.fleetEventPrefix() && options?.reverse && this.commitOnNextReverseScan) {
      this.commitOnNextReverseScan = false;
      const envelope = {
        kind: 'worker:connected',
        sequence: 0,
        cursor: '0',
        emittedAtMs: 0,
        payload: { workerId: 'racing-worker' },
      };
      await super.conditionalBatch(
        [{ key: KEYS.fleetEventTail(), expectedValue: null }],
        [
          { type: 'put', key: KEYS.fleetEvent(0), value: encode(envelope) },
          { type: 'put', key: KEYS.fleetEventTail(), value: encode({ sequence: 0 }) },
        ],
      );
    }
    yield* super.scan(prefix, options);
  }
}

class LosingFirstRetentionBatchStorage extends MemoryStorage {
  loseNextRetentionBatch = true;

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    if (
      this.loseNextRetentionBatch &&
      conditions.some((condition) => condition.key === KEYS.fleetEventWatermark())
    ) {
      this.loseNextRetentionBatch = false;
      await super.batch([
        { type: 'delete', key: KEYS.fleetEvent(0) },
        {
          type: 'put',
          key: KEYS.fleetEventWatermark(),
          value: encode({ firstRetainedSequence: 1 }),
        },
      ]);
      return false;
    }
    return super.conditionalBatch(conditions, operations);
  }
}

class ContendedRetentionStorage extends MemoryStorage {
  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    if (conditions.some((condition) => condition.key === KEYS.fleetEventWatermark())) return false;
    return super.conditionalBatch(conditions, operations);
  }
}

class NonConditionalStorage extends MemoryStorage {
  override capabilities(): ReturnType<MemoryStorage['capabilities']> {
    return { ...super.capabilities(), conditionalBatch: false };
  }
}

class RetainingDuringReplayStorage extends MemoryStorage {
  retainOnNextForwardScan = false;

  override async *scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]> {
    if (prefix === KEYS.fleetEventPrefix() && !options?.reverse && this.retainOnNextForwardScan) {
      this.retainOnNextForwardScan = false;
      await super.conditionalBatch(
        [{ key: KEYS.fleetEventWatermark(), expectedValue: null }],
        [
          { type: 'delete', key: KEYS.fleetEvent(0) },
          {
            type: 'put',
            key: KEYS.fleetEventWatermark(),
            value: encode({ firstRetainedSequence: 1 }),
          },
        ],
      );
    }
    yield* super.scan(prefix, options);
  }
}

class RetainingBetweenWorkflowIndexScanAndEventReadStorage extends MemoryStorage {
  retainOnNextEventRead = false;

  override async get(key: string): Promise<Uint8Array | null> {
    if (key === KEYS.fleetEvent(0) && this.retainOnNextEventRead) {
      this.retainOnNextEventRead = false;
      await super.conditionalBatch(
        [{ key: KEYS.fleetEventWatermark(), expectedValue: null }],
        [
          { type: 'delete', key: KEYS.fleetEvent(0) },
          { type: 'delete', key: KEYS.fleetEventByWorkflow('wf-race', 0) },
          {
            type: 'put',
            key: KEYS.fleetEventWatermark(),
            value: encode({ firstRetainedSequence: 1 }),
          },
        ],
      );
    }
    return super.get(key);
  }
}

class CorruptingEventWithoutIndexStorage extends MemoryStorage {
  corruptOnNextEventRead = false;

  override async get(key: string): Promise<Uint8Array | null> {
    if (key === KEYS.fleetEvent(0) && this.corruptOnNextEventRead) {
      this.corruptOnNextEventRead = false;
      // Delete ONLY the event record, leaving its by-workflow index entry in
      // place — unlike retain()/purge(), which always delete both keys
      // atomically, this is a torn write neither legitimate deleter could
      // produce: genuine corruption, not a benign concurrent deletion.
      await super.delete(KEYS.fleetEvent(0));
    }
    return super.get(key);
  }
}

class PurgingBetweenWorkflowIndexScanAndEventReadStorage extends MemoryStorage {
  purgeOnNextEventRead = false;

  override async get(key: string): Promise<Uint8Array | null> {
    if (key === KEYS.fleetEvent(0) && this.purgeOnNextEventRead) {
      this.purgeOnNextEventRead = false;
      // Mimic Engine.purge() (addWorkflowLinkedFleetEventDeleteKeys in
      // core/engine/bulk-operations-purge.ts): it deletes a fleet event and
      // its by-workflow index entry together in one atomic batch, but unlike
      // retain(), purge never writes fleetEventWatermark — grep confirms it
      // has no reference to that key.
      await super.batch([
        { type: 'delete', key: KEYS.fleetEvent(0) },
        { type: 'delete', key: KEYS.fleetEventByWorkflow('wf-purged', 0) },
      ]);
    }
    return super.get(key);
  }
}

class UnstableWatermarkStorage extends MemoryStorage {
  watermarkReads = 0;

  override async get(key: string): Promise<Uint8Array | null> {
    if (key === KEYS.fleetEventWatermark()) {
      this.watermarkReads += 1;
      return encode({ firstRetainedSequence: this.watermarkReads });
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

async function nextEnvelope(
  iterator: AsyncIterator<FleetEventEnvelope>,
): Promise<FleetEventEnvelope> {
  const result = await iterator.next();
  if (result.done) throw new Error('Fleet event subscription ended unexpectedly.');
  return result.value;
}

describe('createFleetEventFeed', () => {
  it('allocates one ordered sequence across concurrent feed instances', async () => {
    const storage = new MemoryStorage();
    const first = createFleetEventFeed(storage);
    const second = createFleetEventFeed(storage);
    const events = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 === 0 ? first : second).append({
          kind: 'worker:connected',
          emittedAtMs: index,
          payload: { index },
        }),
      ),
    );

    expect(events.map((event) => event.sequence).toSorted((left, right) => left - right)).toEqual(
      Array.from({ length: 20 }, (_, index) => index),
    );
    expect(await first.snapshotTailSequence()).toBe(19);
    first.dispose();
    second.dispose();
  });

  it('serializes large same-process append bursts before durable allocation', async () => {
    const feed = createFleetEventFeed(new MemoryStorage());
    const events = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        feed.append({ kind: 'worker:connected', emittedAtMs: index, payload: { index } }),
      ),
    );

    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 100 }, (_, index) => index),
    );
    feed.dispose();
  });

  it('retries when another process advances the tail during authority validation', async () => {
    const storage = new AdvancingTailDuringScanStorage();
    await storage.put(
      KEYS.fleetEvent(0),
      encode({
        kind: 'worker:connected',
        sequence: 0,
        cursor: '0',
        emittedAtMs: 0,
        payload: { workerId: 'first-worker' },
      }),
    );
    await storage.put(KEYS.fleetEventTail(), encode({ sequence: 0 }));
    storage.advanceOnNextReverseScan = true;
    const feed = createFleetEventFeed(storage);

    const appended = await feed.append({
      kind: 'worker:connected',
      emittedAtMs: 2,
      payload: { workerId: 'third-worker' },
    });

    expect(appended.sequence).toBe(2);
    const replayed = await collect(feed.replay(), 10);
    expect(replayed.map((event) => event.sequence)).toEqual([0, 1, 2]);
    feed.dispose();
  });

  it('retries when another process wins the first append race', async () => {
    const storage = new CommittingFirstEventDuringScanStorage();
    const feed = createFleetEventFeed(storage);

    const appended = await feed.append({
      kind: 'worker:connected',
      emittedAtMs: 1,
      payload: { workerId: 'second-worker' },
    });

    expect(appended.sequence).toBe(1);
    const replayed = await collect(feed.replay(), 10);
    expect(replayed.map((event) => event.sequence)).toEqual([0, 1]);
    feed.dispose();
  });

  it('restarts replay when retention advances after the initial floor read', async () => {
    const storage = new RetainingDuringReplayStorage();
    const feed = createFleetEventFeed(storage);
    await feed.append({ kind: 'worker:connected', emittedAtMs: 0, payload: { index: 0 } });
    await feed.append({ kind: 'worker:connected', emittedAtMs: 1, payload: { index: 1 } });
    storage.retainOnNextForwardScan = true;

    const replayed = await collect(feed.replay({ fromCursor: '-1' }), 10);

    expect(replayed.map((event) => event.kind)).toEqual(['fleet:gap', 'worker:connected']);
    expect(replayed.map((event) => event.sequence)).toEqual([0, 1]);
    feed.dispose();
  });

  it('settles an idle durable subscription when the feed is disposed', async () => {
    const feed = createFleetEventFeed(new MemoryStorage(), { livePollIntervalMs: 60_000 });
    const iterator = feed.subscribe()[Symbol.asyncIterator]();
    const pending = iterator.next();

    await Promise.resolve();
    feed.dispose();

    expect(pending).resolves.toEqual({ done: true, value: undefined });
  });

  it('commits caller-owned operations with the matching event', async () => {
    const storage = new MemoryStorage();
    const feed = createFleetEventFeed(storage);
    const stateKey = 'app:state';
    const state = new TextEncoder().encode('next');
    const event = await feed.append(
      { kind: 'worker:connected', emittedAtMs: 1, payload: { state: 'next' } },
      {
        conditions: [{ key: stateKey, expectedValue: null }],
        operations: [{ type: 'put', key: stateKey, value: state }],
      },
    );

    expect(await storage.get(stateKey)).toEqual(state);
    const replayed = await collect(feed.replay(), 1);
    expect(replayed[0]).toEqual(event);
    feed.dispose();
  });

  it('advances a bounded retention floor and reports stale cursors explicitly', async () => {
    const storage = new MemoryStorage();
    const feed = createFleetEventFeed(storage);
    for (let index = 0; index < 4; index += 1) {
      await feed.append({
        kind: 'workflow:completed',
        workflowId: `wf-${index}`,
        emittedAtMs: index,
        payload: { index },
      });
    }
    expect(await feed.snapshotRetentionFloor()).toBe(0);
    expect(await feed.retain({ beforeSequence: 2, limit: 10 })).toBe(2);
    expect(await feed.snapshotRetentionFloor()).toBe(2);
    expect(await storage.get(KEYS.fleetEventByWorkflow('wf-0', 0))).toBeNull();
    expect(await storage.get(KEYS.fleetEventByWorkflow('wf-1', 1))).toBeNull();
    expect(await storage.get(KEYS.fleetEventByWorkflow('wf-2', 2))).not.toBeNull();
    const replayed = await collect(feed.replay({ fromCursor: '-1' }), 10);
    expect(replayed[0]?.kind).toBe('fleet:gap');
    expect(replayed[0]?.sequence).toBe(1);
    expect(replayed[0]?.cursor).toBe('1');
    expect(replayed[0]?.payload).toEqual({ requestedCursor: '-1', firstRetainedSequence: 2 });
    expect(replayed.slice(1).map((event) => event.sequence)).toEqual([2, 3]);
    expect(await feed.retain({ beforeSequence: 3, limit: 10 })).toBe(1);
    feed.dispose();
  });

  it('preserves the opaque requested cursor in a retention gap', async () => {
    const feed = createFleetEventFeed(new MemoryStorage());
    for (let index = 0; index < 3; index += 1) {
      await feed.append({ kind: 'worker:connected', emittedAtMs: index, payload: { index } });
    }
    await feed.retain({ beforeSequence: 2 });

    const [gap] = await collect(feed.replay({ fromCursor: '0000' }), 1);

    expect(gap?.kind).toBe('fleet:gap');
    expect(gap?.payload).toEqual({ requestedCursor: '0000', firstRetainedSequence: 2 });
    feed.dispose();
  });

  it('retries retention after another process advances the watermark', async () => {
    const storage = new LosingFirstRetentionBatchStorage();
    const feed = createFleetEventFeed(storage);
    for (let index = 0; index < 3; index += 1) {
      await feed.append({ kind: 'worker:connected', emittedAtMs: index, payload: { index } });
    }

    expect(feed.retain({ beforeSequence: 3, limit: 10 })).resolves.toBe(2);
    expect(feed.snapshotRetentionFloor()).resolves.toBe(3);
    feed.dispose();
  });

  it('fails loudly when retention contention exhausts its retry budget', async () => {
    const feed = createFleetEventFeed(new ContendedRetentionStorage());
    await feed.append({ kind: 'worker:connected', emittedAtMs: 0, payload: {} });

    expect(feed.retain({ beforeSequence: 1 })).rejects.toThrow(
      'lost its storage precondition after 25 attempts',
    );
    feed.dispose();
  });

  it('rejects storage that cannot provide conditional batches', () => {
    expect(() => createFleetEventFeed(new NonConditionalStorage())).toThrow(
      'require storage with conditional batch support',
    );
  });

  it('rejects the reserved retention-gap event kind', async () => {
    const feed = createFleetEventFeed(new MemoryStorage());
    expect(feed.append({ kind: 'fleet:gap', emittedAtMs: 0, payload: {} })).rejects.toThrow(
      'reserved',
    );
    feed.dispose();
  });

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

  it('replays large histories in bounded storage pages', async () => {
    const storage = new RecordingScanStorage();
    const feed = createFleetEventFeed(storage);
    for (let index = 0; index < 260; index += 1) {
      await feed.append({ kind: 'worker:connected', emittedAtMs: index, payload: { index } });
    }

    const replayed = await collect(feed.replay(), 300);
    expect(replayed).toHaveLength(260);
    const replayScans = storage.scanCalls.filter(
      ({ prefix, options }) => prefix === KEYS.fleetEventPrefix() && !options?.reverse,
    );
    expect(replayScans).toHaveLength(3);
    expect(replayScans.every(({ options }) => options?.limit === 128)).toBeTrue();
    feed.dispose();
  });

  it('recovers appends during replay from durable storage without live-buffer overflow', async () => {
    const feed = createFleetEventFeed(new MemoryStorage());
    for (let index = 0; index < 129; index += 1) {
      await feed.append({ kind: 'worker:connected', emittedAtMs: index, payload: { index } });
    }
    const controller = new AbortController();
    const iterator = feed.subscribe({ signal: controller.signal })[Symbol.asyncIterator]();
    const received = [await nextEnvelope(iterator)];
    for (let index = 129; index < 132; index += 1) {
      await feed.append({ kind: 'worker:connected', emittedAtMs: index, payload: { index } });
    }
    while (received.length < 132) received.push(await nextEnvelope(iterator));

    expect(received.map((event) => event.sequence)).toEqual(
      Array.from({ length: 132 }, (_, index) => index),
    );
    controller.abort();
    await iterator.return?.();
    feed.dispose();
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

  it('appends a workflow-owned event only while the workflow record still exists', async () => {
    const storage = new MemoryStorage();
    await storage.put(KEYS.workflow('wf-present'), encode({ status: 'running' }));
    const feed = createFleetEventFeed(storage);

    const appended = await feed.appendWorkflowEventIfPresent({
      kind: 'workflow:started',
      workflowId: 'wf-present',
      emittedAtMs: 1,
      payload: { workflowId: 'wf-present' },
    });
    const dropped = await feed.appendWorkflowEventIfPresent({
      kind: 'workflow:completed',
      workflowId: 'wf-missing',
      emittedAtMs: 2,
      payload: { workflowId: 'wf-missing' },
    });

    expect(appended?.sequence).toBe(0);
    expect(dropped).toBeNull();
    expect(await storage.get(KEYS.fleetEvent(0))).not.toBeNull();
    expect(await storage.get(KEYS.fleetEvent(1))).toBeNull();
    feed.dispose();
  });

  it('drops a workflow-owned append when purge wins the conditional batch race', async () => {
    const storage = new PurgingConditionalBatchStorage();
    await storage.put(KEYS.workflow('wf-race'), encode({ status: 'running' }));
    const feed = createFleetEventFeed(storage);

    const appended = await feed.appendWorkflowEventIfPresent({
      kind: 'workflow:completed',
      workflowId: 'wf-race',
      emittedAtMs: 1,
      payload: { workflowId: 'wf-race' },
    });

    expect(appended).toBeNull();
    expect(await storage.get(KEYS.fleetEvent(0))).toBeNull();
    expect(await storage.get(KEYS.fleetEventByWorkflow('wf-race', 0))).toBeNull();
    feed.dispose();
  });

  it('retries a workflow-owned append when the workflow record changes before commit', async () => {
    const storage = new UpdatingConditionalBatchStorage();
    await storage.put(KEYS.workflow('wf-updated'), encode({ status: 'running', step: 0 }));
    const feed = createFleetEventFeed(storage);

    const appended = await feed.appendWorkflowEventIfPresent({
      kind: 'workflow:completed',
      workflowId: 'wf-updated',
      emittedAtMs: 1,
      payload: { workflowId: 'wf-updated' },
    });

    expect(storage.conditionalBatchCalls).toBe(2);
    expect(appended?.sequence).toBe(0);
    expect(await storage.get(KEYS.fleetEvent(0))).not.toBeNull();
    expect(await storage.get(KEYS.fleetEventByWorkflow('wf-updated', 0))).not.toBeNull();
    expect(await storage.get(KEYS.fleetEvent(1))).toBeNull();
    feed.dispose();
  });

  it('fails loudly without advancing the sequence when workflow-owned append contention persists', async () => {
    const storage = new ContendedConditionalBatchStorage();
    await storage.put(KEYS.workflow('wf-contended'), encode({ status: 'running' }));
    const feed = createFleetEventFeed(storage);

    try {
      expect(
        feed.appendWorkflowEventIfPresent({
          kind: 'workflow:completed',
          workflowId: 'wf-contended',
          emittedAtMs: 1,
          payload: { workflowId: 'wf-contended' },
        }),
      ).rejects.toThrow('lost its storage precondition after 25 attempts');

      expect(storage.conditionalBatchCalls).toBe(25);
      expect(await storage.get(KEYS.workflow('wf-contended'))).not.toBeNull();
      expect(await storage.get(KEYS.fleetEvent(0))).toBeNull();

      const later = await feed.append({
        kind: 'worker:connected',
        emittedAtMs: 2,
        payload: { workerId: 'worker-a' },
      });
      expect(later.sequence).toBe(0);
    } finally {
      feed.dispose();
    }
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

  it('discovers a committed live event appended by another feed instance', async () => {
    const storage = new MemoryStorage();
    const subscriberFeed = createFleetEventFeed(storage, { livePollIntervalMs: 1 });
    const appenderFeed = createFleetEventFeed(storage);
    const controller = new AbortController();
    const subscription = collect(subscriberFeed.subscribe({ signal: controller.signal }), 1);

    await new Promise<void>((resolve) => setImmediate(resolve));
    await appenderFeed.append({
      kind: 'worker:connected',
      emittedAtMs: 1,
      payload: { workerId: 'worker-remote' },
    });

    const [envelope] = await subscription;
    controller.abort();
    expect(envelope).toMatchObject({ sequence: 0, payload: { workerId: 'worker-remote' } });
    subscriberFeed.dispose();
    appenderFeed.dispose();
  });

  it('cancels an idle durable poll without waiting for another append', async () => {
    const feed = createFleetEventFeed(new MemoryStorage(), { livePollIntervalMs: 1 });
    const controller = new AbortController();
    const iterator = feed.subscribe({ signal: controller.signal })[Symbol.asyncIterator]();
    const pending = iterator.next();
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    expect(await pending).toEqual({ done: true, value: undefined });
    feed.dispose();
  });

  it('validates feed and retention bounds', async () => {
    expect(() => createFleetEventFeed(new MemoryStorage(), { livePollIntervalMs: 0 })).toThrow(
      'live poll interval must be positive',
    );
    const feed = createFleetEventFeed(new MemoryStorage());
    expect(feed.retain({ beforeSequence: -1 })).rejects.toThrow(
      'retention sequence must be a non-negative',
    );
    expect(feed.retain({ beforeSequence: 1, limit: 0 })).rejects.toThrow(
      'retention limit must be positive',
    );
    feed.dispose();
  });

  it('reads a valid event tail when the allocator record is absent', async () => {
    const storage = new MemoryStorage();
    await storage.put(
      KEYS.fleetEvent(4),
      encode({
        kind: 'worker:connected',
        sequence: 4,
        cursor: '4',
        emittedAtMs: 1,
        payload: {},
      }),
    );
    const feed = createFleetEventFeed(storage);
    expect(await feed.snapshotTailSequence()).toBe(4);
    expect(feed.append({ kind: 'worker:connected', emittedAtMs: 2, payload: {} })).rejects.toThrow(
      KEYS.fleetEventTail(),
    );
    feed.dispose();
  });

  it('self-heals a virgin feed so only the first snapshot scans storage', async () => {
    const storage = new RecordingScanStorage();
    const feed = createFleetEventFeed(storage);

    expect(await feed.snapshotTailSequence()).toBe(-1);
    const scansAfterFirstCall = storage.scanCalls.length;
    expect(scansAfterFirstCall).toBe(1);
    expect(storage.scanCalls[0]).toEqual({
      prefix: KEYS.fleetEventPrefix(),
      options: { reverse: true, limit: 1 },
    });
    expect(await storage.get(KEYS.fleetEventTail())).not.toBeNull();

    expect(await feed.snapshotTailSequence()).toBe(-1);
    expect(storage.scanCalls.length).toBe(scansAfterFirstCall);

    feed.dispose();
  });

  it('resolves -1 for a virgin feed even when persisting the sentinel throws', async () => {
    const storage = new FailingVirginSentinelStorage();
    const feed = createFleetEventFeed(storage);

    expect(feed.snapshotTailSequence()).resolves.toBe(-1);
    expect(storage.failNextSentinelWrite).toBe(false);
    // The failed write never landed, so the tail key stays absent.
    expect(await storage.get(KEYS.fleetEventTail())).toBeNull();
    // A later call re-scans (nothing was persisted) but still resolves -1.
    expect(feed.snapshotTailSequence()).resolves.toBe(-1);

    feed.dispose();
  });

  it('rejects malformed event keys, retained records, and watermarks', async () => {
    const malformedKeyStorage = new MemoryStorage();
    await malformedKeyStorage.put(`${KEYS.fleetEventPrefix()}bad`, encode({}));
    const malformedKeyFeed = createFleetEventFeed(malformedKeyStorage);
    expect(malformedKeyFeed.snapshotTailSequence()).rejects.toThrow(
      `${KEYS.fleetEventPrefix()}bad`,
    );

    const malformedEventStorage = new MemoryStorage();
    await malformedEventStorage.put(KEYS.fleetEvent(0), encode({ sequence: 1 }));
    await malformedEventStorage.put(KEYS.fleetEventTail(), encode({ sequence: 0 }));
    const malformedEventFeed = createFleetEventFeed(malformedEventStorage);
    expect(collect(malformedEventFeed.replay(), 10)).rejects.toThrow(KEYS.fleetEvent(0));
    expect(malformedEventFeed.retain({ beforeSequence: 1 })).rejects.toThrow(KEYS.fleetEvent(0));

    const malformedWatermarkStorage = new MemoryStorage();
    await malformedWatermarkStorage.put(KEYS.fleetEventWatermark(), encode({ floor: 1 }));
    const malformedWatermarkFeed = createFleetEventFeed(malformedWatermarkStorage);
    expect(malformedWatermarkFeed.snapshotRetentionFloor()).rejects.toThrow(
      KEYS.fleetEventWatermark(),
    );
    expect(malformedWatermarkFeed.retain({ beforeSequence: 1 })).rejects.toThrow(
      KEYS.fleetEventWatermark(),
    );
    malformedKeyFeed.dispose();
    malformedEventFeed.dispose();
    malformedWatermarkFeed.dispose();
  });

  it('rejects a stable tail that lags committed event history', async () => {
    const storage = new MemoryStorage();
    await storage.put(
      KEYS.fleetEvent(1),
      encode({
        kind: 'worker:connected',
        sequence: 1,
        cursor: '1',
        emittedAtMs: 1,
        payload: {},
      }),
    );
    await storage.put(KEYS.fleetEventTail(), encode({ sequence: 0 }));
    const feed = createFleetEventFeed(storage);

    expect(feed.append({ kind: 'worker:connected', emittedAtMs: 2, payload: {} })).rejects.toThrow(
      KEYS.fleetEventTail(),
    );
    feed.dispose();
  });

  it('fails loudly when retention never provides a stable replay snapshot', async () => {
    const feed = createFleetEventFeed(new UnstableWatermarkStorage());

    expect(collect(feed.replay(), 10)).rejects.toThrow(
      'could not obtain a stable retention snapshot',
    );
    feed.dispose();
  });

  it('rejects a malformed tail instead of reusing an existing sequence', async () => {
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
    expect(
      feed.append({
        kind: 'workflow:completed',
        workflowId: 'wf-new',
        emittedAtMs: 2,
        payload: { workflowId: 'wf-new' },
      }),
    ).rejects.toThrow('fleet-event-tail');
    expect(await storage.get(KEYS.fleetEvent(5))).toBeNull();
    feed.dispose();
  });

  it('resets sequence initialization after a transient tail read failure', async () => {
    const storage = new FailingTailReadStorage();
    const feed = createFleetEventFeed(storage);

    expect(
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

    expect(
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
    expect(feed.snapshotTailSequence()).resolves.toBe(0);
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
      options: { gt: KEYS.fleetEvent(2), limit: 128 },
    });
    feed.dispose();
  });

  it('replays one workflow through the index and matches a full-replay filter exactly', async () => {
    const feed = createFleetEventFeed(new MemoryStorage());
    const workflowIds = ['wf-alpha', 'wf-beta', 'wf-gamma'];
    for (let index = 0; index < 24; index += 1) {
      const workflowId = workflowIds[index % workflowIds.length];
      await feed.append({
        kind: index % 2 === 0 ? 'workflow:started' : 'workflow:completed',
        // Every third event is fleet-wide (no workflowId) to prove those are excluded.
        ...(index % 3 === 0 ? {} : { workflowId }),
        emittedAtMs: index,
        payload: { index },
      });
    }

    const fullReplay = await collect(feed.replay(), 100);
    for (const workflowId of workflowIds) {
      const expected = fullReplay.filter((envelope) => envelope.workflowId === workflowId);
      const indexed = await collect(feed.replay({ workflowId }), 100);
      expect(indexed).toEqual(expected);
    }
    feed.dispose();
  });

  it('scans only the by-workflow index, never the full fleet-event keyspace', async () => {
    const storage = new RecordingScanStorage();
    const feed = createFleetEventFeed(storage);
    for (let index = 0; index < 12; index += 1) {
      await feed.append({
        kind: 'workflow:started',
        workflowId: index % 2 === 0 ? 'wf-target' : 'wf-other',
        emittedAtMs: index,
        payload: { index },
      });
    }
    storage.scanCalls.length = 0;

    const indexed = await collect(feed.replay({ workflowId: 'wf-target' }), 100);

    expect(indexed).toHaveLength(6);
    expect(indexed.every((envelope) => envelope.workflowId === 'wf-target')).toBeTrue();
    expect(
      storage.scanCalls.some(
        ({ prefix }) => prefix === KEYS.fleetEventByWorkflowPrefix('wf-target'),
      ),
    ).toBeTrue();
    expect(storage.scanCalls.some(({ prefix }) => prefix === KEYS.fleetEventPrefix())).toBeFalse();
    feed.dispose();
  });

  it('resumes an indexed workflow replay from a cursor with a lower-bound scan', async () => {
    const storage = new RecordingScanStorage();
    const feed = createFleetEventFeed(storage);
    for (let index = 0; index < 5; index += 1) {
      await feed.append({
        kind: 'workflow:started',
        workflowId: 'wf-cursor',
        emittedAtMs: index,
        payload: { index },
      });
    }

    const replayed = await collect(feed.replay({ workflowId: 'wf-cursor', fromCursor: '2' }), 10);

    expect(replayed.map((envelope) => envelope.sequence)).toEqual([3, 4]);
    expect(storage.scanCalls).toContainEqual({
      prefix: KEYS.fleetEventByWorkflowPrefix('wf-cursor'),
      options: { gt: KEYS.fleetEventByWorkflow('wf-cursor', 2), limit: 128 },
    });
    feed.dispose();
  });

  it('applies limit to an indexed workflow replay the same way as the unfiltered replay', async () => {
    const feed = createFleetEventFeed(new MemoryStorage());
    for (let index = 0; index < 5; index += 1) {
      await feed.append({
        kind: 'workflow:started',
        workflowId: 'wf-limited',
        emittedAtMs: index,
        payload: { index },
      });
    }

    const replayed = await collect(feed.replay({ workflowId: 'wf-limited' }), 2);

    expect(replayed.map((envelope) => envelope.sequence)).toEqual([0, 1]);
    feed.dispose();
  });

  it('reports the same retention gap for an indexed workflow replay as the unfiltered replay', async () => {
    const feed = createFleetEventFeed(new MemoryStorage());
    for (let index = 0; index < 4; index += 1) {
      await feed.append({
        kind: 'workflow:started',
        workflowId: 'wf-retained',
        emittedAtMs: index,
        payload: { index },
      });
    }
    await feed.retain({ beforeSequence: 2, limit: 10 });

    const indexed = await collect(feed.replay({ workflowId: 'wf-retained', fromCursor: '-1' }), 10);

    expect(indexed[0]?.kind).toBe('fleet:gap');
    expect(indexed[0]?.payload).toEqual({ requestedCursor: '-1', firstRetainedSequence: 2 });
    expect(indexed.slice(1).map((envelope) => envelope.sequence)).toEqual([2, 3]);
    feed.dispose();
  });

  it('fails loudly when retention never provides a stable snapshot for a workflow-scoped replay', async () => {
    const feed = createFleetEventFeed(new UnstableWatermarkStorage());

    expect(collect(feed.replay({ workflowId: 'wf-unstable' }), 10)).rejects.toThrow(
      'could not obtain a stable retention snapshot',
    );
    feed.dispose();
  });

  it('rejects an empty workflowId when replaying the by-workflow index', async () => {
    const feed = createFleetEventFeed(new MemoryStorage());

    expect(collect(feed.replay({ workflowId: '' }), 1)).rejects.toThrow(
      'Fleet event replay workflowId must not be empty.',
    );
    feed.dispose();
  });

  it('rejects a malformed cursor identically whether or not the replay is workflow-scoped', async () => {
    const feed = createFleetEventFeed(new MemoryStorage());

    // The unfiltered path decodes `fromCursor` through the shared
    // `ReplayLiveFeed.replay()` helper in workflow-event-feed.ts; the
    // workflow-scoped path has its own private `decodeCursorOrThrow` in
    // fleet-event-feed.ts. Both must reject the same malformed input with the
    // same error, or "identical cursor semantics" would be an unverified claim.
    expect(collect(feed.replay({ fromCursor: 'not-a-cursor' }), 1)).rejects.toThrow(
      'Invalid cursor',
    );
    expect(
      collect(feed.replay({ workflowId: 'wf-cursor-check', fromCursor: 'not-a-cursor' }), 1),
    ).rejects.toThrow('Invalid cursor');
    feed.dispose();
  });

  it('retries an indexed workflow replay page instead of reporting corruption when retention races the per-event read', async () => {
    const storage = new RetainingBetweenWorkflowIndexScanAndEventReadStorage();
    const feed = createFleetEventFeed(storage);
    await feed.append({
      kind: 'worker:connected',
      workflowId: 'wf-race',
      emittedAtMs: 0,
      payload: { index: 0 },
    });
    await feed.append({
      kind: 'worker:connected',
      workflowId: 'wf-race',
      emittedAtMs: 1,
      payload: { index: 1 },
    });
    storage.retainOnNextEventRead = true;

    const replayed = await collect(feed.replay({ workflowId: 'wf-race', fromCursor: '-1' }), 10);

    expect(replayed.map((event) => event.kind)).toEqual(['fleet:gap', 'worker:connected']);
    expect(replayed.map((event) => event.sequence)).toEqual([0, 1]);
    feed.dispose();
  });

  it('skips a workflow event purged mid-page instead of reporting corruption, with no watermark to lean on', async () => {
    const storage = new PurgingBetweenWorkflowIndexScanAndEventReadStorage();
    const feed = createFleetEventFeed(storage);
    await feed.append({
      kind: 'worker:connected',
      workflowId: 'wf-purged',
      emittedAtMs: 0,
      payload: { index: 0 },
    });
    await feed.append({
      kind: 'worker:connected',
      workflowId: 'wf-purged',
      emittedAtMs: 1,
      payload: { index: 1 },
    });
    storage.purgeOnNextEventRead = true;

    const replayed = await collect(feed.replay({ workflowId: 'wf-purged', fromCursor: '-1' }), 10);

    // Unlike the retention race above, retention never advanced (purge
    // doesn't touch the floor), so there is no fleet:gap — event 0 is just
    // silently absent, exactly as it would be if the by-workflow index scan
    // had simply run a moment later and never seen it at all.
    expect(replayed.map((event) => event.kind)).toEqual(['worker:connected']);
    expect(replayed.map((event) => event.sequence)).toEqual([1]);
    feed.dispose();
  });

  it('reports genuine corruption when a workflow-indexed event is missing but its index entry survives', async () => {
    const storage = new CorruptingEventWithoutIndexStorage();
    const feed = createFleetEventFeed(storage);
    await feed.append({
      kind: 'worker:connected',
      workflowId: 'wf-corrupt',
      emittedAtMs: 0,
      payload: { index: 0 },
    });
    storage.corruptOnNextEventRead = true;

    // Unlike the retention-race and purge-race tests above (where the index
    // entry is also gone, so a missing event reads as a benign concurrent
    // deletion), the by-workflow index for sequence 0 is still present here —
    // no legitimate deleter ever tears those two keys apart, so this must
    // surface as PersistedDataCorruptError rather than being silently
    // skipped.
    expect(
      collect(feed.replay({ workflowId: 'wf-corrupt', fromCursor: '-1' }), 10),
    ).rejects.toThrow(PersistedDataCorruptError);
    feed.dispose();
  });

  it('reports genuine corruption when an indexed event decodes but names a different workflow', async () => {
    const storage = new MemoryStorage();
    const feed = createFleetEventFeed(storage);
    await feed.append({
      kind: 'worker:connected',
      workflowId: 'wf-real-owner',
      emittedAtMs: 0,
      payload: { index: 0 },
    });
    // Plant a phantom by-workflow index entry pointing an UNRELATED workflow
    // at sequence 0 — an index/event pairing no legitimate writer ever
    // produces (append() always writes both keys for the SAME workflowId in
    // one atomic batch). The event at sequence 0 decodes fine, but its own
    // workflowId ("wf-real-owner") disagrees with the index that pointed us
    // here ("wf-phantom-owner").
    await storage.put(KEYS.fleetEventByWorkflow('wf-phantom-owner', 0), new Uint8Array());

    expect(
      collect(feed.replay({ workflowId: 'wf-phantom-owner', fromCursor: '-1' }), 10),
    ).rejects.toThrow(PersistedDataCorruptError);
    feed.dispose();
  });

  it('rejects an undecodable tail instead of overwriting retained history', async () => {
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
    expect(
      feed.append({
        kind: 'workflow:completed',
        workflowId: 'wf-new',
        emittedAtMs: 2,
        payload: { workflowId: 'wf-new' },
      }),
    ).rejects.toThrow('fleet-event-tail');
    expect(await storage.get(KEYS.fleetEvent(3))).toBeNull();
    feed.dispose();
  });

  it('rejects malformed tail authority even when event keys are present', async () => {
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
    expect(
      feed.append({
        kind: 'workflow:completed',
        workflowId: 'wf-new',
        emittedAtMs: 2,
        payload: { workflowId: 'wf-new' },
      }),
    ).rejects.toThrow('fleet-event-tail');
    expect(await storage.get(KEYS.fleetEvent(8))).toBeNull();
    feed.dispose();
  });
});

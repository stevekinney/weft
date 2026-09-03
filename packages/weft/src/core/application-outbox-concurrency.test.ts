/**
 * Concurrency for the durable application delivery outbox (WFT-85): two
 * workers over one storage, fenced claims, stale attempts refused after
 * recovery, concurrent same-key enqueues, contention surfaced as a typed
 * error, and the same fences across every conditional-batch backend.
 */

import { describe, expect, it } from 'bun:test';

import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { storageBackends, teardown } from '../testing/storage-backends.test-support.ts';
import { ApplicationOutboxContentionError } from './application-outbox-internals.ts';
import {
  beginOne,
  claimOne,
  createIdSource,
  createOutboxClock,
  createOutboxFixture,
  deliveryInput,
  enqueueOne,
  fieldOf,
  statusOf,
} from './application-outbox.test-support.ts';
import { ApplicationOutbox } from './application-outbox.ts';

describe('ApplicationOutbox concurrency', () => {
  it('lets exactly one of two workers claim a delivery', async () => {
    const storage = new MemoryStorage();
    const clock = createOutboxClock();
    const left = createOutboxFixture({ storage, clock, generateId: createIdSource('l') }).outbox;
    const right = createOutboxFixture({ storage, clock, generateId: createIdSource('r') }).outbox;
    await enqueueOne(left);
    const results = await Promise.all([left.claim(), right.claim()]);
    expect(results.map((result) => result.status).toSorted()).toEqual(['claimed', 'empty']);
    left.dispose();
    right.dispose();
  });

  it('refuses every mutation from an attempt another worker superseded', async () => {
    const storage = new MemoryStorage();
    const shared = createOutboxClock();
    const crashed = createOutboxFixture({ storage, clock: shared, attemptTimeoutMs: 100 }).outbox;
    const successor = createOutboxFixture({ storage, clock: shared }).outbox;
    const deliveryId = await enqueueOne(crashed);
    const stale = await beginOne(crashed);
    shared.advance(100);
    await successor.runMaintenance();
    // The recovered delivery is parked (default policy) — the stale attempt
    // cannot acknowledge, reschedule, cancel, or heartbeat a terminal record.
    expect(await statusOf(crashed.heartbeat(stale))).toBe('stale');
    expect(await statusOf(crashed.settle({ ...stale, outcome: { status: 'acknowledged' } }))).toBe(
      'stale',
    );
    expect(await fieldOf(successor.receipt(deliveryId), 'state')).toBe('unknown-outcome');
    // After an operator retry the successor claims a NEW attempt; the old token is stale.
    await successor.retry({ deliveryId });
    const fresh = await claimOne(successor);
    expect(fresh.attemptToken).not.toBe(stale.attemptToken);
    expect(await statusOf(crashed.beginAttempt(stale))).toBe('stale');
    expect(await statusOf(crashed.heartbeat(stale))).toBe('stale');
    expect(await statusOf(crashed.settle({ ...stale, outcome: { status: 'rejected' } }))).toBe(
      'stale',
    );
    expect(await statusOf(successor.beginAttempt(fresh))).toBe('settled');
    crashed.dispose();
    successor.dispose();
  });

  it('converges concurrent same-key enqueues on one delivery', async () => {
    const storage = new MemoryStorage();
    const clock = createOutboxClock();
    const left = createOutboxFixture({ storage, clock, generateId: createIdSource('l') }).outbox;
    const right = createOutboxFixture({ storage, clock, generateId: createIdSource('r') }).outbox;
    const results = await Promise.all([
      left.enqueue(deliveryInput({ idempotencyKey: 'same' })),
      right.enqueue(deliveryInput({ idempotencyKey: 'same' })),
    ]);
    expect(results.map((result) => result.status).toSorted()).toEqual(['duplicate', 'enqueued']);
    expect(await left.list()).toHaveLength(1);
    expect(await left.capacity()).toMatchObject({ open: 1, enqueued: 1 });
    left.dispose();
    right.dispose();
  });

  it('keeps backlog accounting exact under concurrent settlement', async () => {
    const storage = new MemoryStorage();
    const clock = createOutboxClock();
    const workers = [0, 1, 2].map(
      (index) =>
        createOutboxFixture({ storage, clock, generateId: createIdSource(`w${index}`) }).outbox,
    );
    for (let index = 0; index < 6; index += 1) await enqueueOne(workers[0]!);
    const settled = await Promise.all(
      workers.flatMap((worker) => [worker.deliverNext(), worker.deliverNext()]),
    );
    expect(settled.filter((result) => result.status === 'settled')).toHaveLength(6);
    expect(await workers[0]!.capacity()).toMatchObject({ open: 0, enqueued: 6 });
    expect(await workers[0]!.list({ states: ['acknowledged'] })).toHaveLength(6);
    for (const worker of workers) worker.dispose();
  });

  it('surfaces sustained compare-and-swap loss as a contention error', async () => {
    class LosingStorage extends MemoryStorage {
      override async conditionalBatch(): Promise<boolean> {
        return false;
      }
    }
    const { outbox } = createOutboxFixture({ storage: new LosingStorage() });
    await expect(outbox.enqueue(deliveryInput())).rejects.toThrow(ApplicationOutboxContentionError);
    outbox.dispose();
  });

  it('surfaces contention on a claim, a settlement, and a cancellation', async () => {
    let losing = false;
    class SometimesLosing extends MemoryStorage {
      override async conditionalBatch(
        ...arguments_: Parameters<MemoryStorage['conditionalBatch']>
      ): Promise<boolean> {
        if (losing) return false;
        return super.conditionalBatch(...arguments_);
      }
    }
    const storage = new SometimesLosing();
    const { outbox } = createOutboxFixture({ storage });
    const deliveryId = await enqueueOne(outbox);
    await enqueueOne(outbox);
    const claim = await beginOne(outbox);
    losing = true;
    await expect(outbox.claim()).rejects.toThrow(ApplicationOutboxContentionError);
    await expect(outbox.settle({ ...claim, outcome: { status: 'acknowledged' } })).rejects.toThrow(
      ApplicationOutboxContentionError,
    );
    await expect(outbox.heartbeat(claim)).rejects.toThrow(ApplicationOutboxContentionError);
    await expect(outbox.requestCancellation({ deliveryId })).rejects.toThrow(
      ApplicationOutboxContentionError,
    );
    await expect(outbox.retry({ deliveryId: 'x' })).resolves.toEqual({ status: 'unknown' });
    const error = await outbox.runMaintenance().catch((cause: unknown) => cause);
    void error;
    losing = false;
    outbox.dispose();
  });

  it('discards a due entry whose record moved on and looks past it', async () => {
    const { outbox, storage, clock } = createOutboxFixture();
    const first = await enqueueOne(outbox);
    const second = await enqueueOne(outbox);
    // Forge a stale due entry ahead of everything, naming a delivery at the wrong instant.
    const stale = KEYS.applicationDeliveryDue('bureau', 'agent-7', 1, first);
    const { encode } = await import('./codec.ts');
    await storage.put(stale, encode(first));
    const claimed = await claimOne(outbox);
    expect([first, second]).toContain(claimed.deliveryId);
    expect(await storage.get(stale)).toBeNull();
    void clock;
    outbox.dispose();
  });
});

describe('ApplicationOutbox concurrency across storage backends', () => {
  for (const backend of storageBackends) {
    it(`fences concurrent claims on ${backend.name}`, async () => {
      const created = backend.factory();
      const capabilities = created.storage.capabilities();
      if (!capabilities.conditionalBatch || capabilities.scanConsistency !== 'snapshot') {
        await teardown(undefined, created.cleanup);
        return;
      }
      const clock = createOutboxClock();
      const left = new ApplicationOutbox({
        storage: created.storage,
        namespace: 'bureau',
        ownerId: 'agent-7',
        now: clock.now,
        generateId: createIdSource('left'),
      });
      const right = new ApplicationOutbox({
        storage: created.storage,
        namespace: 'bureau',
        ownerId: 'agent-7',
        now: clock.now,
        generateId: createIdSource('right'),
      });
      try {
        await enqueueOne(left);
        const results = await Promise.all([left.claim(), right.claim()]);
        expect(results.map((result) => result.status).toSorted()).toEqual(['claimed', 'empty']);
        const winner = results.find((result) => result.status === 'claimed');
        if (winner?.status !== 'claimed') throw new Error('no winner');
        const token = winner.claim.attemptToken;
        const deliveryId = winner.claim.receipt.deliveryId;
        expect(await statusOf(right.beginAttempt({ deliveryId, attemptToken: 'other' }))).toBe(
          'stale',
        );
        expect(await statusOf(left.beginAttempt({ deliveryId, attemptToken: token }))).toBe(
          'settled',
        );
        expect(
          await statusOf(
            right.settle({ deliveryId, attemptToken: token, outcome: { status: 'acknowledged' } }),
          ),
        ).toBe('settled');
        expect(await fieldOf(left.receipt(deliveryId), 'state')).toBe('acknowledged');
      } finally {
        left.dispose();
        right.dispose();
        await teardown(undefined, created.cleanup);
      }
    });
  }
});

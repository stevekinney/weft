/**
 * Recovery for the durable application delivery outbox (WFT-85): restart
 * with every state on disk, lapsed leases recovered by the state they lapsed
 * in, the unknown-outcome policy under recovery, maintenance accounting,
 * the paged scan cursor, retention, and fail-closed maintenance.
 *
 * A "restart" is modelled as a new `Outbox` over the same storage
 * with the same injected clock; a "crash" is an attempt that was claimed or
 * begun and never settled.
 */

import { describe, expect, it } from 'bun:test';

import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { encode } from './codec.ts';
import {
  beginOne,
  claimOne,
  createOutboxClock,
  createOutboxFixture,
  deliverOne,
  enqueueOne,
  fieldOf,
  ScriptedAdapter,
  statusOf,
} from './outbox.test-support.ts';
import { PersistedDataCorruptError } from './persisted-data-incompatible-error.ts';

describe('Outbox restart', () => {
  it('recovers every durable state without losing or duplicating authority', async () => {
    const storage = new MemoryStorage();
    const clock = createOutboxClock();
    const adapter = new ScriptedAdapter();
    adapter
      .reply({ status: 'acknowledged' })
      .reply({ status: 'retryable' })
      .reply({ status: 'unknown' });
    const first = createOutboxFixture({ storage, clock, scripted: adapter }).outbox;
    const queued = await enqueueOne(first, { availableAfterMs: 1_000_000 });
    const acknowledged = await enqueueOne(first);
    const rescheduled = await enqueueOne(first);
    const parked = await enqueueOne(first);
    const claimed = await enqueueOne(first);
    const attempting = await enqueueOne(first);
    const cancelling = await enqueueOne(first);
    await deliverOne(first);
    await deliverOne(first);
    await deliverOne(first);
    await claimOne(first);
    await beginOne(first);
    await beginOne(first);
    await first.requestCancellation({ deliveryId: cancelling });
    // The process dies with three leases open.
    first.dispose();

    const second = createOutboxFixture({ storage, clock }).outbox;
    const states = async () =>
      Object.fromEntries(
        await Promise.all(
          [queued, acknowledged, rescheduled, parked, claimed, attempting, cancelling].map(
            async (id) => [id, await fieldOf(second.receipt(id), 'state')] as const,
          ),
        ),
      );
    expect(await states()).toEqual({
      [queued]: 'queued',
      [acknowledged]: 'acknowledged',
      [rescheduled]: 'retry-scheduled',
      [parked]: 'unknown-outcome',
      [claimed]: 'claimed',
      [attempting]: 'attempting',
      [cancelling]: 'cancellation-requested',
    });
    // Nothing is claimable while the leases are live and the retry is backing off.
    expect(await statusOf(second.claim())).toBe('held');
    expect(await second.runMaintenance()).toEqual({
      rescheduled: 0,
      parked: 0,
      deadLettered: 0,
      retired: 0,
    });
    clock.advance(400_000);
    expect(await second.runMaintenance()).toEqual({
      rescheduled: 1,
      parked: 2,
      deadLettered: 0,
      retired: 0,
    });
    expect(await states()).toMatchObject({
      [claimed]: 'retry-scheduled',
      [attempting]: 'unknown-outcome',
      [cancelling]: 'unknown-outcome',
    });
    const abandoned = await second.receipt(attempting);
    expect(abandoned?.cleanupPending).toBe(true);
    expect(await statusOf(second.cleanupState(attempting))).toBe('pending');
    expect(await statusOf(second.cleanupState(cancelling))).toBe('pending');
    expect(await second.capacity()).toMatchObject({ open: 3, enqueued: 7 });
    second.dispose();
  });

  it('reschedules a lease that lapsed by visibility even before its attempt deadline', async () => {
    const { outbox, clock } = createOutboxFixture({
      visibilityTimeoutMs: 100,
      attemptTimeoutMs: 10_000,
    });
    const deliveryId = await enqueueOne(outbox);
    const claim = await claimOne(outbox);
    clock.advance(100);
    expect(await outbox.runMaintenance()).toMatchObject({ rescheduled: 1 });
    expect(claim.signal.aborted).toBe(true);
    const receipt = await outbox.receipt(deliveryId);
    expect(receipt?.state).toBe('retry-scheduled');
    expect(receipt?.lastFailure?.reason).toBe('retryable');
    // The old attempt can no longer touch the delivery.
    expect(await statusOf(outbox.beginAttempt(claim))).toBe('stale');
    outbox.dispose();
  });

  it('keeps a heartbeating lease alive until the attempt deadline, then parks it', async () => {
    const { outbox, clock } = createOutboxFixture({
      visibilityTimeoutMs: 100,
      attemptTimeoutMs: 250,
      unknownOutcomePolicy: 'park',
    });
    const deliveryId = await enqueueOne(outbox);
    const claim = await beginOne(outbox);
    for (let step = 0; step < 2; step += 1) {
      clock.advance(90);
      expect(await statusOf(outbox.heartbeat(claim))).toBe('renewed');
      expect(await outbox.runMaintenance()).toMatchObject({ parked: 0, rescheduled: 0 });
    }
    clock.advance(70);
    expect(await outbox.runMaintenance()).toMatchObject({ parked: 1 });
    expect(await fieldOf(outbox.receipt(deliveryId), 'state')).toBe('unknown-outcome');
    expect(await statusOf(outbox.heartbeat(claim))).toBe('stale');
    outbox.dispose();
  });

  it.each([
    ['dead-letter', 'dead-lettered', { deadLettered: 1 }],
    ['retry-with-idempotency', 'retry-scheduled', { rescheduled: 1 }],
  ] as const)(
    'applies %s to a lease that lapsed after the send began',
    async (policy, state, counts) => {
      const { outbox, clock } = createOutboxFixture({ attemptTimeoutMs: 100 });
      const deliveryId = await enqueueOne(outbox, {
        unknownOutcomePolicy: policy,
        externalIdempotencyKey: 'ext',
      });
      await beginOne(outbox);
      clock.advance(100);
      expect(await outbox.runMaintenance()).toMatchObject(counts);
      expect(await fieldOf(outbox.receipt(deliveryId), 'state')).toBe(state);
      outbox.dispose();
    },
  );

  it('dead-letters a claimed lease that lapsed with no attempts left', async () => {
    const { outbox, clock } = createOutboxFixture({ maxAttempts: 1, attemptTimeoutMs: 100 });
    const deliveryId = await enqueueOne(outbox);
    await claimOne(outbox);
    clock.advance(100);
    expect(await outbox.runMaintenance()).toMatchObject({ deadLettered: 1 });
    const receipt = await outbox.receipt(deliveryId);
    expect(receipt?.state).toBe('dead-lettered');
    expect(receipt?.failure?.reason).toBe('attempts-exhausted');
    expect(receipt?.cleanupPending).toBe(true);
    outbox.dispose();
  });

  it('lets a recovered delivery be delivered again by a new process', async () => {
    const storage = new MemoryStorage();
    const clock = createOutboxClock();
    const crashed = createOutboxFixture({ storage, clock, attemptTimeoutMs: 100 }).outbox;
    const deliveryId = await enqueueOne(crashed);
    await claimOne(crashed);
    crashed.dispose();
    const fresh = createOutboxFixture({ storage, clock }).outbox;
    clock.advance(100);
    await fresh.runMaintenance();
    clock.advance(1000);
    expect(await deliverOne(fresh)).toBe('acknowledged');
    expect(await fieldOf(fresh.receipt(deliveryId), 'attempt')).toBe(2);
    fresh.dispose();
  });
});

describe('Outbox maintenance scan', () => {
  it('reaches every record across pages and carries its cursor when capped', async () => {
    const { outbox, clock } = createOutboxFixture({
      maintenanceBatchSize: 2,
      attemptTimeoutMs: 100,
    });
    for (let index = 0; index < 5; index += 1) await enqueueOne(outbox);
    for (let index = 0; index < 5; index += 1) await claimOne(outbox);
    clock.advance(100);
    expect(await outbox.runMaintenance()).toMatchObject({ rescheduled: 5 });
    expect(await outbox.list({ states: ['retry-scheduled'] })).toHaveLength(5);
    outbox.dispose();
  });

  it('does not double-count a lease another process already recovered', async () => {
    const storage = new MemoryStorage();
    const clock = createOutboxClock();
    const a = createOutboxFixture({ storage, clock, attemptTimeoutMs: 100 }).outbox;
    const b = createOutboxFixture({ storage, clock }).outbox;
    await enqueueOne(a);
    const claim = await claimOne(a);
    clock.advance(100);
    expect(await b.runMaintenance()).toMatchObject({ rescheduled: 1 });
    expect(await a.runMaintenance()).toMatchObject({ rescheduled: 0 });
    // The scan in `a` released the local attempt the remote pass reclaimed.
    expect(claim.signal.aborted).toBe(true);
    a.dispose();
    b.dispose();
  });

  it('halts on a corrupt record without advancing the cursor', async () => {
    const { outbox, storage, clock } = createOutboxFixture({ attemptTimeoutMs: 100 });
    const deliveryId = await enqueueOne(outbox);
    await claimOne(outbox);
    await storage.put(KEYS.applicationDelivery('bureau', 'agent-7', 'zzz'), encode({ nope: 1 }));
    clock.advance(100);
    await expect(outbox.runMaintenance()).rejects.toThrow(PersistedDataCorruptError);
    await storage.delete(KEYS.applicationDelivery('bureau', 'agent-7', 'zzz'));
    expect(await outbox.runMaintenance()).toMatchObject({ rescheduled: 1 });
    expect(await fieldOf(outbox.receipt(deliveryId), 'state')).toBe('retry-scheduled');
    outbox.dispose();
  });

  it('rejects an invalid maintenance instant', async () => {
    const { outbox } = createOutboxFixture();
    await expect(outbox.runMaintenance(Number.NaN)).rejects.toThrow(/runMaintenance/);
    outbox.dispose();
  });
});

describe('Outbox retention', () => {
  it('retires terminal receipts past retention with their listing entry and binding', async () => {
    const { outbox, clock, storage } = createOutboxFixture({ terminalRetentionMs: 1000 });
    const deliveryId = await enqueueOne(outbox, { idempotencyKey: 'k-1' });
    await deliverOne(outbox);
    clock.advance(1000);
    expect(await outbox.runMaintenance()).toMatchObject({ retired: 0 });
    clock.advance(1);
    expect(await outbox.runMaintenance()).toMatchObject({ retired: 1 });
    expect(await outbox.receipt(deliveryId)).toBeNull();
    expect(await outbox.list()).toHaveLength(0);
    expect(
      await storage.get(KEYS.applicationDeliveryIdempotency('bureau', 'agent-7', 'k-1')),
    ).toBeNull();
    // The key is spent: a retry enqueues afresh rather than resolving a gone receipt.
    const again = await outbox.enqueue({
      destinationRef: 'webhook:orders',
      kind: 'order.shipped',
      payload: { form: 'inline', value: { orderId: 42 } },
      idempotencyKey: 'k-1',
    });
    expect(again.status).toBe('enqueued');
    outbox.dispose();
  });

  it('discards orphaned and malformed terminal entries without counting them', async () => {
    const { outbox, clock, storage } = createOutboxFixture({ terminalRetentionMs: 1 });
    const live = await enqueueOne(outbox);
    const prefix = KEYS.applicationDeliveryTerminalPrefix('bureau', 'agent-7');
    await storage.put(`${prefix}garbage`, encode('x'));
    await storage.put(KEYS.applicationDeliveryTerminal('bureau', 'agent-7', 1, live), encode(live));
    await storage.put(
      KEYS.applicationDeliveryTerminal('bureau', 'agent-7', 2, 'gone'),
      encode('gone'),
    );
    clock.advance(10);
    expect(await outbox.runMaintenance()).toMatchObject({ retired: 1 });
    expect(await fieldOf(outbox.receipt(live), 'state')).toBe('queued');
    expect(await storage.get(`${prefix}garbage`)).toBeNull();
    expect(
      await storage.get(KEYS.applicationDeliveryTerminal('bureau', 'agent-7', 1, live)),
    ).toBeNull();
    outbox.dispose();
  });

  it('never retires before the retention horizon can exist', async () => {
    const clock = createOutboxClock(10);
    const { outbox } = createOutboxFixture({ clock, terminalRetentionMs: 1000 });
    await enqueueOne(outbox);
    await deliverOne(outbox);
    expect(await outbox.runMaintenance()).toMatchObject({ retired: 0 });
    outbox.dispose();
  });
});

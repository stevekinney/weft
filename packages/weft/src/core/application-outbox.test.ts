/**
 * Core contract for the durable application delivery outbox (WFT-85):
 * construction, enqueue and idempotency, receipts and listing, the adapter
 * runner across every outcome, the fenced claim API, cancellation, operator
 * transitions, events, and secret hygiene.
 *
 * Concurrency, recovery, liveness, and shutdown each have their own file.
 */

import { describe, expect, it } from 'bun:test';

import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { ApplicationDeliveryValidationError } from './application-outbox-guards.ts';
import {
  beginOne,
  claimOne,
  createOutboxFixture,
  deliverOne,
  deliveryInput,
  enqueueOne,
  fieldOf,
  RecordingEventSink,
  ScriptedAdapter,
  statusOf,
} from './application-outbox.test-support.ts';
import { ApplicationOutbox } from './application-outbox.ts';
import { decode, encode } from './codec.ts';
import { PersistedDataCorruptError } from './persisted-data-incompatible-error.ts';

describe('ApplicationOutbox construction', () => {
  it('rejects storage without conditional batch support or snapshot scans', () => {
    class WithoutConditionalBatch extends MemoryStorage {
      override capabilities(): ReturnType<MemoryStorage['capabilities']> {
        return { ...super.capabilities(), conditionalBatch: false };
      }
    }
    class BestEffortScan extends MemoryStorage {
      override capabilities(): ReturnType<MemoryStorage['capabilities']> {
        return { ...super.capabilities(), scanConsistency: 'best-effort' };
      }
    }
    for (const storage of [new WithoutConditionalBatch(), new BestEffortScan()]) {
      expect(() => new ApplicationOutbox({ storage, namespace: 'n', ownerId: 'o' })).toThrow(
        ApplicationDeliveryValidationError,
      );
    }
  });

  it('exposes the scope it was built for', () => {
    const { outbox } = createOutboxFixture();
    expect(outbox.namespace).toBe('bureau');
    expect(outbox.ownerId).toBe('agent-7');
    expect(outbox.storage).toBeInstanceOf(MemoryStorage);
    outbox.dispose();
  });

  it.each([
    ['namespace', { namespace: '' }],
    ['ownerId', { ownerId: '' }],
    ['maxBacklog', { maxBacklog: 0 }],
    ['visibilityTimeoutMs', { visibilityTimeoutMs: -1 }],
    ['attemptTimeoutMs', { attemptTimeoutMs: 2_147_483_648 }],
    ['maxAttempts', { maxAttempts: 1_000 }],
    ['retryBackoffMs', { retryBackoffMs: 0 }],
    ['maxRetryBackoffMs', { maxRetryBackoffMs: 0 }],
    ['terminalRetentionMs', { terminalRetentionMs: 0 }],
    ['maxInlinePayloadBytes', { maxInlinePayloadBytes: 0 }],
    ['maintenanceBatchSize', { maintenanceBatchSize: 0 }],
    ['maintenanceIntervalMs', { maintenanceIntervalMs: 0 }],
    ['unknownOutcomePolicy', { unknownOutcomePolicy: 'ignore' as never }],
    ['backgroundTasks', { backgroundTasks: 'sometimes' as never }],
    ['adapter', { adapter: {} as never }],
    ['onMaintenanceError', { onMaintenanceError: 'log' as never }],
  ])('rejects an out-of-range %s', (_name, override) => {
    expect(() => createOutboxFixture(override)).toThrow(ApplicationDeliveryValidationError);
  });

  it('refuses every operation after disposal', async () => {
    const { outbox } = createOutboxFixture();
    outbox.dispose();
    outbox.dispose();
    await expect(outbox.enqueue(deliveryInput())).rejects.toThrow(/disposed/);
    await expect(outbox.deliverNext()).rejects.toThrow(/disposed/);
    await expect(outbox.runMaintenance()).rejects.toThrow(/disposed/);
  });
});

describe('ApplicationOutbox enqueue', () => {
  it('returns a durable receipt before any adapter attempt begins', async () => {
    const { outbox, storage, clock, adapter } = createOutboxFixture();
    const deliveryId = await enqueueOne(outbox, { idempotencyKey: 'k-1', credentialRef: 'cred:1' });
    expect(adapter.requests).toHaveLength(0);
    outbox.dispose();
    const again = createOutboxFixture({ storage, clock }).outbox;
    const receipt = await again.receipt(deliveryId);
    expect(receipt?.state).toBe('queued');
    expect(receipt?.enqueuedAt).toBe(clock.now());
    expect(receipt?.destinationRef).toBe('webhook:orders');
    expect(receipt).not.toHaveProperty('credentialRef');
    expect(Object.isFrozen(receipt)).toBe(true);
    again.dispose();
  });

  it('answers an exact idempotent retry with the original receipt', async () => {
    const { outbox } = createOutboxFixture();
    const first = await outbox.enqueue(deliveryInput({ idempotencyKey: 'k-1' }));
    const second = await outbox.enqueue(
      deliveryInput({ idempotencyKey: 'k-1', credentialRef: 'x' }),
    );
    expect(first.status).toBe('enqueued');
    expect(second.status).toBe('duplicate');
    expect(second.status === 'duplicate' && second.receipt.deliveryId).toBe(
      first.status === 'enqueued' ? first.receipt.deliveryId : '',
    );
    expect(await outbox.capacity()).toMatchObject({ open: 1, enqueued: 1 });
    outbox.dispose();
  });

  it('reports a stable conflict for a reused key with a different identity', async () => {
    const { outbox } = createOutboxFixture();
    await enqueueOne(outbox, { idempotencyKey: 'k-1' });
    for (const override of [
      { destinationRef: 'webhook:other' },
      { kind: 'order.cancelled' },
      { payload: { form: 'inline' as const, value: { orderId: 43 } } },
    ]) {
      const conflict = await outbox.enqueue(deliveryInput({ idempotencyKey: 'k-1', ...override }));
      expect(conflict.status).toBe('conflict');
      expect(conflict.status === 'conflict' && conflict.reason).toBe(
        'idempotency-identity-mismatch',
      );
    }
    outbox.dispose();
  });

  it('rejects a full backlog before any write', async () => {
    const { outbox } = createOutboxFixture({ maxBacklog: 1 });
    await enqueueOne(outbox);
    const rejected = await outbox.enqueue(deliveryInput());
    expect(rejected.status).toBe('rejected');
    expect(rejected.status === 'rejected' && rejected.capacity).toEqual({
      open: 1,
      limit: 1,
      remaining: 0,
      enqueued: 1,
    });
    expect(await outbox.list()).toHaveLength(1);
    outbox.dispose();
  });

  it('requires external idempotency evidence for retry-with-idempotency', async () => {
    const { outbox } = createOutboxFixture();
    await expect(
      outbox.enqueue(deliveryInput({ unknownOutcomePolicy: 'retry-with-idempotency' })),
    ).rejects.toThrow(/externalIdempotencyKey/);
    const admitted = await outbox.enqueue(
      deliveryInput({
        unknownOutcomePolicy: 'retry-with-idempotency',
        externalIdempotencyKey: 'e',
      }),
    );
    expect(admitted.status).toBe('enqueued');
    outbox.dispose();
  });

  it.each([
    ['destinationRef', { destinationRef: '' }],
    ['kind', { kind: 'k'.repeat(300) }],
    ['payload', { payload: { form: 'other' } as never }],
    ['payload.digest', { payload: { form: 'reference', reference: 'r', digest: 'nope' } as never }],
    ['availableAfterMs', { availableAfterMs: -1 }],
    ['maxAttempts', { maxAttempts: 0 }],
    ['attemptTimeoutMs', { attemptTimeoutMs: 0 }],
    ['unknownOutcomePolicy', { unknownOutcomePolicy: 'nope' as never }],
    ['causation', { causation: null as never }],
    ['payload.value', { payload: { form: 'inline', value: () => 1 } as never }],
  ])('rejects an invalid %s', async (_name, override) => {
    const { outbox } = createOutboxFixture();
    await expect(outbox.enqueue(deliveryInput(override))).rejects.toThrow(
      ApplicationDeliveryValidationError,
    );
    expect(await outbox.list()).toHaveLength(0);
    outbox.dispose();
  });

  it('rejects an oversized inline payload and accepts a reference with a byte length', async () => {
    const { outbox } = createOutboxFixture({ maxInlinePayloadBytes: 16 });
    await expect(
      outbox.enqueue(deliveryInput({ payload: { form: 'inline', value: 'x'.repeat(64) } })),
    ).rejects.toThrow(/inline ceiling/);
    const reference = await outbox.enqueue(
      deliveryInput({
        payload: { form: 'reference', reference: 'blob:1', digest: 'a'.repeat(64), byteLength: 9 },
      }),
    );
    expect(reference.status).toBe('enqueued');
    outbox.dispose();
  });

  it('rejects a non-object delivery and a malformed generated id', async () => {
    const { outbox } = createOutboxFixture();
    await expect(outbox.enqueue(null as never)).rejects.toThrow(/must be an object/);
    outbox.dispose();
    const empty = createOutboxFixture({ generateId: () => '' }).outbox;
    await expect(empty.enqueue(deliveryInput())).rejects.toThrow(/generateId/);
    empty.dispose();
  });
});

describe('ApplicationOutbox receipts and listing', () => {
  it('lists in enqueue order, filtered by state and bounded by limit', async () => {
    const { outbox } = createOutboxFixture();
    const first = await enqueueOne(outbox);
    const second = await enqueueOne(outbox, { availableAfterMs: 10 });
    await deliverOne(outbox);
    const all = await outbox.list();
    expect(all.map((receipt) => receipt.deliveryId)).toEqual([first, second]);
    expect(all.map((receipt) => receipt.state)).toEqual(['acknowledged', 'queued']);
    const queuedOnly = await outbox.list({ states: ['queued'] });
    expect(queuedOnly.map((receipt) => receipt.deliveryId)).toEqual([second]);
    expect(await outbox.list({ limit: 1 })).toHaveLength(1);
    await expect(outbox.list({ limit: 0 })).rejects.toThrow(/limit/);
    expect(await outbox.receipt('missing')).toBeNull();
    await expect(outbox.receipt('')).rejects.toThrow(ApplicationDeliveryValidationError);
    outbox.dispose();
  });

  it('fails closed on a listing entry that names the wrong sequence', async () => {
    const { outbox, storage } = createOutboxFixture();
    await enqueueOne(outbox);
    await storage.put(KEYS.applicationDeliveryBySequence('bureau', 'agent-7', 7), encode('id-1'));
    await expect(outbox.list()).rejects.toThrow(PersistedDataCorruptError);
    outbox.dispose();
  });

  it('skips a listing entry whose record was retired', async () => {
    const { outbox, storage } = createOutboxFixture();
    await enqueueOne(outbox);
    await storage.put(KEYS.applicationDeliveryBySequence('bureau', 'agent-7', 5), encode('gone'));
    expect(await outbox.list()).toHaveLength(1);
    outbox.dispose();
  });

  it('fails closed on a corrupt record', async () => {
    const { outbox, storage } = createOutboxFixture();
    const deliveryId = await enqueueOne(outbox);
    const key = KEYS.applicationDelivery('bureau', 'agent-7', deliveryId);
    const record = decode(await storage.get(key).then((bytes) => bytes!)) as Record<
      string,
      unknown
    >;
    await storage.put(key, encode({ ...record, state: 'attempting' }));
    await expect(outbox.receipt(deliveryId)).rejects.toThrow(PersistedDataCorruptError);
    await storage.put(key, new Uint8Array([1, 2, 3]));
    await expect(outbox.receipt(deliveryId)).rejects.toThrow(PersistedDataCorruptError);
    outbox.dispose();
  });
});

describe('ApplicationOutbox adapter runner', () => {
  it('marks attempting before the adapter is called, then acknowledges on its report', async () => {
    const { outbox, adapter, storage, clock } = createOutboxFixture();
    const deliveryId = await enqueueOne(outbox, { credentialRef: 'cred:1', maxAttempts: 2 });
    let stateDuringSend: string | undefined;
    const release = adapter.block();
    const pending = outbox.deliverNext();
    // Let the claim and the attempting commit land, then observe the record.
    await new Promise((resolve) => setTimeout(resolve, 0));
    while (adapter.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    const observer = createOutboxFixture({ storage, clock }).outbox;
    stateDuringSend = await fieldOf(observer.receipt(deliveryId), 'state');
    observer.dispose();
    release({ status: 'acknowledged', evidence: { messageId: 'm-1' } });
    const result = await pending;
    expect(stateDuringSend).toBe('attempting');
    expect(result.status).toBe('settled');
    expect(result.status === 'settled' && result.receipt.state).toBe('acknowledged');
    expect(result.status === 'settled' && result.receipt.evidence).toEqual({ messageId: 'm-1' });
    const request = adapter.requests[0]!;
    expect(request.credentialRef).toBe('cred:1');
    expect(request.delivery.state).toBe('attempting');
    expect(request.payload).toMatchObject({ form: 'inline', verified: true });
    expect(request.attemptToken).toBeString();
    expect(await outbox.capacity()).toMatchObject({ open: 0 });
    outbox.dispose();
  });

  it('reports empty and held without calling the adapter', async () => {
    const { outbox, adapter, clock } = createOutboxFixture();
    expect(await outbox.deliverNext()).toEqual({ status: 'empty' });
    await enqueueOne(outbox, { availableAfterMs: 500 });
    expect(await outbox.deliverNext()).toEqual({ status: 'held', availableAt: clock.now() + 500 });
    expect(adapter.requests).toHaveLength(0);
    clock.advance(500);
    expect(await deliverOne(outbox)).toBe('acknowledged');
    outbox.dispose();
  });

  it('rejects permanently on a rejected outcome', async () => {
    const { outbox, adapter } = createOutboxFixture();
    adapter.reply({ status: 'rejected', message: '400', details: { code: 'bad' } });
    const deliveryId = await enqueueOne(outbox);
    expect(await deliverOne(outbox)).toBe('rejected');
    const receipt = await outbox.receipt(deliveryId);
    expect(receipt?.failure).toEqual({
      reason: 'application',
      message: '400',
      details: { code: 'bad' },
    });
    expect(receipt?.terminalAt).toBeNumber();
    outbox.dispose();
  });

  it('reschedules a retryable outcome and dead-letters when attempts run out', async () => {
    const { outbox, adapter, clock } = createOutboxFixture({ maxAttempts: 2, retryBackoffMs: 100 });
    adapter.reply({ status: 'retryable', message: '503', retryAfterMs: 250 }).reply({
      status: 'retryable',
      message: '503 again',
    });
    const deliveryId = await enqueueOne(outbox);
    expect(await deliverOne(outbox)).toBe('retry-scheduled');
    const scheduled = await outbox.receipt(deliveryId);
    expect(scheduled?.availableAt).toBe(clock.now() + 250);
    expect(scheduled?.retryCount).toBe(1);
    expect(scheduled?.lastFailure).toEqual({ reason: 'retryable', message: '503' });
    expect(await outbox.deliverNext()).toMatchObject({ status: 'held' });
    clock.advance(250);
    expect(await deliverOne(outbox)).toBe('dead-lettered');
    expect(await fieldOf(outbox.receipt(deliveryId), 'failure')).toEqual({
      reason: 'attempts-exhausted',
      message: '503 again',
    });
    expect(adapter.requests.map((request) => request.delivery.attempt)).toEqual([1, 2]);
    outbox.dispose();
  });

  it.each([
    ['park', 'unknown-outcome'],
    ['dead-letter', 'dead-lettered'],
    ['retry-with-idempotency', 'retry-scheduled'],
  ] as const)('applies the %s policy to an unknown outcome', async (policy, state) => {
    const { outbox, adapter } = createOutboxFixture();
    adapter.reply({ status: 'unknown', message: 'timeout' });
    const deliveryId = await enqueueOne(outbox, {
      unknownOutcomePolicy: policy,
      externalIdempotencyKey: 'ext-1',
    });
    expect(await deliverOne(outbox)).toBe(state);
    const receipt = await outbox.receipt(deliveryId);
    expect((receipt?.failure ?? receipt?.lastFailure)?.reason).toBe('unknown-outcome');
    outbox.dispose();
  });

  it('treats a thrown adapter error and a malformed outcome as unknown', async () => {
    const { outbox, adapter } = createOutboxFixture();
    adapter.fail(new Error('socket hang up')).reply({ status: 'maybe' }).reply(null);
    for (const expected of ['socket hang up', 'malformed outcome', 'malformed outcome']) {
      const deliveryId = await enqueueOne(outbox);
      expect(await deliverOne(outbox)).toBe('unknown-outcome');
      const failure = await fieldOf(outbox.receipt(deliveryId), 'failure');
      expect(failure?.message).toContain(expected);
    }
    outbox.dispose();
  });

  it('treats an attempt deadline that elapses in flight as unknown and aborts the signal', async () => {
    const { outbox, adapter } = createOutboxFixture({ attemptTimeoutMs: 1 });
    const deliveryId = await enqueueOne(outbox);
    adapter.block();
    // The budget is real-time here: one millisecond, then the race aborts.
    expect(await deliverOne(outbox)).toBe('unknown-outcome');
    expect(adapter.requests[0]!.signal.aborted).toBe(true);
    const failure = await fieldOf(outbox.receipt(deliveryId), 'failure');
    expect(failure?.message).toContain('deadline passed');
    outbox.dispose();
  });

  it('requires an adapter for deliverNext and drain', async () => {
    const { outbox } = createOutboxFixture({ adapter: undefined });
    await enqueueOne(outbox);
    await expect(outbox.deliverNext()).rejects.toThrow(/require an adapter/);
    await expect(outbox.drain({ timeoutMs: 0 })).rejects.toThrow(/require an adapter/);
    outbox.dispose();
  });

  it('never calls the adapter for a delivery cancelled between claim and begin', async () => {
    const { outbox, adapter, storage, clock } = createOutboxFixture();
    const deliveryId = await enqueueOne(outbox);
    // Model a second process cancelling while this one holds the claim.
    const claim = await claimOne(outbox);
    const other = createOutboxFixture({ storage, clock }).outbox;
    expect(await statusOf(other.requestCancellation({ deliveryId }))).toBe('cancelled');
    other.dispose();
    const begun = await outbox.beginAttempt(claim);
    expect(begun.status).toBe('stale');
    expect(begun.status === 'stale' && begun.receipt.state).toBe('cancelled');
    expect(claim.signal.aborted).toBe(true);
    expect(adapter.requests).toHaveLength(0);
    outbox.dispose();
  });
});

describe('ApplicationOutbox fenced claim API', () => {
  it('claims, begins, heartbeats, and settles under one attempt token', async () => {
    const { outbox, clock } = createOutboxFixture({
      visibilityTimeoutMs: 100,
      attemptTimeoutMs: 1000,
    });
    const deliveryId = await enqueueOne(outbox);
    const claim = await outbox.claim();
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') return;
    expect(claim.claim.visibilityExpiresAt).toBe(clock.now() + 100);
    expect(claim.claim.attemptDeadlineAt).toBe(clock.now() + 1000);
    expect(await statusOf(outbox.claim())).toBe('empty');
    const begun = await outbox.beginAttempt({ deliveryId, attemptToken: claim.claim.attemptToken });
    expect(begun.status === 'settled' && begun.receipt.state).toBe('attempting');
    clock.advance(50);
    const beat = await outbox.heartbeat({
      deliveryId,
      attemptToken: claim.claim.attemptToken,
      transportActivity: { bytesWritten: 10 },
    });
    expect(beat).toMatchObject({
      status: 'renewed',
      visibilityExpiresAt: clock.now() + 100,
      attemptDeadlineAt: clock.now() - 50 + 1000,
      cancellationRequested: false,
    });
    expect(beat.status === 'renewed' && beat.receipt.transportActivity).toEqual({
      bytesWritten: 10,
    });
    const settled = await outbox.settle({
      deliveryId,
      attemptToken: claim.claim.attemptToken,
      outcome: { status: 'acknowledged', evidence: 'ok' },
    });
    expect(settled.status).toBe('settled');
    expect(settled.status === 'settled' && settled.receipt.evidence).toBe('ok');
    expect(claim.claim.signal.aborted).toBe(true);
    outbox.dispose();
  });

  it('refuses every mutation from a stale attempt and reports unknown ids', async () => {
    const { outbox } = createOutboxFixture();
    const deliveryId = await enqueueOne(outbox);
    const claim = await claimOne(outbox);
    const stale = { deliveryId, attemptToken: 'not-mine' };
    expect(await statusOf(outbox.beginAttempt(stale))).toBe('stale');
    expect(await statusOf(outbox.heartbeat(stale))).toBe('stale');
    expect(await statusOf(outbox.settle({ ...stale, outcome: { status: 'acknowledged' } }))).toBe(
      'stale',
    );
    expect(claim.signal.aborted).toBe(false);
    const missing = { deliveryId: 'missing', attemptToken: claim.attemptToken };
    expect(await statusOf(outbox.beginAttempt(missing))).toBe('unknown');
    expect(await statusOf(outbox.heartbeat(missing))).toBe('unknown');
    expect(await statusOf(outbox.settle({ ...missing, outcome: { status: 'acknowledged' } }))).toBe(
      'unknown',
    );
    // A mismatched token paired with another delivery never aborts this attempt.
    expect(claim.signal.aborted).toBe(false);
    outbox.dispose();
  });

  it('cannot settle a claimed delivery whose send never began', async () => {
    const { outbox } = createOutboxFixture();
    await enqueueOne(outbox);
    const claim = await claimOne(outbox);
    const settled = await outbox.settle({ ...claim, outcome: { status: 'acknowledged' } });
    expect(settled.status).toBe('stale');
    expect(settled.status === 'stale' && settled.receipt.state).toBe('claimed');
    outbox.dispose();
  });

  it('refuses a heartbeat and a settlement past the attempt deadline', async () => {
    const { outbox, clock } = createOutboxFixture({ attemptTimeoutMs: 10 });
    await enqueueOne(outbox);
    const claim = await beginOne(outbox);
    clock.advance(10);
    expect(await statusOf(outbox.heartbeat(claim))).toBe('deadline-exceeded');
    expect(await statusOf(outbox.settle({ ...claim, outcome: { status: 'acknowledged' } }))).toBe(
      'deadline-exceeded',
    );
    expect(claim.signal.aborted).toBe(true);
    outbox.dispose();
  });

  it('validates the heartbeat marker and the evidence it persists', async () => {
    const { outbox } = createOutboxFixture();
    await enqueueOne(outbox);
    const claim = await beginOne(outbox);
    await expect(
      outbox.heartbeat({ ...claim, transportActivity: new Map() as never }),
    ).rejects.toThrow(ApplicationDeliveryValidationError);
    // A malformed evidence value is an unknown outcome, not a caller error.
    const settled = await outbox.settle({
      ...claim,
      outcome: { status: 'acknowledged', evidence: new Map() as never },
    });
    expect(settled.status === 'settled' && settled.receipt.state).toBe('unknown-outcome');
    outbox.dispose();
  });

  it('claims deliveries in due order, not enqueue order', async () => {
    const { outbox, clock } = createOutboxFixture();
    const later = await enqueueOne(outbox, { availableAfterMs: 100 });
    const sooner = await enqueueOne(outbox);
    expect(await fieldOf(claimOne(outbox), 'deliveryId')).toBe(sooner);
    expect(await statusOf(outbox.claim())).toBe('held');
    clock.advance(100);
    expect(await fieldOf(claimOne(outbox), 'deliveryId')).toBe(later);
    outbox.dispose();
  });

  it('hands a reference payload over unverified and fails closed on a tampered inline one', async () => {
    const { outbox, storage } = createOutboxFixture();
    await enqueueOne(outbox, {
      payload: { form: 'reference', reference: 'blob:1', digest: 'b'.repeat(64) },
    });
    const claim = await outbox.claim();
    expect(claim.status === 'claimed' && claim.claim.payload).toMatchObject({
      form: 'reference',
      reference: 'blob:1',
      verified: false,
    });
    const tampered = await enqueueOne(outbox);
    const key = KEYS.applicationDelivery('bureau', 'agent-7', tampered);
    const record = decode((await storage.get(key))!) as Record<string, unknown>;
    await storage.put(
      key,
      encode({ ...record, payload: { form: 'inline', value: { orderId: 'changed' } } }),
    );
    await expect(outbox.claim()).rejects.toThrow(PersistedDataCorruptError);
    outbox.dispose();
  });
});

describe('ApplicationOutbox cancellation', () => {
  it('cancels a queued delivery outright and reports repeats as already terminal', async () => {
    const { outbox } = createOutboxFixture();
    const deliveryId = await enqueueOne(outbox);
    const first = await outbox.requestCancellation({ deliveryId, reason: 'no longer needed' });
    expect(first.status).toBe('cancelled');
    expect(first.status === 'cancelled' && first.receipt.cancellationReason).toBe(
      'no longer needed',
    );
    expect(await statusOf(outbox.requestCancellation({ deliveryId }))).toBe('already-terminal');
    expect(await statusOf(outbox.requestCancellation({ deliveryId: 'missing' }))).toBe('unknown');
    expect(await outbox.deliverNext()).toEqual({ status: 'empty' });
    expect(await outbox.capacity()).toMatchObject({ open: 0 });
    outbox.dispose();
  });

  it('cancels a claimed delivery and aborts the local claimant before its send begins', async () => {
    const { outbox, adapter } = createOutboxFixture();
    const deliveryId = await enqueueOne(outbox);
    const claim = await claimOne(outbox);
    expect(await statusOf(outbox.requestCancellation({ deliveryId }))).toBe('cancelled');
    expect(claim.signal.aborted).toBe(true);
    expect(await statusOf(outbox.beginAttempt(claim))).toBe('stale');
    expect(adapter.requests).toHaveLength(0);
    outbox.dispose();
  });

  it('records the request on an attempting delivery, aborts the signal, and lets the outcome decide', async () => {
    const { outbox } = createOutboxFixture();
    const deliveryId = await enqueueOne(outbox);
    const claim = await beginOne(outbox);
    const requested = await outbox.requestCancellation({ deliveryId, reason: 'stop' });
    expect(requested).toMatchObject({ status: 'requested', cleanupPending: true });
    expect(claim.signal.aborted).toBe(true);
    expect(await statusOf(outbox.requestCancellation({ deliveryId }))).toBe('requested');
    expect(await statusOf(outbox.cleanupState(deliveryId))).toBe('pending');
    const beat = await outbox.heartbeat(claim);
    expect(beat.status === 'renewed' && beat.cancellationRequested).toBe(true);
    const settled = await outbox.settle({ ...claim, outcome: { status: 'retryable' } });
    expect(settled.status === 'settled' && settled.receipt.state).toBe('cancelled');
    expect(await statusOf(outbox.cleanupState(deliveryId))).toBe('settled');
    outbox.dispose();
  });

  it('keeps an acknowledgement that raced a cancellation request', async () => {
    const { outbox } = createOutboxFixture();
    const deliveryId = await enqueueOne(outbox);
    const claim = await beginOne(outbox);
    await outbox.requestCancellation({ deliveryId });
    const settled = await outbox.settle({ ...claim, outcome: { status: 'acknowledged' } });
    expect(settled.status === 'settled' && settled.receipt.state).toBe('acknowledged');
    expect(settled.status === 'settled' && settled.receipt.cancellationRequestedAt).toBeNumber();
    outbox.dispose();
  });

  it('aborts the adapter signal mid-send through the runner', async () => {
    const { outbox, adapter, storage, clock } = createOutboxFixture();
    const deliveryId = await enqueueOne(outbox);
    const release = adapter.block();
    const pending = outbox.deliverNext();
    while (adapter.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    const other = createOutboxFixture({ storage, clock }).outbox;
    expect(await statusOf(other.requestCancellation({ deliveryId }))).toBe('requested');
    other.dispose();
    // The request came from another handle onto the same storage, which shares
    // the process-local registry, so the adapter's signal fires.
    expect(adapter.requests[0]!.signal.aborted).toBe(true);
    release({ status: 'unknown' });
    const result = await pending;
    expect(result.status === 'settled' && result.receipt.state).toBe('unknown-outcome');
    outbox.dispose();
  });

  it('validates the cancellation reason and the delivery id', async () => {
    const { outbox } = createOutboxFixture();
    await expect(
      outbox.requestCancellation({ deliveryId: 'x', reason: 'r'.repeat(2000) }),
    ).rejects.toThrow(ApplicationDeliveryValidationError);
    await expect(outbox.cleanupState('')).rejects.toThrow(ApplicationDeliveryValidationError);
    expect(await statusOf(outbox.cleanupState('missing'))).toBe('unknown');
    outbox.dispose();
  });
});

describe('ApplicationOutbox operator transitions', () => {
  it('retries a parked delivery once more and dead-letters it on request', async () => {
    const { outbox, adapter } = createOutboxFixture({ maxAttempts: 1 });
    adapter.reply({ status: 'unknown' });
    const deliveryId = await enqueueOne(outbox);
    expect(await deliverOne(outbox)).toBe('unknown-outcome');
    expect(await outbox.capacity()).toMatchObject({ open: 0 });
    const retried = await outbox.retry({ deliveryId });
    expect(retried.status === 'applied' && retried.receipt).toMatchObject({
      state: 'queued',
      maxAttempts: 2,
      attempt: 1,
    });
    expect(await outbox.capacity()).toMatchObject({ open: 1 });
    expect(await deliverOne(outbox)).toBe('acknowledged');
    expect(await statusOf(outbox.retry({ deliveryId }))).toBe('not-applicable');
    expect(await statusOf(outbox.deadLetter({ deliveryId }))).toBe('not-applicable');
    expect(await statusOf(outbox.retry({ deliveryId: 'missing' }))).toBe('unknown');
    outbox.dispose();
  });

  it('dead-letters a parked delivery and moves its retention entry', async () => {
    const { outbox, adapter, clock, storage } = createOutboxFixture();
    adapter.reply({ status: 'unknown' });
    const deliveryId = await enqueueOne(outbox);
    await deliverOne(outbox);
    const parkedAt = clock.now();
    clock.advance(1000);
    const dead = await outbox.deadLetter({ deliveryId, reason: 'gave up' });
    expect(dead.status === 'applied' && dead.receipt).toMatchObject({
      state: 'dead-lettered',
      failure: { reason: 'unknown-outcome', message: 'gave up' },
    });
    expect(
      await storage.get(
        KEYS.applicationDeliveryTerminal('bureau', 'agent-7', parkedAt, deliveryId),
      ),
    ).toBeNull();
    expect(
      await storage.get(
        KEYS.applicationDeliveryTerminal('bureau', 'agent-7', clock.now(), deliveryId),
      ),
    ).not.toBeNull();
    expect(await statusOf(outbox.deadLetter({ deliveryId: 'missing' }))).toBe('unknown');
    outbox.dispose();
  });
});

describe('ApplicationOutbox events and secrets', () => {
  it('commits every transition with its fleet event and keeps secrets out of them', async () => {
    const storage = new MemoryStorage();
    const events = new RecordingEventSink(storage);
    const adapter = new ScriptedAdapter();
    adapter.reply({ status: 'retryable' });
    const { outbox, clock } = createOutboxFixture({ storage, events, scripted: adapter });
    const deliveryId = await enqueueOne(outbox, { credentialRef: 'cred:secret', maxAttempts: 2 });
    await deliverOne(outbox);
    clock.advance(60_000);
    await deliverOne(outbox);
    expect(events.events.map((event) => event.kind)).toEqual([
      'outbox:delivery-queued',
      'outbox:delivery-claimed',
      'outbox:delivery-attempting',
      'outbox:delivery-retry-scheduled',
      'outbox:delivery-claimed',
      'outbox:delivery-attempting',
      'outbox:delivery-acknowledged',
    ]);
    const serialized = JSON.stringify(events.events);
    expect(serialized).not.toContain('cred:secret');
    expect(serialized).not.toContain('webhook:orders');
    expect(serialized).not.toContain('orderId');
    expect(events.events[0]!.payload).toMatchObject({ deliveryId, previousState: null });
    // Heartbeat emits no event.
    const count = events.events.length;
    await enqueueOne(outbox);
    const claim = await beginOne(outbox);
    await outbox.heartbeat(claim);
    expect(events.events).toHaveLength(count + 3);
    outbox.dispose();
  });

  it('surfaces a sink that refuses to commit', async () => {
    const storage = new MemoryStorage();
    const events = new RecordingEventSink(storage);
    events.failure = new Error('feed down');
    const { outbox } = createOutboxFixture({ storage, events });
    await expect(outbox.enqueue(deliveryInput())).rejects.toThrow('feed down');
    outbox.dispose();
  });

  it('labels an operator retry distinctly in the feed', async () => {
    const storage = new MemoryStorage();
    const events = new RecordingEventSink(storage);
    const adapter = new ScriptedAdapter();
    adapter.reply({ status: 'unknown' });
    const { outbox } = createOutboxFixture({ storage, events, scripted: adapter });
    const deliveryId = await enqueueOne(outbox);
    await deliverOne(outbox);
    await outbox.retry({ deliveryId });
    expect(events.events.at(-1)?.kind).toBe('outbox:delivery-retried');
    outbox.dispose();
  });
});

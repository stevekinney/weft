/**
 * The outbox state machine, edge by edge (WFT-85).
 *
 * Every transition is pure, so this file needs no storage: it builds records,
 * proposes edges, and asserts the next record or the rejection reason. The
 * unknown-outcome policy table and the recovery table are pinned here first,
 * because everything downstream — settlement, maintenance, drain — leans on
 * them.
 */

import { describe, expect, it } from 'bun:test';

import {
  isDeliveryLeaseExpired,
  recoverExpiredDelivery,
} from './application-outbox-transitions-recovery.ts';
import {
  beginDeliveryAttempt,
  claimWaitingDelivery,
  createEnqueuedDeliveryRecord,
  deadLetterDeliveryByOperator,
  heartbeatDeliveryAttempt,
  requestDeliveryCancellation,
  retryDeliveryByOperator,
  settleDeliveryAttempt,
} from './application-outbox-transitions.ts';
import type {
  ApplicationDeliveryAttempting,
  ApplicationDeliveryCancelling,
  ApplicationDeliveryClaimed,
  ApplicationDeliveryRecord,
} from './application-outbox-types.ts';
import type { ValidatedDeliveryInput, ValidatedOutcome } from './application-outbox-validation.ts';

const NOW = 1_700_000_000_000;
const BACKOFF = { retryBackoffMs: 1000, maxRetryBackoffMs: 60_000 } as const;

function input(overrides: Partial<ValidatedDeliveryInput> = {}): ValidatedDeliveryInput {
  return {
    destinationRef: 'webhook:orders',
    kind: 'order.shipped',
    payload: { form: 'inline', value: { orderId: 1 } },
    payloadDigest: 'a'.repeat(64),
    unknownOutcomePolicy: 'park',
    availableAfterMs: 0,
    maxAttempts: 3,
    visibilityTimeoutMs: 10_000,
    attemptTimeoutMs: 60_000,
    ...overrides,
  };
}

function queued(overrides: Partial<ValidatedDeliveryInput> = {}) {
  return createEnqueuedDeliveryRecord(input(overrides), {
    namespace: 'bureau',
    ownerId: 'agent-7',
    deliveryId: 'd-1',
    sequence: 0,
    now: NOW,
  });
}

function expectOk<T>(transition: { ok: true; next: T } | { ok: false; reason: string }): T {
  if (!transition.ok) throw new Error(`Expected a transition, received "${transition.reason}".`);
  return transition.next;
}

function claimed(overrides: Partial<ValidatedDeliveryInput> = {}): ApplicationDeliveryClaimed {
  return expectOk(claimWaitingDelivery(queued(overrides), { now: NOW, attemptToken: 't-1' }));
}

function attempting(
  overrides: Partial<ValidatedDeliveryInput> = {},
  now = NOW + 5,
): ApplicationDeliveryAttempting {
  return expectOk(beginDeliveryAttempt(claimed(overrides), { attemptToken: 't-1', now }));
}

function cancelling(
  overrides: Partial<ValidatedDeliveryInput> = {},
): ApplicationDeliveryCancelling {
  const next = expectOk(requestDeliveryCancellation(attempting(overrides), { now: NOW + 10 }));
  if (next.state !== 'cancellation-requested') throw new Error(`Unexpected ${next.state}.`);
  return next;
}

const ACKNOWLEDGED: ValidatedOutcome = { status: 'acknowledged', evidence: { id: 'm-1' } };
const RETRYABLE: ValidatedOutcome = {
  status: 'retryable',
  failure: { reason: 'retryable', message: '503' },
  retryAfterMs: undefined,
};
const REJECTED: ValidatedOutcome = {
  status: 'rejected',
  failure: { reason: 'application', message: '400' },
};
const UNKNOWN: ValidatedOutcome = {
  status: 'unknown',
  failure: { reason: 'unknown-outcome', message: 'socket closed' },
};

describe('enqueue and claim', () => {
  it('enqueues into queued with a delay honoured in availableAt', () => {
    const record = queued({ availableAfterMs: 500 });
    expect(record.state).toBe('queued');
    expect(record.availableAt).toBe(NOW + 500);
    expect(record.attempt).toBe(0);
  });

  it('claims a due delivery, fixing the attempt deadline and clamping visibility to it', () => {
    const record = claimed({ visibilityTimeoutMs: 100_000, attemptTimeoutMs: 60_000 });
    expect(record.attempt).toBe(1);
    expect(record.firstClaimedAt).toBe(NOW);
    expect(record.attemptDeadlineAt).toBe(NOW + 60_000);
    expect(record.visibilityExpiresAt).toBe(NOW + 60_000);
  });

  it('refuses to claim a delivery that is not yet due, leased, or terminal', () => {
    expect(
      claimWaitingDelivery(queued({ availableAfterMs: 1 }), { now: NOW, attemptToken: 't' }),
    ).toEqual({ ok: false, reason: 'not-due' });
    expect(claimWaitingDelivery(claimed(), { now: NOW, attemptToken: 't' })).toEqual({
      ok: false,
      reason: 'not-waiting',
    });
    const terminal = expectOk(
      settleDeliveryAttempt(attempting(), {
        attemptToken: 't-1',
        now: NOW + 6,
        outcome: ACKNOWLEDGED,
        ...BACKOFF,
      }),
    );
    expect(claimWaitingDelivery(terminal, { now: NOW, attemptToken: 't' })).toEqual({
      ok: false,
      reason: 'already-terminal',
    });
  });
});

describe('begin and heartbeat', () => {
  it('moves claimed to attempting exactly once, fenced on the attempt', () => {
    const record = attempting();
    expect(record.state).toBe('attempting');
    expect(record.attemptStartedAt).toBe(NOW + 5);
    expect(beginDeliveryAttempt(record, { attemptToken: 't-1', now: NOW + 6 })).toEqual({
      ok: false,
      reason: 'not-applicable',
    });
    expect(beginDeliveryAttempt(claimed(), { attemptToken: 'other', now: NOW })).toEqual({
      ok: false,
      reason: 'stale-attempt',
    });
    expect(beginDeliveryAttempt(queued(), { attemptToken: 't-1', now: NOW })).toEqual({
      ok: false,
      reason: 'not-leased',
    });
  });

  it('extends visibility on heartbeat but never the attempt deadline', () => {
    const record = claimed({ visibilityTimeoutMs: 10_000, attemptTimeoutMs: 15_000 });
    const renewed = expectOk(
      heartbeatDeliveryAttempt(record, {
        attemptToken: 't-1',
        now: NOW + 9_000,
        transportActivity: { bytesWritten: 12 },
      }),
    );
    expect(renewed.visibilityExpiresAt).toBe(NOW + 15_000);
    expect(renewed.attemptDeadlineAt).toBe(NOW + 15_000);
    expect(renewed.lastActivityAt).toBe(NOW + 9_000);
    expect(renewed.transportActivity).toEqual({ bytesWritten: 12 });
    // No new marker keeps the previous one.
    const again = expectOk(
      heartbeatDeliveryAttempt(renewed, { attemptToken: 't-1', now: NOW + 9_500 }),
    );
    expect(again.transportActivity).toEqual({ bytesWritten: 12 });
  });

  it('refuses a heartbeat past the attempt deadline or from a stale attempt', () => {
    const record = claimed({ attemptTimeoutMs: 1000 });
    expect(heartbeatDeliveryAttempt(record, { attemptToken: 't-1', now: NOW + 1000 })).toEqual({
      ok: false,
      reason: 'deadline-exceeded',
    });
    expect(heartbeatDeliveryAttempt(record, { attemptToken: 'stale', now: NOW })).toEqual({
      ok: false,
      reason: 'stale-attempt',
    });
  });
});

describe('settlement', () => {
  it('cannot settle a claimed delivery: nothing was sent', () => {
    expect(
      settleDeliveryAttempt(claimed(), {
        attemptToken: 't-1',
        now: NOW,
        outcome: ACKNOWLEDGED,
        ...BACKOFF,
      }),
    ).toEqual({ ok: false, reason: 'not-attempting' });
  });

  it('acknowledges with bounded evidence', () => {
    const next = expectOk(
      settleDeliveryAttempt(attempting(), {
        attemptToken: 't-1',
        now: NOW + 6,
        outcome: ACKNOWLEDGED,
        ...BACKOFF,
      }),
    );
    expect(next.state).toBe('acknowledged');
    expect(next.state === 'acknowledged' && next.evidence).toEqual({ id: 'm-1' });
    expect(next.state === 'acknowledged' && next.failure).toBeUndefined();
  });

  it('rejects permanently with the transport failure', () => {
    const next = expectOk(
      settleDeliveryAttempt(attempting(), {
        attemptToken: 't-1',
        now: NOW + 6,
        outcome: REJECTED,
        ...BACKOFF,
      }),
    );
    expect(next.state).toBe('rejected');
    expect(next.state === 'rejected' && next.failure).toEqual({
      reason: 'application',
      message: '400',
    });
  });

  it('reschedules a retryable outcome with the larger of backoff and retryAfterMs', () => {
    const next = expectOk(
      settleDeliveryAttempt(attempting(), {
        attemptToken: 't-1',
        now: NOW + 6,
        outcome: { ...RETRYABLE, retryAfterMs: 5000 },
        ...BACKOFF,
      }),
    );
    expect(next.state).toBe('retry-scheduled');
    expect(next.availableAt).toBe(NOW + 6 + 5000);
    expect(next.retryCount).toBe(1);
    expect(next.state === 'retry-scheduled' && next.lastFailure.reason).toBe('retryable');
    const shorter = expectOk(
      settleDeliveryAttempt(attempting(), {
        attemptToken: 't-1',
        now: NOW + 6,
        outcome: { ...RETRYABLE, retryAfterMs: 1 },
        ...BACKOFF,
      }),
    );
    expect(shorter.availableAt).toBe(NOW + 6 + 1000);
  });

  it('dead-letters a retryable outcome once attempts are exhausted', () => {
    const next = expectOk(
      settleDeliveryAttempt(attempting({ maxAttempts: 1 }), {
        attemptToken: 't-1',
        now: NOW + 6,
        outcome: RETRYABLE,
        ...BACKOFF,
      }),
    );
    expect(next.state).toBe('dead-lettered');
    expect(next.state === 'dead-lettered' && next.failure).toEqual({
      reason: 'attempts-exhausted',
      message: '503',
    });
  });

  it.each([
    ['park', 'unknown-outcome', 'unknown-outcome'],
    ['dead-letter', 'dead-lettered', 'unknown-outcome'],
    ['retry-with-idempotency', 'retry-scheduled', 'unknown-outcome'],
  ] as const)('applies the unknown-outcome policy %s', (policy, state, reason) => {
    const next: any = expectOk(
      settleDeliveryAttempt(
        attempting({ unknownOutcomePolicy: policy, externalIdempotencyKey: 'ext-1' }),
        { attemptToken: 't-1', now: NOW + 6, outcome: UNKNOWN, ...BACKOFF },
      ),
    );
    expect(next.state).toBe(state);
    expect((next.lastFailure ?? next.failure).reason).toBe(reason);
    expect(next.cleanupPending).toBeUndefined();
  });

  it('dead-letters an unknown outcome under retry-with-idempotency once attempts are exhausted', () => {
    const next = expectOk(
      settleDeliveryAttempt(
        attempting({
          unknownOutcomePolicy: 'retry-with-idempotency',
          externalIdempotencyKey: 'ext-1',
          maxAttempts: 1,
        }),
        { attemptToken: 't-1', now: NOW + 6, outcome: UNKNOWN, ...BACKOFF },
      ),
    );
    expect(next.state).toBe('dead-lettered');
    expect(next.state === 'dead-lettered' && next.failure?.reason).toBe('attempts-exhausted');
  });

  it('refuses a stale or expired settlement', () => {
    const record = attempting({ attemptTimeoutMs: 1000 });
    expect(
      settleDeliveryAttempt(record, {
        attemptToken: 'stale',
        now: NOW + 6,
        outcome: ACKNOWLEDGED,
        ...BACKOFF,
      }),
    ).toEqual({ ok: false, reason: 'stale-attempt' });
    expect(
      settleDeliveryAttempt(record, {
        attemptToken: 't-1',
        now: NOW + 1000,
        outcome: ACKNOWLEDGED,
        ...BACKOFF,
      }),
    ).toEqual({ ok: false, reason: 'deadline-exceeded' });
  });
});

describe('cancellation', () => {
  it('cancels waiting and claimed deliveries at once', () => {
    for (const record of [queued(), claimed()] as ApplicationDeliveryRecord[]) {
      const next = expectOk(requestDeliveryCancellation(record, { now: NOW + 1, reason: 'why' }));
      expect(next.state).toBe('cancelled');
      expect(next.state === 'cancelled' && next.cleanupPending).toBe(false);
      expect(next.state === 'cancelled' && next.cancellationReason).toBe('why');
    }
  });

  it('records the request on an attempting delivery and keeps its lease', () => {
    const next = cancelling();
    expect(next.attemptToken).toBe('t-1');
    expect(next.cancellationRequestedAt).toBe(NOW + 10);
    expect(requestDeliveryCancellation(next, { now: NOW + 11 })).toEqual({
      ok: false,
      reason: 'not-leased',
    });
  });

  it('refuses to cancel a terminal delivery', () => {
    const terminal = expectOk(requestDeliveryCancellation(queued(), { now: NOW }));
    expect(requestDeliveryCancellation(terminal, { now: NOW })).toEqual({
      ok: false,
      reason: 'already-terminal',
    });
  });

  it('lets an acknowledgement win over a cancellation request', () => {
    const next = expectOk(
      settleDeliveryAttempt(cancelling(), {
        attemptToken: 't-1',
        now: NOW + 11,
        outcome: ACKNOWLEDGED,
        ...BACKOFF,
      }),
    );
    expect(next.state).toBe('acknowledged');
    expect(next.state === 'acknowledged' && next.cancellationRequestedAt).toBe(NOW + 10);
  });

  it.each([
    [RETRYABLE, 'cancelled'],
    [REJECTED, 'cancelled'],
  ] as const)('honours the cancellation for a non-acknowledged outcome %#', (outcome, state) => {
    const next = expectOk(
      settleDeliveryAttempt(cancelling(), {
        attemptToken: 't-1',
        now: NOW + 11,
        outcome,
        ...BACKOFF,
      }),
    );
    expect(next.state).toBe(state);
    expect(next.state === 'cancelled' && next.cleanupPending).toBe(false);
  });

  it('never retries a cancelled delivery after an unknown outcome', () => {
    const parked = expectOk(
      settleDeliveryAttempt(
        cancelling({ unknownOutcomePolicy: 'retry-with-idempotency', externalIdempotencyKey: 'e' }),
        { attemptToken: 't-1', now: NOW + 11, outcome: UNKNOWN, ...BACKOFF },
      ),
    );
    expect(parked.state).toBe('unknown-outcome');
    const dead = expectOk(
      settleDeliveryAttempt(cancelling({ unknownOutcomePolicy: 'dead-letter' }), {
        attemptToken: 't-1',
        now: NOW + 11,
        outcome: UNKNOWN,
        ...BACKOFF,
      }),
    );
    expect(dead.state).toBe('dead-lettered');
  });
});

describe('recovery', () => {
  it('detects an expired lease by visibility or by attempt deadline', () => {
    const record = claimed({ visibilityTimeoutMs: 100, attemptTimeoutMs: 1000 });
    expect(isDeliveryLeaseExpired(record, NOW + 99)).toBe(false);
    expect(isDeliveryLeaseExpired(record, NOW + 100)).toBe(true);
    const renewed = expectOk(
      heartbeatDeliveryAttempt(record, { attemptToken: 't-1', now: NOW + 950 }),
    );
    expect(isDeliveryLeaseExpired(renewed, NOW + 1000)).toBe(true);
    expect(isDeliveryLeaseExpired(queued(), NOW + 1_000_000)).toBe(false);
  });

  it('reschedules an expired claimed lease: nothing was sent', () => {
    const next = expectOk(recoverExpiredDelivery(claimed(), { now: NOW + 10_000, ...BACKOFF }));
    expect(next.state).toBe('retry-scheduled');
    expect(next.state === 'retry-scheduled' && next.lastFailure.reason).toBe('retryable');
    expect(next.availableAt).toBe(NOW + 10_000 + 1000);
  });

  it('dead-letters an expired claimed lease with no attempts left, naming the abandoned attempt', () => {
    const next = expectOk(
      recoverExpiredDelivery(claimed({ maxAttempts: 1 }), { now: NOW + 10_000, ...BACKOFF }),
    );
    expect(next.state).toBe('dead-lettered');
    expect(next.state === 'dead-lettered' && next.cleanupPending).toBe(true);
    expect(next.state === 'dead-lettered' && next.abandonedAttemptToken).toBe('t-1');
  });

  it.each([
    ['park', 'unknown-outcome'],
    ['dead-letter', 'dead-lettered'],
    ['retry-with-idempotency', 'retry-scheduled'],
  ] as const)('applies the policy %s to an expired attempting lease', (policy, state) => {
    const next: any = expectOk(
      recoverExpiredDelivery(
        attempting({ unknownOutcomePolicy: policy, externalIdempotencyKey: 'e' }),
        { now: NOW + 100_000, ...BACKOFF },
      ),
    );
    expect(next.state).toBe(state);
    if (state !== 'retry-scheduled') {
      expect(next.cleanupPending).toBe(true);
      expect(next.abandonedAttemptToken).toBe('t-1');
    }
  });

  it('parks an expired cancellation-requested lease rather than retrying it', () => {
    const next = expectOk(
      recoverExpiredDelivery(
        cancelling({ unknownOutcomePolicy: 'retry-with-idempotency', externalIdempotencyKey: 'e' }),
        { now: NOW + 100_000, ...BACKOFF },
      ),
    );
    expect(next.state).toBe('unknown-outcome');
    expect(next.state === 'unknown-outcome' && next.cancellationRequestedAt).toBe(NOW + 10);
    expect(next.state === 'unknown-outcome' && next.cleanupPending).toBe(true);
  });

  it('refuses recovery of a waiting, live, or terminal record', () => {
    expect(recoverExpiredDelivery(queued(), { now: NOW, ...BACKOFF })).toEqual({
      ok: false,
      reason: 'not-leased',
    });
    expect(recoverExpiredDelivery(claimed(), { now: NOW, ...BACKOFF })).toEqual({
      ok: false,
      reason: 'not-due',
    });
    const terminal = expectOk(requestDeliveryCancellation(queued(), { now: NOW }));
    expect(recoverExpiredDelivery(terminal, { now: NOW, ...BACKOFF })).toEqual({
      ok: false,
      reason: 'already-terminal',
    });
  });
});

describe('operator transitions', () => {
  it('retries a parked delivery with exactly one more attempt', () => {
    const parked = expectOk(
      recoverExpiredDelivery(attempting({ maxAttempts: 1 }), { now: NOW + 100_000, ...BACKOFF }),
    );
    expect(parked.state).toBe('unknown-outcome');
    const retried = expectOk(retryDeliveryByOperator(parked, { now: NOW + 20_000 }));
    expect(retried.state).toBe('queued');
    expect(retried.maxAttempts).toBe(2);
    expect(retried.attempt).toBe(1);
    expect(retried.availableAt).toBe(NOW + 20_000);
  });

  it('keeps a larger attempt budget on operator retry', () => {
    const rejected = expectOk(
      settleDeliveryAttempt(attempting({ maxAttempts: 5 }), {
        attemptToken: 't-1',
        now: NOW + 6,
        outcome: REJECTED,
        ...BACKOFF,
      }),
    );
    expect(expectOk(retryDeliveryByOperator(rejected, { now: NOW })).maxAttempts).toBe(5);
  });

  it('refuses to retry a live or acknowledged delivery', () => {
    expect(retryDeliveryByOperator(queued(), { now: NOW })).toEqual({
      ok: false,
      reason: 'not-applicable',
    });
    const acknowledged = expectOk(
      settleDeliveryAttempt(attempting(), {
        attemptToken: 't-1',
        now: NOW + 6,
        outcome: ACKNOWLEDGED,
        ...BACKOFF,
      }),
    );
    expect(retryDeliveryByOperator(acknowledged, { now: NOW })).toEqual({
      ok: false,
      reason: 'not-applicable',
    });
  });

  it('dead-letters only a parked delivery, carrying its abandoned attempt forward', () => {
    const parked = expectOk(
      recoverExpiredDelivery(attempting(), { now: NOW + 100_000, ...BACKOFF }),
    );
    const dead = expectOk(
      deadLetterDeliveryByOperator(parked, { now: NOW + 200_000, reason: 'operator gave up' }),
    );
    expect(dead.state).toBe('dead-lettered');
    expect(dead.failure).toEqual({ reason: 'unknown-outcome', message: 'operator gave up' });
    expect(dead.abandonedAttemptToken).toBe('t-1');
    expect(dead.cleanupPending).toBe(true);
    expect(deadLetterDeliveryByOperator(queued(), { now: NOW })).toEqual({
      ok: false,
      reason: 'not-applicable',
    });
    const withoutReason = expectOk(deadLetterDeliveryByOperator(parked, { now: NOW + 200_000 }));
    expect(withoutReason.failure?.message).toBe(
      parked.state === 'unknown-outcome' ? parked.failure?.message : undefined,
    );
  });
});

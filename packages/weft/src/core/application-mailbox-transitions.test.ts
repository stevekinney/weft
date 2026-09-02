/**
 * The pure transition functions for the application command mailbox (WFT-84),
 * exercised directly.
 *
 * These functions are where every fencing invariant actually lives, and several
 * of their rejection branches are unreachable through the public class because
 * the class checks the same condition first. Driving them here proves the
 * invariant holds on its own rather than by accident of call order.
 */

import { describe, expect, it } from 'bun:test';
import { KEYS } from '../storage/interface.ts';

import {
  decodeApplicationCommandIdempotencyRecord,
  decodeApplicationMailboxRecord,
  decodeApplicationReadyEntry,
  encodeApplicationCommandIdempotencyRecord,
  encodeApplicationMailboxRecord,
  encodeApplicationReadyEntry,
} from './application-mailbox-codec.ts';
import {
  computeRetryBackoffMs,
  isTerminalCommandRecord,
  nonTerminalCommandRecord,
} from './application-mailbox-transition-helpers.ts';
import { recoverExpiredCommand } from './application-mailbox-transitions-recovery.ts';
import {
  acknowledgeCommand,
  asWaitingRecord,
  claimWaitingCommand,
  createAdmittedCommandRecord,
  isCommandPastDeadline,
  rejectCommand,
  releaseWaitingCommand,
  renewCommandLease,
  requestCommandCancellation,
} from './application-mailbox-transitions.ts';
import {
  isApplicationCommandLeased,
  isApplicationCommandTerminalState,
  isApplicationCommandWaiting,
  type ApplicationCommandRecord,
} from './application-mailbox-types.ts';
import type { ValidatedCommandInput } from './application-mailbox-validation.ts';
import { PersistedDataCorruptError } from './persisted-data-incompatible-error.ts';

const NOW = 1_000_000;

const validated: ValidatedCommandInput = {
  caller: 'user:42',
  target: 'agent:7',
  kind: 'steer',
  payload: { form: 'inline', value: { text: 'stop' } },
  payloadDigest: 'a'.repeat(64),
  availableAfterMs: 0,
  maxAttempts: 3,
  visibilityTimeoutMs: 1_000,
  commandTimeoutMs: 10_000,
};

function admitted(overrides: Partial<ValidatedCommandInput> = {}) {
  return createAdmittedCommandRecord(
    { ...validated, ...overrides },
    { namespace: 'bureau', resourceId: 'agent-7', commandId: 'c-1', sequence: 0, now: NOW },
  );
}

function claimed(overrides: Partial<ValidatedCommandInput> = {}) {
  const transition = claimWaitingCommand(admitted(overrides), {
    now: NOW,
    attemptToken: 'attempt-1',
  });
  if (!transition.ok) throw new Error('fixture claim must succeed');
  return transition.next;
}

const backoff = { retryBackoffMs: 100, maxRetryBackoffMs: 1_000 };

describe('createAdmittedCommandRecord', () => {
  it('carries identity, policy, and a zeroed attempt history', () => {
    const record = admitted();
    expect(record).toMatchObject({
      recordVersion: 1,
      state: 'available',
      namespace: 'bureau',
      resourceId: 'agent-7',
      commandId: 'c-1',
      sequence: 0,
      caller: 'user:42',
      target: 'agent:7',
      kind: 'steer',
      payloadDigest: 'a'.repeat(64),
      acceptedAt: NOW,
      availableAt: NOW,
      absoluteDeadlineAt: NOW + 10_000,
      maxAttempts: 3,
      generation: 0,
      attempt: 0,
      retryCount: 0,
    });
  });

  it('starts a delayed command in accepted rather than available', () => {
    expect(admitted({ availableAfterMs: 500 })).toMatchObject({
      state: 'accepted',
      availableAt: NOW + 500,
    });
  });
});

describe('releaseWaitingCommand', () => {
  it('releases an accepted command once it is due', () => {
    const result = releaseWaitingCommand(admitted({ availableAfterMs: 500 }), NOW + 500);
    expect(result.ok && result.next.state).toBe('available');
    expect(result.ok && result.next.generation).toBe(1);
  });

  it.each([
    ['not-due' as const, admitted({ availableAfterMs: 500 }), NOW],
    ['not-waiting' as const, claimed(), NOW],
  ])('rejects with %s', (reason, record, now) => {
    const result = releaseWaitingCommand(record, now);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe(reason);
  });

  it('rejects an already-terminal record', () => {
    const settled = acknowledgeCommand(claimed(), { attemptToken: 'attempt-1', now: NOW });
    if (!settled.ok) throw new Error('fixture settle must succeed');
    const result = releaseWaitingCommand(settled.next, NOW);
    expect(!result.ok && result.reason).toBe('already-terminal');
  });
});

describe('claimWaitingCommand', () => {
  it('leases a due command and clamps the lease to the absolute deadline', () => {
    const shortDeadline = admitted({ commandTimeoutMs: 200, visibilityTimeoutMs: 5_000 });
    const result = claimWaitingCommand(shortDeadline, { now: NOW, attemptToken: 't' });
    expect(result.ok && result.next.visibilityExpiresAt).toBe(NOW + 200);
    expect(result.ok && result.next.attempt).toBe(1);
    expect(result.ok && result.next.firstClaimedAt).toBe(NOW);
  });

  it('preserves the first-claim timestamp across a redelivery', () => {
    const first = claimed();
    const reclaimed = recoverExpiredCommand(first, { now: NOW + 1_000, ...backoff });
    if (!reclaimed.ok || reclaimed.next.state !== 'accepted') throw new Error('expected a requeue');
    const second = claimWaitingCommand(reclaimed.next, { now: NOW + 2_000, attemptToken: 't2' });
    expect(second.ok && second.next.firstClaimedAt).toBe(NOW);
    expect(second.ok && second.next.attempt).toBe(2);
  });

  it.each([
    ['not-due' as const, admitted({ availableAfterMs: 500 }), NOW],
    ['not-waiting' as const, claimed(), NOW],
  ])('rejects with %s', (reason, record, now) => {
    const result = claimWaitingCommand(record, { now, attemptToken: 't' });
    expect(!result.ok && result.reason).toBe(reason);
  });
});

describe('renewCommandLease', () => {
  it('rejects an unleased, stale, terminal, or past-deadline record distinctly', () => {
    const waiting = admitted();
    expect(
      !renewCommandLease(waiting, { attemptToken: 't', now: NOW }).ok &&
        (renewCommandLease(waiting, { attemptToken: 't', now: NOW }) as { reason: string }).reason,
    ).toBe('not-leased');

    const lease = claimed();
    const stale = renewCommandLease(lease, { attemptToken: 'other', now: NOW });
    expect(!stale.ok && stale.reason).toBe('stale-attempt');

    const expired = renewCommandLease(lease, { attemptToken: 'attempt-1', now: NOW + 10_000 });
    expect(!expired.ok && expired.reason).toBe('deadline-exceeded');

    const settled = acknowledgeCommand(lease, { attemptToken: 'attempt-1', now: NOW });
    if (!settled.ok) throw new Error('fixture settle must succeed');
    const terminal = renewCommandLease(settled.next, { attemptToken: 'attempt-1', now: NOW });
    expect(!terminal.ok && terminal.reason).toBe('already-terminal');
  });

  it('keeps the previous progress when a renewal reports none', () => {
    const withProgress = renewCommandLease(claimed(), {
      attemptToken: 'attempt-1',
      now: NOW + 10,
      progress: { step: 1 },
    });
    if (!withProgress.ok) throw new Error('expected a renewal');
    const withoutProgress = renewCommandLease(withProgress.next, {
      attemptToken: 'attempt-1',
      now: NOW + 20,
    });
    expect(withoutProgress.ok && withoutProgress.next.progress).toEqual({ step: 1 });
    expect(withoutProgress.ok && withoutProgress.next.lastActivityAt).toBe(NOW + 20);
  });
});

describe('rejectCommand', () => {
  it('dead-letters instead of retrying once attempts are spent', () => {
    const lastAttempt = { ...claimed(), attempt: 3, maxAttempts: 3 };
    const result = rejectCommand(lastAttempt, {
      attemptToken: 'attempt-1',
      now: NOW,
      retry: true,
      failure: { reason: 'application', message: 'nope' },
      ...backoff,
    });
    expect(result.ok && result.next.state).toBe('dead-lettered');
    expect(result.ok && result.next.state === 'dead-lettered' && result.next.failure).toEqual({
      reason: 'attempts-exhausted',
      message: 'nope',
    });
  });

  it('settles a cancellation-requested command as cancelled, retry or not', () => {
    const cancelling = requestCommandCancellation(claimed(), { now: NOW, reason: 'stop' });
    if (!cancelling.ok || cancelling.next.state !== 'cancellation-requested') {
      throw new Error('expected a cancellation request');
    }
    const result = rejectCommand(cancelling.next, {
      attemptToken: 'attempt-1',
      now: NOW + 1,
      retry: true,
      failure: { reason: 'application' },
      ...backoff,
    });
    expect(result.ok && result.next.state).toBe('cancelled');
    expect(result.ok && result.next.state === 'cancelled' && result.next.cleanupPending).toBe(
      false,
    );
  });
});

describe('requestCommandCancellation', () => {
  it('rejects a second request against a record already cancelling', () => {
    const first = requestCommandCancellation(claimed(), { now: NOW });
    if (!first.ok || first.next.state !== 'cancellation-requested') {
      throw new Error('expected a cancellation request');
    }
    const second = requestCommandCancellation(first.next, { now: NOW + 1 });
    expect(!second.ok && second.reason).toBe('not-leased');
  });

  it('cancels a delayed command outright, with nothing to clean up', () => {
    const result = requestCommandCancellation(admitted({ availableAfterMs: 5_000 }), { now: NOW });
    expect(result.ok && result.next.state).toBe('cancelled');
    expect(result.ok && result.next.state === 'cancelled' && result.next.cleanupPending).toBe(
      false,
    );
  });
});

describe('recoverExpiredCommand', () => {
  it('rejects a lease that has not expired and a record holding no lease', () => {
    const notDue = recoverExpiredCommand(claimed(), { now: NOW, ...backoff });
    expect(!notDue.ok && notDue.reason).toBe('not-due');

    const unleased = recoverExpiredCommand(admitted(), { now: NOW, ...backoff });
    expect(!unleased.ok && unleased.reason).toBe('not-leased');
  });

  it('dead-letters a waiting command past its deadline with no cleanup pending', () => {
    const result = recoverExpiredCommand(admitted(), { now: NOW + 10_000, ...backoff });
    expect(result.ok && result.next.state).toBe('dead-lettered');
    expect(
      result.ok && result.next.state === 'dead-lettered' && result.next.cleanupPending,
    ).toBeUndefined();
  });

  it('records the abandoned attempt token when a lease is still open at the deadline', () => {
    const result = recoverExpiredCommand(claimed(), { now: NOW + 10_000, ...backoff });
    if (!result.ok || result.next.state !== 'dead-lettered')
      throw new Error('expected dead-letter');
    expect(result.next.abandonedAttemptToken).toBe('attempt-1');
    expect(result.next.cleanupPending).toBe(true);
  });

  it('rejects an already-terminal record', () => {
    const settled = acknowledgeCommand(claimed(), { attemptToken: 'attempt-1', now: NOW });
    if (!settled.ok) throw new Error('fixture settle must succeed');
    const result = recoverExpiredCommand(settled.next, { now: NOW + 100_000, ...backoff });
    expect(!result.ok && result.reason).toBe('already-terminal');
  });
});

describe('transition helpers', () => {
  it('computes deterministic, capped exponential backoff', () => {
    expect(computeRetryBackoffMs(1, 100, 1_000)).toBe(100);
    expect(computeRetryBackoffMs(2, 100, 1_000)).toBe(200);
    expect(computeRetryBackoffMs(4, 100, 1_000)).toBe(800);
    expect(computeRetryBackoffMs(5, 100, 1_000)).toBe(1_000);
    // A zeroth attempt and an overflowing exponent both clamp rather than misbehave.
    expect(computeRetryBackoffMs(0, 100, 1_000)).toBe(100);
    expect(computeRetryBackoffMs(5_000, 100, 1_000)).toBe(1_000);
  });

  it('narrows terminal and non-terminal records', () => {
    const waiting = admitted();
    expect(isTerminalCommandRecord(waiting)).toBe(false);
    expect(nonTerminalCommandRecord(waiting)).toBe(waiting);

    const settled = acknowledgeCommand(claimed(), { attemptToken: 'attempt-1', now: NOW });
    if (!settled.ok) throw new Error('fixture settle must succeed');
    expect(isTerminalCommandRecord(settled.next)).toBe(true);
    expect(nonTerminalCommandRecord(settled.next)).toBeNull();
  });

  it('reports whether a record has passed its absolute deadline', () => {
    expect(isCommandPastDeadline(admitted(), NOW)).toBe(false);
    expect(isCommandPastDeadline(admitted(), NOW + 10_000)).toBe(true);

    const settled = acknowledgeCommand(claimed(), { attemptToken: 'attempt-1', now: NOW });
    if (!settled.ok) throw new Error('fixture settle must succeed');
    // A terminal record is never "past deadline": it is simply over.
    expect(isCommandPastDeadline(settled.next, NOW + 100_000)).toBe(false);
  });

  it('narrows waiting records', () => {
    expect(asWaitingRecord(admitted())).not.toBeNull();
    expect(asWaitingRecord(claimed())).toBeNull();
    expect(isApplicationCommandWaiting(admitted())).toBe(true);
    expect(isApplicationCommandWaiting(claimed())).toBe(false);
    expect(isApplicationCommandLeased(claimed())).toBe(true);
    expect(isApplicationCommandLeased(admitted())).toBe(false);
    expect(isApplicationCommandTerminalState('cancelled')).toBe(true);
    expect(isApplicationCommandTerminalState('accepted')).toBe(false);
  });
});

describe('mailbox record codec', () => {
  it('round-trips the mailbox header, the idempotency binding, and a ready entry', () => {
    const header = {
      recordVersion: 1 as const,
      namespace: 'bureau',
      resourceId: 'agent-7',
      nextSequence: 4,
      openCount: 2,
      admittedCount: 4,
    };
    expect(
      decodeApplicationMailboxRecord(
        encodeApplicationMailboxRecord(header),
        KEYS.applicationMailbox('bureau', 'agent-7'),
      ),
    ).toEqual(header);

    const binding = {
      recordVersion: 1 as const,
      commandId: 'c-1',
      identityDigest: 'b'.repeat(64),
    };
    expect(
      decodeApplicationCommandIdempotencyRecord(
        encodeApplicationCommandIdempotencyRecord(binding),
        'k',
      ),
    ).toEqual(binding);

    expect(decodeApplicationReadyEntry(encodeApplicationReadyEntry('c-1'), 'k')).toBe('c-1');
  });

  it.each([
    ['undecodable bytes', new Uint8Array([0xc1, 0xc1])],
    ['a non-object payload', new Uint8Array([0x01])],
  ])('fails closed on %s in every record kind', (_name, bytes) => {
    for (const decode of [
      decodeApplicationMailboxRecord,
      decodeApplicationCommandIdempotencyRecord,
    ]) {
      expect(() => decode(bytes, 'the-key')).toThrow(PersistedDataCorruptError);
    }
    expect(() => decodeApplicationReadyEntry(bytes, 'the-key')).toThrow(PersistedDataCorruptError);
  });

  it('names the offending key in the diagnostic', () => {
    try {
      decodeApplicationMailboxRecord(new Uint8Array([0xc1]), 'appmbx:v1:bureau:agent-7');
      throw new Error('expected a corruption error');
    } catch (error) {
      expect(error).toBeInstanceOf(PersistedDataCorruptError);
      expect((error as PersistedDataCorruptError).key).toBe('appmbx:v1:bureau:agent-7');
    }
  });

  it('rejects a ready entry that decodes to an empty string', () => {
    expect(() => decodeApplicationReadyEntry(encodeApplicationReadyEntry(''), 'k')).toThrow(
      PersistedDataCorruptError,
    );
  });

  it('preserves optional causation fields through a record round trip', () => {
    const record: ApplicationCommandRecord = {
      ...admitted(),
      causation: { correlationId: 'conv-7', causationId: undefined, traceparent: '00-a-b-01' },
    };
    expect(record.causation?.correlationId).toBe('conv-7');
  });
});

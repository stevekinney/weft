/**
 * Fail-closed decoding for the application outbox's records and index
 * entries (WFT-85). Every malformed shape must surface as
 * `PersistedDataCorruptError`, never as a plausible-looking record.
 */

import { describe, expect, it } from 'bun:test';

import { KEYS } from '../storage/interface.ts';
import {
  decodeApplicationDeliveryRecord,
  encodeApplicationDeliveryRecord,
} from './application-outbox-codec.ts';
import {
  decodeApplicationDeliveryEntry,
  decodeApplicationDeliveryIdempotencyRecord,
  decodeApplicationOutboxRecord,
  encodeApplicationDeliveryEntry,
  encodeApplicationDeliveryIdempotencyRecord,
  encodeApplicationOutboxRecord,
} from './application-outbox-index-codec.ts';
import type { ApplicationDeliveryRecord } from './application-outbox-types.ts';
import { readVersion } from './application-primitive-codec.ts';
import { encode } from './codec.ts';
import { PersistedDataCorruptError } from './persisted-data-incompatible-error.ts';

const KEY = KEYS.applicationDelivery('bureau', 'agent-7', 'd-1');

function base(): Record<string, unknown> {
  return {
    recordVersion: 1,
    namespace: 'bureau',
    ownerId: 'agent-7',
    deliveryId: 'd-1',
    sequence: 0,
    destinationRef: 'webhook:orders',
    kind: 'order.shipped',
    payload: { form: 'inline', value: { orderId: 1 } },
    payloadDigest: 'a'.repeat(64),
    unknownOutcomePolicy: 'park',
    enqueuedAt: 10,
    availableAt: 10,
    maxAttempts: 3,
    visibilityTimeoutMs: 100,
    attemptTimeoutMs: 1000,
    generation: 0,
    attempt: 0,
    retryCount: 0,
  };
}

function leased(state: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...base(),
    state,
    attempt: 1,
    attemptToken: 't-1',
    claimedAt: 10,
    attemptDeadlineAt: 1010,
    visibilityExpiresAt: 110,
    lastActivityAt: 10,
    ...(state === 'claimed' ? {} : { attemptStartedAt: 12 }),
    ...(state === 'cancellation-requested' ? { cancellationRequestedAt: 15 } : {}),
    ...extra,
  };
}

function terminal(state: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...base(), state, terminalAt: 20, ...extra };
}

function decodes(record: Record<string, unknown>): ApplicationDeliveryRecord {
  return decodeApplicationDeliveryRecord(encode(record), KEY);
}

function rejects(record: unknown): void {
  expect(() => decodeApplicationDeliveryRecord(encode(record), KEY)).toThrow(
    PersistedDataCorruptError,
  );
}

describe('delivery record codec', () => {
  it('round-trips every state', () => {
    const records: Record<string, unknown>[] = [
      { ...base(), state: 'queued' },
      { ...base(), state: 'retry-scheduled', retryCount: 1, lastFailure: { reason: 'retryable' } },
      leased('claimed', { transportActivity: { bytes: 1 } }),
      leased('attempting'),
      leased('cancellation-requested', { cancellationReason: 'why' }),
      terminal('acknowledged', { evidence: { id: 'm' } }),
      terminal('rejected', { failure: { reason: 'application', details: { code: 1 } } }),
      terminal('cancelled', { failure: { reason: 'cancelled' }, cleanupPending: false }),
      terminal('unknown-outcome', {
        failure: { reason: 'unknown-outcome' },
        cleanupPending: true,
        abandonedAttemptToken: 't-1',
      }),
      terminal('dead-lettered', { failure: { reason: 'attempts-exhausted' } }),
      terminal('dead-lettered', { failure: { reason: 'unknown-outcome' } }),
      {
        ...base(),
        state: 'queued',
        payload: { form: 'reference', reference: 'blob:1', digest: 'b'.repeat(64), byteLength: 3 },
        payloadDigest: 'b'.repeat(64),
        causation: { correlationId: 'c' },
        idempotencyKey: 'k',
        externalIdempotencyKey: 'e',
        unknownOutcomePolicy: 'retry-with-idempotency',
        credentialRef: 'cred',
        payloadMediaType: 'application/json',
        payloadSchema: 's',
        firstClaimedAt: 5,
      },
    ];
    for (const record of records) {
      const decoded = decodes(record);
      expect(decodes(decodeAgain(decoded))).toEqual(decoded);
    }
  });

  it.each<[string, unknown]>([
    ['undecodable bytes', undefined],
    ['non-object', 'text'],
    ['wrong version', { ...base(), state: 'queued', recordVersion: 2 }],
    ['misplaced identity', { ...base(), state: 'queued', deliveryId: 'other' }],
    ['unknown state', { ...base(), state: 'flying' }],
    ['waiting with spent budget', { ...base(), state: 'queued', attempt: 3 }],
    ['retry without failure', { ...base(), state: 'retry-scheduled' }],
    [
      'retry with wrong failure',
      { ...base(), state: 'retry-scheduled', lastFailure: { reason: 'cancelled' } },
    ],
    [
      'unknown failure reason',
      { ...base(), state: 'retry-scheduled', lastFailure: { reason: 'meh' } },
    ],
    ['failure not an object', { ...base(), state: 'retry-scheduled', lastFailure: 'x' }],
    [
      'policy without evidence',
      { ...base(), state: 'queued', unknownOutcomePolicy: 'retry-with-idempotency' },
    ],
    ['unknown policy', { ...base(), state: 'queued', unknownOutcomePolicy: 'never' }],
    ['payload not an object', { ...base(), state: 'queued', payload: 1 }],
    ['inline without value', { ...base(), state: 'queued', payload: { form: 'inline' } }],
    ['unknown payload form', { ...base(), state: 'queued', payload: { form: 'x' } }],
    [
      'reference with bad digest',
      { ...base(), state: 'queued', payload: { form: 'reference', reference: 'r', digest: 'z' } },
    ],
    [
      'reference digest mismatch',
      {
        ...base(),
        state: 'queued',
        payload: { form: 'reference', reference: 'r', digest: 'b'.repeat(64) },
      },
    ],
    ['causation not an object', { ...base(), state: 'queued', causation: 1 }],
    ['bad idempotency key', { ...base(), state: 'queued', idempotencyKey: '' }],
    ['leased attempt zero', leased('claimed', { attempt: 0 })],
    ['leased attempt over budget', leased('claimed', { attempt: 4 })],
    ['deadline not from claim', leased('claimed', { attemptDeadlineAt: 999 })],
    ['visibility not derived', leased('claimed', { visibilityExpiresAt: 50 })],
    [
      'activity not JSON',
      leased('claimed', {
        transportActivity: undefined,
        progress: 1,
        transportActivityX: 1,
        lastActivityAt: 'x',
      }),
    ],
    ['attempting without start', { ...leased('attempting'), attemptStartedAt: undefined }],
    [
      'cancelling without request',
      { ...leased('cancellation-requested'), cancellationRequestedAt: undefined },
    ],
    ['acknowledged with failure', terminal('acknowledged', { failure: { reason: 'application' } })],
    ['rejected without failure', terminal('rejected')],
    ['cancelled wrong reason', terminal('cancelled', { failure: { reason: 'application' } })],
    ['parked wrong reason', terminal('unknown-outcome', { failure: { reason: 'cancelled' } })],
    [
      'dead-lettered wrong reason',
      terminal('dead-lettered', { failure: { reason: 'application' } }),
    ],
    [
      'cleanup pending without token',
      terminal('unknown-outcome', { failure: { reason: 'unknown-outcome' }, cleanupPending: true }),
    ],
    [
      'abandoned token without cleanup',
      terminal('unknown-outcome', {
        failure: { reason: 'unknown-outcome' },
        abandonedAttemptToken: 't',
      }),
    ],
    [
      'cleanup pending on acknowledged',
      terminal('acknowledged', { cleanupPending: true, abandonedAttemptToken: 't' }),
    ],
    ['cleanup pending not boolean', terminal('acknowledged', { cleanupPending: 'yes' })],
    ['evidence not JSON', terminal('acknowledged', { evidence: undefined, terminalAt: 'x' })],
    [
      'failure details not JSON',
      terminal('rejected', {
        failure: {
          reason: 'application',
          details: { nested: undefined, fn: 1, date: new Date(0) },
        },
      }),
    ],
  ])('fails closed on %s', (_name, record) => {
    if (record === undefined) {
      expect(() => decodeApplicationDeliveryRecord(new Uint8Array([1, 2, 3]), KEY)).toThrow(
        PersistedDataCorruptError,
      );
      return;
    }
    rejects(record);
  });

  it('fails closed on an identity that cannot build its own key', () => {
    rejects({ ...base(), state: 'queued', deliveryId: '\uD800' });
  });
});

describe('record version reader', () => {
  it('checks the version the owning codec expects, not the mailbox default', () => {
    expect(() => readVersion({ recordVersion: 2 }, 'k', 2)).not.toThrow();
    expect(() => readVersion({ recordVersion: 2 }, 'k')).toThrow(PersistedDataCorruptError);
    expect(() => readVersion({ recordVersion: 1 }, 'k', 2)).toThrow(PersistedDataCorruptError);
  });
});

describe('index codecs', () => {
  const HEADER = KEYS.applicationOutbox('bureau', 'agent-7');

  it('round-trips the header and rejects inconsistent counters', () => {
    const header = {
      recordVersion: 1 as const,
      namespace: 'bureau',
      ownerId: 'agent-7',
      nextSequence: 3,
      openCount: 1,
      enqueuedCount: 3,
    };
    expect(decodeApplicationOutboxRecord(encodeApplicationOutboxRecord(header), HEADER)).toEqual(
      header,
    );
    for (const broken of [
      { ...header, openCount: 4 },
      { ...header, nextSequence: 2 },
      { ...header, ownerId: 'other' },
      { ...header, recordVersion: 9 },
      'nope',
    ]) {
      expect(() => decodeApplicationOutboxRecord(encode(broken), HEADER)).toThrow(
        PersistedDataCorruptError,
      );
    }
    expect(() => decodeApplicationOutboxRecord(new Uint8Array([9]), HEADER)).toThrow(
      PersistedDataCorruptError,
    );
  });

  it('round-trips the idempotency binding and rejects damage', () => {
    const key = KEYS.applicationDeliveryIdempotency('bureau', 'agent-7', 'k');
    const binding = { recordVersion: 1 as const, deliveryId: 'd-1', identityDigest: 'x' };
    expect(
      decodeApplicationDeliveryIdempotencyRecord(
        encodeApplicationDeliveryIdempotencyRecord(binding),
        key,
      ),
    ).toEqual(binding);
    for (const broken of [{ ...binding, deliveryId: '' }, { ...binding, recordVersion: 2 }, 1]) {
      expect(() => decodeApplicationDeliveryIdempotencyRecord(encode(broken), key)).toThrow(
        PersistedDataCorruptError,
      );
    }
    expect(() => decodeApplicationDeliveryIdempotencyRecord(new Uint8Array([9]), key)).toThrow(
      PersistedDataCorruptError,
    );
  });

  it('round-trips an index entry and rejects a non-identifier', () => {
    expect(decodeApplicationDeliveryEntry(encodeApplicationDeliveryEntry('d-1'), 'k')).toBe('d-1');
    expect(() => decodeApplicationDeliveryEntry(encode(''), 'k')).toThrow(
      PersistedDataCorruptError,
    );
    expect(() => decodeApplicationDeliveryEntry(new Uint8Array([9]), 'k')).toThrow(
      PersistedDataCorruptError,
    );
  });
});

function decodeAgain(record: ApplicationDeliveryRecord): Record<string, unknown> {
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}

void encodeApplicationDeliveryRecord;

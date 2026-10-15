import { describe, expect, it } from 'bun:test';

import { encode } from '../codec.ts';
import { MAX_TASK_REASON_BYTES, utf8ByteLength } from './task-ledger-limits.ts';
import {
  appendTaskResultDelivery,
  boundTaskResultDeliveryReason,
  decodeTaskResultDeliveryHistory,
  encodeTaskResultDeliveryHistory,
  isTaskResultDeliveryEntry,
  TASK_RESULT_DELIVERY_HISTORY_LIMIT,
  taskResultDeliveryKey,
  type TaskResultDeliveryEntry,
} from './task-result-delivery.ts';

function acknowledged(receivedAt: number): TaskResultDeliveryEntry {
  return {
    attemptTokenDigest: 'sha256:abc',
    transport: 'webSocket',
    workerId: 'w-1',
    submittedStatus: 'completed',
    receivedAt,
    outcome: 'acknowledged',
    disposition: 'applied',
  };
}

describe('task result delivery history', () => {
  it('encodes the operationId as one key component so a separator cannot collide', () => {
    expect(taskResultDeliveryKey('a:b')).not.toBe(taskResultDeliveryKey('a'));
    expect(taskResultDeliveryKey('op-1').startsWith('task-result-delivery:')).toBe(true);
  });

  it('round-trips a valid history', () => {
    const history = appendTaskResultDelivery(null, 'op-1', acknowledged(1));
    expect(decodeTaskResultDeliveryHistory(encodeTaskResultDeliveryHistory(history))).toEqual(
      history,
    );
  });

  it('decodes absent bytes and hostile records to null', () => {
    expect(decodeTaskResultDeliveryHistory(null)).toBeNull();
    expect(decodeTaskResultDeliveryHistory(encode({ recordVersion: 1 }))).toBeNull();
    expect(
      decodeTaskResultDeliveryHistory(
        encode({
          recordVersion: 1,
          operationId: 'op-1',
          entries: [{ ...acknowledged(1), disposition: 'resolved' }],
          droppedCount: 0,
        }),
      ),
    ).toBeNull();
    expect(
      decodeTaskResultDeliveryHistory(
        encode({ recordVersion: 1, operationId: 'op-1', entries: [], droppedCount: -1 }),
      ),
    ).toBeNull();
  });

  it('validates each outcome branch independently', () => {
    expect(isTaskResultDeliveryEntry(acknowledged(1))).toBe(true);
    expect(isTaskResultDeliveryEntry({ ...acknowledged(1), oversizedPayload: false })).toBe(false);
    const rejected = {
      attemptTokenDigest: 'sha256:abc',
      transport: 'longPoll',
      submittedStatus: 'failed',
      receivedAt: 2,
      outcome: 'rejected',
      rejectionCode: 'queue-mismatch',
      reason: 'wrong queue',
    };
    expect(isTaskResultDeliveryEntry(rejected)).toBe(true);
    expect(isTaskResultDeliveryEntry({ ...rejected, rejectionCode: 'unknown-operation' })).toBe(
      false,
    );
    expect(isTaskResultDeliveryEntry({ ...rejected, reason: '' })).toBe(false);
    expect(isTaskResultDeliveryEntry({ ...rejected, outcome: 'ignored' })).toBe(false);
    expect(isTaskResultDeliveryEntry({ ...rejected, transport: 'carrier-pigeon' })).toBe(false);
    expect(isTaskResultDeliveryEntry('not a record')).toBe(false);
  });

  it('keeps at most the history limit, dropping the oldest and counting what it dropped', () => {
    let history = appendTaskResultDelivery(null, 'op-1', acknowledged(0));
    for (let index = 1; index < TASK_RESULT_DELIVERY_HISTORY_LIMIT + 5; index++) {
      history = appendTaskResultDelivery(history, 'op-1', acknowledged(index));
    }
    expect(history.entries).toHaveLength(TASK_RESULT_DELIVERY_HISTORY_LIMIT);
    expect(history.droppedCount).toBe(5);
    expect(history.entries[0]?.receivedAt).toBe(5);
    expect(history.entries.at(-1)?.receivedAt).toBe(TASK_RESULT_DELIVERY_HISTORY_LIMIT + 4);
  });

  it('bounds reasons to the ledger reason limit without splitting a code point', () => {
    expect(boundTaskResultDeliveryReason('')).toBe('rejected');
    expect(boundTaskResultDeliveryReason('short')).toBe('short');
    const long = '\u{1F600}'.repeat(MAX_TASK_REASON_BYTES);
    const bounded = boundTaskResultDeliveryReason(long);
    expect(utf8ByteLength(bounded)).toBeLessThanOrEqual(MAX_TASK_REASON_BYTES);
    expect(bounded.length % 2).toBe(0);
    expect(bounded.length).toBeGreaterThan(0);
  });
});

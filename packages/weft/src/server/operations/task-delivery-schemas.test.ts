import { describe, expect, it } from 'bun:test';

import {
  deadLetterPayloadSchema,
  getTaskDeadLetterInput,
  getTaskDeadLetterOutputSchema,
  getTaskResultDeliveriesOutputSchema,
  taskResultDeliverySchema,
} from './task-delivery-schemas.ts';

const deliveryBase = {
  attemptTokenDigest: 'sha256:abc',
  transport: 'webSocket',
  submittedStatus: 'completed',
  receivedAt: 1_000,
} as const;

describe('taskResultDeliverySchema', () => {
  it('accepts an acknowledged delivery with a transport disposition', () => {
    for (const disposition of ['applied', 'duplicate', 'dead-lettered']) {
      expect(
        taskResultDeliverySchema.safeParse({
          ...deliveryBase,
          outcome: 'acknowledged',
          disposition,
        }).success,
      ).toBe(true);
    }
  });

  it('accepts a rejected delivery with a code and reason', () => {
    const result = taskResultDeliverySchema.safeParse({
      ...deliveryBase,
      attempt: 2,
      outcome: 'rejected',
      rejectionCode: 'conflicting-content',
      reason: 'conflicting content',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a ledger disposition in place of a transport disposition', () => {
    expect(
      taskResultDeliverySchema.safeParse({
        ...deliveryBase,
        outcome: 'acknowledged',
        disposition: 'resolved',
      }).success,
    ).toBe(false);
  });

  it('rejects an acknowledged delivery carrying rejection fields — those belong only to rejected', () => {
    expect(
      taskResultDeliverySchema.safeParse({
        ...deliveryBase,
        outcome: 'acknowledged',
        disposition: 'applied',
        rejectionCode: 'stale-attempt',
      }).success,
    ).toBe(false);
  });

  it('rejects a rejected delivery without a reason, or carrying a disposition', () => {
    expect(
      taskResultDeliverySchema.safeParse({
        ...deliveryBase,
        outcome: 'rejected',
        rejectionCode: 'stale-attempt',
      }).success,
    ).toBe(false);
    expect(
      taskResultDeliverySchema.safeParse({
        ...deliveryBase,
        outcome: 'rejected',
        rejectionCode: 'stale-attempt',
        reason: 'stale',
        disposition: 'applied',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown-operation, which is never recorded', () => {
    expect(
      taskResultDeliverySchema.safeParse({
        ...deliveryBase,
        outcome: 'rejected',
        rejectionCode: 'unknown-operation',
        reason: 'unknown',
      }).success,
    ).toBe(false);
  });

  it('rejects a raw attemptToken field (strict)', () => {
    expect(
      taskResultDeliverySchema.safeParse({
        ...deliveryBase,
        outcome: 'acknowledged',
        disposition: 'applied',
        attemptToken: 'raw-token',
      }).success,
    ).toBe(false);
  });
});

describe('getTaskResultDeliveriesOutputSchema', () => {
  it('accepts an empty history and rejects extra top-level keys', () => {
    const output = { operationId: 'op-1', deliveries: [], historyLimit: 32, droppedCount: 0 };
    expect(getTaskResultDeliveriesOutputSchema.safeParse(output).success).toBe(true);
    expect(getTaskResultDeliveriesOutputSchema.safeParse({ ...output, extra: true }).success).toBe(
      false,
    );
  });
});

describe('deadLetterPayloadSchema', () => {
  it('accepts each payload kind with exactly its own fields', () => {
    expect(
      deadLetterPayloadSchema.safeParse({ kind: 'value', value: { a: 1 }, serializedBytes: 7 })
        .success,
    ).toBe(true);
    expect(deadLetterPayloadSchema.safeParse({ kind: 'absent' }).success).toBe(true);
    expect(
      deadLetterPayloadSchema.safeParse({
        kind: 'omitted',
        reason: 'exceeds-max-bytes',
        serializedBytes: 10,
        maxBytes: 5,
      }).success,
    ).toBe(true);
  });

  it('rejects an omitted payload carrying a value, and an absent payload carrying one', () => {
    expect(
      deadLetterPayloadSchema.safeParse({
        kind: 'omitted',
        reason: 'exceeds-max-bytes',
        serializedBytes: 10,
        maxBytes: 5,
        value: 'partial',
      }).success,
    ).toBe(false);
    expect(deadLetterPayloadSchema.safeParse({ kind: 'absent', value: null }).success).toBe(false);
  });

  it('rejects an omitted payload without its size evidence', () => {
    expect(
      deadLetterPayloadSchema.safeParse({ kind: 'omitted', reason: 'exceeds-max-bytes' }).success,
    ).toBe(false);
  });
});

describe('getTaskDeadLetterOutputSchema', () => {
  const output = {
    operationId: 'op-1',
    workflowType: 'test',
    activityName: 'charge',
    queue: 'default',
    attempt: 1,
    attemptTokenDigest: 'sha256:abc',
    pendingStatus: 'completed',
    resultDigest: 'digest',
    deadLetteredAt: 1,
    persistenceFailureReason: 'storage exhausted',
    payload: { kind: 'absent' },
  };

  it('accepts a dead letter and rejects a raw attemptToken or headers (strict)', () => {
    expect(getTaskDeadLetterOutputSchema.safeParse(output).success).toBe(true);
    expect(
      getTaskDeadLetterOutputSchema.safeParse({ ...output, attemptToken: 'raw' }).success,
    ).toBe(false);
    expect(getTaskDeadLetterOutputSchema.safeParse({ ...output, headers: {} }).success).toBe(false);
  });
});

describe('getTaskDeadLetterInput', () => {
  it('defaults maxBytes to 64 KiB and bounds it to 1 MiB', () => {
    expect(getTaskDeadLetterInput.parse({ operationId: 'op-1' }).maxBytes).toBe(64 * 1024);
    expect(getTaskDeadLetterInput.safeParse({ operationId: 'op-1', maxBytes: 0 }).success).toBe(
      false,
    );
    expect(
      getTaskDeadLetterInput.safeParse({ operationId: 'op-1', maxBytes: 1024 * 1024 + 1 }).success,
    ).toBe(false);
  });
});

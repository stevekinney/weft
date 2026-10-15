/**
 * Zod schemas for the two COR-1366 task delivery operations:
 * `weft.tasks.deliveries` (transport-level result delivery history) and
 * `weft.tasks.deadletters.get` (a dead-lettered attempt's retained result
 * value). Kept apart from `get-task-detail-schema.ts` so `weft.tasks.get`'s
 * contract stays byte-for-byte unchanged.
 *
 * @module server/operations/task-delivery-schemas
 */

import { z } from 'zod';

import { TASK_RESULT_DELIVERY_REJECTION_CODES } from '../../core/task-ledger/task-result-delivery.ts';
import { getTaskDetailInput } from './get-task-detail-schema.ts';

// ---------------------------------------------------------------------------
// weft.tasks.deliveries
// ---------------------------------------------------------------------------

export const getTaskResultDeliveriesInput = getTaskDetailInput;

const deliveryCommonFields = {
  /**
   * The ledger attempt number whose `attemptTokenDigest` matches this
   * delivery, when one does. Absent for a submission carrying a token the
   * ledger never issued for this operation (a forged or foreign token), or
   * when the matching attempt record predates COR-205.
   */
  attempt: z.number().int().nonnegative().optional(),
  attemptTokenDigest: z.string(),
  transport: z.enum(['webSocket', 'longPoll']),
  workerId: z.string().optional(),
  submittedStatus: z.enum(['completed', 'failed', 'cancelled']),
  receivedAt: z.number(),
};

const acknowledgedDeliverySchema = z
  .object({
    ...deliveryCommonFields,
    outcome: z.literal('acknowledged'),
    disposition: z.enum(['applied', 'duplicate', 'dead-lettered']),
    oversizedPayload: z.literal(true).optional(),
  })
  .strict();

const rejectedDeliverySchema = z
  .object({
    ...deliveryCommonFields,
    outcome: z.literal('rejected'),
    rejectionCode: z.enum(TASK_RESULT_DELIVERY_REJECTION_CODES),
    reason: z.string(),
  })
  .strict();

/** One answered `taskResult` submission. Exported for schema-level tests. */
export const taskResultDeliverySchema = z.discriminatedUnion('outcome', [
  acknowledgedDeliverySchema,
  rejectedDeliverySchema,
]);

export const getTaskResultDeliveriesOutputSchema = z
  .object({
    operationId: z.string(),
    /** Oldest first. */
    deliveries: z.array(taskResultDeliverySchema),
    /** The most entries the server retains per operation. */
    historyLimit: z.number().int().positive(),
    /** Older entries dropped to stay within `historyLimit`; `0` means the history is complete. */
    droppedCount: z.number().int().nonnegative(),
  })
  .strict();

export type GetTaskResultDeliveriesInput = z.infer<typeof getTaskResultDeliveriesInput>;
export type GetTaskResultDeliveriesOutput = z.infer<typeof getTaskResultDeliveriesOutputSchema>;
export type TaskResultDeliveryView = z.infer<typeof taskResultDeliverySchema>;

// ---------------------------------------------------------------------------
// weft.tasks.deadletters.get
// ---------------------------------------------------------------------------

/** Default ceiling on the serialized value `weft.tasks.deadletters.get` returns inline. */
export const DEAD_LETTER_PAYLOAD_DEFAULT_MAX_BYTES = 64 * 1024;

/** Highest ceiling a caller may request. */
export const DEAD_LETTER_PAYLOAD_MAX_BYTES_LIMIT = 1024 * 1024;

export const getTaskDeadLetterInput = getTaskDetailInput.extend({
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(DEAD_LETTER_PAYLOAD_MAX_BYTES_LIMIT)
    .default(DEAD_LETTER_PAYLOAD_DEFAULT_MAX_BYTES),
});

const deadLetterPayloadValueSchema = z
  .object({
    kind: z.literal('value'),
    value: z.unknown().describe('The retained result value, exactly as the worker submitted it.'),
    serializedBytes: z.number().int().nonnegative(),
  })
  .strict();

const deadLetterPayloadAbsentSchema = z
  .object({
    // The dead letter retained no value: either a `failed` result (its `error`
    // text is the whole result) or a `completed` result whose value is
    // `undefined`, such as an activity that returned nothing. `pendingStatus`
    // tells the two apart.
    kind: z.literal('absent'),
  })
  .strict();

const deadLetterPayloadOmittedSchema = z
  .object({
    kind: z.literal('omitted'),
    reason: z.literal('exceeds-max-bytes'),
    serializedBytes: z.number().int().nonnegative(),
    maxBytes: z.number().int().positive(),
  })
  .strict();

/** Exported for schema-level tests. */
export const deadLetterPayloadSchema = z.discriminatedUnion('kind', [
  deadLetterPayloadValueSchema,
  deadLetterPayloadAbsentSchema,
  deadLetterPayloadOmittedSchema,
]);

export const getTaskDeadLetterOutputSchema = z
  .object({
    operationId: z.string(),
    workflowId: z.string().optional(),
    workflowType: z.string(),
    activityName: z.string(),
    queue: z.string(),
    attempt: z.number().int().nonnegative(),
    /** Correlates with `weft.tasks.get`'s `attempts[].attemptTokenDigest`. Never the raw token. */
    attemptTokenDigest: z.string(),
    pendingStatus: z.enum(['completed', 'failed']),
    resultDigest: z.string(),
    deadLetteredAt: z.number(),
    persistenceFailureReason: z.string(),
    error: z.string().optional(),
    payload: deadLetterPayloadSchema,
  })
  .strict();

export type GetTaskDeadLetterInput = z.input<typeof getTaskDeadLetterInput>;
export type GetTaskDeadLetterOutput = z.infer<typeof getTaskDeadLetterOutputSchema>;

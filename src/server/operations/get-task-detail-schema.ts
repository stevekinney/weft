/**
 * Zod schema definitions for `weft.tasks.get` (WFT-92), split out of
 * `get-task-detail.ts` purely to stay under this repo's 500-line-per-file
 * ceiling — see `task-ledger-transitions.ts`/`task-ledger-transitions-cancellation.ts`
 * for the identical precedent. `get-task-detail.ts` re-exports everything a
 * consumer needs, so callers import from one canonical module.
 *
 * @module server/operations/get-task-detail-schema
 */

import { z } from 'zod';

import { MAX_TASK_IDENTIFIER_BYTES, utf8ByteLength } from '../task-ledger.ts';

export const getTaskDetailInput = z.object({
  // Bounded to the ledger's own MAX_TASK_IDENTIFIER_BYTES: the ledger can
  // never actually store an operationId past that limit, so an unbounded
  // input here just means every request past the limit does a doomed
  // storage lookup with an attacker-controlled key size.
  operationId: z
    .string()
    .min(1)
    .refine((value) => utf8ByteLength(value) <= MAX_TASK_IDENTIFIER_BYTES, {
      message: `operationId exceeds the ledger's ${MAX_TASK_IDENTIFIER_BYTES}-byte identifier limit`,
    }),
});

const durationSchema = z.union([z.number(), z.string()]);

export const retryPolicySchema = z
  .object({
    maxAttempts: z.number(),
    initialBackoff: durationSchema,
    backoffMultiplier: z.number(),
    maxBackoff: durationSchema,
    nonRetryableErrors: z.array(z.string()).optional(),
  })
  .strict();

export const executionRequirementSchema = z
  .object({
    deploymentName: z.string().optional(),
    buildId: z.string().optional(),
    artifactDigest: z.string().optional(),
    workflowRevision: z.string().optional(),
    activityContractHash: z.string().optional(),
  })
  .strict();

const taskDetailBaseFields = {
  operationId: z.string(),
  workflowId: z.string().optional(),
  // Not a secret — an external write fence, same as activity/finalizer
  // attempt tokens (see this repo's execution-token conventions). Lets an
  // operator correlate a retained task with the exact workflow run that
  // owns it, distinguishing runs when start-new reuses a workflow ID.
  workflowExecutionToken: z.string().optional(),
  workflowType: z.string(),
  activityName: z.string(),
  queue: z.string(),
  priority: z.number().optional(),
  headerKeys: z.array(z.string()),
  visibilityTimeoutMilliseconds: z.number(),
  retryPolicy: retryPolicySchema.optional(),
  scheduleToCloseDeadline: z.number().optional(),
  executionRequirement: executionRequirementSchema.optional(),
  fairShareKey: z.string().optional(),
  stickyWorkflowId: z.string().optional(),
  createdAt: z.number(),
  attempt: z.number().int().nonnegative(),
  retryCount: z.number().int().nonnegative().optional(),
  requeueCount: z.number().int().nonnegative().optional(),
  lastRequeueReason: z.string().optional(),
};

const leaseHolderSchemaFields = {
  leaseDeadline: z.number(),
  firstQueuedAt: z.number(),
  lastQueuedAt: z.number(),
  startedAt: z.number(),
  lastHeartbeatAt: z.number(),
};

const taskDetailQueuedSchema = z
  .object({
    ...taskDetailBaseFields,
    state: z.literal('queued'),
    availableAt: z.number(),
    firstQueuedAt: z.number(),
    lastQueuedAt: z.number(),
    lastDispatchedAt: z.number().optional(),
    startedAt: z.number().optional(),
  })
  .strict();

const taskDetailLeasedSchema = z
  .object({ ...taskDetailBaseFields, state: z.literal('leased'), ...leaseHolderSchemaFields })
  .strict();

const taskDetailCompletingSchema = z
  .object({
    ...taskDetailBaseFields,
    state: z.literal('completing'),
    ...leaseHolderSchemaFields,
    pendingStatus: z.enum(['completed', 'failed']),
    resultDigest: z.string(),
  })
  .strict();

const taskDetailCancellingSchema = z
  .object({
    ...taskDetailBaseFields,
    state: z.literal('cancelling'),
    ...leaseHolderSchemaFields,
    cancellationReason: z.string(),
    cancellationRequestedAt: z.number(),
  })
  .strict();

// The RemoteTaskTerminal union guarantees resultStatus for 'resolved',
// cancellationReason for 'cancelled', and error for 'retryExhausted' — never
// independently optional the way task-ledger-types.ts models them. A single
// flat object schema with all three optional would accept impossible
// responses (e.g. `{ disposition: 'cancelled' }` with no reason) and
// couldn't be narrowed precisely by a schema consumer. Modeled as a nested
// discriminatedUnion on `disposition`, itself one branch of the outer
// discriminatedUnion on `state` below — Zod v4 requires every branch of a
// discriminatedUnion to be $ZodTypeDiscriminable, which a plain z.union()
// does not satisfy.
const terminalCommonFields = {
  ...taskDetailBaseFields,
  state: z.literal('terminal'),
  terminalAt: z.number(),
  adopted: z.boolean(),
  adoptedAt: z.number().optional(),
};

const taskDetailTerminalResolvedSchema = z
  .object({
    ...terminalCommonFields,
    disposition: z.literal('resolved'),
    resultDigest: z.string(),
    resultStatus: z.enum(['completed', 'failed']),
    error: z.string().optional(),
  })
  .strict();

const taskDetailTerminalCancelledSchema = z
  .object({
    ...terminalCommonFields,
    disposition: z.literal('cancelled'),
    cancellationReason: z.string(),
  })
  .strict();

const taskDetailTerminalRetryExhaustedSchema = z
  .object({
    ...terminalCommonFields,
    disposition: z.literal('retryExhausted'),
    error: z.string(),
  })
  .strict();

const taskDetailTerminalSchema = z.discriminatedUnion('disposition', [
  taskDetailTerminalResolvedSchema,
  taskDetailTerminalCancelledSchema,
  taskDetailTerminalRetryExhaustedSchema,
]);

const taskDetailDeadLetteredSchema = z
  .object({
    ...taskDetailBaseFields,
    state: z.literal('deadLettered'),
    pendingStatus: z.enum(['completed', 'failed']),
    resultDigest: z.string(),
    deadLetteredAt: z.number(),
    persistenceFailureReason: z.string(),
    error: z.string().optional(),
  })
  .strict();

/** Exported for direct schema-level tests; the operation itself uses this via `outputSchema`. */
export const getTaskDetailOutputSchema = z.discriminatedUnion('state', [
  taskDetailQueuedSchema,
  taskDetailLeasedSchema,
  taskDetailCompletingSchema,
  taskDetailCancellingSchema,
  taskDetailTerminalSchema,
  taskDetailDeadLetteredSchema,
]);

export type GetTaskDetailInput = z.infer<typeof getTaskDetailInput>;
export type GetTaskDetailOutput = z.infer<typeof getTaskDetailOutputSchema>;

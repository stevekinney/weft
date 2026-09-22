import { z } from 'zod';
import { workflowStatusSchema } from '../../core/list-filter-validation.ts';

const workflowIds = z.array(z.string());
const action = z.enum(['cancel', 'signal', 'delete', 'tag:add', 'tag:remove', 'retry-failed']);
const scalar = z.union([z.string(), z.number(), z.boolean(), z.date()]);
const attribute = z.looseObject({
  key: z.string(),
  value: z.union([scalar, z.array(scalar)]).exactOptional(),
  gt: scalar.exactOptional(),
  lt: scalar.exactOptional(),
  gte: scalar.exactOptional(),
  lte: scalar.exactOptional(),
});
const filter = z.looseObject({
  status: z.union([workflowStatusSchema, z.array(workflowStatusSchema)]).exactOptional(),
  type: z.string().exactOptional(),
  scheduleId: z.string().exactOptional(),
  tags: z.array(z.string()).exactOptional(),
  attributes: z.array(attribute).exactOptional(),
  limit: z.number().exactOptional(),
  offset: z.number().exactOptional(),
});
const scope = z.looseObject({
  matched: z.number(),
  filter,
  statuses: z.array(workflowStatusSchema),
  workflowTypes: z.array(z.string()),
  sampleWorkflowIds: workflowIds,
  sampleLimit: z.number(),
});
const principal = z.looseObject({ method: z.string(), subject: z.string().exactOptional() });
const auditEvent = z
  .looseObject({
    type: z.literal('bulk-operation:audit'),
    action,
    requestId: z.string(),
    timestamp: z.number(),
    principal,
    filterSummary: filter,
    scope,
    affectedCount: z.number(),
    sampleWorkflowIds: workflowIds,
    confirmationToken: z.string(),
  })
  .exactOptional();
const errors = z.array(z.looseObject({ id: z.string(), error: z.string() }));

const preview = z.looseObject({
  dryRun: z.literal(true),
  action,
  matched: z.number(),
  requestId: z.string(),
  scope,
  sampleWorkflowIds: workflowIds,
  confirmationToken: z.string(),
  confirmationTokenVersion: z.literal(1),
  skippedTeardownPending: workflowIds.exactOptional(),
});

export const bulkCancelOutputSchema = z.union([
  z.looseObject({ cancelled: z.number(), failed: z.number(), errors, auditEvent }),
  preview,
]);
export const bulkDeleteOutputSchema = z.union([
  z.looseObject({
    deleted: z.number(),
    skippedTeardownPending: workflowIds.exactOptional(),
    auditEvent,
  }),
  preview,
]);
export const bulkTagOutputSchema = z.union([
  z.looseObject({ modified: z.number(), auditEvent }),
  preview,
]);
export const bulkRetryFailedOutputSchema = z.union([
  z.looseObject({ retried: z.number(), failed: z.number(), errors, auditEvent }),
  preview,
]);
export const bulkSignalOutputSchema = z.union([
  z.looseObject({ signalled: z.number(), failed: z.number(), auditEvent }),
  preview,
]);
export const purgeOutputSchema = z.looseObject({ deleted: z.number() });

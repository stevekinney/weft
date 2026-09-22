import { describe, expect, test } from 'bun:test';
import type { BulkOperationAuditEvent, BulkOperationDryRunResult } from '../../core/types.ts';
import { bulkCancelWorkflowsOperation } from './bulk-cancel-workflows.ts';
import { bulkDeleteWorkflowsOperation } from './bulk-delete-workflows.ts';
import { bulkMutateWorkflowTagsOperation } from './bulk-mutate-workflow-tags.ts';
import { bulkRetryFailedWorkflowsOperation } from './bulk-retry-failed-workflows.ts';
import { bulkSignalWorkflowsOperation } from './bulk-signal-workflows.ts';
import { purgeWorkflowsOperation } from './purge-workflows.ts';

const outputs = [
  { operation: bulkCancelWorkflowsOperation, valid: { cancelled: 1, failed: 0, errors: [] } },
  { operation: bulkDeleteWorkflowsOperation, valid: { deleted: 1 } },
  { operation: bulkMutateWorkflowTagsOperation, valid: { modified: 1 } },
  { operation: bulkRetryFailedWorkflowsOperation, valid: { retried: 1, failed: 0, errors: [] } },
  { operation: bulkSignalWorkflowsOperation, valid: { signalled: 1, failed: 0 } },
  { operation: purgeWorkflowsOperation, valid: { deleted: 1 } },
];

const scope = {
  matched: 1,
  filter: { type: 'checkout', attributes: [{ key: 'region', value: ['east', 'west'] }] },
  statuses: ['completed'],
  workflowTypes: ['checkout'],
  sampleWorkflowIds: ['workflow-1'],
  sampleLimit: 20,
} satisfies BulkOperationDryRunResult['scope'];
const preview = {
  dryRun: true,
  action: 'delete',
  matched: 1,
  requestId: 'request-1',
  scope,
  sampleWorkflowIds: ['workflow-1'],
  confirmationToken: 'confirmation-1',
  confirmationTokenVersion: 1,
  skippedTeardownPending: ['workflow-1'],
} satisfies BulkOperationDryRunResult;
const auditEvent = {
  type: 'bulk-operation:audit',
  action: 'delete',
  requestId: 'request-1',
  timestamp: 1000,
  principal: { method: 'api-key', subject: 'operator' },
  filterSummary: scope.filter,
  scope,
  affectedCount: 1,
  sampleWorkflowIds: ['workflow-1'],
  confirmationToken: 'confirmation-1',
} satisfies BulkOperationAuditEvent;

describe('bulk operation output contracts', () => {
  for (const { operation, valid } of outputs) {
    test(`${operation.name} accepts its result and rejects malformed output`, () => {
      expect(operation.outputSchema.safeParse(valid).success).toBe(true);
      const complete = { ...valid, auditEvent, additionalDetail: 'retained' };
      expect(operation.outputSchema.parse(complete)).toEqual(complete);
      expect(operation.outputSchema.safeParse({}).success).toBe(false);
      expect(
        operation.outputSchema.safeParse({
          ...valid,
          ...Object.fromEntries(Object.keys(valid).map((key) => [key, 'invalid'])),
        }).success,
      ).toBe(false);
    });
    if (operation !== purgeWorkflowsOperation) {
      test(`${operation.name} validates complete previews and nested scope fields`, () => {
        expect(operation.outputSchema.parse(preview)).toEqual(preview);
        expect(
          operation.outputSchema.safeParse({
            ...preview,
            scope: { ...scope, matched: 'invalid' },
          }).success,
        ).toBe(false);
        expect(
          operation.outputSchema.safeParse({ ...preview, confirmationTokenVersion: 2 }).success,
        ).toBe(false);
      });
    }
  }
});

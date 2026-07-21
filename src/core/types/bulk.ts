import type { WorkflowId, WorkflowStatus } from './identity.ts';
import type { AttributeFilterScalarValue } from './list-options.ts';

export const MAX_BULK_OPERATION_REQUEST_ID_LENGTH = 200;
export const MAX_BULK_CONFIRMATION_TOKEN_LENGTH = 256;

/**
 * Bulk workflow action names used in previews, confirmations, and audit
 * records.
 *
 * @example
 * ```ts
 * import type { BulkOperationAction } from '@lostgradient/weft';
 *
 * const action: BulkOperationAction = 'cancel';
 * void action;
 * ```
 */
export type BulkOperationAction =
  | 'cancel'
  | 'signal'
  | 'delete'
  | 'tag:add'
  | 'tag:remove'
  | 'retry-failed';

/**
 * Credential-safe caller summary recorded on bulk audit events. Claims,
 * bearer tokens, API keys, and other credentials are intentionally absent.
 *
 * @example
 * ```ts
 * import type { BulkOperationPrincipal } from '@lostgradient/weft';
 *
 * const principal: BulkOperationPrincipal = {
 *   method: 'api-key',
 *   subject: 'operator@example.com',
 * };
 * void principal;
 * ```
 */
export type BulkOperationPrincipal = {
  method: string;
  subject?: string;
};

/**
 * Canonical filter summary used when deriving bulk confirmation tokens.
 *
 * @example
 * ```ts
 * import type { BulkOperationFilterSummary } from '@lostgradient/weft';
 *
 * const filter: BulkOperationFilterSummary = {
 *   status: ['running', 'pending'],
 *   type: 'checkout',
 *   tags: ['nightly'],
 * };
 * void filter;
 * ```
 */
export type BulkOperationFilterSummary = {
  status?: WorkflowStatus | WorkflowStatus[];
  type?: string;
  scheduleId?: string;
  tags?: string[];
  attributes?: Array<{
    key: string;
    value?: AttributeFilterScalarValue | AttributeFilterScalarValue[];
    gt?: AttributeFilterScalarValue;
    lt?: AttributeFilterScalarValue;
    gte?: AttributeFilterScalarValue;
    lte?: AttributeFilterScalarValue;
  }>;
  limit?: number;
  offset?: number;
};

/**
 * Scope summary returned by dry-run previews and persisted in audit records.
 *
 * @example
 * ```ts
 * import type { BulkOperationScopeSummary } from '@lostgradient/weft';
 *
 * const scope: BulkOperationScopeSummary = {
 *   matched: 2,
 *   filter: { status: 'running' },
 *   statuses: ['running'],
 *   workflowTypes: ['checkout'],
 *   sampleWorkflowIds: ['wf-1', 'wf-2'],
 *   sampleLimit: 20,
 * };
 * void scope;
 * ```
 */
export type BulkOperationScopeSummary = {
  matched: number;
  filter: BulkOperationFilterSummary;
  statuses: WorkflowStatus[];
  workflowTypes: string[];
  sampleWorkflowIds: WorkflowId[];
  sampleLimit: number;
};

/**
 * Dry-run result shared by bulk workflow operations.
 *
 * @example
 * ```ts
 * import type { BulkOperationDryRunResult } from '@lostgradient/weft';
 *
 * const preview: BulkOperationDryRunResult = {
 *   dryRun: true,
 *   action: 'cancel',
 *   matched: 1,
 *   requestId: 'ops-123',
 *   scope: {
 *     matched: 1,
 *     filter: { status: 'running' },
 *     statuses: ['running'],
 *     workflowTypes: ['checkout'],
 *     sampleWorkflowIds: ['wf-1'],
 *     sampleLimit: 20,
 *   },
 *   sampleWorkflowIds: ['wf-1'],
 *   confirmationToken: 'bulk:token',
 *   confirmationTokenVersion: 1,
 * };
 * void preview;
 * ```
 */
export type BulkOperationDryRunResult = {
  dryRun: true;
  action: BulkOperationAction;
  matched: number;
  requestId: string;
  scope: BulkOperationScopeSummary;
  sampleWorkflowIds: WorkflowId[];
  confirmationToken: string;
  confirmationTokenVersion: 1;
  /**
   * Delete-only, point-in-time advisory: ids in the matched scope that currently owe an
   * engine-driven finalizer (#446) and so would be SKIPPED by the commit (mirrors
   * {@link BulkDeleteResult.skippedTeardownPending}). Present only on a `delete` preview
   * and only when non-empty. `matched`, `scope`, and `confirmationToken` still describe
   * the full filter scope — they are stable and derive the commit token — so this field
   * surfaces the skip without recomputing them (teardown-owed is transient and is
   * re-evaluated at commit time, where the authoritative skip list is reported).
   */
  skippedTeardownPending?: WorkflowId[];
};

/**
 * Options for a dry-run bulk operation preview.
 *
 * @example
 * ```ts
 * import type { BulkOperationDryRunOptions } from '@lostgradient/weft';
 *
 * const options: BulkOperationDryRunOptions = {
 *   dryRun: true,
 *   requestId: 'ops-123',
 * };
 * void options;
 * ```
 */
export type BulkOperationDryRunOptions = {
  dryRun: true;
  requestId?: string;
  principal?: BulkOperationPrincipal;
  bulkConcurrency?: number;
};

/**
 * Options for a committed bulk operation.
 *
 * @example
 * ```ts
 * import type { BulkOperationCommitOptions } from '@lostgradient/weft';
 *
 * const options: BulkOperationCommitOptions = {
 *   confirmationToken: 'bulk:token-from-preview',
 *   requestId: 'ops-123',
 * };
 * void options;
 * ```
 */
export type BulkOperationCommitOptions = {
  dryRun?: false;
  confirmationToken?: string;
  requestId?: string;
  principal?: BulkOperationPrincipal;
  bulkConcurrency?: number;
};

/**
 * Options accepted by bulk workflow operations.
 *
 * @example
 * ```ts
 * import type { BulkOperationOptions } from '@lostgradient/weft';
 *
 * const options: BulkOperationOptions = { dryRun: true, bulkConcurrency: 4 };
 * void options;
 * ```
 */
export type BulkOperationOptions = BulkOperationDryRunOptions | BulkOperationCommitOptions;

/**
 * Dry-run options for `engine.signalAll`. Pass the signal payload as the
 * third argument and these controls as the fourth argument.
 *
 * @example
 * ```ts
 * import type { BulkSignalAllDryRunOptions } from '@lostgradient/weft';
 *
 * const options: BulkSignalAllDryRunOptions = { dryRun: true };
 * void options;
 * ```
 */
export type BulkSignalAllDryRunOptions = BulkOperationDryRunOptions;

/**
 * Commit options for `engine.signalAll`. Pass the signal payload as the
 * third argument and these controls as the fourth argument.
 *
 * @example
 * ```ts
 * import type { BulkSignalAllCommitOptions } from '@lostgradient/weft';
 *
 * const options: BulkSignalAllCommitOptions = {
 *   confirmationToken: 'bulk:token-from-preview',
 * };
 * void options;
 * ```
 */
export type BulkSignalAllCommitOptions = BulkOperationCommitOptions;

/**
 * Control options accepted by `engine.signalAll` as the fourth argument.
 *
 * @example
 * ```ts
 * import type { BulkSignalAllOptions } from '@lostgradient/weft';
 *
 * const options: BulkSignalAllOptions = { dryRun: true };
 * void options;
 * ```
 */
export type BulkSignalAllOptions = BulkSignalAllDryRunOptions | BulkSignalAllCommitOptions;

/**
 * Durable audit record persisted after a committed bulk operation succeeds.
 *
 * @example
 * ```ts
 * import type { BulkOperationAuditEvent } from '@lostgradient/weft';
 *
 * const event: BulkOperationAuditEvent = {
 *   type: 'bulk-operation:audit',
 *   action: 'cancel',
 *   requestId: 'ops-123',
 *   timestamp: Date.now(),
 *   principal: { method: 'api-key', subject: 'operator@example.com' },
 *   filterSummary: { status: 'running' },
 *   scope: {
 *     matched: 1,
 *     filter: { status: 'running' },
 *     statuses: ['running'],
 *     workflowTypes: ['checkout'],
 *     sampleWorkflowIds: ['wf-1'],
 *     sampleLimit: 20,
 *   },
 *   affectedCount: 1,
 *   sampleWorkflowIds: ['wf-1'],
 *   confirmationToken: 'bulk:token',
 * };
 * void event;
 * ```
 */
export type BulkOperationAuditEvent = {
  type: 'bulk-operation:audit';
  action: BulkOperationAction;
  requestId: string;
  timestamp: number;
  principal: BulkOperationPrincipal;
  filterSummary: BulkOperationFilterSummary;
  scope: BulkOperationScopeSummary;
  affectedCount: number;
  sampleWorkflowIds: WorkflowId[];
  confirmationToken: string;
};

/**
 * Per-workflow error entry in bulk operation results. `id` identifies the
 * workflow that failed; `error` is the error message string.
 */
export type BulkOperationError = {
  id: WorkflowId;
  error: string;
};

/**
 * Result of a bulk cancel operation (`engine.cancelAll`). Reports the count
 * of successfully cancelled workflows, the number that failed, and per-workflow
 * error details in `errors`.
 */
export type BulkCancelResult = {
  cancelled: number;
  failed: number;
  errors: BulkOperationError[];
  auditEvent?: BulkOperationAuditEvent;
};

/**
 * Result of a bulk failed-workflow retry operation (`engine.retryFailedAll`).
 * Reports the number of workflows accepted for retry, the number that failed
 * to restart or resume, and per-workflow error details in `errors`.
 *
 * @example
 * ```ts
 * import type { BulkRetryFailedResult } from '@lostgradient/weft';
 *
 * const result: BulkRetryFailedResult = {
 *   retried: 2,
 *   failed: 1,
 *   errors: [{ id: 'wf-3', error: 'Checkpoint no longer exists' }],
 * };
 * void result;
 * ```
 */
export type BulkRetryFailedResult = {
  retried: number;
  failed: number;
  errors: BulkOperationError[];
  auditEvent?: BulkOperationAuditEvent;
};

/**
 * Result of a bulk signal operation (`engine.signalAll`). Reports the number
 * of workflows that received the signal and the number for which delivery failed.
 */
export type BulkSignalResult = {
  signalled: number;
  failed: number;
  auditEvent?: BulkOperationAuditEvent;
};

/**
 * Result of a bulk delete operation (`engine.deleteAll`). Reports how many
 * terminal workflows were deleted from storage. Workflows that still owe an
 * engine-driven finalizer (#446) are NOT deleted — deleting them would drop the
 * finalizer payload before the resource is torn down — and are reported, by id, in
 * `skippedTeardownPending` so the skip is visible rather than silent. The skip is
 * transient: once the finalizer settles, a later `deleteAll` removes the record.
 */
export type BulkDeleteResult = {
  deleted: number;
  /** Ids of terminal workflows skipped because they still owe a finalizer run. */
  skippedTeardownPending?: WorkflowId[];
  auditEvent?: BulkOperationAuditEvent;
};

/**
 * Result of a bulk tag operation (`engine.tagAll` / `engine.untagAll`).
 * Reports how many workflows had their tags modified.
 */
export type BulkTagResult = {
  modified: number;
  auditEvent?: BulkOperationAuditEvent;
};

/**
 * Result of a purge operation (`engine.purge`). Reports how many workflow
 * records were permanently removed from storage.
 */
export interface PurgeResult {
  deleted: number;
}

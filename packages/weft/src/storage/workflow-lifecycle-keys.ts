/**
 * Storage key builders for post-execution workflow lifecycle concerns:
 * deadlines and terminal timers, finalizer/teardown tracking, concurrency
 * limits, child-workflow bookkeeping, durable state/stream storage, and the
 * workflow visibility index.
 *
 * These are spread into `KEYS` in `interface.ts` rather than declared there, so
 * the lifecycle keyspace can carry its full rationale without pushing that
 * file's documented line ceiling. Callers still reach them through `KEYS`,
 * which keeps one import contract for storage keys.
 *
 * @module storage/workflow-lifecycle-keys
 */

import { DEFAULT_SCOPE } from './default-scope.ts';
import { encodeStorageKeyComponent, formatSortableStorageTimestamp } from './key-encoding.ts';

const formatSortableTimestamp = formatSortableStorageTimestamp;

/**
 * Deadline and terminal timer keys.
 *
 * Spread into `KEYS` after `SIGNAL_KEYS` and ahead of
 * `WORKFLOW_RECORD_KEYS_EXTENDED` to preserve the pre-split
 * `Object.keys(KEYS)` insertion order; not intended to be imported directly
 * by engine code.
 */
export const WORKFLOW_LIFECYCLE_KEYS_CORE = {
  deadline: (deadline: number, workflowId: string) =>
    `wf-deadline:${formatSortableTimestamp(deadline)}:${encodeStorageKeyComponent(workflowId)}`,
  terminalCleanup: (fireAt: number, timerId: string) =>
    `wf-cleanup:${formatSortableTimestamp(fireAt)}:${encodeStorageKeyComponent(timerId)}`,
  /**
   * Durable timer that drives a workflow's finalizer after a `cancelled`/`timed-out`
   * terminal (issue #446 Phase 2). Sortable by `fireAt` and scanned by its own
   * source (`wf-teardown:`) so it dispatches as the `teardown` timer kind rather
   * than `terminal-cleanup`. Re-armed with exponential backoff on a failed finalizer
   * attempt; the scheduler deletes the fired entry after the drive returns without
   * throwing, so a backoff reschedule is a write of a new entry at the later `fireAt`.
   */
  teardownTimer: (fireAt: number, timerId: string) =>
    `wf-teardown:${formatSortableTimestamp(fireAt)}:${encodeStorageKeyComponent(timerId)}`,
  delayedStart: (startAt: number, workflowId: string) =>
    `wf-delayed:${formatSortableTimestamp(startAt)}:${encodeStorageKeyComponent(workflowId)}`,
  terminalWorkflowPrefix: () => 'wf-terminal:',
  terminalWorkflow: (updatedAt: number, workflowId: string) =>
    `wf-terminal:${formatSortableTimestamp(updatedAt)}:${encodeStorageKeyComponent(workflowId)}`,
} as const;

/**
 * Finalizer/teardown tracking, concurrency limits, child-workflow
 * bookkeeping, durable state/stream storage, and workflow visibility index
 * keys.
 *
 * Spread into `KEYS` after `MAILBOX_KEYS`, `OUTBOX_KEYS`,
 * `OWNERSHIP_CLAIM_KEYS`, and `WORKFLOW_CATALOG_KEYS` to preserve the
 * pre-split `Object.keys(KEYS)` insertion order; not intended to be imported
 * directly by engine code.
 */
export const WORKFLOW_LIFECYCLE_KEYS_EXTENDED = {
  budget: (namespace: string, period: string, date: string) =>
    `budget:${namespace}:${period}:${date}`,
  review: (workflowId: string, reviewId: string) =>
    `review:${encodeStorageKeyComponent(workflowId)}:${reviewId}`,
  workflowHeaders: (workflowId: string) => `wf-headers:${encodeStorageKeyComponent(workflowId)}`,
  childCancellationPrefix: (workflowId: string) =>
    `child-cancel:${encodeStorageKeyComponent(workflowId)}:`,
  childCancellation: (workflowId: string, childWorkflowId: string) =>
    `child-cancel:${encodeStorageKeyComponent(workflowId)}:${encodeStorageKeyComponent(childWorkflowId)}`,
  childWorkflowByParentPrefix: (parentWorkflowId: string, parentWorkflowExecutionToken?: string) =>
    `child-by-parent:${encodeStorageKeyComponent(parentWorkflowId)}:${
      parentWorkflowExecutionToken === undefined
        ? ''
        : `${encodeStorageKeyComponent(parentWorkflowExecutionToken)}:`
    }`,
  childWorkflowByParent: (
    parentWorkflowId: string,
    parentWorkflowExecutionToken: string | undefined,
    childWorkflowId: string,
  ) =>
    `child-by-parent:${encodeStorageKeyComponent(parentWorkflowId)}:${
      parentWorkflowExecutionToken === undefined
        ? ''
        : `${encodeStorageKeyComponent(parentWorkflowExecutionToken)}:`
    }${encodeStorageKeyComponent(childWorkflowId)}`,
  terminalCleanupNeeded: (workflowId: string) =>
    `wf-cleanup-needed:${encodeStorageKeyComponent(workflowId)}`,
  workflowConcurrency: (workflowType: string, partitionKey: string) =>
    `wf-concurrency:${encodeStorageKeyComponent(workflowType)}:${encodeStorageKeyComponent(partitionKey)}`,
  workflowConcurrencyHolder: (workflowId: string) =>
    `wf-concurrency-holder:${encodeStorageKeyComponent(workflowId)}`,
  /**
   * Presence-only marker written at start only when a run is launched with a
   * non-serialized `services` value (see `start-batch.ts`). It lets a
   * fresh-process recovery tell a run whose services were lost on crash apart
   * from one that never had any — the services value itself is never persisted,
   * so this bit is the only durable trace. Cleared on terminal cleanup.
   */
  workflowHasServices: (workflowId: string) =>
    `wf-has-services:${encodeStorageKeyComponent(workflowId)}`,
  /**
   * Last-write-wins payload that `ctx.setFinalizerState(value)` records for a
   * workflow's definition-level `finalizer` activity (issue #446). Staged as a
   * pending atomic side-effect so it commits with the next checkpoint or the
   * terminal batch, and swept on terminal cleanup.
   *
   * **Current behavior (this release): recorded only.** Nothing reads this value
   * yet. **Planned behavior (future release):** the engine will pass the decoded
   * value as the finalizer's input when driving teardown after a
   * `cancelled`/`timed-out` terminal, where presence means "a resource was
   * recorded" and absence means the finalizer is skipped.
   */
  finalizerState: (workflowId: string) =>
    `wf-finalizer-state:${encodeStorageKeyComponent(workflowId)}`,
  /**
   * Durable execution-claim + attempt marker for a workflow that owes a finalizer
   * run after a `cancelled`/`timed-out` terminal (issue #446 Phase 2). Mirrors the
   * `wf-cleanup-needed:` lifecycle. The value is the encoded claim record
   * `{ status: 'owed' | 'running'; attempts: number; token: string; claimedAt?: number }`:
   * the engine fenced-CAS's `owed → running` (stamping `claimedAt`) before invoking the
   * finalizer, and settle-CAS's the exact `running` bytes it wrote when clearing or
   * rescheduling. Liveness is decided purely by TIME: a `running` claim is reclaimable
   * once `claimedAt` is older than the finalizer's per-attempt timeout plus a margin
   * (see `teardownStaleThresholdMs`), so crash recovery is an ordinary stale-claim retry
   * driven by the timer that survived the terminal batch — there is no in-memory liveness
   * set and no epoch in the record. The cost is that a finalizer running past the stale
   * threshold may be re-driven concurrently, which is why workflow finalizers must be
   * idempotent. Present while teardown is outstanding; deleted by the finalizer on
   * success or when it dead-letters, which is what unblocks purge.
   */
  teardownOwed: (workflowId: string) =>
    `wf-teardown-needed:${encodeStorageKeyComponent(workflowId)}`,
  /** Durable successful finalizer outcome, retained until workflow purge or retention. */
  teardownSucceeded: (workflowId: string) =>
    `wf-teardown-succeeded:${encodeStorageKeyComponent(workflowId)}`,
  /**
   * Durable audit record written when a workflow's finalizer permanently fails — the
   * retry horizon is reached, or the recorded resource state vanished so the finalizer
   * can never run (issue #446 Phase 2). Holds the `TeardownDeadLetterRecord` shape
   * `{ type, lastError, attempts, deadLetteredAt, workflowExecutionToken?, finalizerInput? }`.
   * **Excluded from the workflow purge delete-set** so it survives as the operator's
   * evidence of a leaked external resource and remains queryable through the durable
   * finalizer-status API after purge.
   */
  teardownDeadLetter: (workflowId: string) =>
    `wf-teardown-deadletter:${encodeStorageKeyComponent(workflowId)}`,
  offload: (workflowId: string, key: string) =>
    `offload:${encodeStorageKeyComponent(workflowId)}:${key}`,
  archive: (workflowId: string, key: string) =>
    `archive:${encodeStorageKeyComponent(workflowId)}:${key}`,
  stateExecution: (ownerWorkflowId: string, key: string) =>
    `state:execution:${encodeStorageKeyComponent(ownerWorkflowId)}:${encodeStorageKeyComponent(key)}`,
  stateWorkflow: (workflowType: string, key: string) =>
    `state:workflow-scope:${DEFAULT_SCOPE}:${encodeStorageKeyComponent(workflowType)}:${encodeStorageKeyComponent(key)}`,
  streamChunkPrefix: (workflowId: string, key: string) =>
    `blob:${encodeStorageKeyComponent(workflowId)}:${key}:chunk:`,
  streamChunk: (workflowId: string, key: string, chunkIndex: number) =>
    `blob:${encodeStorageKeyComponent(workflowId)}:${key}:chunk:${String(chunkIndex).padStart(10, '0')}`,
  streamTail: (workflowId: string, key: string) =>
    `blob:${encodeStorageKeyComponent(workflowId)}:${key}:tail`,
  streamMetadata: (workflowId: string, key: string) =>
    `blob:${encodeStorageKeyComponent(workflowId)}:${key}:meta`,
  budgetCharged: (operationId: string) => `budget-charged:${operationId}`,
  toolEffect: (workflowId: string, agentId: string, semanticHash: string) =>
    `tool-effect:${encodeStorageKeyComponent(workflowId)}:${agentId}:${semanticHash}`,
  // Visibility index timestamps lex-sort correctly; see `workflow-indexes.ts`.
  workflowVisibilityStatus: (status: string, workflowId: string) =>
    `wf-idx-status:${encodeStorageKeyComponent(status)}:${encodeStorageKeyComponent(workflowId)}`,
  workflowVisibilityType: (type: string, workflowId: string) =>
    `wf-idx-type:${encodeStorageKeyComponent(type)}:${encodeStorageKeyComponent(workflowId)}`,
  workflowVisibilityCreated: (createdAt: number, workflowId: string) =>
    `wf-idx-created:${formatSortableTimestamp(createdAt)}:${encodeStorageKeyComponent(workflowId)}`,
  workflowVisibilityUpdated: (updatedAt: number, workflowId: string) =>
    `wf-idx-updated:${formatSortableTimestamp(updatedAt)}:${encodeStorageKeyComponent(workflowId)}`,
  workflowVisibilityDeadline: (deadline: number, workflowId: string) =>
    `wf-idx-deadline:${formatSortableTimestamp(deadline)}:${encodeStorageKeyComponent(workflowId)}`,
  workflowVisibilityManifest: (workflowId: string) =>
    `wf-idx-manifest:${encodeStorageKeyComponent(workflowId)}`,
  workflowVisibilityMetaVersion: () => 'wf-idx-meta:version',
  workflowVisibilityMetaBuiltAt: () => 'wf-idx-meta:built-at',
  workflowVisibilityMetaCursor: () => 'wf-idx-meta:cursor',
} as const;

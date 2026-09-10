/**
 * Storage key builders for the durable per-run execution record: workflow
 * state, checkpoints, timelines, schedules, queued operations, events, async
 * activity resolution, and workflow updates.
 *
 * These are spread into `KEYS` in `interface.ts` rather than declared there, so
 * the workflow-record keyspace can carry its full rationale without pushing
 * that file's documented line ceiling. Callers still reach them through `KEYS`,
 * which keeps one import contract for storage keys.
 *
 * @module storage/workflow-record-keys
 */

import { encodeStorageKeyComponent, formatSortableStorageTimestamp } from './key-encoding.ts';

const formatSortableTimestamp = formatSortableStorageTimestamp;

/**
 * Workflow state, checkpoint, timeline, schedule, queued-operation, event, and
 * async-activity/update keys.
 *
 * Spread into `KEYS`; not intended to be imported directly by engine code.
 */
export const WORKFLOW_RECORD_KEYS = {
  workflow: (id: string) => `wf:${encodeStorageKeyComponent(id)}`,
  checkpoint: (id: string) => `wf:${encodeStorageKeyComponent(id)}:ckpt`,
  checkpointHistory: (id: string, step: number) =>
    `wf:${encodeStorageKeyComponent(id)}:ckpt:${String(step).padStart(10, '0')}`,
  timelinePrefix: (id: string) => `wf:${encodeStorageKeyComponent(id)}:timeline:`,
  timeline: (id: string, step: number) =>
    `wf:${encodeStorageKeyComponent(id)}:timeline:${String(step).padStart(10, '0')}`,
  schedule: (id: string) => `schedule:${encodeStorageKeyComponent(id)}`,
  scheduleTick: (fireAt: number, id: string) =>
    `schedule-due:${String(fireAt).padStart(16, '0')}:${encodeStorageKeyComponent(id)}`,
  scheduleRun: (workflowId: string) => `schedule-run:${encodeStorageKeyComponent(workflowId)}`,
  /**
   * Durable per-workflow manifest for the schedule that launched a run. Unlike
   * `scheduleRun`, this link survives terminal cleanup so schedule history can
   * be queried until the workflow itself is purged.
   */
  scheduleRunLink: (workflowId: string) =>
    `schedule-run-link:${encodeStorageKeyComponent(workflowId)}`,
  scheduleRunBySchedulePrefix: (scheduleId: string) =>
    `schedule-run-by-schedule:${encodeStorageKeyComponent(scheduleId)}:`,
  scheduleRunBySchedule: (scheduleId: string, workflowId: string) =>
    `schedule-run-by-schedule:${encodeStorageKeyComponent(scheduleId)}:${encodeStorageKeyComponent(workflowId)}`,
  operation: (queue: string, scheduledAt: number, id: string) =>
    `op:${queue}:${formatSortableTimestamp(scheduledAt)}:${id}`,
  operationInflight: (id: string) => `op:inflight:${id}`,
  operationQueued: (id: string) => `op:queued:${id}`,
  operationResolved: (id: string) => `op:resolved:${id}`,
  bulkOperationAuditPrefix: () => 'audit:bulk:',
  bulkOperationAudit: (timestamp: number, requestId: string, confirmationToken: string) =>
    `audit:bulk:${formatSortableTimestamp(timestamp)}:${encodeStorageKeyComponent(requestId)}:${encodeStorageKeyComponent(confirmationToken)}`,
  operationResolvedByTimePrefix: () => 'op:resolved-by-time:',
  operationResolvedByTime: (resolvedAt: number, id: string) =>
    `op:resolved-by-time:${formatSortableTimestamp(resolvedAt)}:${encodeStorageKeyComponent(id)}`,
  asyncActivity: (workflowId: string, token: string) =>
    `async-act:v1:${encodeStorageKeyComponent(workflowId)}:${encodeStorageKeyComponent(token)}`,
  // The raw `:resolution` suffix cannot collide with a token key: token
  // components are percent-encoded, so an encoded token never contains `:`.
  asyncActivityResolution: (workflowId: string, token: string) =>
    `async-act:v1:${encodeStorageKeyComponent(workflowId)}:${encodeStorageKeyComponent(token)}:resolution`,
  activityReconciliationPrefix: (workflowId: string) =>
    `actrec:v1:${encodeStorageKeyComponent(workflowId)}:`,
  activityReconciliation: (
    workflowId: string,
    activityName: string,
    idempotencyKeyDigest: string,
  ) =>
    `actrec:v1:${encodeStorageKeyComponent(workflowId)}:${encodeStorageKeyComponent(activityName)}:${idempotencyKeyDigest}`,
  eventPrefix: (workflowId: string) => `ev:${encodeStorageKeyComponent(workflowId)}:`,
  event: (workflowId: string, sequence: number) =>
    `ev:${encodeStorageKeyComponent(workflowId)}:${String(sequence).padStart(10, '0')}`,
  eventHead: (workflowId: string) => `ev:${encodeStorageKeyComponent(workflowId)}:head`,
  eventWatermark: (workflowId: string) => `ev:${encodeStorageKeyComponent(workflowId)}:watermark`,
  fleetEventPrefix: () => 'fleet-event:',
  fleetEvent: (sequence: number) => `fleet-event:${String(sequence).padStart(10, '0')}`,
  fleetEventTail: () => 'fleet-event-tail',
  fleetEventWatermark: () => 'fleet-event-watermark',
  fleetEventByWorkflowPrefix: (workflowId: string) =>
    `fleet-event-by-workflow:${encodeStorageKeyComponent(workflowId)}:`,
  fleetEventByWorkflow: (workflowId: string, sequence: number) =>
    `fleet-event-by-workflow:${encodeStorageKeyComponent(workflowId)}:${String(sequence).padStart(10, '0')}`,
  updatePrefix: (workflowId: string) => `upd:${encodeStorageKeyComponent(workflowId)}:`,
  update: (workflowId: string, updateId: string) =>
    `upd:${encodeStorageKeyComponent(workflowId)}:${updateId}`,
  updateResponse: (updateId: string) => `upr:${updateId}`,
  updateIdempotency: (workflowId: string, key: string) =>
    `upk:${encodeStorageKeyComponent(workflowId)}:${key}`,
  /**
   * Maps a start `idempotencyKey` to the workflow id created for it. Written
   * atomically with the workflow record under a `conditionalBatch` gated on this
   * key being absent, so concurrent same-key starts converge on one workflow.
   * Unlike `updateIdempotency`, it is keyed by the idempotency key alone (no
   * workflow id) because the workflow id is the value it resolves to. It is
   * intentionally NOT swept on terminal cleanup: it must outlive the run so a
   * post-completion `startOrSignal` sees a terminal workflow (and conflicts)
   * rather than missing the mapping and creating a fresh run.
   */
  startIdempotency: (key: string) => `start-idem:${encodeStorageKeyComponent(key)}`,
  /**
   * The convergence signal id that `startOrSignal` derives from an idempotency
   * key so independent same-key callers deliver ONE signal. Deliberately uses the
   * RAW key (not `encodeStorageKeyComponent`): unlike `startIdempotency` this is a
   * signal id, not a storage key, and `validateSignalId` is character-agnostic, so
   * the raw key is always a valid id as long as it fits the byte cap (enforced as
   * ≤117 bytes so `"start-idem:"` + key stays within the 128-byte signal-id
   * ceiling). The two derivations are independent namespaces; both are individually
   * correct, so the raw-vs-encoded difference is harmless.
   */
  startIdempotencySignalId: (key: string) => `start-idem:${key}`,
  attribute: (workflowId: string) => `attr:${encodeStorageKeyComponent(workflowId)}`,
  attributeIndex: (attributeName: string, encodedValue: string, workflowId: string) =>
    `idx:${attributeName}:${encodedValue}:${encodeStorageKeyComponent(workflowId)}`,
  tagIndex: (tag: string, workflowId: string) =>
    `tag:${encodeStorageKeyComponent(tag)}:${encodeStorageKeyComponent(workflowId)}`,
} as const;

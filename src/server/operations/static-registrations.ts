/**
 * Static operation and REST-binding registrations — every operation that
 * needs no per-server configuration, in one place.
 *
 * `rest-bindings.ts` composes these arrays with the per-server factory
 * operations (metrics, workers, task queues, diagnostics) to build the live
 * registry and binding set. Adding a new statically-configured operation
 * means adding its import and two array entries HERE; `rest-bindings.ts`
 * itself only changes when an operation needs per-server wiring.
 *
 * @module server/operations/static-registrations
 */

import type { RegistrableOperation } from '../operation-catalog.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { addWorkflowTagsOperation, addWorkflowTagsRestBinding } from './add-workflow-tags.ts';
import {
  aggregateWorkflowsOperation,
  aggregateWorkflowsRestBinding,
} from './aggregate-workflows.ts';
import * as asyncActivity from './async-activity.ts';
import {
  bulkCancelWorkflowsOperation,
  bulkCancelWorkflowsRestBinding,
} from './bulk-cancel-workflows.ts';
import {
  bulkDeleteWorkflowsOperation,
  bulkDeleteWorkflowsRestBinding,
} from './bulk-delete-workflows.ts';
import {
  bulkMutateWorkflowTagsOperation,
  bulkMutateWorkflowTagsRestBinding,
} from './bulk-mutate-workflow-tags.ts';
import {
  bulkRetryFailedWorkflowsOperation,
  bulkRetryFailedWorkflowsRestBinding,
} from './bulk-retry-failed-workflows.ts';
import {
  bulkSignalWorkflowsOperation,
  bulkSignalWorkflowsRestBinding,
} from './bulk-signal-workflows.ts';
import { cancelScheduleOperation, cancelScheduleRestBinding } from './cancel-schedule.ts';
import { cancelWorkflowOperation, cancelWorkflowRestBinding } from './cancel-workflow.ts';
import { createScheduleOperation, createScheduleRestBinding } from './create-schedule.ts';
import { fleetEventsSseOperation, fleetEventsSseRestBinding } from './fleet-events-sse.ts';
import { fleetEventsSubscriptionOperation } from './fleet-events-subscription.ts';
import { forkWorkflowOperation, forkWorkflowRestBinding } from './fork-workflow.ts';
import { getCheckpointAtOperation, getCheckpointAtRestBinding } from './get-checkpoint-at.ts';
import { getPrincipalOperation, getPrincipalRestBinding } from './get-principal.ts';
import { getRegistryOperation, getRegistryRestBinding } from './get-registry.ts';
import {
  getRetentionOverviewOperation,
  getRetentionOverviewRestBinding,
} from './get-retention-overview.ts';
import { getReviewOperation, getReviewRestBinding } from './get-review.ts';
import { getScheduleOperation, getScheduleRestBinding } from './get-schedule.ts';
import { getStreamChunksOperation, getStreamChunksRestBinding } from './get-stream-chunks.ts';
import { getSystemLeaseOperation, getSystemLeaseRestBinding } from './get-system-lease.ts';
import {
  clearTaskDeadLetterOperation,
  clearTaskDeadLetterRestBinding,
  getTaskDiagnosticsRestBinding,
} from './get-task-diagnostics.ts';
import { getUpdateResultOperation, getUpdateResultRestBinding } from './get-update-result.ts';
import {
  getWorkflowAttributesOperation,
  getWorkflowAttributesRestBinding,
} from './get-workflow-attributes.ts';
import { getWorkflowEventsOperation, getWorkflowEventsRestBinding } from './get-workflow-events.ts';
import * as workflowObservability from './get-workflow-observability.ts';
import { getWorkflowResultOperation, getWorkflowResultRestBinding } from './get-workflow-result.ts';
import {
  getWorkflowTimelineOperation,
  getWorkflowTimelineRestBinding,
} from './get-workflow-timeline.ts';
import { getWorkflowOperation, getWorkflowRestBinding } from './get-workflow.ts';
import { listAlertsOperation, listAlertsRestBinding } from './list-alerts.ts';
import { listCheckpointsOperation, listCheckpointsRestBinding } from './list-checkpoints.ts';
import { listReviewsOperation, listReviewsRestBinding } from './list-reviews.ts';
import { listSchedulesOperation, listSchedulesRestBinding } from './list-schedules.ts';
import { listWorkflowsOperation, listWorkflowsRestBinding } from './list-workflows.ts';
import { pauseScheduleOperation, pauseScheduleRestBinding } from './pause-schedule.ts';
import { purgeWorkflowsOperation, purgeWorkflowsRestBinding } from './purge-workflows.ts';
import {
  queryWorkflowOperation,
  queryWorkflowRestBinding,
  queryWorkflowWithInputRestBinding,
} from './query-workflow.ts';
import { recoverAllOperation, recoverAllRestBinding } from './recover-all.ts';
import {
  removeWorkflowTagsOperation,
  removeWorkflowTagsRestBinding,
} from './remove-workflow-tags.ts';
import { replayWorkflowOperation, replayWorkflowRestBinding } from './replay-workflow.ts';
import { resumeScheduleOperation, resumeScheduleRestBinding } from './resume-schedule.ts';
import { resumeWorkflowOperation, resumeWorkflowRestBinding } from './resume-workflow.ts';
import {
  setWorkflowAttributesOperation,
  setWorkflowAttributesRestBinding,
} from './set-workflow-attributes.ts';
import { signalWorkflowOperation, signalWorkflowRestBinding } from './signal-workflow.ts';
import {
  startOrSignalWorkflowOperation,
  startOrSignalWorkflowRestBinding,
} from './start-or-signal-workflow.ts';
import { startWorkflowOperation, startWorkflowRestBinding } from './start-workflow.ts';
import * as storageCapabilities from './storage-capabilities.ts';
import {
  storageBatchOperation,
  storageBatchRestBinding,
  storageConditionalBatchOperation,
  storageConditionalBatchRestBinding,
  storageDeleteOperation,
  storageDeleteRestBinding,
  storageGetOperation,
  storageGetRestBinding,
  storagePutOperation,
  storagePutRestBinding,
  storageScanOperation,
  storageScanRestBinding,
} from './storage.ts';
import { streamWorkflowSseOperation, streamWorkflowSseRestBinding } from './stream-workflow-sse.ts';
import {
  submitReviewDecisionOperation,
  submitReviewDecisionRestBinding,
} from './submit-review-decision.ts';
import { suspendWorkflowOperation, suspendWorkflowRestBinding } from './suspend-workflow.ts';
import { timeoutWorkflowOperation, timeoutWorkflowRestBinding } from './timeout-workflow.ts';
import { updateScheduleOperation, updateScheduleRestBinding } from './update-schedule.ts';
import { updateWorkflowOperation, updateWorkflowRestBinding } from './update-workflow.ts';
import { workflowEventsSseOperation, workflowEventsSseRestBinding } from './workflow-events-sse.ts';
import { workflowEventsSubscriptionOperation } from './workflow-events-subscription.ts';

/**
 * Static REST bindings for all operations that do not need per-server
 * configuration. `rest-bindings.ts` re-exports this as `REST_BINDINGS` and
 * appends the per-server factory bindings in `createLiveRestBindings()`.
 */
export const STATIC_REST_BINDINGS: ReadonlyArray<UnknownRestBinding> = [
  listAlertsRestBinding,
  getPrincipalRestBinding,
  startWorkflowRestBinding,
  startOrSignalWorkflowRestBinding,
  recoverAllRestBinding,
  listWorkflowsRestBinding,
  aggregateWorkflowsRestBinding,
  purgeWorkflowsRestBinding,
  bulkCancelWorkflowsRestBinding,
  bulkSignalWorkflowsRestBinding,
  bulkRetryFailedWorkflowsRestBinding,
  bulkDeleteWorkflowsRestBinding,
  bulkMutateWorkflowTagsRestBinding,
  getWorkflowRestBinding,
  cancelWorkflowRestBinding,
  getWorkflowResultRestBinding,
  getWorkflowAttributesRestBinding,
  ...workflowObservability.workflowObservabilityRestBindings,
  getWorkflowEventsRestBinding,
  setWorkflowAttributesRestBinding,
  signalWorkflowRestBinding,
  asyncActivity.listPendingAsyncActivitiesRestBinding,
  asyncActivity.completeAsyncActivityRestBinding,
  asyncActivity.failAsyncActivityRestBinding,
  queryWorkflowRestBinding,
  queryWorkflowWithInputRestBinding,
  resumeWorkflowRestBinding,
  suspendWorkflowRestBinding,
  forkWorkflowRestBinding,
  timeoutWorkflowRestBinding,
  updateWorkflowRestBinding,
  createScheduleRestBinding,
  updateScheduleRestBinding,
  getRegistryRestBinding,
  getSystemLeaseRestBinding,
  getRetentionOverviewRestBinding,
  getUpdateResultRestBinding,
  listReviewsRestBinding,
  getReviewRestBinding,
  listCheckpointsRestBinding,
  getCheckpointAtRestBinding,
  getWorkflowTimelineRestBinding,
  addWorkflowTagsRestBinding,
  removeWorkflowTagsRestBinding,
  submitReviewDecisionRestBinding,
  cancelScheduleRestBinding,
  pauseScheduleRestBinding,
  resumeScheduleRestBinding,
  getStreamChunksRestBinding,
  streamWorkflowSseRestBinding,
  workflowEventsSseRestBinding,
  fleetEventsSseRestBinding,
  getTaskDiagnosticsRestBinding,
  clearTaskDeadLetterRestBinding,
  // Operation-catalog-backed routes
  listSchedulesRestBinding,
  getScheduleRestBinding,
  replayWorkflowRestBinding,
  storageCapabilities.storageCapabilitiesRestBinding,
  storageGetRestBinding,
  storagePutRestBinding,
  storageDeleteRestBinding,
  storageScanRestBinding,
  storageBatchRestBinding,
  storageConditionalBatchRestBinding,
];

/**
 * Statically-configured operations, in registration order.
 * `rest-bindings.ts`'s `createLiveOperationRegistry()` appends the
 * per-server factory operations (metrics, workers, task queues,
 * diagnostics); the registry is keyed by operation name, so relative
 * order carries no behavior.
 */
export const STATIC_OPERATIONS: ReadonlyArray<RegistrableOperation> = [
  startWorkflowOperation,
  startOrSignalWorkflowOperation,
  recoverAllOperation,
  listWorkflowsOperation,
  aggregateWorkflowsOperation,
  purgeWorkflowsOperation,
  bulkCancelWorkflowsOperation,
  bulkSignalWorkflowsOperation,
  bulkRetryFailedWorkflowsOperation,
  bulkDeleteWorkflowsOperation,
  bulkMutateWorkflowTagsOperation,
  getWorkflowOperation,
  cancelWorkflowOperation,
  getWorkflowResultOperation,
  getWorkflowAttributesOperation,
  ...workflowObservability.workflowObservabilityOperations,
  getWorkflowEventsOperation,
  setWorkflowAttributesOperation,
  signalWorkflowOperation,
  asyncActivity.listPendingAsyncActivitiesOperation,
  asyncActivity.completeAsyncActivityOperation,
  asyncActivity.failAsyncActivityOperation,
  queryWorkflowOperation,
  resumeWorkflowOperation,
  suspendWorkflowOperation,
  forkWorkflowOperation,
  timeoutWorkflowOperation,
  updateWorkflowOperation,
  createScheduleOperation,
  updateScheduleOperation,
  getRegistryOperation,
  getSystemLeaseOperation,
  getRetentionOverviewOperation,
  getUpdateResultOperation,
  listReviewsOperation,
  getReviewOperation,
  listCheckpointsOperation,
  getCheckpointAtOperation,
  getWorkflowTimelineOperation,
  addWorkflowTagsOperation,
  removeWorkflowTagsOperation,
  submitReviewDecisionOperation,
  cancelScheduleOperation,
  pauseScheduleOperation,
  resumeScheduleOperation,
  getStreamChunksOperation,
  streamWorkflowSseOperation,
  workflowEventsSseOperation,
  fleetEventsSseOperation,
  workflowEventsSubscriptionOperation,
  fleetEventsSubscriptionOperation,
  clearTaskDeadLetterOperation,
  // Operation-catalog-backed routes
  listSchedulesOperation,
  listAlertsOperation,
  getPrincipalOperation,
  getScheduleOperation,
  replayWorkflowOperation,
  storageCapabilities.storageCapabilitiesOperation,
  storageGetOperation,
  storagePutOperation,
  storageDeleteOperation,
  storageScanOperation,
  storageBatchOperation,
  storageConditionalBatchOperation,
];

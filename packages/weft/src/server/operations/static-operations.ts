/** Static operations that require no per-server configuration. */
import type { RegistrableOperation } from '../operation-catalog.ts';
import { activateWorkflowRevisionOperation } from './activate-workflow-revision.ts';
import { addWorkflowTagsOperation } from './add-workflow-tags.ts';
import { aggregateWorkflowsOperation } from './aggregate-workflows.ts';
import * as asyncActivity from './async-activity.ts';
import { bulkCancelWorkflowsOperation } from './bulk-cancel-workflows.ts';
import { bulkDeleteWorkflowsOperation } from './bulk-delete-workflows.ts';
import { bulkMutateWorkflowTagsOperation } from './bulk-mutate-workflow-tags.ts';
import { bulkRetryFailedWorkflowsOperation } from './bulk-retry-failed-workflows.ts';
import { bulkSignalWorkflowsOperation } from './bulk-signal-workflows.ts';
import { cancelScheduleOperation } from './cancel-schedule.ts';
import { cancelWorkflowOperation } from './cancel-workflow.ts';
import { clearTaskDeadLetterOperation } from './clear-task-dead-letter.ts';
import { createScheduleOperation } from './create-schedule.ts';
import { fleetEventsSseOperation } from './fleet-events-sse.ts';
import { fleetEventsSubscriptionOperation } from './fleet-events-subscription.ts';
import { forkWorkflowOperation } from './fork-workflow.ts';
import { getActiveWorkflowRevisionOperation } from './get-active-workflow-revision.ts';
import { getCatalogDiagnosticsOperation } from './get-catalog-diagnostics.ts';
import { getCheckpointAtOperation } from './get-checkpoint-at.ts';
import { getPrincipalOperation } from './get-principal.ts';
import { getRegistryOperation } from './get-registry.ts';
import { getRetentionOverviewOperation } from './get-retention-overview.ts';
import { getReviewOperation } from './get-review.ts';
import { getScheduleOperation } from './get-schedule.ts';
import { getStreamChunksOperation } from './get-stream-chunks.ts';
import { getSystemLeaseOperation } from './get-system-lease.ts';
import { getTaskDetailOperation } from './get-task-detail.ts';
import { getUpdateResultOperation } from './get-update-result.ts';
import { getWorkflowAttributesOperation } from './get-workflow-attributes.ts';
import { getWorkflowEventsOperation } from './get-workflow-events.ts';
import * as workflowObservability from './get-workflow-observability.ts';
import { getWorkflowResultOperation } from './get-workflow-result.ts';
import { getWorkflowRevisionOperation } from './get-workflow-revision.ts';
import { getWorkflowTimelineOperation } from './get-workflow-timeline.ts';
import { getWorkflowOperation } from './get-workflow.ts';
import { installWorkflowRevisionOperation } from './install-workflow-revision.ts';
import { listAlertsOperation } from './list-alerts.ts';
import { listCatalogSourcesOperation } from './list-catalog-sources.ts';
import { listCheckpointsOperation } from './list-checkpoints.ts';
import { listReviewsOperation } from './list-reviews.ts';
import { listSchedulesOperation } from './list-schedules.ts';
import { listWorkflowRevisionsOperation } from './list-workflow-revisions.ts';
import { listWorkflowsOperation } from './list-workflows.ts';
import { pauseScheduleOperation } from './pause-schedule.ts';
import { preloadWorkflowRevisionOperation } from './preload-workflow-revision.ts';
import { purgeWorkflowsOperation } from './purge-workflows.ts';
import { queryWorkflowOperation } from './query-workflow.ts';
import { recoverAllOperation } from './recover-all.ts';
import { removeWorkflowTagsOperation } from './remove-workflow-tags.ts';
import { replayWorkflowOperation } from './replay-workflow.ts';
import { resumeScheduleOperation } from './resume-schedule.ts';
import { resumeWorkflowOperation } from './resume-workflow.ts';
import { setWorkflowAttributesOperation } from './set-workflow-attributes.ts';
import { signalWorkflowOperation } from './signal-workflow.ts';
import { startOrSignalWorkflowOperation } from './start-or-signal-workflow.ts';
import { startWorkflowOperation } from './start-workflow.ts';
import * as storageCapabilities from './storage-capabilities.ts';
import {
  storageBatchOperation,
  storageConditionalBatchOperation,
  storageDeleteOperation,
  storageGetOperation,
  storagePutOperation,
  storageScanOperation,
} from './storage.ts';
import { streamWorkflowSseOperation } from './stream-workflow-sse.ts';
import { submitReviewDecisionOperation } from './submit-review-decision.ts';
import { suspendWorkflowOperation } from './suspend-workflow.ts';
import { timeoutWorkflowOperation } from './timeout-workflow.ts';
import { updateScheduleOperation } from './update-schedule.ts';
import { updateWorkflowOperation } from './update-workflow.ts';
import { workflowEventsSseOperation } from './workflow-events-sse.ts';
import { workflowEventsSubscriptionOperation } from './workflow-events-subscription.ts';

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
  listCatalogSourcesOperation,
  getCatalogDiagnosticsOperation,
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
  installWorkflowRevisionOperation,
  activateWorkflowRevisionOperation,
  preloadWorkflowRevisionOperation,
  getWorkflowRevisionOperation,
  listWorkflowRevisionsOperation,
  getActiveWorkflowRevisionOperation,
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
  getTaskDetailOperation,
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

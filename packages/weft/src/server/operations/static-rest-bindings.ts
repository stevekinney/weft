/** Static HTTP bindings in route matching order. */
import {
  type UnknownRestBinding,
  getPrincipalRestBinding,
} from "../../embedded/backchannel/src/internals.ts";
import { activateWorkflowRevisionRestBinding } from './activate-workflow-revision.ts';
import { addWorkflowTagsRestBinding } from './add-workflow-tags.ts';
import { aggregateWorkflowsRestBinding } from './aggregate-workflows.ts';
import * as asyncActivity from './async-activity.ts';
import { bulkCancelWorkflowsRestBinding } from './bulk-cancel-workflows.ts';
import { bulkDeleteWorkflowsRestBinding } from './bulk-delete-workflows.ts';
import { bulkMutateWorkflowTagsRestBinding } from './bulk-mutate-workflow-tags.ts';
import { bulkRetryFailedWorkflowsRestBinding } from './bulk-retry-failed-workflows.ts';
import { bulkSignalWorkflowsRestBinding } from './bulk-signal-workflows.ts';
import { cancelScheduleRestBinding } from './cancel-schedule.ts';
import { cancelWorkflowRestBinding } from './cancel-workflow.ts';
import { clearTaskDeadLetterRestBinding } from './clear-task-dead-letter.ts';
import { compareWorkflowRestBinding } from './compare-workflow.ts';
import { createScheduleRestBinding } from './create-schedule.ts';
import { fleetEventsSseRestBinding } from './fleet-events-sse.ts';
import { forkWorkflowRestBinding } from './fork-workflow.ts';
import { getActiveWorkflowRevisionRestBinding } from './get-active-workflow-revision.ts';
import { getCatalogDiagnosticsRestBinding } from './get-catalog-diagnostics.ts';
import { getCheckpointAtRestBinding } from './get-checkpoint-at.ts';
import { getRealmDiagnosticsRestBinding } from './get-realm-diagnostics.ts';
import { getRefreshDiagnosticsRestBinding } from './get-refresh-diagnostics.ts';
import { getRegistryRestBinding } from './get-registry.ts';
import { getRetentionOverviewRestBinding } from './get-retention-overview.ts';
import { getReviewRestBinding } from './get-review.ts';
import { getScheduleRestBinding } from './get-schedule.ts';
import { getStreamChunksRestBinding } from './get-stream-chunks.ts';
import { getSystemLeaseRestBinding } from './get-system-lease.ts';
import {
  getTaskDeadLetterRestBinding,
  getTaskResultDeliveriesRestBinding,
} from './get-task-deliveries.ts';
import { getTaskDetailRestBinding } from './get-task-detail.ts';
import { getTaskDiagnosticsRestBinding } from './get-task-diagnostics.ts';
import { getUpdateResultRestBinding } from './get-update-result.ts';
import { getWorkflowAttributesRestBinding } from './get-workflow-attributes.ts';
import { getWorkflowDefinitionRestBinding } from './get-workflow-definition.ts';
import { getWorkflowEventsRestBinding } from './get-workflow-events.ts';
import * as workflowObservability from './get-workflow-observability.ts';
import { getWorkflowResultRestBinding } from './get-workflow-result.ts';
import { getWorkflowRevisionRestBinding } from './get-workflow-revision.ts';
import { getWorkflowTimelineRestBinding } from './get-workflow-timeline.ts';
import { getWorkflowRestBinding } from './get-workflow.ts';
import { installWorkflowRevisionRestBinding } from './install-workflow-revision.ts';
import { listAlertsRestBinding } from './list-alerts.ts';
import { listCatalogSourcesRestBinding } from './list-catalog-sources.ts';
import { listCheckpointsRestBinding } from './list-checkpoints.ts';
import { listQueueTasksRestBinding } from './list-queue-tasks.ts';
import { listReviewsRestBinding } from './list-reviews.ts';
import { listScheduleMissedFiresRestBinding } from './list-schedule-missed-fires.ts';
import { listSchedulesRestBinding } from './list-schedules.ts';
import { listWorkflowDefinitionsRestBinding } from './list-workflow-definitions.ts';
import { listWorkflowLogsRestBinding } from './list-workflow-logs.ts';
import { listWorkflowRevisionsRestBinding } from './list-workflow-revisions.ts';
import { listWorkflowUpdatesRestBinding } from './list-workflow-updates.ts';
import { listWorkflowsRestBinding } from './list-workflows.ts';
import { pauseScheduleRestBinding } from './pause-schedule.ts';
import { preloadWorkflowRevisionRestBinding } from './preload-workflow-revision.ts';
import { purgeWorkflowsRestBinding } from './purge-workflows.ts';
import { queryWorkflowRestBinding, queryWorkflowWithInputRestBinding } from './query-workflow.ts';
import { recoverAllRestBinding } from './recover-all.ts';
import { refreshWorkflowRestBinding } from './refresh-workflow.ts';
import { removeWorkflowTagsRestBinding } from './remove-workflow-tags.ts';
import { replayWorkflowRestBinding } from './replay-workflow.ts';
import { resumeScheduleRestBinding } from './resume-schedule.ts';
import { resumeWorkflowRestBinding } from './resume-workflow.ts';
import { retryTaskDeadLetterRestBinding } from './retry-task-dead-letter.ts';
import { setWorkflowAttributesRestBinding } from './set-workflow-attributes.ts';
import { signalWorkflowRestBinding } from './signal-workflow.ts';
import { skipNextScheduleRestBinding } from './skip-next-schedule.ts';
import { startOrSignalWorkflowRestBinding } from './start-or-signal-workflow.ts';
import { startWorkflowRestBinding } from './start-workflow.ts';
import * as storageCapabilities from './storage-capabilities.ts';
import {
  storageBatchRestBinding,
  storageConditionalBatchRestBinding,
  storageDeleteRestBinding,
  storageGetRestBinding,
  storagePreviewRestBinding,
  storagePutRestBinding,
  storageScanRestBinding,
} from './storage-rest-bindings.ts';
import { streamWorkflowSseRestBinding } from './stream-workflow-sse.ts';
import { submitReviewDecisionRestBinding } from './submit-review-decision.ts';
import { suspendWorkflowRestBinding } from './suspend-workflow.ts';
import { timeoutWorkflowRestBinding } from './timeout-workflow.ts';
import { triggerScheduleRestBinding } from './trigger-schedule.ts';
import { unskipScheduleRestBinding } from './unskip-schedule.ts';
import { updateScheduleRestBinding } from './update-schedule.ts';
import { updateWorkflowRestBinding } from './update-workflow.ts';
import { workerStartOverridePreviewRestBinding } from './worker-start-override-preview.ts';
import { workflowEventsSseRestBinding } from './workflow-events-sse.ts';

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
  listCatalogSourcesRestBinding,
  listWorkflowDefinitionsRestBinding,
  getWorkflowDefinitionRestBinding,
  getCatalogDiagnosticsRestBinding,
  getRealmDiagnosticsRestBinding,
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
  listWorkflowUpdatesRestBinding,
  listWorkflowLogsRestBinding,
  createScheduleRestBinding,
  updateScheduleRestBinding,
  getRegistryRestBinding,
  installWorkflowRevisionRestBinding,
  activateWorkflowRevisionRestBinding,
  preloadWorkflowRevisionRestBinding,
  refreshWorkflowRestBinding,
  getRefreshDiagnosticsRestBinding,
  getWorkflowRevisionRestBinding,
  listWorkflowRevisionsRestBinding,
  getActiveWorkflowRevisionRestBinding,
  getSystemLeaseRestBinding,
  getRetentionOverviewRestBinding,
  getUpdateResultRestBinding,
  listReviewsRestBinding,
  getReviewRestBinding,
  listCheckpointsRestBinding,
  getCheckpointAtRestBinding,
  getWorkflowTimelineRestBinding,
  compareWorkflowRestBinding,
  addWorkflowTagsRestBinding,
  removeWorkflowTagsRestBinding,
  submitReviewDecisionRestBinding,
  cancelScheduleRestBinding,
  pauseScheduleRestBinding,
  skipNextScheduleRestBinding,
  unskipScheduleRestBinding,
  triggerScheduleRestBinding,
  listScheduleMissedFiresRestBinding,
  resumeScheduleRestBinding,
  getStreamChunksRestBinding,
  streamWorkflowSseRestBinding,
  workflowEventsSseRestBinding,
  fleetEventsSseRestBinding,
  // getTaskDetailRestBinding lives under the /v1/tasks/detail/ namespace
  // specifically so its :operationId segment can never collide with a
  // sibling literal path (see the binding's own comment). Still registered
  // after the other /v1/tasks/... bindings on general principle — matchRestBinding
  // is first-match-wins in array order.
  getTaskDiagnosticsRestBinding,
  listQueueTasksRestBinding,
  clearTaskDeadLetterRestBinding,
  getTaskDetailRestBinding,
  getTaskResultDeliveriesRestBinding,
  getTaskDeadLetterRestBinding,
  retryTaskDeadLetterRestBinding,
  // Operation-catalog-backed routes
  listSchedulesRestBinding,
  getScheduleRestBinding,
  replayWorkflowRestBinding,
  storageCapabilities.storageCapabilitiesRestBinding,
  storageGetRestBinding,
  storagePreviewRestBinding,
  storagePutRestBinding,
  storageDeleteRestBinding,
  storageScanRestBinding,
  storageBatchRestBinding,
  storageConditionalBatchRestBinding,
  workerStartOverridePreviewRestBinding,
];

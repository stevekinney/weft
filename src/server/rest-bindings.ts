/**
 * Live registry of `RestBinding` instances for operation-backed REST routes.
 *
 * Each entry is a REST route whose dispatch flows through the shared
 * `executeOperation` pipeline. The router (handleRequest) checks reserved
 * direct meta and discovery routes first; remaining requests then match
 * these operation-backed bindings.
 *
 * @module server/rest-bindings
 */

import type { MetricsCollector } from '../observability/metrics.ts';
import type { WorkerRegistry } from '../worker/registry.ts';
import { createOperationRegistry, type OperationRegistry } from './operation-catalog.ts';
import {
  addWorkflowTagsOperation,
  addWorkflowTagsRestBinding,
} from './operations/add-workflow-tags.ts';
import {
  aggregateWorkflowsOperation,
  aggregateWorkflowsRestBinding,
} from './operations/aggregate-workflows.ts';
import {
  completeAsyncActivityOperation,
  completeAsyncActivityRestBinding,
  failAsyncActivityOperation,
  failAsyncActivityRestBinding,
} from './operations/async-activity.ts';
import {
  bulkCancelWorkflowsOperation,
  bulkCancelWorkflowsRestBinding,
} from './operations/bulk-cancel-workflows.ts';
import {
  bulkDeleteWorkflowsOperation,
  bulkDeleteWorkflowsRestBinding,
} from './operations/bulk-delete-workflows.ts';
import {
  bulkMutateWorkflowTagsOperation,
  bulkMutateWorkflowTagsRestBinding,
} from './operations/bulk-mutate-workflow-tags.ts';
import {
  bulkRetryFailedWorkflowsOperation,
  bulkRetryFailedWorkflowsRestBinding,
} from './operations/bulk-retry-failed-workflows.ts';
import {
  bulkSignalWorkflowsOperation,
  bulkSignalWorkflowsRestBinding,
} from './operations/bulk-signal-workflows.ts';
import {
  cancelScheduleOperation,
  cancelScheduleRestBinding,
} from './operations/cancel-schedule.ts';
import {
  cancelWorkflowOperation,
  cancelWorkflowRestBinding,
} from './operations/cancel-workflow.ts';
import {
  createScheduleOperation,
  createScheduleRestBinding,
} from './operations/create-schedule.ts';
import {
  fleetEventsSseOperation,
  fleetEventsSseRestBinding,
} from './operations/fleet-events-sse.ts';
import { fleetEventsSubscriptionOperation } from './operations/fleet-events-subscription.ts';
import { forkWorkflowOperation, forkWorkflowRestBinding } from './operations/fork-workflow.ts';
import {
  getCheckpointAtOperation,
  getCheckpointAtRestBinding,
} from './operations/get-checkpoint-at.ts';
import { getRegistryOperation, getRegistryRestBinding } from './operations/get-registry.ts';
import {
  getRetentionOverviewOperation,
  getRetentionOverviewRestBinding,
} from './operations/get-retention-overview.ts';
import { getReviewOperation, getReviewRestBinding } from './operations/get-review.ts';
import { getScheduleOperation, getScheduleRestBinding } from './operations/get-schedule.ts';
import {
  getStreamChunksOperation,
  getStreamChunksRestBinding,
} from './operations/get-stream-chunks.ts';
import {
  createGetSystemMetricsOperation,
  createGetSystemMetricsRestBinding,
} from './operations/get-system-metrics.ts';
import {
  clearTaskDeadLetterOperation,
  clearTaskDeadLetterRestBinding,
  createGetTaskDiagnosticsOperation,
  getTaskDiagnosticsOperation,
  getTaskDiagnosticsRestBinding,
} from './operations/get-task-diagnostics.ts';
import {
  getUpdateResultOperation,
  getUpdateResultRestBinding,
} from './operations/get-update-result.ts';
import {
  getWorkflowAttributesOperation,
  getWorkflowAttributesRestBinding,
} from './operations/get-workflow-attributes.ts';
import {
  getWorkflowEventsOperation,
  getWorkflowEventsRestBinding,
} from './operations/get-workflow-events.ts';
import {
  getWorkflowResultOperation,
  getWorkflowResultRestBinding,
} from './operations/get-workflow-result.ts';
import {
  getWorkflowTimelineOperation,
  getWorkflowTimelineRestBinding,
} from './operations/get-workflow-timeline.ts';
import { getWorkflowOperation, getWorkflowRestBinding } from './operations/get-workflow.ts';
import {
  listCheckpointsOperation,
  listCheckpointsRestBinding,
} from './operations/list-checkpoints.ts';
import { listReviewsOperation, listReviewsRestBinding } from './operations/list-reviews.ts';
import { listSchedulesOperation, listSchedulesRestBinding } from './operations/list-schedules.ts';
import {
  createListTaskQueuesOperation,
  createListTaskQueuesRestBinding,
  listTaskQueuesOperation,
} from './operations/list-task-queues.ts';
import {
  createListWorkersOperation,
  createListWorkersRestBinding,
  listWorkersOperation,
} from './operations/list-workers.ts';
import { listWorkflowsOperation, listWorkflowsRestBinding } from './operations/list-workflows.ts';
import { pauseScheduleOperation, pauseScheduleRestBinding } from './operations/pause-schedule.ts';
import {
  purgeWorkflowsOperation,
  purgeWorkflowsRestBinding,
} from './operations/purge-workflows.ts';
import {
  queryWorkflowOperation,
  queryWorkflowRestBinding,
  queryWorkflowWithInputRestBinding,
} from './operations/query-workflow.ts';
import { recoverAllOperation, recoverAllRestBinding } from './operations/recover-all.ts';
import {
  removeWorkflowTagsOperation,
  removeWorkflowTagsRestBinding,
} from './operations/remove-workflow-tags.ts';
import {
  replayWorkflowOperation,
  replayWorkflowRestBinding,
} from './operations/replay-workflow.ts';
import {
  resumeScheduleOperation,
  resumeScheduleRestBinding,
} from './operations/resume-schedule.ts';
import {
  resumeWorkflowOperation,
  resumeWorkflowRestBinding,
} from './operations/resume-workflow.ts';
import {
  setWorkflowAttributesOperation,
  setWorkflowAttributesRestBinding,
} from './operations/set-workflow-attributes.ts';
import {
  signalWorkflowOperation,
  signalWorkflowRestBinding,
} from './operations/signal-workflow.ts';
import {
  startOrSignalWorkflowOperation,
  startOrSignalWorkflowRestBinding,
} from './operations/start-or-signal-workflow.ts';
import { startWorkflowOperation, startWorkflowRestBinding } from './operations/start-workflow.ts';
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
} from './operations/storage.ts';
import {
  streamWorkflowSseOperation,
  streamWorkflowSseRestBinding,
} from './operations/stream-workflow-sse.ts';
import {
  submitReviewDecisionOperation,
  submitReviewDecisionRestBinding,
} from './operations/submit-review-decision.ts';
import {
  suspendWorkflowOperation,
  suspendWorkflowRestBinding,
} from './operations/suspend-workflow.ts';
import {
  timeoutWorkflowOperation,
  timeoutWorkflowRestBinding,
} from './operations/timeout-workflow.ts';
import {
  updateScheduleOperation,
  updateScheduleRestBinding,
} from './operations/update-schedule.ts';
import {
  updateWorkflowOperation,
  updateWorkflowRestBinding,
} from './operations/update-workflow.ts';
import {
  clearDeploymentDrainOperation,
  clearWorkerDrainOperation,
  createClearDeploymentDrainOperation,
  createClearDeploymentDrainRestBinding,
  createClearWorkerDrainOperation,
  createClearWorkerDrainRestBinding,
  createDrainDeploymentOperation,
  createDrainDeploymentRestBinding,
  createDrainWorkerOperation,
  createDrainWorkerRestBinding,
  drainDeploymentOperation,
  drainWorkerOperation,
} from './operations/worker-drain.ts';
import {
  workflowEventsSseOperation,
  workflowEventsSseRestBinding,
} from './operations/workflow-events-sse.ts';
import { workflowEventsSubscriptionOperation } from './operations/workflow-events-subscription.ts';
import type { RestBinding } from './rest-binding.ts';
import type { TaskQueue } from './task-queue.ts';

/**
 * The router stores heterogeneous bindings whose `Input`/`Output` pairs
 * all differ. `RestBinding<Input, Output>` is strictly-typed at the
 * author boundary (so `defineOperation` + binding factories catch
 * mistakes), but at the router level those generics are irrelevant —
 * every binding produces a `Response` regardless of its output type.
 *
 * `RestBinding<any, any>` is the idiomatic way to express "a binding
 * with SOME Input/Output pair the router doesn't care about." A stricter
 * `unknown, unknown` form fails under `exactOptionalPropertyTypes`
 * because `shapeSuccess: (Output) => Response` cannot be safely widened
 * to `(unknown) => Response` (function parameters are contravariant).
 */
export type UnknownRestBinding = RestBinding<any, any>;

/**
 * Static REST bindings for all operations that do not need per-server
 * configuration. The `weft.system.metrics` binding is excluded here
 * because it is constructed per-server via `createGetSystemMetricsRestBinding`
 * (to receive the metrics collector without module-level singletons).
 * Use `createLiveRestBindings()` to get the full set for a given server.
 */
export const REST_BINDINGS: ReadonlyArray<UnknownRestBinding> = [
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
  getWorkflowEventsRestBinding,
  setWorkflowAttributesRestBinding,
  signalWorkflowRestBinding,
  completeAsyncActivityRestBinding,
  failAsyncActivityRestBinding,
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
  storageGetRestBinding,
  storagePutRestBinding,
  storageDeleteRestBinding,
  storageScanRestBinding,
  storageBatchRestBinding,
  storageConditionalBatchRestBinding,
];

/**
 * Build the full REST binding set for a server instance. Appends the
 * `weft.system.metrics`, `weft.workers.list`, and `weft.task.queues.list`
 * bindings. Each takes no per-server data on the binding side; the
 * runtime dependencies (metrics collector, worker registry, task queue)
 * are wired into the operations through {@link createLiveOperationRegistry}.
 */
export function createLiveRestBindings(): ReadonlyArray<UnknownRestBinding> {
  return [
    ...REST_BINDINGS,
    createGetSystemMetricsRestBinding(),
    createListWorkersRestBinding(),
    createDrainWorkerRestBinding(),
    createClearWorkerDrainRestBinding(),
    createDrainDeploymentRestBinding(),
    createClearDeploymentDrainRestBinding(),
    createListTaskQueuesRestBinding(),
  ];
}

/**
 * Live operation registry — populated with every operation that has a
 * `RestBinding`, a JSON-RPC mount, or an stdio mount. Exposed via a
 * factory so tests can spin up a fresh registry without inheriting
 * the live one's state.
 *
 * Concrete `OperationDefinition<Input, Output>` values are directly
 * assignable to `RegistrableOperation` by the variance design in
 * `operation-catalog.ts` — no `as ErasedOperation` cast is needed.
 */
/**
 * Create the live operation registry for a server instance.
 *
 * Live `serve()` passes `workerRegistry` and `taskQueue` so the
 * infrastructure-observability operations (`weft.workers.list`,
 * `weft.task.queues.list`) bind their `invoke` to real server state.
 *
 * Callers that build the registry for **discovery only**
 * (`openapi.ts`, `asyncapi.ts`) omit both. The operations are still
 * registered with full metadata so the catalog matches the live wire
 * surface, but their `invoke` paths throw if reached — no discovery-only
 * registry is ever used to serve real requests.
 */
type LiveOperationRegistryOptions = {
  metricsCollector?: MetricsCollector;
  workerRegistry?: WorkerRegistry;
  taskQueue?: TaskQueue;
  clock?: () => number;
};

function buildSystemMetricsOperation(options: LiveOperationRegistryOptions) {
  return createGetSystemMetricsOperation({ metricsCollector: options.metricsCollector });
}

function buildListWorkersOperationForRegistry(options: LiveOperationRegistryOptions) {
  if (options.workerRegistry === undefined) return listWorkersOperation;
  return createListWorkersOperation({
    workerRegistry: options.workerRegistry,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });
}

function buildDrainWorkerOperationForRegistry(options: LiveOperationRegistryOptions) {
  if (options.workerRegistry === undefined) return drainWorkerOperation;
  return createDrainWorkerOperation({
    workerRegistry: options.workerRegistry,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });
}

function buildClearWorkerDrainOperationForRegistry(options: LiveOperationRegistryOptions) {
  if (options.workerRegistry === undefined) return clearWorkerDrainOperation;
  return createClearWorkerDrainOperation({ workerRegistry: options.workerRegistry });
}

function buildDrainDeploymentOperationForRegistry(options: LiveOperationRegistryOptions) {
  if (options.workerRegistry === undefined) return drainDeploymentOperation;
  return createDrainDeploymentOperation({
    workerRegistry: options.workerRegistry,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });
}

function buildClearDeploymentDrainOperationForRegistry(options: LiveOperationRegistryOptions) {
  if (options.workerRegistry === undefined) return clearDeploymentDrainOperation;
  return createClearDeploymentDrainOperation({ workerRegistry: options.workerRegistry });
}

function buildListTaskQueuesOperationForRegistry(options: LiveOperationRegistryOptions) {
  if (options.workerRegistry === undefined || options.taskQueue === undefined) {
    return listTaskQueuesOperation;
  }
  return createListTaskQueuesOperation({
    workerRegistry: options.workerRegistry,
    taskQueue: options.taskQueue,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });
}

function buildTaskDiagnosticsOperationForRegistry(options: LiveOperationRegistryOptions) {
  if (options.workerRegistry === undefined || options.taskQueue === undefined) {
    return getTaskDiagnosticsOperation;
  }
  return createGetTaskDiagnosticsOperation({
    registry: options.workerRegistry,
    taskQueue: options.taskQueue,
    ...(options.clock !== undefined ? { now: options.clock } : {}),
  });
}

export function createLiveOperationRegistry(
  options?: LiveOperationRegistryOptions,
): OperationRegistry {
  const resolved: LiveOperationRegistryOptions = options ?? {};
  return createOperationRegistry([
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
    getWorkflowEventsOperation,
    setWorkflowAttributesOperation,
    signalWorkflowOperation,
    completeAsyncActivityOperation,
    failAsyncActivityOperation,
    queryWorkflowOperation,
    resumeWorkflowOperation,
    suspendWorkflowOperation,
    forkWorkflowOperation,
    timeoutWorkflowOperation,
    updateWorkflowOperation,
    createScheduleOperation,
    updateScheduleOperation,
    getRegistryOperation,
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
    buildTaskDiagnosticsOperationForRegistry(resolved),
    clearTaskDeadLetterOperation,
    // Operation-catalog-backed routes
    listSchedulesOperation,
    getScheduleOperation,
    replayWorkflowOperation,
    storageGetOperation,
    storagePutOperation,
    storageDeleteOperation,
    storageScanOperation,
    storageBatchOperation,
    storageConditionalBatchOperation,
    buildSystemMetricsOperation(resolved),
    buildListWorkersOperationForRegistry(resolved),
    buildDrainWorkerOperationForRegistry(resolved),
    buildClearWorkerDrainOperationForRegistry(resolved),
    buildDrainDeploymentOperationForRegistry(resolved),
    buildClearDeploymentDrainOperationForRegistry(resolved),
    buildListTaskQueuesOperationForRegistry(resolved),
  ]);
}

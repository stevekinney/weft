/**
 * Live registry of `RestBinding` instances for operation-backed REST routes.
 *
 * Each entry is a REST route whose dispatch flows through the shared
 * `executeOperation` pipeline. The router (handleRequest) checks reserved
 * direct meta and discovery routes first; remaining requests then match
 * these operation-backed bindings.
 *
 * Statically-configured operations and bindings live in
 * `operations/static-operations.ts` and `operations/static-rest-bindings.ts`; this module owns the heterogeneous
 * binding type, the per-server factory wiring (metrics, workers, task
 * queues, diagnostics), and the composed live registry/binding builders.
 *
 * @module server/rest-bindings
 */

import {
  createOperationRegistry,
  type OperationRegistry,
  type RegistrableOperation,
  type UnknownRestBinding,
} from "../embedded/backchannel/src/internals.ts";
import type { Storage } from "../embedded/storage/src/index.ts";
import type { ConformanceTargetRunner } from '../conformance/targets.ts';
import type { RegistryAgnosticEngine } from '../core/engine.ts';
import type { RemoteTaskQueued } from '../core/task-ledger/task-ledger-types.ts';
import type { MetricsCollector } from '../observability/metrics.ts';
import type { WorkerDeploymentCatalog } from '../worker/deployment-routing.ts';
import type { WorkerRegistry } from '../worker/registry.ts';
import {
  createCompareWorkflowOperation,
  type WorkflowReadAuthorizer,
} from './operations/compare-workflow.ts';
import {
  createListConformanceTargetsOperation,
  createRunConformanceReportOperation,
  listConformanceTargetsOperation,
  listConformanceTargetsRestBinding,
  runConformanceReportOperation,
  runConformanceReportRestBinding,
} from './operations/conformance.ts';
import {
  createForgetWorkerOperation,
  createForgetWorkerRestBinding,
  forgetWorkerOperation,
} from './operations/forget-worker.ts';
import {
  createGetSystemMetricsOperation,
  createGetSystemMetricsRestBinding,
} from './operations/get-system-metrics.ts';
import {
  createGetTaskDiagnosticsOperation,
  getTaskDiagnosticsOperation,
} from './operations/get-task-diagnostics.ts';
import {
  createGetWorkerDiagnosticsOperation,
  createGetWorkerDiagnosticsRestBinding,
  getWorkerDiagnosticsOperation,
  type WorkerSessionTiming,
} from './operations/get-worker-diagnostics.ts';
import {
  createListTaskQueuesOperation,
  createListTaskQueuesRestBinding,
  listTaskQueuesOperation,
} from './operations/list-task-queues.ts';
import {
  createListWorkerRegistrationRejectionsOperation,
  createListWorkerRegistrationRejectionsRestBinding,
  listWorkerRegistrationRejectionsOperation,
} from './operations/list-worker-registration-rejections.ts';
import {
  createListWorkersOperation,
  createListWorkersRestBinding,
  listWorkersOperation,
} from './operations/list-workers.ts';
import { createRetryTaskDeadLetterOperation } from './operations/retry-task-dead-letter.ts';
import { createStartOrSignalWorkflowOperation } from './operations/start-or-signal-workflow.ts';
import { createStartWorkflowOperation } from './operations/start-workflow.ts';
import { STATIC_OPERATIONS } from './operations/static-operations.ts';
import { STATIC_REST_BINDINGS } from './operations/static-rest-bindings.ts';
import {
  createPreviewWorkerDeploymentRoutingOperation,
  createPromoteWorkerDeploymentOperation,
  createRemoveWorkerDeploymentVersionOperation,
  createRollbackWorkerDeploymentOperation,
  createSetWorkerDeploymentRoutingOperation,
  createWorkerDeploymentDiagnosticsOperation,
  workerDeploymentDiagnosticsRestBinding,
  workerDeploymentPreviewRestBinding,
  workerDeploymentPromoteRestBinding,
  workerDeploymentRemoveRestBinding,
  workerDeploymentRollbackRestBinding,
  workerDeploymentRoutingRestBinding,
} from './operations/worker-deployment-routing.ts';
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
import { createWorkerStartOverridePreviewOperation } from './operations/worker-start-override-preview.ts';
import type { TaskQueue } from './task-queue.ts';
import { weftFaultPolicy } from './weft-fault-policy.ts';

/**
 * Static REST bindings for all operations that do not need per-server
 * configuration. The `weft.system.metrics` binding is excluded because its
 * factory receives the per-server metrics collector.
 * Use `createLiveRestBindings()` to get the full set for a given server.
 */
export const REST_BINDINGS: ReadonlyArray<UnknownRestBinding> = STATIC_REST_BINDINGS;

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
    createForgetWorkerRestBinding(),
    createDrainDeploymentRestBinding(),
    createClearDeploymentDrainRestBinding(),
    createListTaskQueuesRestBinding(),
    createGetWorkerDiagnosticsRestBinding(),
    createListWorkerRegistrationRejectionsRestBinding(),
    workerDeploymentRoutingRestBinding,
    workerDeploymentDiagnosticsRestBinding,
    workerDeploymentPromoteRestBinding,
    workerDeploymentRollbackRestBinding,
    workerDeploymentPreviewRestBinding,
    workerDeploymentRemoveRestBinding,
    listConformanceTargetsRestBinding,
    runConformanceReportRestBinding,
  ];
}

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
export type LiveOperationRegistryOptions = {
  metricsCollector?: MetricsCollector;
  workerRegistry?: WorkerRegistry;
  workerDeploymentCatalog?: WorkerDeploymentCatalog;
  /** Receives the events operations raise after a mutation commits; `serve()` passes the engine's `dispatchEvent`. */
  dispatchEvent?: (event: Event) => void;
  storage?: Storage;
  /**
   * Hand a task queued by `weft.tasks.deadletters.retry` to the dispatcher at
   * once; `serve()` supplies it. Without it the retried record waits for the
   * ledger sweep, which dispatches a queued record nothing is tracking.
   */
  redispatchQueuedTask?: (record: RemoteTaskQueued) => void;
  taskQueue?: TaskQueue;
  clock?: () => number;
  /** Where `weft.workers.diagnostics` reads each worker's reconnect-grace and session-lease instants. */
  workerSessionTiming?: WorkerSessionTiming;
  workerStartOverrideSigningSecret?: string;
  /** Per-run read gate `weft.workflows.compare` asks for a fork and its source; `serve()` passes `authorizeWorkflowRead`. */
  authorizeWorkflowRead?: WorkflowReadAuthorizer;
  /**
   * Runs the operator-registered targets behind `weft.conformance.targets` and
   * `weft.conformance.report`. `serve()` always supplies one (empty when no
   * `conformanceTargets` are configured); discovery-only callers omit it.
   */
  conformanceTargetRunner?: ConformanceTargetRunner | undefined;
  /**
   * Operations declared outside this package, registered alongside Weft's own.
   *
   * The catalog is shared: `@lostgradient/operative` and `@lostgradient/bureau`
   * declare subscriptions with `defineOperation` and both already depend on
   * Weft, so a host serving all three wants one registry, one dispatch
   * pipeline, and one discovery document rather than a second RPC surface
   * standing beside this one.
   *
   * Appended last, and `createOperationRegistry` rejects a duplicate name, so
   * a foreign operation cannot shadow one of Weft's — it fails construction
   * instead, before a port is bound.
   */
  additionalOperations?: ReadonlyArray<RegistrableOperation<RegistryAgnosticEngine>>;
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

function buildForgetWorkerOperationForRegistry(options: LiveOperationRegistryOptions) {
  if (options.workerRegistry === undefined) return forgetWorkerOperation;
  return createForgetWorkerOperation({ workerRegistry: options.workerRegistry });
}

function buildDrainDeploymentOperationForRegistry(options: LiveOperationRegistryOptions) {
  if (options.workerRegistry === undefined) return drainDeploymentOperation;
  return createDrainDeploymentOperation({
    workerRegistry: options.workerRegistry,
    ...(options.dispatchEvent === undefined ? {} : { dispatchEvent: options.dispatchEvent }),
    ...(options.workerDeploymentCatalog === undefined
      ? {}
      : { catalog: options.workerDeploymentCatalog }),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });
}

function buildClearDeploymentDrainOperationForRegistry(options: LiveOperationRegistryOptions) {
  if (options.workerRegistry === undefined) return clearDeploymentDrainOperation;
  return createClearDeploymentDrainOperation({
    workerRegistry: options.workerRegistry,
    ...(options.dispatchEvent === undefined ? {} : { dispatchEvent: options.dispatchEvent }),
    ...(options.workerDeploymentCatalog === undefined
      ? {}
      : { catalog: options.workerDeploymentCatalog }),
  });
}

function buildRetryTaskDeadLetterOperationForRegistry(options: LiveOperationRegistryOptions) {
  return createRetryTaskDeadLetterOperation({
    metricsCollector: options.metricsCollector,
    redispatchQueuedTask: options.redispatchQueuedTask,
  });
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

function buildWorkerDiagnosticsOperationForRegistry(options: LiveOperationRegistryOptions) {
  if (options.workerRegistry === undefined) return getWorkerDiagnosticsOperation;
  return createGetWorkerDiagnosticsOperation({
    workerRegistry: options.workerRegistry,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.workerSessionTiming !== undefined
      ? { sessionTiming: options.workerSessionTiming }
      : {}),
  });
}

function buildWorkerRegistrationRejectionsOperationForRegistry(
  options: LiveOperationRegistryOptions,
) {
  if (options.workerRegistry === undefined) return listWorkerRegistrationRejectionsOperation;
  return createListWorkerRegistrationRejectionsOperation({
    workerRegistry: options.workerRegistry,
  });
}

function buildConformanceOperations(options: LiveOperationRegistryOptions) {
  const runner = options.conformanceTargetRunner;
  if (runner === undefined) {
    return [listConformanceTargetsOperation, runConformanceReportOperation];
  }
  return [
    createListConformanceTargetsOperation({ conformanceTargetRunner: runner }),
    createRunConformanceReportOperation({ conformanceTargetRunner: runner }),
  ];
}

function buildWorkerDeploymentRoutingOperations(options: LiveOperationRegistryOptions) {
  const catalog = options.workerDeploymentCatalog;
  const mutationOptions = {
    ...(catalog === undefined ? {} : { catalog }),
    ...(options.workerRegistry === undefined ? {} : { workerRegistry: options.workerRegistry }),
    ...(options.dispatchEvent === undefined ? {} : { dispatchEvent: options.dispatchEvent }),
  };
  return [
    createSetWorkerDeploymentRoutingOperation(mutationOptions),
    createPromoteWorkerDeploymentOperation(mutationOptions),
    createRollbackWorkerDeploymentOperation(mutationOptions),
    catalog === undefined
      ? createWorkerDeploymentDiagnosticsOperation()
      : createWorkerDeploymentDiagnosticsOperation({ catalog }),
    catalog === undefined
      ? createPreviewWorkerDeploymentRoutingOperation()
      : createPreviewWorkerDeploymentRoutingOperation({ catalog }),
    catalog === undefined
      ? createRemoveWorkerDeploymentVersionOperation()
      : createRemoveWorkerDeploymentVersionOperation({ catalog }),
  ];
}

function buildWorkerStartOverridePreviewOperation(options: LiveOperationRegistryOptions) {
  return createWorkerStartOverridePreviewOperation({
    ...(options.storage === undefined ? {} : { storage: options.storage }),
    ...(options.workerStartOverrideSigningSecret === undefined
      ? {}
      : { serverSecret: options.workerStartOverrideSigningSecret }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
}

function buildStartOrSignalWorkflowOperationForRegistry(options: LiveOperationRegistryOptions) {
  const { workerStartOverrideSigningSecret } = options;
  const signing =
    workerStartOverrideSigningSecret === undefined ? {} : { workerStartOverrideSigningSecret };
  return createStartOrSignalWorkflowOperation(signing);
}

function buildCompareWorkflowOperationForRegistry(options: LiveOperationRegistryOptions) {
  return createCompareWorkflowOperation({ authorizeWorkflowRead: options.authorizeWorkflowRead });
}

function buildStartWorkflowOperationForRegistry(options: LiveOperationRegistryOptions) {
  return createStartWorkflowOperation(
    options.workerStartOverrideSigningSecret === undefined
      ? {}
      : { workerStartOverrideSigningSecret: options.workerStartOverrideSigningSecret },
  );
}

/**
 * Build the registry of every operation this build serves, wiring the ones
 * that need live collaborators — task diagnostics, system metrics, the worker
 * registry — to the instances you pass, and falling back to standalone
 * versions for anything you omit.
 *
 * `serve()` calls this for you. Call it directly when you need the operation
 * surface without a running server: {@link createCatalogSnapshot} uses it as
 * its default source, which is how `weft codegen` describes a build it never
 * starts.
 *
 * @example
 * ```ts
 * import { createLiveOperationRegistry } from '@lostgradient/weft';
 *
 * const operations = createLiveOperationRegistry().list();
 *
 * console.log(operations.length, 'operations registered');
 * ```
 */
export function createLiveOperationRegistry(
  options?: LiveOperationRegistryOptions,
): OperationRegistry {
  const resolved: LiveOperationRegistryOptions = options ?? {};
  return createOperationRegistry<RegistryAgnosticEngine>(
    [
      ...STATIC_OPERATIONS.map((operation) =>
        operation.name === 'weft.workflows.start'
          ? buildStartWorkflowOperationForRegistry(resolved)
          : operation.name === 'weft.workflows.startorsignal'
            ? buildStartOrSignalWorkflowOperationForRegistry(resolved)
            : operation.name === 'weft.worker.startoverrides.preview'
              ? buildWorkerStartOverridePreviewOperation(resolved)
              : operation.name === 'weft.tasks.deadletters.retry'
                ? buildRetryTaskDeadLetterOperationForRegistry(resolved)
                : operation.name === 'weft.workflows.compare'
                  ? buildCompareWorkflowOperationForRegistry(resolved)
                  : operation,
      ),
      buildTaskDiagnosticsOperationForRegistry(resolved),
      buildSystemMetricsOperation(resolved),
      buildListWorkersOperationForRegistry(resolved),
      buildDrainWorkerOperationForRegistry(resolved),
      buildClearWorkerDrainOperationForRegistry(resolved),
      buildForgetWorkerOperationForRegistry(resolved),
      buildDrainDeploymentOperationForRegistry(resolved),
      buildClearDeploymentDrainOperationForRegistry(resolved),
      buildListTaskQueuesOperationForRegistry(resolved),
      buildWorkerDiagnosticsOperationForRegistry(resolved),
      buildWorkerRegistrationRejectionsOperationForRegistry(resolved),
      ...buildWorkerDeploymentRoutingOperations(resolved),
      ...buildConformanceOperations(resolved),
      ...(resolved.additionalOperations ?? []),
    ],
    { faultPolicy: weftFaultPolicy },
  );
}

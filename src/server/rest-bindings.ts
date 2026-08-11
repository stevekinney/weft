/**
 * Live registry of `RestBinding` instances for operation-backed REST routes.
 *
 * Each entry is a REST route whose dispatch flows through the shared
 * `executeOperation` pipeline. The router (handleRequest) checks reserved
 * direct meta and discovery routes first; remaining requests then match
 * these operation-backed bindings.
 *
 * Statically-configured operations and bindings live in
 * `operations/static-registrations.ts`; this module owns the heterogeneous
 * binding type, the per-server factory wiring (metrics, workers, task
 * queues, diagnostics), and the composed live registry/binding builders.
 *
 * @module server/rest-bindings
 */

import type { MetricsCollector } from '../observability/metrics.ts';
import type { WorkerRegistry } from '../worker/registry.ts';
import { createOperationRegistry, type OperationRegistry } from './operation-catalog.ts';
import {
  createGetSystemMetricsOperation,
  createGetSystemMetricsRestBinding,
} from './operations/get-system-metrics.ts';
import {
  createGetTaskDiagnosticsOperation,
  getTaskDiagnosticsOperation,
} from './operations/get-task-diagnostics.ts';
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
import { STATIC_OPERATIONS, STATIC_REST_BINDINGS } from './operations/static-registrations.ts';
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
    createDrainDeploymentRestBinding(),
    createClearDeploymentDrainRestBinding(),
    createListTaskQueuesRestBinding(),
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
    ...STATIC_OPERATIONS,
    buildTaskDiagnosticsOperationForRegistry(resolved),
    buildSystemMetricsOperation(resolved),
    buildListWorkersOperationForRegistry(resolved),
    buildDrainWorkerOperationForRegistry(resolved),
    buildClearWorkerDrainOperationForRegistry(resolved),
    buildDrainDeploymentOperationForRegistry(resolved),
    buildClearDeploymentDrainOperationForRegistry(resolved),
    buildListTaskQueuesOperationForRegistry(resolved),
  ]);
}

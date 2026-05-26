// ---------------------------------------------------------------------------
// RemoteWorker construction options
// ---------------------------------------------------------------------------

import type { ActivityInterceptor } from '../core/interceptor.ts';
import {
  REMOTE_WORKER_PROTOCOL_VERSION,
  type RegisterMessage,
  type RemoteWorkerCapabilities,
} from './protocol.ts';
import type {
  RemoteWorkerActivityFunction,
  RemoteWorkerWorkflowDefinition,
} from './workflow-activity-binding.ts';

/**
 * Options accepted by `new RemoteWorker(...)`.
 *
 * Workers may advertise their activities in two equivalent ways:
 *
 *   1. **Preferred — `workflows`**: a map of `workflowType → { name, activities }`.
 *      The SDK builds the qualified `${workflowType}.${activityName}` table that
 *      protocol v2 expects and validates that each outer key matches the inner
 *      `workflow.name`. This is the API the engine-side builder produces.
 *   2. **Legacy — `activities`**: a flat map whose keys are already qualified
 *      names. Useful for tests and ad-hoc workers that don't use the builder.
 *
 * Exactly one of `workflows` / `activities` must be provided.
 */
export interface RemoteWorkerOptions {
  serverUrl: string;
  workerId?: string;
  /**
   * Map of workflow type → workflow definition. The SDK produces qualified
   * activity names from this map and validates name grammar + key/name match.
   */
  workflows?: Record<string, RemoteWorkerWorkflowDefinition>;
  /**
   * Flat map of qualified activity name → executor. When supplied without
   * `workflows`, the worker advertises these names verbatim.
   */
  activities?: Record<string, RemoteWorkerActivityFunction>;
  concurrency?: number; // default: 10
  queue?: string; // default: 'default'
  disconnectTimeoutMs?: number; // default: 30_000
  deploymentName?: string;
  buildId?: string;
  runtimeVersion?: string;
  gitSha?: string;
  startedAt?: number;
  capabilities?: RemoteWorkerCapabilities;
  /** Activity interceptors to run around each activity execution on this worker. */
  interceptors?: ActivityInterceptor[];
}

/**
 * Construction options including internal knobs that are deliberately kept off
 * the public {@link RemoteWorkerOptions} surface. The `RemoteWorker` constructor
 * accepts this wider type; only `RemoteWorkerOptions` is exported from the
 * package, so consumers never see these fields.
 */
export interface InternalRemoteWorkerOptions extends RemoteWorkerOptions {
  /**
   * Test-only override for the unsent-task-result buffer ceiling. Defaults to
   * `MAX_BUFFERED_TASK_RESULTS`. Lets a test exercise the backpressure decline
   * branch with a small cap instead of fabricating a thousand buffered results.
   */
  maxBufferedResults?: number;
}

/** A `connect()` promise's resolve/reject pair, awaiting `registerAck`. */
export type PendingRegistration = {
  resolve: () => void;
  reject: (error: Error) => void;
};

/**
 * Build the `register` frame from the worker's resolved options and advertised
 * activity names. Optional identity/capability fields are omitted entirely when
 * undefined so the wire frame stays minimal. `workerId`, `concurrency`, and
 * `queue` are resolved to defaults by the constructor before this runs.
 */
export function buildRegisterMessage(
  workerId: string,
  activities: readonly string[],
  options: RemoteWorkerOptions,
): RegisterMessage {
  return {
    type: 'register',
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    workerId,
    activities: [...activities],
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    ...(options.queue !== undefined ? { queue: options.queue } : {}),
    ...(options.deploymentName !== undefined ? { deploymentName: options.deploymentName } : {}),
    ...(options.buildId !== undefined ? { buildId: options.buildId } : {}),
    ...(options.runtimeVersion !== undefined ? { runtimeVersion: options.runtimeVersion } : {}),
    ...(options.gitSha !== undefined ? { gitSha: options.gitSha } : {}),
    ...(options.startedAt !== undefined ? { startedAt: options.startedAt } : {}),
    ...(options.capabilities !== undefined ? { capabilities: options.capabilities } : {}),
  };
}

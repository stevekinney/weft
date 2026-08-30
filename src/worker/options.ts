// ---------------------------------------------------------------------------
// RemoteWorker construction options
// ---------------------------------------------------------------------------

import type { ActivityInterceptor } from '../core/interceptor.ts';
import { DEFAULT_WORKFLOW_VERSION } from '../core/versioning.ts';
import { detectRuntime, detectRuntimeVersion } from '../runtime/portable.ts';
import { VERSION } from '../version.ts';
import { declaredShapeDigest } from './manifest/declared-shape-digest.ts';
import type {
  WorkerActivityContract,
  WorkerManifest,
  WorkerWorkflowContract,
} from './manifest/index.ts';
import { WORKER_MANIFEST_VERSION } from './manifest/index.ts';
import {
  REMOTE_WORKER_PROTOCOL_VERSION,
  type RegisterMessage,
  type RemoteWorkerCapabilities,
} from './protocol.ts';
import type { RemoteWorkerWorkflowDefinition } from './workflow-activity-binding.ts';

/**
 * Options accepted by `new RemoteWorker(...)`.
 *
 * A worker advertises its activities through `workflows`: a map of
 * `workflowType → { name, activities }`. The SDK builds the qualified
 * `${workflowType}.${activityName}` table that the protocol expects and
 * validates that each outer key matches the inner `workflow.name`. This is the
 * API the engine-side builder produces, and it is required.
 *
 * `deploymentName` and `buildId` are required — defaulting them risks a false
 * deployment-conflict collision between two unrelated apps that both skip the
 * option and happen to declare different workflows.
 */
export interface RemoteWorkerOptions {
  serverUrl: string;
  workerId?: string;
  /**
   * Map of workflow type → workflow definition. The SDK produces qualified
   * activity names from this map and validates name grammar + key/name match.
   * This is the single, required activity-advertisement input.
   */
  workflows: Record<string, RemoteWorkerWorkflowDefinition>;
  concurrency?: number; // default: 10
  queue?: string; // default: 'default'
  disconnectTimeoutMs?: number; // default: 30_000
  /** Logical service this worker instance belongs to. */
  deploymentName: string;
  /** Operator-visible release this worker instance is running. */
  buildId: string;
  /**
   * Trusted digest of the executable artifact this instance loaded. When
   * omitted, a placeholder digest is derived from the declared workflow and
   * activity names — tagged `declared-shape:...` so it is never mistaken for
   * a real content digest. Real build tooling should supply this. Ignored
   * when `manifest` is supplied, which carries its own `deployment.artifactDigest`.
   */
  artifactDigest?: string;
  /**
   * A complete, real manifest built ahead of time — typically by
   * `buildWorkerManifestFromRegistry` (WFT-29) from the engine's canonical
   * workflow registry. When supplied, it is advertised verbatim at
   * registration instead of the `declared-shape:` placeholder this module
   * otherwise derives from `workflows`, and every other manifest-shaping
   * option (`deploymentName`, `buildId`, `artifactDigest`, `runtimeVersion`,
   * `capabilities`) is ignored.
   *
   * The constructor requires `manifest.workflows` to declare exactly the
   * same set of workflow types as `workflows` — a manifest advertising
   * contracts this instance's dispatch table cannot execute (or omitting
   * ones it can) is rejected at construction rather than at registration.
   */
  manifest?: WorkerManifest;
  /** Runtime version string. Defaults to `detectRuntimeVersion()`. */
  runtimeVersion?: string;
  startedAt?: number;
  capabilities?: RemoteWorkerCapabilities;
  /**
   * Headers sent with the WebSocket upgrade request, such as `Authorization`.
   * When the server enforces authentication, registration requires credentials
   * with the `workers:write` scope; supply them here. This relies on Bun's
   * WebSocket constructor header extension and does not apply in browsers.
   */
  headers?: Record<string, string>;
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
 * Copy a caller-supplied `workflows` map so later mutation of the caller's
 * own object cannot desync the manifest a future `connect()` advertises from
 * the activity dispatch table the constructor already built from the same
 * shape. `buildRegisterMessage` re-derives the manifest from `options.workflows`
 * on every `connect()`; without this copy that field stays a live reference
 * to the caller's object for the instance's whole lifetime.
 */
export function snapshotWorkflows(
  workflows: Record<string, RemoteWorkerWorkflowDefinition>,
): Record<string, RemoteWorkerWorkflowDefinition> {
  const snapshot: Record<string, RemoteWorkerWorkflowDefinition> = {};
  for (const [workflowType, workflow] of Object.entries(workflows)) {
    snapshot[workflowType] = { name: workflow.name, activities: { ...workflow.activities } };
  }
  return snapshot;
}

/**
 * Build a placeholder workflow contract from what the SDK actually knows: the
 * declared workflow type and its activity names. Real contract generation
 * (workflowVersion, workflowRevision, contractHash from an actual build) is
 * out of this project's scope — these values change whenever the declared
 * shape changes, which is honest given the input, if coarse.
 */
function buildWorkflowContract(
  workflowType: string,
  workflow: RemoteWorkerWorkflowDefinition,
): WorkerWorkflowContract {
  const activityNames = Object.keys(workflow.activities).toSorted();
  const workflowShapeDigest = declaredShapeDigest(`${workflowType}:${activityNames.join(',')}`);

  const activities: Record<string, WorkerActivityContract> = {};
  for (const activityName of activityNames) {
    const activityShapeDigest = declaredShapeDigest(`${workflowType}.${activityName}`);
    activities[activityName] = {
      contractHash: activityShapeDigest,
      implementationRevision: activityShapeDigest,
    };
  }

  return {
    workflowVersion: DEFAULT_WORKFLOW_VERSION,
    workflowRevision: workflowShapeDigest,
    contractHash: workflowShapeDigest,
    activities,
  };
}

/** Derive a placeholder artifact digest from every declared qualified activity name. */
function deriveArtifactDigest(workflows: Record<string, RemoteWorkerWorkflowDefinition>): string {
  const qualifiedNames = Object.entries(workflows)
    .flatMap(([workflowType, workflow]) =>
      Object.keys(workflow.activities).map((activityName) => `${workflowType}.${activityName}`),
    )
    .toSorted();
  return declaredShapeDigest(qualifiedNames.join(','));
}

/**
 * Assert that a caller-supplied real manifest (`options.manifest`) declares
 * exactly the workflow types the SDK's own `workflows` dispatch table
 * declares — no more, no fewer. Called once, at construction, so a mismatch
 * between build-tool output and the live dispatch table fails fast rather
 * than surfacing later as a confusing registration rejection or a routed
 * task this instance cannot actually execute.
 */
export function assertManifestMatchesWorkflows(
  manifest: WorkerManifest,
  workflows: Record<string, RemoteWorkerWorkflowDefinition>,
): void {
  const manifestTypes = new Set(Object.keys(manifest.workflows));
  const declaredTypes = new Set(Object.keys(workflows));

  const missingFromManifest = [...declaredTypes]
    .filter((type) => !manifestTypes.has(type))
    .toSorted();
  const extraInManifest = [...manifestTypes].filter((type) => !declaredTypes.has(type)).toSorted();

  if (missingFromManifest.length === 0 && extraInManifest.length === 0) return;

  const parts: string[] = [];
  if (missingFromManifest.length > 0) {
    parts.push(`missing from manifest: ${missingFromManifest.join(', ')}`);
  }
  if (extraInManifest.length > 0) {
    parts.push(`not in workflows: ${extraInManifest.join(', ')}`);
  }
  throw new Error(
    `RemoteWorkerOptions.manifest.workflows must declare exactly the workflow types in ` +
      `\`workflows\` (${parts.join('; ')}).`,
  );
}

/** Build the manifest this worker instance advertises at registration. */
function buildManifest(options: RemoteWorkerOptions): WorkerManifest {
  if (options.manifest !== undefined) return options.manifest;

  const workflows: Record<string, WorkerWorkflowContract> = {};
  for (const [workflowType, workflow] of Object.entries(options.workflows)) {
    workflows[workflowType] = buildWorkflowContract(workflowType, workflow);
  }

  return {
    manifestVersion: WORKER_MANIFEST_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    sdkVersion: VERSION,
    runtime: { name: detectRuntime(), version: options.runtimeVersion ?? detectRuntimeVersion() },
    deployment: {
      name: options.deploymentName,
      buildId: options.buildId,
      artifactDigest: options.artifactDigest ?? deriveArtifactDigest(options.workflows),
    },
    workflows,
    // options.capabilities is already worker-authored JSON; RemoteWorkerCapabilities
    // and JSONValue describe the same shape and differ only in readonly-vs-mutable
    // array element typing.
    capabilities: options.capabilities ?? {},
  };
}

/**
 * Build the `register` frame from the worker's resolved options. `workerId`
 * and `concurrency` are resolved to defaults by the constructor before this
 * runs; `manifest` carries every identity claim protocol v3 validates.
 */
export function buildRegisterMessage(
  workerId: string,
  options: RemoteWorkerOptions,
): RegisterMessage {
  return {
    type: 'register',
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    workerId,
    manifest: buildManifest(options),
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    ...(options.startedAt !== undefined ? { startedAt: options.startedAt } : {}),
  };
}

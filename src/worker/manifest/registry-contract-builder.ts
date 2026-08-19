/**
 * Real worker manifest production from an engine's canonical workflow
 * registry (WFT-29).
 *
 * `RemoteWorkerOptions` and the internal Worker realm both fall back to
 * `declared-shape:` placeholders when no real build tooling supplies a
 * manifest — see {@link declaredShapeDigest}. This module is that build
 * tooling: it derives `WorkerWorkflowContract`/`WorkerActivityContract`
 * values from the *same* normalized representation `buildRegistrySnapshot`
 * produces for `GET /v1/registry` and `weft codegen`, hashed with the
 * collision-resistant {@link sha256Hex} rather than the cache-key-quality
 * FNV-1a scheme those placeholders use.
 *
 * Intended use is a build script: construct an `Engine` with every workflow
 * the artifact bundles registered (never started), call
 * {@link buildWorkerManifestFromRegistry}, and pass the result as
 * `RemoteWorkerOptions.manifest`.
 *
 * @module worker/manifest/registry-contract-builder
 */

import type { Engine } from '../../core/engine.ts';
import {
  buildRegistrySnapshot,
  type RegistryActivityEntry,
  type RegistryWorkflowEntry,
} from '../../core/registry-snapshot.ts';
import { WeftError } from '../../core/weft-error.ts';
import { VERSION } from '../../version.ts';
import { REMOTE_WORKER_PROTOCOL_VERSION } from '../protocol.ts';
import { canonicalJsonStringify } from './canonical-json.ts';
import { sha256Hex } from './content-digest.ts';
import type {
  WorkerActivityContract,
  WorkerDeploymentIdentity,
  WorkerManifest,
  WorkerRuntimeIdentity,
  WorkerWorkflowContract,
} from './types.ts';
import { WORKER_MANIFEST_VERSION } from './types.ts';

/**
 * Thrown when {@link buildWorkerManifestFromRegistry} is asked to advertise a
 * workflow or activity name that the source `Engine` has not registered.
 *
 * This is a build-time tooling error, thrown before any manifest reaches the
 * wire — analogous to the engine's own `RegistrySchemaConversionError`.
 *
 * @example
 * ```ts
 * import { WorkerManifestBuildError } from '@lostgradient/weft';
 *
 * try {
 *   throw new WorkerManifestBuildError('workflow "checkout" is not registered');
 * } catch (error) {
 *   console.log(error instanceof WorkerManifestBuildError); // true
 * }
 * ```
 */
export class WorkerManifestBuildError extends WeftError<'WorkerManifestBuildError'> {
  constructor(message: string) {
    super('WorkerManifestBuildError', message);
  }
}

/**
 * Options accepted by {@link buildWorkerManifestFromRegistry}.
 *
 * @example
 * ```ts
 * import type { WorkerManifestFromRegistryOptions } from '@lostgradient/weft';
 *
 * const options: WorkerManifestFromRegistryOptions = {
 *   workflows: { checkout: ['charge'] },
 *   deployment: { name: 'billing', buildId: '2026.08.18-3', artifactDigest: 'sha256:41d0e2' },
 *   runtime: { name: 'bun', version: '1.3.14' },
 * };
 * console.log(options.workflows['checkout']);
 * ```
 */
export interface WorkerManifestFromRegistryOptions {
  /**
   * Workflow types this worker instance can execute, each mapped to the
   * activity names it invokes. Every key must name a workflow the source
   * `Engine` has registered, and every activity name must be one the same
   * `Engine` has registered — the engine's activity registry is a flat
   * namespace, not partitioned per workflow, so this association is the one
   * thing the registry genuinely cannot supply on its own.
   */
  workflows: Readonly<Record<string, readonly string[]>>;
  /** Immutable deployment artifact identity. Required — never derived. */
  deployment: WorkerDeploymentIdentity;
  /**
   * Runtime that will execute the deployed artifact. Required rather than
   * defaulted: a build script's own process (often a CI runner) is not
   * necessarily the runtime the artifact deploys to, so live detection here
   * would silently assert the wrong identity.
   */
  runtime: WorkerRuntimeIdentity;
  /** Weft worker SDK release the deployed artifact bundles. Defaults to this package's `VERSION`. */
  sdkVersion?: string;
  /** RemoteWorker wire protocol version. Defaults to `REMOTE_WORKER_PROTOCOL_VERSION`. */
  protocolVersion?: number;
  /** Bounded descriptive capability data. Defaults to `{}`. */
  capabilities?: WorkerManifest['capabilities'];
}

function findWorkflowEntry(
  snapshot: ReturnType<typeof buildRegistrySnapshot>,
  workflowType: string,
): RegistryWorkflowEntry {
  const entry = snapshot.workflows[workflowType];
  if (entry === undefined) {
    throw new WorkerManifestBuildError(
      `Cannot build a worker manifest: workflow type "${workflowType}" is not registered on the source Engine.`,
    );
  }
  return entry;
}

function findActivityEntry(
  snapshot: ReturnType<typeof buildRegistrySnapshot>,
  workflowType: string,
  activityName: string,
): RegistryActivityEntry {
  const entry = snapshot.activities[activityName];
  if (entry === undefined) {
    throw new WorkerManifestBuildError(
      `Cannot build a worker manifest: activity "${activityName}" declared under workflow ` +
        `"${workflowType}" is not registered on the source Engine.`,
    );
  }
  return entry;
}

/**
 * Canonical payload-contract content for a workflow: everything a caller may
 * send and expect back. `description` and `tags` are deliberately excluded
 * — they are documentation, and including them would change `contractHash`
 * on every doc edit with no change to the actual wire contract.
 */
function workflowContractPayload(entry: RegistryWorkflowEntry): unknown {
  return {
    inputSchema: entry.inputSchema,
    outputSchema: entry.outputSchema,
    signals: entry.signals,
    updates: entry.updates,
    queries: entry.queries,
  };
}

function activityContractPayload(entry: RegistryActivityEntry): unknown {
  return { inputSchema: entry.inputSchema, outputSchema: entry.outputSchema };
}

async function buildActivityContract(
  snapshot: ReturnType<typeof buildRegistrySnapshot>,
  workflowType: string,
  activityName: string,
  implementationRevision: string,
): Promise<WorkerActivityContract> {
  const entry = findActivityEntry(snapshot, workflowType, activityName);
  const contractHash = await sha256Hex(canonicalJsonStringify(activityContractPayload(entry)));
  return { contractHash, implementationRevision };
}

async function buildWorkflowContract(
  snapshot: ReturnType<typeof buildRegistrySnapshot>,
  workflowVersionsByType: ReadonlyMap<string, string>,
  workflowType: string,
  activityNames: readonly string[],
  implementationRevision: string,
): Promise<WorkerWorkflowContract> {
  const entry = findWorkflowEntry(snapshot, workflowType);
  // snapshot and workflowVersionsByType are both derived from the same
  // engine.listWorkflowDefinitions() / buildRegistrySnapshot(engine) pair
  // (see buildWorkerManifestFromRegistry below) — findWorkflowEntry above
  // already proved workflowType is registered, so a version is guaranteed.
  const workflowVersion = workflowVersionsByType.get(workflowType) as string;

  const contractHash = await sha256Hex(canonicalJsonStringify(workflowContractPayload(entry)));
  const workflowRevision = await sha256Hex(
    canonicalJsonStringify({ ...entry, version: workflowVersion }),
  );

  const sortedActivityNames = [...activityNames].toSorted();
  const activityContracts = await Promise.all(
    sortedActivityNames.map((activityName) =>
      buildActivityContract(snapshot, workflowType, activityName, implementationRevision),
    ),
  );
  const activities: Record<string, WorkerActivityContract> = {};
  sortedActivityNames.forEach((activityName, index) => {
    activities[activityName] = activityContracts[index] as WorkerActivityContract;
  });

  return { workflowVersion, workflowRevision, contractHash, activities };
}

/**
 * Build a real worker manifest from an engine's canonical workflow and
 * activity registrations.
 *
 * `implementationRevision` on every activity contract is set to
 * `options.deployment.buildId`: a schema identifies the *contract*, not the
 * code behind it, so there is no honest schema-derived source for "which
 * implementation" — the build that produced this artifact is the closest
 * available honest answer.
 *
 * Throws {@link WorkerManifestBuildError} if `options.workflows` names a
 * workflow or activity the source `Engine` has not registered, and a
 * (non-public) schema-conversion error if a registered schema cannot be
 * converted to JSON Schema.
 *
 * @example
 * ```ts
 * import { buildWorkerManifestFromRegistry, Engine, workflow } from '@lostgradient/weft';
 *
 * const engine = new Engine();
 * engine.register(
 *   workflow({ name: 'checkout', version: '2.1.0' }).execute(async function* () {}),
 * );
 *
 * const manifest = await buildWorkerManifestFromRegistry(engine, {
 *   workflows: { checkout: [] },
 *   deployment: { name: 'billing', buildId: '2026.08.18-3', artifactDigest: 'sha256:41d0e2' },
 *   runtime: { name: 'bun', version: '1.3.14' },
 * });
 *
 * console.log(manifest.workflows['checkout']?.workflowVersion); // '2.1.0'
 * engine[Symbol.dispose]();
 * ```
 */
export async function buildWorkerManifestFromRegistry(
  engine: Engine,
  options: WorkerManifestFromRegistryOptions,
): Promise<WorkerManifest> {
  const snapshot = buildRegistrySnapshot(engine);
  const workflowVersionsByType = new Map(
    engine.listWorkflowDefinitions().map((definition) => [definition.type, definition.version]),
  );

  const sortedWorkflowTypes = Object.keys(options.workflows).toSorted();
  const workflowContracts = await Promise.all(
    sortedWorkflowTypes.map((workflowType) =>
      buildWorkflowContract(
        snapshot,
        workflowVersionsByType,
        workflowType,
        options.workflows[workflowType] ?? [],
        options.deployment.buildId,
      ),
    ),
  );
  const workflows: Record<string, WorkerWorkflowContract> = {};
  sortedWorkflowTypes.forEach((workflowType, index) => {
    workflows[workflowType] = workflowContracts[index] as WorkerWorkflowContract;
  });

  return {
    manifestVersion: WORKER_MANIFEST_VERSION,
    protocolVersion: options.protocolVersion ?? REMOTE_WORKER_PROTOCOL_VERSION,
    sdkVersion: options.sdkVersion ?? VERSION,
    runtime: options.runtime,
    deployment: options.deployment,
    workflows,
    capabilities: options.capabilities ?? {},
  };
}

/**
 * Real worker manifest production from an engine's canonical workflow
 * registry (WFT-29).
 *
 * `RemoteWorkerOptions` and the internal Worker realm both fall back to
 * `declared-shape:` placeholders when no real build tooling supplies a
 * manifest — see {@link declaredShapeDigest}. This module is that build
 * tooling: it derives `WorkerWorkflowContract`/`WorkerActivityContract`
 * values from the *same* normalized representation `buildRegistrySnapshot`
 * produces for `GET /v1/registry` and `weft codegen`, hashed via
 * `core/contract`'s canonical `contractHash()`/`activityContractHash()`/
 * `deriveWorkflowRevision()` (WFT-5) — the same normalized-contract vocabulary
 * `weft codegen` and `WorkflowRevisionManifest` use, rather than this
 * module's own ad hoc hashing (as it did before WFT-5).
 *
 * **WFT-5 digest-value change.** `contractHash`/`workflowRevision` here now
 * fold in a `contractVersion` domain separator (`WORKFLOW_CONTRACT_VERSION`)
 * that the pre-WFT-5 formula never had, so digest *strings* for an
 * otherwise-unchanged registration differ from 0.23.x output — see
 * `CHANGELOG.md`. `workflowRevision` also now derives from a `WorkflowContract`
 * that omits `queue`/`retry`/`timeout` (registry-only activity metadata with
 * no contract-identity meaning), which the pre-WFT-5 formula's
 * `{ ...entry, version }` spread incidentally included; this is a narrowing,
 * not a behavior a caller could rely on. `contractHash` also now folds in
 * whichever activities `options.workflows[type]` names (previously
 * independent of that list, since only the activity's *own* schema was
 * hashed) — declaring a different activity subset for the same workflow type
 * now changes `contractHash`, which is the intended effect of a contract
 * identity that is supposed to answer "what can a caller do with this
 * workflow", not just "what does the workflow's own input/output look like".
 *
 * Intended use is a build script: construct an `Engine` with every workflow
 * the artifact bundles registered (never started), call
 * {@link buildWorkerManifestFromRegistry}, and pass the result as
 * `RemoteWorkerOptions.manifest`.
 *
 * @module worker/manifest/registry-contract-builder
 */

import {
  activityContractHash,
  contractHash,
  deriveWorkflowRevision,
  type WorkflowActivityContract,
  type WorkflowContract,
} from '../../core/contract/index.ts';
import type { Engine } from '../../core/engine.ts';
import {
  buildRegistrySnapshot,
  type RegistryActivityEntry,
  type RegistryWorkflowEntry,
} from '../../core/registry-snapshot.ts';
import { WeftError } from '../../core/weft-error.ts';
import { VERSION } from '../../version.ts';
import { REMOTE_WORKER_PROTOCOL_VERSION } from '../protocol.ts';
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

/** Registry activity metadata carries `queue`/`retry`/`timeout`; a contract carries only the schema pair. */
function toActivityContract(entry: RegistryActivityEntry): WorkflowActivityContract {
  const contract: {
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
  } = {};
  if (entry.inputSchema !== undefined) contract.inputSchema = entry.inputSchema;
  if (entry.outputSchema !== undefined) contract.outputSchema = entry.outputSchema;
  return contract;
}

function applyDescriptionAndTags(
  draft: Record<string, unknown>,
  entry: RegistryWorkflowEntry,
): void {
  if (entry.description !== undefined) draft['description'] = entry.description;
  if (entry.tags !== undefined && entry.tags.length > 0) draft['tags'] = [...entry.tags];
}

function applySchemas(draft: Record<string, unknown>, entry: RegistryWorkflowEntry): void {
  if (entry.inputSchema !== undefined) draft['inputSchema'] = entry.inputSchema;
  if (entry.outputSchema !== undefined) draft['outputSchema'] = entry.outputSchema;
}

function applyMessageRecords(draft: Record<string, unknown>, entry: RegistryWorkflowEntry): void {
  if (entry.signals !== undefined && Object.keys(entry.signals).length > 0) {
    draft['signals'] = entry.signals;
  }
  if (entry.updates !== undefined && Object.keys(entry.updates).length > 0) {
    draft['updates'] = entry.updates;
  }
  if (entry.queries !== undefined && Object.keys(entry.queries).length > 0) {
    draft['queries'] = entry.queries;
  }
}

/**
 * Build the `core/contract` `WorkflowContract` this workflow type's
 * `contractHash`/`workflowRevision` are computed from. Only the activities in
 * `activityNames` (the caller-declared subset this worker actually invokes)
 * are included — see this module's JSDoc for why that is a deliberate
 * `contractHash` semantic, not an oversight.
 */
function toWorkflowContract(
  entry: RegistryWorkflowEntry,
  workflowType: string,
  workflowVersion: string,
): WorkflowContract {
  const draft: Record<string, unknown> = { name: workflowType, workflowVersion };
  applyDescriptionAndTags(draft, entry);
  applySchemas(draft, entry);
  applyMessageRecords(draft, entry);
  return draft as WorkflowContract;
}

async function buildActivityContract(
  snapshot: ReturnType<typeof buildRegistrySnapshot>,
  workflowType: string,
  activityName: string,
  implementationRevision: string,
): Promise<WorkerActivityContract> {
  const entry = findActivityEntry(snapshot, workflowType, activityName);
  const hash = await activityContractHash(toActivityContract(entry));
  return { contractHash: hash, implementationRevision };
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

  const sortedActivityNames = [...activityNames].toSorted();
  // Null-prototype: an activity literally named `__proto__` is a
  // grammar-valid name (see name-grammar.ts) that a plain `{}` object would
  // silently swallow into the prototype chain instead of storing as an own
  // property, dropping it from the hashed contract entirely.
  const activities: Record<string, WorkflowActivityContract> = Object.create(null) as Record<
    string,
    WorkflowActivityContract
  >;
  for (const activityName of sortedActivityNames) {
    activities[activityName] = toActivityContract(
      findActivityEntry(snapshot, workflowType, activityName),
    );
  }

  const baseContract = toWorkflowContract(entry, workflowType, workflowVersion);
  const contractForHash: WorkflowContract =
    Object.keys(activities).length > 0 ? { ...baseContract, activities } : baseContract;

  const [hash, revision] = await Promise.all([
    contractHash(contractForHash),
    deriveWorkflowRevision(contractForHash),
  ]);

  const activityContracts = await Promise.all(
    sortedActivityNames.map((activityName) =>
      buildActivityContract(snapshot, workflowType, activityName, implementationRevision),
    ),
  );
  // Same null-prototype rationale as `activities` above.
  const workerActivities: Record<string, WorkerActivityContract> = Object.create(null) as Record<
    string,
    WorkerActivityContract
  >;
  sortedActivityNames.forEach((activityName, index) => {
    workerActivities[activityName] = activityContracts[index] as WorkerActivityContract;
  });

  return {
    workflowVersion,
    workflowRevision: revision,
    contractHash: hash,
    activities: workerActivities,
  };
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
  // A workflow literally named `__proto__` is grammar-valid too; same
  // null-prototype rationale as `activities` above.
  const workflows: Record<string, WorkerWorkflowContract> = Object.create(null) as Record<
    string,
    WorkerWorkflowContract
  >;
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

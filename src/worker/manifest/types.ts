/**
 * Canonical worker manifest and execution-identity vocabulary.
 *
 * One manifest answers every identity question about a worker at once, with
 * each question in its own field:
 *
 * | Field             | Question answered                                | Stability                       |
 * | ----------------- | ------------------------------------------------ | ------------------------------- |
 * | `manifestVersion` | Can the host parse this manifest shape?          | Changes with manifest schema    |
 * | `protocolVersion` | Can these peers exchange wire messages?          | Changes with wire semantics     |
 * | `sdkVersion`      | Which Weft worker SDK produced this worker?      | Package release                 |
 * | `runtime`         | Which runtime executes the worker?               | Runtime deployment              |
 * | `deployment.name` | Which logical service owns this worker?          | Stable service identity         |
 * | `buildId`         | Which operator-visible release is this?          | Immutable within a deployment   |
 * | `artifactDigest`  | Which exact executable bytes are loaded?         | Content-addressed and immutable |
 * | `workflowVersion` | Which replay compatibility boundary is declared? | Workflow author controlled      |
 * | `contractHash`    | Which public payload contract is implemented?    | Deterministic contract identity |
 *
 * A Git SHA is deliberately absent from that table: repositories may be dirty,
 * builds may inject configuration, and one commit may produce several
 * artifacts, so a commit is metadata rather than an executable identity.
 *
 * @module worker/manifest/types
 */

import type { JSONValue } from '../../core/json.ts';

/**
 * Current worker manifest schema version.
 *
 * This is a different axis from the RemoteWorker wire protocol version:
 * `manifestVersion` answers "can the host parse this shape", while
 * `protocolVersion` answers "can these peers exchange messages". Bump this
 * only when the manifest's own structure changes incompatibly; unknown
 * versions are rejected before registration rather than best-effort parsed.
 *
 * @example
 * ```ts
 * import { WORKER_MANIFEST_VERSION } from '@lostgradient/weft';
 *
 * const canParse = (received: number): boolean => received === WORKER_MANIFEST_VERSION;
 * console.log(canParse(1));
 * ```
 */
export const WORKER_MANIFEST_VERSION = 1;

/**
 * Deterministic identity of one activity implementation inside a workflow.
 *
 * `contractHash` identifies the public payload contract — what callers may
 * send and expect back. `implementationRevision` identifies the code behind
 * that contract, which may change without changing the contract.
 *
 * @example
 * ```ts
 * import type { WorkerActivityContract } from '@lostgradient/weft';
 *
 * const charge: WorkerActivityContract = {
 *   contractHash: 'sha256:2b1f0c9d',
 *   implementationRevision: 'rev-41',
 * };
 * console.log(charge.contractHash);
 * ```
 */
export type WorkerActivityContract = Readonly<{
  /** Deterministic identity of this activity's public payload contract. */
  contractHash: string;
  /** Identity of the implementation currently bound to that contract. */
  implementationRevision: string;
}>;

/**
 * Deterministic identity of one workflow an artifact can execute, including
 * every activity it exposes.
 *
 * Activity keys are canonical runtime activity names. An activity is qualified
 * structurally by the workflow that contains it rather than only through a
 * dotted string, so the same activity name may appear under two workflows
 * without collision.
 *
 * @example
 * ```ts
 * import type { WorkerWorkflowContract } from '@lostgradient/weft';
 *
 * const checkout: WorkerWorkflowContract = {
 *   workflowVersion: '2.1.0',
 *   workflowRevision: 'rev-88',
 *   contractHash: 'sha256:9ab3',
 *   activities: { charge: { contractHash: 'sha256:2b1f', implementationRevision: 'rev-41' } },
 * };
 * console.log(Object.keys(checkout.activities));
 * ```
 */
export type WorkerWorkflowContract = Readonly<{
  /** Semantic replay-compatibility boundary declared by the workflow author. */
  workflowVersion: string;
  /** Identity of the exact workflow definition loaded from this artifact. */
  workflowRevision: string;
  /** Deterministic identity of the workflow's public payload contract. */
  contractHash: string;
  /** Activities this workflow exposes, keyed by canonical activity name. */
  activities: Readonly<Record<string, WorkerActivityContract>>;
}>;

/**
 * Immutable deployment artifact identity.
 *
 * `(name, buildId)` identifies exactly one `artifactDigest` within one server
 * scope. Shipping different bytes means choosing a new `buildId` — reusing one
 * is a registration conflict, not an update.
 *
 * @example
 * ```ts
 * import type { WorkerDeploymentIdentity } from '@lostgradient/weft';
 *
 * const deployment: WorkerDeploymentIdentity = {
 *   name: 'billing',
 *   buildId: '2026.08.18-3',
 *   artifactDigest: 'sha256:41d0e2',
 * };
 * console.log(deployment.buildId);
 * ```
 */
export type WorkerDeploymentIdentity = Readonly<{
  /** Logical service that owns this worker. */
  name: string;
  /** Operator-visible release identity, immutable within the deployment. */
  buildId: string;
  /** Content-addressed digest of the complete executable artifact. */
  artifactDigest: string;
}>;

/**
 * Runtime that executes a worker process.
 *
 * `version` is an empty string on runtimes that expose none — a browser or
 * edge worker — rather than being omitted, so the field is always answerable.
 *
 * @example
 * ```ts
 * import type { WorkerRuntimeIdentity } from '@lostgradient/weft';
 *
 * const runtime: WorkerRuntimeIdentity = { name: 'bun', version: '1.3.14' };
 * console.log(`${runtime.name} ${runtime.version}`);
 * ```
 */
export type WorkerRuntimeIdentity = Readonly<{
  /** Runtime name, such as `bun` or `node`. */
  name: string;
  /** Runtime version, or an empty string where the runtime exposes none. */
  version: string;
}>;

/**
 * Everything a worker asserts about itself, validated by the host before the
 * worker becomes routing-eligible.
 *
 * Worker readiness means the server accepted a validated manifest — not merely
 * that a socket opened. Digests and contract hashes carried here are checked
 * against trusted records rather than believed because the worker asserted
 * them, and `capabilities` never grants authorization on its own.
 *
 * @example
 * ```ts
 * import { WORKER_MANIFEST_VERSION, type WorkerManifest } from '@lostgradient/weft';
 *
 * const manifest: WorkerManifest = {
 *   manifestVersion: WORKER_MANIFEST_VERSION,
 *   protocolVersion: 2,
 *   sdkVersion: '0.18.0',
 *   runtime: { name: 'bun', version: '1.3.14' },
 *   deployment: { name: 'billing', buildId: '2026.08.18-3', artifactDigest: 'sha256:41d0e2' },
 *   workflows: {},
 *   capabilities: {},
 * };
 * console.log(manifest.deployment.name);
 * ```
 */
export type WorkerManifest = Readonly<{
  /** Manifest schema version; unknown values are rejected, not tolerated. */
  manifestVersion: typeof WORKER_MANIFEST_VERSION;
  /** RemoteWorker wire protocol version these peers will speak. */
  protocolVersion: number;
  /** Weft worker SDK release that produced this worker. */
  sdkVersion: string;
  /** Runtime executing the worker process. */
  runtime: WorkerRuntimeIdentity;
  /** Immutable deployment artifact identity. */
  deployment: WorkerDeploymentIdentity;
  /** Workflows this artifact can execute, keyed by canonical workflow name. */
  workflows: Readonly<Record<string, WorkerWorkflowContract>>;
  /** Bounded descriptive capability data; never an authorization claim. */
  capabilities: Readonly<Record<string, JSONValue>>;
}>;

/**
 * Routing input: the constraints a task places on the worker that may execute
 * it.
 *
 * An omitted field lets policy choose any eligible value. It is *not* an
 * empty-string wildcard, and it is not a claim that the field does not matter
 * once the task is leased — see {@link WorkerExecutionIdentity}, which is
 * always complete.
 *
 * @example
 * ```ts
 * import type { WorkerExecutionRequirement } from '@lostgradient/weft';
 *
 * // Pin the deployment, let policy pick any eligible build within it.
 * const requirement: WorkerExecutionRequirement = { deploymentName: 'billing' };
 * console.log(requirement.buildId === undefined);
 * ```
 */
export type WorkerExecutionRequirement = Readonly<{
  /** Required logical service, when the task pins one. */
  deploymentName?: string;
  /** Required operator-visible release, when the task pins one. */
  buildId?: string;
  /** Required executable artifact, when the task pins exact bytes. */
  artifactDigest?: string;
  /** Required workflow definition revision, when the task pins one. */
  workflowRevision?: string;
  /** Required activity contract identity, when the task pins one. */
  activityContractHash?: string;
}>;

/**
 * Observed execution: the complete identity of the worker that actually holds
 * a lease on an attempt.
 *
 * Every field is populated from the accepted manifest plus the live session.
 * A worker cannot self-report a different execution identity in its result,
 * which is what makes this safe to persist as provenance.
 *
 * @example
 * ```ts
 * import type { WorkerExecutionIdentity } from '@lostgradient/weft';
 *
 * function describe(identity: WorkerExecutionIdentity): string {
 *   return `${identity.deploymentName}@${identity.buildId} (${identity.workerId})`;
 * }
 * console.log(typeof describe);
 * ```
 */
export type WorkerExecutionIdentity = Readonly<{
  /** Live process instance that holds the lease. */
  workerId: string;
  /** Digest of the manifest the server accepted from that instance. */
  manifestDigest: string;
  /** Wire protocol version negotiated with that instance. */
  protocolVersion: number;
  /** Weft worker SDK release that produced the instance. */
  sdkVersion: string;
  /** Runtime name executing the instance. */
  runtimeName: string;
  /** Runtime version executing the instance. */
  runtimeVersion: string;
  /** Logical service that owns the instance. */
  deploymentName: string;
  /** Operator-visible release the instance is running. */
  buildId: string;
  /** Executable artifact the instance loaded. */
  artifactDigest: string;
  /** Workflow definition revision that executed the attempt. */
  workflowRevision: string;
  /** Activity that executed the attempt. */
  activityName: string;
  /** Contract identity of that activity. */
  activityContractHash: string;
}>;

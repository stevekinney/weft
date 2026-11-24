/**
 * Records a worker's deployment version in the durable catalog when its
 * registration is accepted (COR-277).
 *
 * `WorkerDeploymentCatalog` is what `weft.worker.deployments.*` lists, routes
 * between, drains, and removes, and what a workflow's worker-version binding
 * resolves against; without a write here nothing ever populates it. Both
 * transports call this after their in-memory `DeploymentConsistencyGuard` check
 * has passed, so a build id that conflicts with a connected worker's artifact
 * digest is refused before anything is written.
 *
 * The write is `registerVersion`, which is idempotent and race-safe: it creates
 * the version with a conditional batch that expects the key absent, and a lost
 * race re-reads the winner's record and compares identities. So the first
 * registration of a build fixes `firstSeenAt` and `state: 'ready'`, a repeat
 * registration (a reconnect, another worker of the same build, a concurrent
 * registration) returns the stored record untouched, and a version that has
 * been drained or removed is never moved back to `ready`.
 *
 * @module server/runtime/deployment-version-registration
 */
import {
  WorkerDeploymentVersionConflictError,
  type WorkerDeploymentVersionState,
} from '../../worker/deployment-routing.ts';
import type { WorkerManifest } from '../../worker/manifest/types.ts';
import type { ServerContext } from './context.ts';

export type DeploymentVersionRecording =
  /** `state` is the stored version's state, or `undefined` when this server keeps no catalog. */
  | { readonly ok: true; readonly state: WorkerDeploymentVersionState | undefined }
  /**
   * `conflict`: the stored version for this build is a different artifact, so the
   * registration is refused for good. `unavailable`: the catalog could not be
   * read or written, so the worker should retry; it is not accepted while the
   * catalog does not know its build.
   */
  | { readonly ok: false; readonly reason: 'conflict' | 'unavailable'; readonly message: string };

export async function recordDeploymentVersion(
  context: Pick<ServerContext, 'workerDeploymentCatalog'>,
  manifest: WorkerManifest,
  acceptedManifestDigest: string,
): Promise<DeploymentVersionRecording> {
  const catalog = context.workerDeploymentCatalog;
  if (catalog === undefined) return { ok: true, state: undefined };
  const { name, buildId, artifactDigest } = manifest.deployment;
  try {
    const stored = await catalog.registerVersion({
      deploymentName: name,
      buildId,
      artifactDigest,
      manifestDigest: acceptedManifestDigest,
      manifest,
      state: 'ready',
      firstSeenAt: Date.now(),
    });
    return { ok: true, state: stored.state };
  } catch (error) {
    if (error instanceof WorkerDeploymentVersionConflictError) {
      return await resolveVersionConflict(catalog, manifest, error);
    }
    return {
      ok: false,
      reason: 'unavailable',
      message: `The deployment catalog is unavailable, so deployment "${name}" build "${buildId}" could not be recorded; retry shortly.`,
    };
  }
}

/**
 * `registerVersion` also refuses a stored version whose manifest digest differs, but a build's
 * identity is its artifact digest: the manifest digest covers the runtime version, SDK version,
 * and capabilities, which workers of one artifact legitimately differ on. So read the stored
 * version back and refuse only a different artifact; the stored manifest stays the first-seen one.
 */
async function resolveVersionConflict(
  catalog: NonNullable<ServerContext['workerDeploymentCatalog']>,
  manifest: WorkerManifest,
  conflict: WorkerDeploymentVersionConflictError,
): Promise<DeploymentVersionRecording> {
  const { name, buildId, artifactDigest } = manifest.deployment;
  try {
    const stored = await catalog.getVersion(name, buildId);
    if (stored !== null && stored.artifactDigest === artifactDigest) {
      return { ok: true, state: stored.state };
    }
    return { ok: false, reason: 'conflict', message: conflict.message };
  } catch {
    return {
      ok: false,
      reason: 'unavailable',
      message: `The deployment catalog is unavailable, so deployment "${name}" build "${buildId}" could not be recorded; retry shortly.`,
    };
  }
}

/**
 * A build the catalog records as draining or removed admits the worker but not new untargeted
 * work: the build's drain marker is applied before the worker can be routed to. The marker lives
 * in this process's registry, so the catalog is what makes a drain, and a removal, survive a
 * restart. A marker already set (an operator's drain) is left as it is.
 */
export function applyRecordedVersionState(
  context: Pick<ServerContext, 'registry'>,
  manifest: WorkerManifest,
  state: WorkerDeploymentVersionState | undefined,
): void {
  if (state === undefined || state === 'ready') return;
  context.registry.ensureBuildDraining(manifest.deployment.name, manifest.deployment.buildId, {
    updatedAt: Date.now(),
    reason: `Deployment build is ${state} in the deployment catalog.`,
  });
}

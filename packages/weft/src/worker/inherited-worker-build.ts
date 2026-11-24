import type { Storage } from "../embedded/storage/src/index.ts";
import { removedTombstoneKey, type WorkerBuildIdentity } from './deployment-records.ts';
import { WorkerDeploymentCatalog } from './deployment-routing.ts';
import { WorkerDeploymentVersionRemovedError } from './deployment-version-removed-error.ts';

/**
 * Refuse a run that would inherit a worker binding whose build has been removed. A restart or a
 * fork copies the binding of a terminal run, which the reference scan does not count. This read
 * fails fast, and it also covers a build removed before tombstones existed; the commit itself is
 * guarded by the tombstone condition every binding adds. A build the catalog has never heard of is
 * not refused: nothing removed it.
 */
export async function assertInheritedWorkerBuildNotRemoved(
  storage: Storage,
  binding: WorkerBuildIdentity,
): Promise<void> {
  const version = await new WorkerDeploymentCatalog(storage).getVersion(
    binding.deploymentName,
    binding.buildId,
  );
  if (version?.state === 'removed') {
    throw new WorkerDeploymentVersionRemovedError(binding.deploymentName, binding.buildId);
  }
}

/**
 * After a commit that binds work to `build` lost, say whether it lost to the build's removal: the
 * tombstone is present. Positive evidence only, so a commit that lost for any other reason keeps
 * its own error. The tombstone is checked for presence and never decoded.
 */
export async function throwIfWorkerBuildRemoved(
  storage: Storage,
  build: WorkerBuildIdentity,
): Promise<void> {
  if ((await storage.get(removedTombstoneKey(build.deploymentName, build.buildId))) !== null) {
    throw new WorkerDeploymentVersionRemovedError(build.deploymentName, build.buildId);
  }
}

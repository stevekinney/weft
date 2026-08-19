/**
 * Process-local enforcement that one `(deploymentName, buildId)` pair never
 * registers two different artifact digests.
 *
 * A build ID is meant to identify one immutable build output. If two workers
 * present the same deployment name and build ID with different artifact
 * digests, at least one of them is lying about what it is running — either a
 * build ID was reused across a redeploy with different bytes, or a worker is
 * misconfigured. Either way, silently accepting both would let routing send
 * work to a worker running code the operator did not intend for that build
 * identity.
 *
 * This is process-local and non-durable: restart-durable enforcement needs
 * revision-aware routing, which is not yet built. The guard also does not
 * evict entries when a worker disconnects — surviving disconnects is the
 * point. A redeploy that reuses a build ID with different bytes must still
 * conflict even if every worker from the first deploy has since dropped off,
 * because the record of what that build ID means must outlive any single
 * connection.
 *
 * @module worker/registry/deployment-consistency
 */

/** Outcome of {@link DeploymentConsistencyGuard.checkAndRecord}. */
export type DeploymentConsistencyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly existingArtifactDigest: string };

/**
 * Tracks the artifact digest first seen for each `(deploymentName, buildId)`
 * pair for the lifetime of this process.
 *
 * Keyed by nested maps rather than a joined string: `deploymentName` and
 * `buildId` are validated only as non-empty, byte-bounded strings, with no
 * character-set restriction, so a separator-joined key could collide across
 * two distinct pairs (e.g. `("ab", "c")` and `("a", "bc")` would
 * both join to `"abc"`). Nested maps compare each component
 * independently and cannot collide this way.
 *
 * @example
 * ```ts
 * import { DeploymentConsistencyGuard } from '@lostgradient/weft/server';
 *
 * const guard = new DeploymentConsistencyGuard();
 * console.log(guard.checkAndRecord('billing', 'b3', 'sha256:aa').ok); // true
 * console.log(guard.checkAndRecord('billing', 'b3', 'sha256:aa').ok); // true (same digest)
 * console.log(guard.checkAndRecord('billing', 'b3', 'sha256:bb').ok); // false (conflict)
 * ```
 */
export class DeploymentConsistencyGuard {
  #artifactDigestByBuildIdByDeployment: Map<string, Map<string, string>>;

  constructor() {
    this.#artifactDigestByBuildIdByDeployment = new Map();
  }

  /**
   * Read-only: does `artifactDigest` conflict with any digest already
   * recorded for `(deploymentName, buildId)`? Never records. Callers with a
   * rejection gate between checking and committing (an admission policy, a
   * hijack guard) must call this before that gate and call {@link record}
   * only once every later gate has also passed, so a worker this function's
   * caller ultimately declines cannot permanently poison a deployment/build
   * slot with an untrusted digest.
   */
  check(
    deploymentName: string,
    buildId: string,
    artifactDigest: string,
  ): DeploymentConsistencyResult {
    const existingArtifactDigest = this.#artifactDigestByBuildIdByDeployment
      .get(deploymentName)
      ?.get(buildId);

    if (existingArtifactDigest === undefined || existingArtifactDigest === artifactDigest) {
      return { ok: true };
    }

    return { ok: false, existingArtifactDigest };
  }

  /**
   * Record `artifactDigest` as the digest of record for `(deploymentName,
   * buildId)` if this is the first sighting; a no-op otherwise. Callers must
   * already have confirmed via {@link check} that this does not conflict.
   */
  record(deploymentName: string, buildId: string, artifactDigest: string): void {
    let byBuildId = this.#artifactDigestByBuildIdByDeployment.get(deploymentName);
    if (byBuildId === undefined) {
      byBuildId = new Map();
      this.#artifactDigestByBuildIdByDeployment.set(deploymentName, byBuildId);
    }
    if (!byBuildId.has(buildId)) {
      byBuildId.set(buildId, artifactDigest);
    }
  }

  /**
   * Check whether `artifactDigest` is consistent with any digest already
   * recorded for `(deploymentName, buildId)`, recording it as the digest of
   * record when this is the first sighting. Convenience combining
   * {@link check} and {@link record} for callers with no rejection gate
   * between checking and committing.
   */
  checkAndRecord(
    deploymentName: string,
    buildId: string,
    artifactDigest: string,
  ): DeploymentConsistencyResult {
    const result = this.check(deploymentName, buildId, artifactDigest);
    if (result.ok) this.record(deploymentName, buildId, artifactDigest);
    return result;
  }
}

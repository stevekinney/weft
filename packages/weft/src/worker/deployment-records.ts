/**
 * Keys and decoders of the stored deployment records. Names and ids are URI-encoded in every key,
 * so a name containing the `:` separator cannot collide with a neighbour.
 *
 * - **Version**, at `worker-deployment-version:<deployment>:<build>`: the MessagePack encoding of a
 *   `WorkerDeploymentVersion`. Its `state` is `ready`, `draining` or `removed`.
 * - **Routing pointer**, at `worker-deployment-routing:<deployment>`: the MessagePack encoding of a
 *   `WorkerDeploymentRouting`. `previousBuildId` is optional persisted format: a record written
 *   before it existed has none and decodes without one, and a record that has one carries a string.
 * - **Binding stamp**, 64 shards per build, at
 *   `worker-deployment-binding:<deployment>:<build>:<k>`, where `<k>` is two lowercase hex digits,
 *   `00` to `3f`. A shard holds sixteen random bytes. Every commit that binds durable work to the
 *   build (a run's worker binding, or a task-ledger entry whose requirement names the build) writes
 *   a fresh value to exactly one shard, blind, in the same batch as that work. The shard is the
 *   32-bit FNV-1a hash of the binding's own key (the run id, or the ledger entry's operation id),
 *   taken over its UTF-8 bytes, modulo 64: concurrent bindings land on different shards, so on a
 *   backend that serializes writes to one row (Postgres and Neon run each conditional batch at
 *   `SERIALIZABLE`) they do not abort one another the way one shared row would. An absent shard
 *   means no binding has used it. Only `remove` reads the shards: all 64, before it scans, and it
 *   conditions its write on every one, so any binding that commits after the scan began changes a
 *   shard in the removal's read set and makes it rescan. Shards are compared and never decoded.
 *   **64 is persisted format.** It cannot change without reading the old shards too.
 *   The hash that picks a binding's shard is not format: `remove` conditions on every shard, so a
 *   binding on any shard is caught, and the choice of shard can change without reading old data.
 * - **Removal tombstone**, at `worker-deployment-removed:<deployment>:<build>`: one opaque byte,
 *   written once, in the same batch as the version record's `removed` state, and never deleted.
 *   Every commit that binds durable work to the build requires it to be absent, so a binding that
 *   meets a removed build fails and binds nothing. It is checked for presence and never decoded.
 *
 * Together they make removal optimistic concurrency, not a lock: nothing is held, so nothing can be
 * left behind by a crash, and there is nothing to reconcile.
 */
import type { BatchOperation, ConditionalBatchCondition } from "../embedded/storage/src/index.ts";
import { decode } from '../core/codec/index.ts';
import type { WorkerDeploymentRouting, WorkerDeploymentVersion } from './deployment-routing.ts';

export const WORKER_DEPLOYMENT_VERSION_PREFIX = 'worker-deployment-version:';
export const WORKER_DEPLOYMENT_ROUTING_PREFIX = 'worker-deployment-routing:';
export const WORKER_DEPLOYMENT_BINDING_PREFIX = 'worker-deployment-binding:';
export const WORKER_DEPLOYMENT_REMOVED_PREFIX = 'worker-deployment-removed:';

/** A build, named the way the catalog names it. */
export type WorkerBuildIdentity = Readonly<{ deploymentName: string; buildId: string }>;

/** How many stamp shards every build has. Persisted format: see the module header. */
export const WORKER_BINDING_STAMP_SHARDS = 64;

/** The shard a binding with this key (a run id, or a ledger entry's operation id) stamps, `0` to `63`. */
export function bindingStampShard(bindingKey: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(bindingKey)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash % WORKER_BINDING_STAMP_SHARDS;
}

export function bindingStampKey(deploymentName: string, buildId: string, shard: number): string {
  return `${WORKER_DEPLOYMENT_BINDING_PREFIX}${encodeURIComponent(deploymentName)}:${encodeURIComponent(buildId)}:${shard.toString(16).padStart(2, '0')}`;
}

/** Every stamp shard key of a build, in shard order. */
export function bindingStampKeys(deploymentName: string, buildId: string): string[] {
  return Array.from({ length: WORKER_BINDING_STAMP_SHARDS }, (_, shard) =>
    bindingStampKey(deploymentName, buildId, shard),
  );
}

export function removedTombstoneKey(deploymentName: string, buildId: string): string {
  return `${WORKER_DEPLOYMENT_REMOVED_PREFIX}${encodeURIComponent(deploymentName)}:${encodeURIComponent(buildId)}`;
}

/** A fresh stamp value: sixteen random bytes. */
export function newBindingStamp(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

/**
 * What every commit that binds durable work to `build` adds to its own batch: the condition that
 * the build's tombstone is absent, and a blind put of a fresh value to the one stamp shard that
 * `bindingKey` (the run id, or the ledger entry's operation id) selects. Neither reads the other's
 * key, and bindings with different keys write different shards, so concurrent bindings to one
 * build do not conflict with each other.
 */
export function workerBuildBinding(
  build: WorkerBuildIdentity,
  bindingKey: string,
): {
  condition: ConditionalBatchCondition;
  operation: BatchOperation;
} {
  return {
    condition: {
      key: removedTombstoneKey(build.deploymentName, build.buildId),
      expectedValue: null,
    },
    operation: {
      type: 'put',
      key: bindingStampKey(build.deploymentName, build.buildId, bindingStampShard(bindingKey)),
      value: newBindingStamp(),
    },
  };
}

export function decodeVersion(value: Uint8Array): WorkerDeploymentVersion {
  const decoded = decode(value) as Partial<WorkerDeploymentVersion>;
  const valid = [
    typeof decoded.deploymentName === 'string',
    typeof decoded.buildId === 'string',
    typeof decoded.artifactDigest === 'string',
    typeof decoded.manifestDigest === 'string',
    typeof decoded.firstSeenAt === 'number',
    ['ready', 'draining', 'removed'].includes(decoded.state ?? ''),
    typeof decoded.manifest === 'object',
    decoded.manifest !== null,
  ].every(Boolean);
  if (!valid) throw new Error('Invalid worker deployment version record.');
  const deployment = decoded.manifest!.deployment;
  if (
    deployment.name !== decoded.deploymentName ||
    deployment.buildId !== decoded.buildId ||
    deployment.artifactDigest !== decoded.artifactDigest
  )
    throw new Error('Worker deployment version manifest identity disagrees with its storage key.');
  // A record written before references were computed carries a stored `executionReferences`
  // counter that nothing maintained. It is dropped here, so it can never be read as a count.
  const { executionReferences: _legacyCounter, ...version } = decoded as WorkerDeploymentVersion & {
    executionReferences?: number;
  };
  return version;
}

export function decodeRouting(value: Uint8Array): WorkerDeploymentRouting {
  const decoded = decode(value) as Partial<WorkerDeploymentRouting>;
  const valid = [
    typeof decoded.deploymentName === 'string',
    typeof decoded.currentBuildId === 'string',
    Number.isInteger(decoded.generation),
    (decoded.generation ?? 0) >= 1,
    Number.isInteger(decoded.rampBasisPoints),
    (decoded.rampBasisPoints ?? -1) >= 0,
    (decoded.rampBasisPoints ?? 10_001) <= 10_000,
    typeof decoded.updatedAt === 'number',
    decoded.previousBuildId === undefined || typeof decoded.previousBuildId === 'string',
  ].every(Boolean);
  if (!valid) throw new Error('Invalid worker deployment routing record.');
  return decoded as WorkerDeploymentRouting;
}

export function versionKey(deploymentName: string, buildId: string): string {
  return `${WORKER_DEPLOYMENT_VERSION_PREFIX}${encodeURIComponent(deploymentName)}:${encodeURIComponent(buildId)}`;
}

export function routingKey(deploymentName: string): string {
  return `${WORKER_DEPLOYMENT_ROUTING_PREFIX}${encodeURIComponent(deploymentName)}`;
}

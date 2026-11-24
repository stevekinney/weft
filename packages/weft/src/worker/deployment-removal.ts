/**
 * Removing a deployment build by optimistic concurrency (COR-1582).
 *
 * `remove` reads the build's version (which must be `draining`), the routing pointer, and the
 * build's 64 binding stamp shards, in that order and before it scans; scans the run records and the
 * non-terminal task-ledger entries for work bound to the build; and, if there is none, writes
 * `removed` and the build's tombstone in one batch conditioned on the exact bytes of the version,
 * the routing pointer and every stamp shard it read (an absent shard is conditioned as absent). Every
 * commit that binds work to a build puts a fresh stamp and requires the tombstone absent
 * (`deployment-records.ts`), so any binding that commits after the stamp was read changes it and
 * fails the removal's write, and any that commits after the removal meets the tombstone.
 *
 * A lost write reads everything again: a build that is now `removed` answers as removed, a build
 * no longer draining or now routed answers that, and anything else rescans. Three attempts in all;
 * after the third the answer is `busy`, a retryable outcome. Nothing is held between the steps, so
 * a crash at any point leaves nothing behind to reconcile.
 */
import { storageConditionalBatch, type Storage } from "../embedded/storage/src/index.ts";
import { encode } from '../core/codec/index.ts';
import { countBuildReference } from './deployment-build-references.ts';
import {
  bindingStampKeys,
  decodeRouting,
  decodeVersion,
  removedTombstoneKey,
  routingKey,
  versionKey,
} from './deployment-records.ts';
import type {
  WorkerDeploymentRemovalOutcome,
  WorkerDeploymentVersion,
} from './deployment-routing.ts';

/** How many times a removal reads, scans and writes before it answers `busy`. */
const REMOVAL_ATTEMPTS = 3;

/** The tombstone's value. Opaque: it is only ever tested for presence. */
const TOMBSTONE = new Uint8Array([1]);

export async function removeWorkerDeploymentVersion(
  storage: Storage,
  deploymentName: string,
  buildId: string,
): Promise<WorkerDeploymentRemovalOutcome> {
  for (let attempt = 1; attempt <= REMOVAL_ATTEMPTS; attempt += 1) {
    const key = versionKey(deploymentName, buildId);
    const versionBytes = await storage.get(key);
    if (versionBytes === null) return { outcome: 'not-found' };
    const version = decodeVersion(versionBytes);
    // A removed build is not found at first; after a lost write it was removed by the one that won.
    if (version.state === 'removed') return { outcome: attempt === 1 ? 'not-found' : 'removed' };
    const routingBytes = await storage.get(routingKey(deploymentName));
    const refusal = refusalBeforeScan(version, routingBytes);
    if (refusal !== undefined) return refusal;
    // Every shard, read in full before the scan: a binding that commits after this changes one.
    const stampKeys = bindingStampKeys(deploymentName, buildId);
    const stamps = await Promise.all(stampKeys.map((stampKey) => storage.get(stampKey)));
    const references = await countBuildReference(storage, { deploymentName, buildId });
    if (references > 0) return { outcome: 'referenced', references };
    const removed = await storageConditionalBatch(
      storage,
      [
        { key, expectedValue: versionBytes },
        { key: routingKey(deploymentName), expectedValue: routingBytes },
        ...stampKeys.map((stampKey, shard) => ({
          key: stampKey,
          expectedValue: stamps[shard] ?? null,
        })),
      ],
      [
        { type: 'put', key, value: encode({ ...version, state: 'removed' as const }) },
        { type: 'put', key: removedTombstoneKey(deploymentName, buildId), value: TOMBSTONE },
      ],
    );
    if (removed) return { outcome: 'removed' };
  }
  return { outcome: 'busy' };
}

/** Why a build cannot be removed whatever is bound to it: it is not draining, or routing names it. */
function refusalBeforeScan(
  version: WorkerDeploymentVersion,
  routingBytes: Uint8Array | null,
): WorkerDeploymentRemovalOutcome | undefined {
  if (version.state !== 'draining') return { outcome: 'not-draining', state: version.state };
  if (routingBytes === null) return undefined;
  const routing = decodeRouting(routingBytes);
  const routed =
    routing.currentBuildId === version.buildId || routing.rampingBuildId === version.buildId;
  return routed ? { outcome: 'routed' } : undefined;
}

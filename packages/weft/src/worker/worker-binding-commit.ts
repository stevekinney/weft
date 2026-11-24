import { storageConditionalBatch, type Storage } from "../embedded/storage/src/index.ts";
import { encode } from '../core/codec/index.ts';
import { workerBuildBinding, type WorkerBuildIdentity } from './deployment-records.ts';
import {
  assertInheritedWorkerBuildNotRemoved,
  throwIfWorkerBuildRemoved,
} from './inherited-worker-build.ts';

/**
 * Write a run record that binds the run to `build`, conditioned on the bytes read. The build is a
 * binding like any other: its tombstone must be absent, and its stamp moves with the run, so a
 * removal that read the stamp earlier cannot commit past it. A commit that lost to the build's
 * removal throws as removed (so does a build whose version record says `removed`, which covers a
 * build removed before tombstones existed); any other loss returns `false`.
 */
export async function commitWorkerBinding(
  storage: Storage,
  key: string,
  expectedBytes: Uint8Array,
  state: Record<string, unknown>,
  build: WorkerBuildIdentity & { workflowId: string },
): Promise<boolean> {
  // A build removed before tombstones existed has none, so its version record is read too.
  await assertInheritedWorkerBuildNotRemoved(storage, build);
  const { condition, operation } = workerBuildBinding(build, build.workflowId);
  const applied = await storageConditionalBatch(
    storage,
    [{ key, expectedValue: expectedBytes }, condition],
    [{ type: 'put', key, value: encode(state) }, operation],
  );
  if (!applied) await throwIfWorkerBuildRemoved(storage, build);
  return applied;
}

/**
 * The durable work that is bound to a deployment build, computed on demand.
 *
 * Nothing keeps a counter. A reference is derived from the records themselves in one bounded
 * scan each of the run records (`wf:`) and the task ledger (`task-ledger:`), at the moment a build
 * is read or removed, so the answer cannot drift from the work it describes. This follows the
 * precedent of a workflow revision's removal (`core/engine/nonterminal-revision-count.ts`).
 *
 * What counts as a reference to a build:
 *
 * - a run that is not terminal (`running`, `pending`, or `suspended`) whose current worker binding
 *   names the build. That includes an auto-upgrade run, which still executes on its current build;
 * - a task-ledger entry that is not terminal (`queued`, `leased`, `completing`, `cancelling`, or
 *   `deadLettered`) whose execution requirement names the build. A requirement that carries a
 *   `buildId` and no `deploymentName` names that build in every deployment, so it counts for each.
 *
 * Schedules and revision realms do not pin a build, so they are not references.
 *
 * @module worker/deployment-build-references
 */

import type { Storage } from "../embedded/storage/src/index.ts";
import { decode } from '../core/codec/index.ts';
import { isTerminalWorkflowStatus } from '../core/engine/validation.ts';
import { isTopLevelWorkflowStateKey } from '../core/engine/workflow-state-stream.ts';
import { decodeRemoteTaskRecord } from '../core/task-ledger/task-ledger-codec.ts';
import type { WorkerExecutionRequirementInput } from '../core/task-ledger/task-ledger-types.ts';
import type { WorkflowStatus } from '../core/types/identity.ts';

/** A build, named the way the catalog names it. */
export type DeploymentBuildIdentity = Readonly<{ deploymentName: string; buildId: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The build a run's current worker binding names, or `null` for a run with no live binding. */
function boundBuildOf(stateBytes: Uint8Array): { deploymentName: string; buildId: string } | null {
  const state = decode(stateBytes);
  if (!isRecord(state)) return null;
  if (isTerminalWorkflowStatus(state['status'] as WorkflowStatus)) return null;
  const binding = state['workerBinding'];
  if (!isRecord(binding) || !isRecord(binding['current'])) return null;
  const { deploymentName, buildId } = binding['current'];
  return typeof deploymentName === 'string' && typeof buildId === 'string'
    ? { deploymentName, buildId }
    : null;
}

/** Whether `requirement` names `build`: the same build id, in the same or an unnamed deployment. */
function requirementNames(
  requirement: WorkerExecutionRequirementInput | undefined,
  build: DeploymentBuildIdentity,
): boolean {
  return (
    requirement?.buildId === build.buildId &&
    (requirement.deploymentName === undefined ||
      requirement.deploymentName === build.deploymentName)
  );
}

/**
 * How many pieces of non-terminal durable work are bound to each of `builds`, in the same order.
 * One pass over the run records and one over the ledger serves every build asked about, so a
 * listing costs the same two scans however many builds it reports.
 */
export async function countBuildReferences(
  storage: Storage,
  builds: ReadonlyArray<DeploymentBuildIdentity>,
): Promise<number[]> {
  const counts = builds.map(() => 0);
  if (builds.length === 0) return counts;
  for await (const [key, bytes] of storage.scan('wf:')) {
    if (!isTopLevelWorkflowStateKey(key)) continue;
    const bound = boundBuildOf(bytes);
    if (bound === null) continue;
    builds.forEach((build, index) => {
      if (build.deploymentName === bound.deploymentName && build.buildId === bound.buildId) {
        counts[index] = (counts[index] ?? 0) + 1;
      }
    });
  }
  for await (const [, bytes] of storage.scan('task-ledger:')) {
    const record = decodeRemoteTaskRecord(bytes);
    if (record === null || record.state === 'terminal') continue;
    builds.forEach((build, index) => {
      if (requirementNames(record.executionRequirement, build)) {
        counts[index] = (counts[index] ?? 0) + 1;
      }
    });
  }
  return counts;
}

/** How many pieces of non-terminal durable work are bound to one build. */
export async function countBuildReference(
  storage: Storage,
  build: DeploymentBuildIdentity,
): Promise<number> {
  const [count] = await countBuildReferences(storage, [build]);
  return count ?? 0;
}

/**
 * Announces an operator mutation of a worker deployment as a
 * `worker:deployment-changed` event. Shared by the drain, resume, set-routing, promote,
 * rollback, and remove operations, which each call it once after their mutation has committed.
 *
 * @module server/operations/worker-deployment-events
 */

import { WorkerDeploymentChangedEvent } from '../../core/events/fleet-state-events.ts';
import type { WorkerDeploymentCatalog } from '../../worker/deployment-routing.ts';
import type { WorkerHealth, WorkerRegistry } from '../../worker/registry.ts';

/** What an operation needs to announce a deployment mutation. Every field is optional: discovery-only registries carry none, and announce nothing. */
export type WorkerDeploymentEventSource = {
  dispatchEvent?: ((event: Event) => void) | undefined;
  workerRegistry?: WorkerRegistry | undefined;
  catalog?: WorkerDeploymentCatalog | undefined;
};

/**
 * Dispatch {@link WorkerDeploymentChangedEvent} for `deploymentName` (and `buildId` when the
 * mutation named one build). `drainState` and `routingGeneration` default to a read of the
 * registry and the catalog; an operation that already holds either from its own result passes it.
 *
 * Call it only after the mutation committed. The announcement is advisory: if the catalog read
 * for the generation fails, the mutation still stands and no event is raised, rather than failing
 * an operation that already took effect.
 */
export async function announceWorkerDeploymentChanged(
  source: WorkerDeploymentEventSource,
  deploymentName: string,
  buildId: string | undefined,
  known: { drainState?: WorkerHealth; routingGeneration?: number } = {},
): Promise<void> {
  const { dispatchEvent } = source;
  if (dispatchEvent === undefined) return;
  const routingGeneration =
    known.routingGeneration ?? (await readRoutingGeneration(source, deploymentName));
  if (routingGeneration === undefined) return;
  const drainState =
    known.drainState ??
    source.workerRegistry?.deploymentDrainState(deploymentName, buildId) ??
    'active';
  dispatchEvent(
    new WorkerDeploymentChangedEvent(deploymentName, buildId, drainState, routingGeneration),
  );
}

/** The deployment's routing generation (`0` before any pointer exists), or `undefined` when the catalog cannot be read. */
async function readRoutingGeneration(
  source: WorkerDeploymentEventSource,
  deploymentName: string,
): Promise<number | undefined> {
  try {
    const routing = await source.catalog?.getRouting(deploymentName);
    return routing?.generation ?? 0;
  } catch {
    return undefined;
  }
}

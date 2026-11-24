/**
 * Durable work would be bound to a deployment build that has been removed: a start, a restart, a
 * fork, a child, an automatic upgrade, the retry of a failed run, or a task-ledger entry. A removed
 * build can never run work again, so the work is refused rather than bound to it. Distinct from
 * other failures so the operations that bind work can report it as a conflict with the deployment
 * state (`reason: "version-removed"`) rather than as an engine failure.
 */
export class WorkerDeploymentVersionRemovedError extends Error {
  readonly deploymentName: string;
  readonly buildId: string;

  constructor(deploymentName: string, buildId: string) {
    super(
      `Deployment build ${deploymentName}/${buildId} has been removed, so no run or task can be bound to it.`,
    );
    this.name = 'WorkerDeploymentVersionRemovedError';
    this.deploymentName = deploymentName;
    this.buildId = buildId;
  }
}

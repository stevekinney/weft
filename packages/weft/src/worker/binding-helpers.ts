import type { WorkerExecutionIdentity, WorkerExecutionRequirement } from './manifest/types.ts';
import type { WorkflowWorkerBinding } from './versioning-policy.ts';

/** Convert an accepted manifest execution identity into the durable binding fact. */
export function bindingFromExecution(
  execution: WorkerExecutionIdentity,
  workflowId: string,
  workflowType: string,
  activityName: string,
  checkpointId: string,
  boundAt = Date.now(),
): WorkflowWorkerBinding {
  return {
    workflowId,
    workflowType,
    deploymentName: execution.deploymentName,
    buildId: execution.buildId,
    artifactDigest: execution.artifactDigest,
    manifestDigest: execution.manifestDigest,
    routingGeneration: 0,
    workflowRevision: execution.workflowRevision,
    workflowContractHash: execution.activityContractHash,
    activityContracts: { [activityName]: execution.activityContractHash },
    activityName,
    activityContractHash: execution.activityContractHash,
    boundAt,
    checkpointId,
  };
}

/** Child, retry, schedule, fork, and continue-as-new operations inherit this exact binding. */
export function inheritWorkflowWorkerBinding(
  binding: WorkflowWorkerBinding,
  options: Readonly<{
    workflowId?: string;
    boundAt?: number;
    checkpointId?: string;
  }> = {},
): WorkflowWorkerBinding {
  return {
    ...binding,
    workflowId: options.workflowId ?? binding.workflowId,
    boundAt: options.boundAt ?? binding.boundAt,
    checkpointId: options.checkpointId ?? binding.checkpointId,
  };
}

/** Convert a durable workflow binding into the exact task routing requirement it authorizes. */
export function executionRequirementFromWorkflowWorkerBinding(
  binding: WorkflowWorkerBinding,
  activityName = binding.activityName,
): WorkerExecutionRequirement {
  const activityContractHash =
    binding.activityContracts[activityName] ?? binding.activityContractHash;
  return {
    deploymentName: binding.deploymentName,
    buildId: binding.buildId,
    artifactDigest: binding.artifactDigest,
    workflowRevision: binding.workflowRevision,
    activityContractHash,
  };
}

/** Couple activities to the workflow unless an explicit activity binding is selected. */
export function selectWorkflowActivityBinding(
  workflowBinding: WorkflowWorkerBinding,
  activityBinding?: WorkflowWorkerBinding,
): WorkflowWorkerBinding {
  if (activityBinding === undefined) return workflowBinding;
  if (
    activityBinding.workflowId !== workflowBinding.workflowId ||
    activityBinding.workflowType !== workflowBinding.workflowType
  ) {
    throw new Error('Activity binding must belong to the bound workflow.');
  }
  return activityBinding;
}

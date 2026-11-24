import type { WorkflowStatus } from '../../types.ts';

/**
 * A resume found the workflow's stored status to be one a resume cannot continue: anything but
 * `running` or `suspended`. Thrown by `resumeWorkflowFromStorage`'s first read of the state and
 * again by its serialized section's re-read, which carry the status they saw so that
 * `recoverAll()` can tell a run that became terminal after its preflight, because another drive
 * (the claim reclaim's, say) completed it, from an error it must surface (COR-1593). The message
 * is the one these sites always threw; this class is internal and not a `WeftError`.
 */
export class WorkflowNotResumableError extends Error {
  readonly workflowId: string;
  readonly status: WorkflowStatus;

  constructor(workflowId: string, status: WorkflowStatus) {
    super(
      `Cannot resume workflow "${workflowId}": status is "${status}", expected "running" or "suspended"`,
    );
    this.name = 'WorkflowNotResumableError';
    this.workflowId = workflowId;
    this.status = status;
  }
}

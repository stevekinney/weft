/**
 * The reactivation of a failed workflow committed and the run is running again; only the cancel of
 * its terminal cleanup timer failed. A caller must go on and resume the run, not report it as
 * unchanged.
 */
export class ReactivationCleanupError extends Error {
  constructor(workflowId: string, cause: unknown) {
    super(
      `Workflow "${workflowId}" was reactivated, but its terminal cleanup timer was not canceled.`,
      { cause },
    );
    this.name = 'ReactivationCleanupError';
  }
}

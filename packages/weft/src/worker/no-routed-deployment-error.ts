/**
 * No ready, routed deployment build provides the workflow type at the requested
 * revision, so no start binding can be resolved. Distinct from other failures so
 * the operations that resolve a binding can report it as a conflict with the
 * deployment state rather than as an engine failure.
 */
export class NoRoutedWorkerDeploymentError extends Error {
  constructor(workflowType: string, workflowRevision: string) {
    super(
      `No accepted routed worker deployment provides workflow "${workflowType}" revision "${workflowRevision}".`,
    );
    this.name = 'NoRoutedWorkerDeploymentError';
  }
}

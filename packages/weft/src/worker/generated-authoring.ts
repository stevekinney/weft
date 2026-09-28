/**
 * Minimal public authoring primitives consumed by generated worker modules.
 *
 * This leaf module intentionally avoids the workflow-builder type graph: a
 * generated worker only needs to package already-generated workflow/activity
 * implementation shapes, and consumers should be able to typecheck that
 * surface without pulling in unrelated engine, server, or storage types.
 *
 * @module worker/generated-authoring
 */

export type { RemoteActivityContext } from './remote-activity-context.ts';

type ImplementedWorkflowMap = Record<
  string,
  { readonly name: string; readonly activities: object }
>;

type WorkerWorkflowMap<TWorkflows extends ImplementedWorkflowMap> = {
  [TName in keyof TWorkflows & string]: TWorkflows[TName] & { readonly name: TName };
};

export type DefinedWorker<TWorkflows extends ImplementedWorkflowMap> = Readonly<{
  deployment: string;
  workflows: WorkerWorkflowMap<TWorkflows>;
}>;

/**
 * Package workflow implementations into the worker `workflows` map. The outer
 * key must match each implementation's literal workflow name.
 */
export function defineWorker<const TWorkflows extends ImplementedWorkflowMap>(options: {
  deployment: string;
  workflows: WorkerWorkflowMap<TWorkflows>;
}): DefinedWorker<TWorkflows> {
  return Object.freeze({
    deployment: options.deployment,
    workflows: Object.freeze({ ...options.workflows }),
  });
}

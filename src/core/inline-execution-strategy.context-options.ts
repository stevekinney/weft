/**
 * Dependency shapes and the context-options builder used by
 * {@link InlineExecutionStrategy}. Kept beside the strategy so the strategy
 * module stays focused on generator lifecycle and context bookkeeping.
 *
 * @module core/inline-execution-strategy.context-options
 */

import type { ContextOptions } from './context.ts';
import type { ComposedWorkflowInterceptor } from './interceptor.ts';
import type { SearchAttributeSchema, WorkflowFunction } from './types.ts';

/** Capabilities the engine injects into the inline strategy at construction. */
export interface InlineExecutionDependencies {
  getRegistration: (workflowType: string) =>
    | {
        handler: WorkflowFunction;
        version: string;
        searchAttributes?: SearchAttributeSchema;
      }
    | undefined;
  getNow: () => number;
  resolveWorkflowType?: (target: string | Function) => string;
  maxNestingDepth: number;
  development?: boolean;
  getComposedWorkflowInterceptor?: () => ComposedWorkflowInterceptor | null;
  registerCancelHandler?: (workflowId: string, handler: () => Promise<void> | void) => () => void;
  /**
   * Look up the non-serialized per-run `services` value for a workflow, exposed
   * to the body as `ctx.services`. Returns `undefined` when none was supplied.
   */
  getWorkflowServices?: (workflowId: string) => unknown;
}

/** A registration resolved through {@link InlineExecutionDependencies.getRegistration}, narrowed to the present case. */
export type InlineWorkflowRegistration = NonNullable<
  ReturnType<InlineExecutionDependencies['getRegistration']>
>;

/** Parameters for starting a workflow run on the inline strategy. */
export type InlineStartWorkflowParameters = {
  workflowId: string;
  workflowType: string;
  input: unknown;
  checkpoint: ArrayBuffer | Uint8Array;
  nestingDepth?: number;
  executionStateOwnerId?: string;
  startedAt?: number;
  sleepReferenceTime?: number;
  deadline?: number;
  headers?: [string, string][];
};

/** Build the {@link ContextOptions} for a single inline workflow run from the injected dependencies and start parameters. */
export function createInlineContextOptions(
  dependencies: InlineExecutionDependencies,
  registration: InlineWorkflowRegistration,
  parameters: InlineStartWorkflowParameters,
  workflowAbort: AbortController,
): ContextOptions {
  const { registerCancelHandler } = dependencies;
  return {
    workflowId: parameters.workflowId,
    workflowType: parameters.workflowType,
    startedAt: parameters.startedAt ?? dependencies.getNow(),
    abortController: workflowAbort,
    getNow: dependencies.getNow,
    nestingDepth: parameters.nestingDepth ?? 0,
    executionStateOwnerId: parameters.executionStateOwnerId ?? parameters.workflowId,
    ...(parameters.sleepReferenceTime !== undefined && {
      sleepReferenceTime: parameters.sleepReferenceTime,
    }),
    ...(dependencies.resolveWorkflowType !== undefined && {
      resolveWorkflowType: dependencies.resolveWorkflowType,
    }),
    ...(registration.searchAttributes && {
      searchAttributeSchema: registration.searchAttributes,
    }),
    ...(parameters.deadline !== undefined && { deadline: parameters.deadline }),
    ...(registerCancelHandler !== undefined && {
      registerCancelHandler: (handler) => registerCancelHandler(parameters.workflowId, handler),
    }),
    services: dependencies.getWorkflowServices?.(parameters.workflowId),
  };
}

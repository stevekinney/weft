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
import type { WorkflowLogRecord } from './types/workflow-log.ts';

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
   * Durably record a `ctx.setFinalizerState(value)` payload for a workflow (#446).
   * The engine stages it as a pending atomic side-effect so it commits with the
   * next checkpoint or the terminal batch. Absent in worker mode.
   */
  recordFinalizerState?: (workflowId: string, value: unknown) => void;
  /**
   * Look up the non-serialized per-run `services` value for a workflow, exposed
   * to the body as `ctx.services`. Returns `undefined` when none was supplied.
   */
  getWorkflowServices?: (workflowId: string) => unknown;
  /**
   * The host log sink (`EngineOptions.onLog`) for `ctx.log` records, or
   * `undefined` for the default console behavior. Engine-scoped, so it takes no
   * workflow id.
   */
  getLogSink?: () => ((record: WorkflowLogRecord) => void) | undefined;
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
    ...resolveWorkflowScopedCallbackOptions(dependencies, parameters.workflowId),
    services: dependencies.getWorkflowServices?.(parameters.workflowId),
    ...resolveLogSinkOption(dependencies),
  };
}

/**
 * Resolve the optional per-workflow callback context options (`registerCancelHandler`,
 * `recordFinalizerState`) from the engine's workflow-id-keyed accessors, binding each
 * to this run's workflow id. Keys are omitted when their accessor is absent so
 * `ContextOptions` stays valid under `exactOptionalPropertyTypes`. Kept as a helper so the
 * conditional spreads do not tip `createInlineContextOptions` over the cyclomatic-complexity cap.
 */
function resolveWorkflowScopedCallbackOptions(
  dependencies: InlineExecutionDependencies,
  workflowId: string,
): Pick<ContextOptions, 'registerCancelHandler' | 'recordFinalizerState'> {
  const { registerCancelHandler, recordFinalizerState } = dependencies;
  return {
    ...(registerCancelHandler !== undefined && {
      registerCancelHandler: (handler) => registerCancelHandler(workflowId, handler),
    }),
    ...(recordFinalizerState !== undefined && {
      recordFinalizerState: (value) => recordFinalizerState(workflowId, value),
    }),
  };
}

/**
 * Resolve the optional `logSink` context option from the engine's `getLogSink`
 * accessor. `EngineOptions.onLog` is fixed at engine construction, so this returns
 * the captured value (or an empty object that omits the key when no sink is
 * installed, keeping `ContextOptions` valid under `exactOptionalPropertyTypes`).
 * Kept as a one-branch helper because inlining the conditional spread tips
 * `createInlineContextOptions` over the cyclomatic-complexity cap.
 */
function resolveLogSinkOption(dependencies: InlineExecutionDependencies): {
  logSink?: (record: WorkflowLogRecord) => void;
} {
  const logSink = dependencies.getLogSink?.();
  return logSink === undefined ? {} : { logSink };
}

/** The optional {@link InlineExecutionDependencies} fields that are only forwarded when present. */
type OptionalInlineDependencyKey =
  | 'getComposedWorkflowInterceptor'
  | 'registerCancelHandler'
  | 'recordFinalizerState'
  | 'getWorkflowServices'
  | 'getLogSink';

/**
 * Keep only the defined optional inline-strategy dependencies, so
 * `InlineExecutionStrategy` construction stays valid under
 * `exactOptionalPropertyTypes` (a key set to `undefined` is rejected, an absent key
 * is fine). Extracted from `createExecutionStrategyBundle` so its conditional
 * spreads do not tip it over the cyclomatic-complexity cap.
 */
export function presentInlineDependencies(candidates: {
  [Key in OptionalInlineDependencyKey]?: InlineExecutionDependencies[Key] | undefined;
}): Partial<InlineExecutionDependencies> {
  const keys: OptionalInlineDependencyKey[] = [
    'getComposedWorkflowInterceptor',
    'registerCancelHandler',
    'recordFinalizerState',
    'getWorkflowServices',
    'getLogSink',
  ];
  const present: Partial<InlineExecutionDependencies> = {};
  for (const key of keys) {
    if (candidates[key] !== undefined) {
      Object.assign(present, { [key]: candidates[key] });
    }
  }
  return present;
}

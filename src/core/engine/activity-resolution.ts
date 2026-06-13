import type { ContextOperationRequest } from '../context.ts';
import { ActivityResolutionError } from './errors.ts';
import type { EngineInternals } from './internals.ts';
import type { ActivityFunctionWithMetadata } from './operations-activity.ts';

type ActivityOperation = Extract<ContextOperationRequest, { type: 'activity' }>;

/**
 * Look up `activityName` for the workflow identified by `workflowId`.
 *
 * Resolution rules:
 *
 * - When a workflow declares activities inline through `.activities()`, it owns
 *   a per-workflow `ActivityRegistry`, which is consulted first.
 * - The global `ActivityRegistry` is the fallback, so a builder workflow can
 *   share an activity that lives in the global pool. A workflow with no
 *   per-workflow registry resolves entirely against the global registry.
 *
 * Both `getActivityFunctionWithMetadata` and `resolveActivityFunction` route
 * through this single resolver so metadata (compensation, verification) and
 * the actual executed function come from the same callable. Speculative
 * execution paths must not see one function for metadata and a different one
 * for execution.
 *
 * Returns `undefined` when no registry resolves the name. Callers decide
 * whether to throw `ActivityResolutionError` (the dispatch path) or treat the
 * miss as advisory (the metadata path).
 */
function resolveActivityViaRegistries(
  internals: EngineInternals,
  workflowId: string,
  activityName: string,
): { fn: (...arguments_: unknown[]) => unknown; workflowType: string } | undefined {
  const workflowType = internals.workflowTypeByWorkflowId.get(workflowId);
  if (workflowType !== undefined) {
    const perWorkflow = internals.activityRegistriesByWorkflow.get(workflowType);
    if (perWorkflow !== undefined) {
      // Per-workflow registry wins; fall back to global to support the
      // mixed-registration pattern (builder workflow + shared global activity).
      const perWorkflowFn = perWorkflow.resolve(activityName);
      if (perWorkflowFn) {
        return { fn: perWorkflowFn, workflowType };
      }
    }
    const globalFn = internals.activityRegistry.resolve(activityName);
    if (globalFn) {
      return { fn: globalFn, workflowType };
    }
    return undefined;
  }
  // Unknown workflow type (lifecycle edge — e.g. activity dispatched outside
  // an active workflow execution). Only the global registry can answer.
  const globalFn = internals.activityRegistry.resolve(activityName);
  if (globalFn) {
    return { fn: globalFn, workflowType: '<unknown>' };
  }
  return undefined;
}

/**
 * Resolve the activity callable along with its attached metadata (compensation,
 * verification). Returns `undefined` when no registry and no `operation.fn`
 * resolve the name — the metadata path treats a miss as advisory rather than
 * fatal.
 */
export function getActivityFunctionWithMetadata(
  internals: EngineInternals,
  workflowId: string,
  operation: ActivityOperation,
): ActivityFunctionWithMetadata | undefined {
  // Use the same resolution order as resolveActivityFunction so metadata
  // (compensation / verification) is taken from the same callable that
  // actually runs. The per-workflow registry wins over `operation.fn`
  // because the workflow's locally-scoped activity is the authoritative
  // implementation when the workflow is builder-registered.
  const resolved = resolveActivityViaRegistries(internals, workflowId, operation.activityName);
  if (resolved) {
    return resolved.fn as ActivityFunctionWithMetadata;
  }
  if (typeof operation.fn === 'function') {
    return operation.fn as ActivityFunctionWithMetadata;
  }
  return undefined;
}

/**
 * Resolve the activity function for a given operation. Uses the same
 * per-workflow-first-then-global ordering as `getActivityFunctionWithMetadata`.
 * For inline-mode callers that pass an `operation.fn` directly, the registries
 * are still consulted first so a workflow's locally-scoped activity wins over
 * the bare callable. Throws `ActivityResolutionError` when neither path
 * resolves.
 */
export function resolveActivityFunction(
  internals: EngineInternals,
  workflowId: string,
  operation: ActivityOperation,
): (...arguments_: unknown[]) => unknown {
  const resolved = resolveActivityViaRegistries(internals, workflowId, operation.activityName);
  if (resolved) return resolved.fn;
  if (operation.fn) return operation.fn as (...arguments_: unknown[]) => unknown;
  const workflowType = internals.workflowTypeByWorkflowId.get(workflowId) ?? '<unknown>';
  throw new ActivityResolutionError(workflowType, operation.activityName);
}

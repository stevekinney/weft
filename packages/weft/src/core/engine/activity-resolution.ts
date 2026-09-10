import type { ContextOperationRequest } from '../context.ts';
import type { WorkflowExecutionIdentity } from './engine-internal-types.ts';
import { ActivityResolutionError } from './errors.ts';
import type { EngineInternals } from './internals.ts';
import type { ActivityFunctionWithMetadata } from './operations-activity.ts';

type ActivityOperation = Extract<ContextOperationRequest, { type: 'activity' }>;

/**
 * The three-tier resolve order for a workflow this process has a cached
 * identity for: eager per-workflow registry, then the exact
 * `(type, revision)`-keyed per-workflow registry, then the global registry.
 * Split out of {@link resolveActivityViaRegistries} purely to keep that
 * function's own cyclomatic complexity under the repository's ceiling.
 */
function resolveViaKnownIdentity(
  internals: EngineInternals,
  identity: WorkflowExecutionIdentity,
  activityName: string,
): { fn: (...arguments_: unknown[]) => unknown; workflowType: string } | undefined {
  const eagerFn = internals.activityRegistriesByWorkflow.get(identity.type)?.resolve(activityName);
  if (eagerFn) {
    return { fn: eagerFn, workflowType: identity.type };
  }

  if (identity.revision !== undefined) {
    const revisionFn = internals.sources.resolved
      .get(identity.type)
      ?.get(identity.revision)
      ?.activityRegistry.resolve(activityName);
    if (revisionFn) {
      return { fn: revisionFn, workflowType: identity.type };
    }
  }

  const globalFn = internals.activityRegistry.resolve(activityName);
  return globalFn ? { fn: globalFn, workflowType: identity.type } : undefined;
}

/**
 * Look up `activityName` for the workflow identified by `workflowId`.
 *
 * Resolution rules, tried in order:
 *
 * - The EAGER per-workflow registry (`internals.activityRegistriesByWorkflow`,
 *   populated only by `engine.register()` as of WFT-19). Tried first
 *   regardless of the instance's pinned `revision`: an eager registration
 *   resolves the same no matter what a legacy or dynamic-source-shaped
 *   `revision` happens to be pinned (mirrors
 *   `resolveExecutableRegistrationForRevision()`'s own "eager always wins"
 *   rule), so a dynamic-source type later re-registered eagerly is never
 *   skipped in favor of a stale revision-keyed lookup.
 * - When the instance's identity carries a defined `revision`, the EXACT
 *   `(type, revision)`-keyed per-workflow registry
 *   (`internals.sources.resolved.get(type)?.get(revision)?.activityRegistry`)
 *   — the running instance's own pin, never a sibling run's more-recently-
 *   resolved revision of the same type (WFT-19; see
 *   `dynamic-source-execution.ts`'s `loadAndInstallSourceRevision()` doc for
 *   the clobber this replaces).
 * - The global `ActivityRegistry`, so a builder workflow can share an
 *   activity that lives in the global pool. A workflow with no per-workflow
 *   registry (of either kind above) resolves entirely against the global one.
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
  const identity = internals.workflowTypeByWorkflowId.get(workflowId);
  if (identity !== undefined) {
    return resolveViaKnownIdentity(internals, identity, activityName);
  }
  // Unknown workflow type (lifecycle edge — e.g. activity dispatched outside
  // an active workflow execution). Only the global registry can answer.
  const globalFn = internals.activityRegistry.resolve(activityName);
  return globalFn ? { fn: globalFn, workflowType: '<unknown>' } : undefined;
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
    return resolved.fn;
  }
  if (typeof operation.fn === 'function') {
    return operation.fn;
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
  if (operation.fn) return operation.fn;
  const workflowType = internals.workflowTypeByWorkflowId.get(workflowId)?.type ?? '<unknown>';
  throw new ActivityResolutionError(workflowType, operation.activityName);
}

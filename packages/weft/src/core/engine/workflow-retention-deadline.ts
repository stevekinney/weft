import type { NormalizedRetentionPolicy, WorkflowState } from '../types.ts';
import { DynamicWorkflowSourceUnavailableError } from './dynamic-source-errors.ts';
import {
  getResolvedDynamicRegistration,
  resolveExecutableRegistrationForRevision,
} from './dynamic-source-execution.ts';
import type { Engine } from './index.ts';
import type { EngineInternals } from './internals.ts';
import { WorkflowRevisionUnavailableError } from './revision-errors.ts';
import { isTerminalWorkflowStatus, resolveRetentionForStatus } from './validation.ts';

/**
 * Resolve `state`'s own retention policy — the running instance's EXACT
 * pinned `revision` (WFT-17/WFT-19), never a sibling run's more-recently-
 * resolved revision. Awaits a full dynamic-source resolve when the pin is
 * `registerSource()`-registered but not yet locally resolved
 * (WFT-19 review round 1): `getResolvedDynamicRegistration()`'s sync-only
 * lookup cannot close that gap, and this call site — unlike
 * `constraints.ts`'s `evaluateConstraints()` — is reachable for a workflow
 * that is NOT currently executing in this process (a fresh engine's purge
 * sweep over a persisted terminal run), where silently falling back to the
 * engine-wide default instead of resolving the run's own declared window is
 * a real premature- or delayed-purge risk, not just a diagnostic gap.
 * Returns `undefined` (engine-default fallback) when `state.type` has no
 * registration at all, when the pinned revision cannot be resolved on this
 * process ({@link WorkflowRevisionUnavailableError}), or when the resolve
 * itself fails ({@link DynamicWorkflowSourceUnavailableError}) — mirrors
 * `termination/finalizer-registration.ts`'s `resolveFinalizerRegistration()`.
 */
async function resolveRetentionPolicyForState(
  internals: EngineInternals,
  state: WorkflowState,
): Promise<NormalizedRetentionPolicy | undefined> {
  const eagerOrAlreadyResolved = getResolvedDynamicRegistration(
    internals,
    state.type,
    state.revision,
  )?.retention;
  if (eagerOrAlreadyResolved !== undefined) {
    return eagerOrAlreadyResolved;
  }
  if (!internals.sources.byName.has(state.type)) {
    return undefined;
  }
  try {
    const { entry } = await resolveExecutableRegistrationForRevision(
      internals.engine as unknown as Engine,
      internals,
      state.type,
      state.revision,
    );
    return entry.retention;
  } catch (error) {
    if (
      error instanceof DynamicWorkflowSourceUnavailableError ||
      error instanceof WorkflowRevisionUnavailableError
    ) {
      return undefined;
    }
    throw error;
  }
}

/**
 * The timestamp at which `state` becomes eligible for retention-driven
 * purge, or `null` when it is non-terminal or has no applicable retention
 * window. Falls back to the resolved dynamic definition's own retention
 * policy for a `registerSource()`-registered type (see
 * `resolveRetentionPolicyForState()`), then the engine-wide default —
 * mirroring `retention.ts`'s `resolveWorkflowTypeRetention`.
 */
export async function getWorkflowRetentionDeadline(
  internals: EngineInternals,
  state: WorkflowState,
): Promise<number | null> {
  if (!isTerminalWorkflowStatus(state.status)) return null;

  const policy =
    (await resolveRetentionPolicyForState(internals, state)) ?? internals.options.retention;
  const retentionMs = resolveRetentionForStatus(policy, state.status);
  if (retentionMs === undefined) return null;

  return state.updatedAt + retentionMs;
}

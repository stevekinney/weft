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
 * The outcome of resolving `state`'s own retention policy: a definite
 * `policy` (either the pinned revision's own declared retention, or — for a
 * type this process has no dynamic-source registration for at all —
 * `undefined`, meaning "fall back to the engine-wide default, purge normally
 * eligible"); or `'unresolvable'` when `state.type` IS a `registerSource()`-
 * registered dynamic source but this process cannot resolve the run's own
 * pinned revision right now (registered-but-not-yet-loaded, or a revision
 * this process never registered). `'unresolvable'` is NOT the same as "no
 * policy" — it means "purge eligibility for this run cannot be determined
 * this sweep," which {@link getWorkflowRetentionDeadline} must not silently
 * paper over with the engine default (WFT-19 review round 2): the run's own
 * declared window might be LONGER than the default, and purge is
 * irreversible, so the safe default under uncertainty is "not eligible yet,"
 * not "eligible under someone else's policy."
 */
type RetentionPolicyResolution =
  | { readonly kind: 'resolved'; readonly policy: NormalizedRetentionPolicy | undefined }
  | { readonly kind: 'unresolvable' };

/**
 * Resolve `state`'s own retention policy — the running instance's EXACT
 * pinned `revision` (WFT-17/WFT-19), never a sibling run's more-recently-
 * resolved revision. Awaits a full dynamic-source resolve when the pin is
 * `registerSource()`-registered but not yet locally resolved
 * (WFT-19 review round 1): `getResolvedDynamicRegistration()`'s sync-only
 * lookup cannot close that gap, and this call site — unlike
 * `constraints.ts`'s `evaluateConstraints()` — is reachable for a workflow
 * that is NOT currently executing in this process (a fresh engine's purge
 * sweep over a persisted terminal run).
 */
async function resolveRetentionPolicyForState(
  internals: EngineInternals,
  state: WorkflowState,
): Promise<RetentionPolicyResolution> {
  const eagerOrAlreadyResolved = getResolvedDynamicRegistration(
    internals,
    state.type,
    state.revision,
  )?.retention;
  if (eagerOrAlreadyResolved !== undefined) {
    return { kind: 'resolved', policy: eagerOrAlreadyResolved };
  }
  if (!internals.sources.byName.has(state.type)) {
    return { kind: 'resolved', policy: undefined };
  }
  try {
    const { entry } = await resolveExecutableRegistrationForRevision(
      internals.engine as unknown as Engine,
      internals,
      state.type,
      state.revision,
    );
    return { kind: 'resolved', policy: entry.retention };
  } catch (error) {
    if (
      error instanceof DynamicWorkflowSourceUnavailableError ||
      error instanceof WorkflowRevisionUnavailableError
    ) {
      return { kind: 'unresolvable' };
    }
    throw error;
  }
}

/**
 * The timestamp at which `state` becomes eligible for retention-driven
 * purge, or `null` when it is non-terminal, has no applicable retention
 * window, or (WFT-19 review round 2) its own pinned revision's retention
 * policy cannot be resolved on this process right now — an unresolvable pin
 * is NOT purge-eligible under the engine default; it is re-examined on a
 * later sweep once the pin becomes resolvable, rather than risking an
 * irreversible early purge against a shorter policy than the run's own.
 * Falls back to the resolved dynamic definition's own retention policy for a
 * `registerSource()`-registered type (see `resolveRetentionPolicyForState()`),
 * then the engine-wide default for any other type — mirroring `retention.ts`'s
 * `resolveWorkflowTypeRetention`.
 */
export async function getWorkflowRetentionDeadline(
  internals: EngineInternals,
  state: WorkflowState,
): Promise<number | null> {
  if (!isTerminalWorkflowStatus(state.status)) return null;

  const resolution = await resolveRetentionPolicyForState(internals, state);
  if (resolution.kind === 'unresolvable') return null;

  const policy = resolution.policy ?? internals.options.retention;
  const retentionMs = resolveRetentionForStatus(policy, state.status);
  if (retentionMs === undefined) return null;

  return state.updatedAt + retentionMs;
}

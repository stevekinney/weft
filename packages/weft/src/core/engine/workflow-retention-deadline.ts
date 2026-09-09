import type { WorkflowState } from '../types.ts';
import { getResolvedDynamicRegistration } from './dynamic-source-execution.ts';
import type { EngineInternals } from './internals.ts';
import { isTerminalWorkflowStatus, resolveRetentionForStatus } from './validation.ts';

/**
 * The timestamp at which `state` becomes eligible for retention-driven
 * purge, or `null` when it is non-terminal or has no applicable retention
 * window. Falls back to the resolved dynamic definition's own retention
 * policy for a `registerSource()`-registered type (see
 * `getResolvedDynamicRegistration()`), then the engine-wide default —
 * mirroring `retention.ts`'s `resolveWorkflowTypeRetention`.
 */
export function getWorkflowRetentionDeadline(
  internals: EngineInternals,
  state: WorkflowState,
): number | null {
  if (!isTerminalWorkflowStatus(state.status)) return null;

  const policy =
    getResolvedDynamicRegistration(internals, state.type)?.retention ?? internals.options.retention;
  const retentionMs = resolveRetentionForStatus(policy, state.status);
  if (retentionMs === undefined) return null;

  return state.updatedAt + retentionMs;
}

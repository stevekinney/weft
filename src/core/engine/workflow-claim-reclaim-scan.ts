/**
 * Storage-scan candidate discovery for the recurring reclaim pass described
 * in [ADR 0002 § Reclaiming stranded claims](../../../documentation/contributing/architecture-decisions/0002-multiengine-per-workflow-ownership.md#reclaiming-stranded-claims).
 *
 * A single boot-time `recoverAll()` sweep only catches a stranded claim that
 * happens to already be past its grace-adjusted expiry at boot. An engine
 * that crashes (or whose graceful-shutdown release fails) later leaves its
 * `wf-owner-holder:<id>` record behind for every OTHER engine to discover;
 * nothing rescans for that unless something recurring does. This module is
 * the discovery half of that recurring scan: enumerate every workflow id
 * with a currently-persisted holder record, store-wide, so a caller can
 * attempt `WorkflowClaimRegistry.takeover` against each one.
 *
 * **Deliberately not a liveness filter.** This module does not decode holder
 * bytes or judge staleness — `WorkflowClaimRegistry.takeover` already does
 * that with a fresh read at the moment of the attempt (see its own
 * grace-adjusted `isWorkflowClaimExpired` check), and re-deciding it here
 * from a possibly-stale scan read would be redundant at best and a source of
 * a second, drifting judgment at worst. This is discovery only.
 *
 * @module core/engine/workflow-claim-reclaim-scan
 */

import { KEYS, tryDecodeStorageKeyComponent, type Storage } from '../../storage/interface.ts';

/**
 * List every workflow id with a currently-persisted `wf-owner-holder:<id>`
 * record, excluding `excludeWorkflowIds` — this engine's own currently-held
 * claims, already kept alive by the same pass's renewal step, so attempting
 * `takeover` against them would be pure overhead rather than a genuine
 * reclaim. A key whose id-component fails to decode is skipped rather than
 * surfaced: it cannot correspond to any id this engine could ever have
 * claimed, since every id this module or `WorkflowClaimRegistry` writes is
 * encoded with the matching encoder.
 */
export async function listWorkflowClaimReclaimCandidates(
  storage: Storage,
  excludeWorkflowIds: ReadonlySet<string>,
): Promise<string[]> {
  const prefix = KEYS.workflowOwnerHolder('');
  const candidates: string[] = [];
  for await (const [key] of storage.scan(prefix)) {
    const workflowId = tryDecodeStorageKeyComponent(key.slice(prefix.length));
    if (workflowId === null || excludeWorkflowIds.has(workflowId)) continue;
    candidates.push(workflowId);
  }
  return candidates;
}

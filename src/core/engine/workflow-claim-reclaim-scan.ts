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
 * **Ownerless-but-running workflows.** The holder-keyed scan above misses a
 * real rolling-deploy shape: an incoming engine boots and runs its
 * `recoverAll()` sweep WHILE an outgoing engine is still the live holder of
 * some workflow — recovery correctly skips it, since the holder is not yet
 * expired. If the outgoing engine then disposes gracefully, its
 * `releaseAll()` DELETES that workflow's `wf-owner-holder:<id>` record
 * (per the ADR's `release` row — the epoch is retained, only the holder
 * goes). The workflow is now `running` in `WorkflowState` with no holder at
 * all, and the holder-keyed scan above will never find it again — there is
 * no `wf-owner-holder:<id>` key left to enumerate. The already-running
 * incoming engine has nothing further to trigger a re-scan, so the workflow
 * is stranded until an operator explicitly calls `recoverAll()`/`resume()`.
 * This module closes that gap with a second scan over the `running`-status
 * workflow-visibility index (`wf-idx-status:running:`), checking each
 * candidate's holder key fresh and including only the genuinely holderless
 * ones — bounded to the same cost class as the holder-keyed scan (one extra
 * index prefix scan per pass, plus one point read per running-and-holderless
 * candidate).
 *
 * @module core/engine/workflow-claim-reclaim-scan
 */

import { KEYS, tryDecodeStorageKeyComponent, type Storage } from '../../storage/interface.ts';

const RUNNING_STATUS = 'running';

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
async function listHolderScanCandidates(
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

/**
 * List every `running`-status workflow id (from the workflow-visibility
 * index) that currently has NO `wf-owner-holder:<id>` record at all —
 * the "ownerless-but-running" shape described in the module doc above.
 * `seen`/`excludeWorkflowIds` skip ids already returned by
 * {@link listHolderScanCandidates} or already held by this engine, so the
 * per-candidate holder read below only ever runs for a workflow this pass
 * has not already classified.
 */
async function listOwnerlessRunningCandidates(
  storage: Storage,
  excludeWorkflowIds: ReadonlySet<string>,
  seen: ReadonlySet<string>,
): Promise<string[]> {
  const prefix = KEYS.workflowVisibilityStatus(RUNNING_STATUS, '');
  const candidates: string[] = [];
  for await (const [key] of storage.scan(prefix)) {
    const workflowId = tryDecodeStorageKeyComponent(key.slice(prefix.length));
    if (
      workflowId === null ||
      excludeWorkflowIds.has(workflowId) ||
      seen.has(workflowId) ||
      candidates.includes(workflowId)
    ) {
      continue;
    }
    const holderBytes = await storage.get(KEYS.workflowOwnerHolder(workflowId));
    if (holderBytes !== null) continue; // has a holder — the scan above already covers it if eligible.
    candidates.push(workflowId);
  }
  return candidates;
}

/**
 * Full candidate discovery for one reclaim-scan pass: every workflow id with
 * a currently-persisted holder record, plus every `running`-status workflow
 * id with NO holder record at all (see the module doc's "Ownerless-but-running
 * workflows" section), excluding `excludeWorkflowIds` from both.
 */
export async function listWorkflowClaimReclaimCandidates(
  storage: Storage,
  excludeWorkflowIds: ReadonlySet<string>,
): Promise<string[]> {
  const holderCandidates = await listHolderScanCandidates(storage, excludeWorkflowIds);
  const ownerlessCandidates = await listOwnerlessRunningCandidates(
    storage,
    excludeWorkflowIds,
    new Set(holderCandidates),
  );
  return [...holderCandidates, ...ownerlessCandidates];
}

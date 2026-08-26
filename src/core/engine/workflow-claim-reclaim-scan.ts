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
 * **Workflows with no visibility-index entry at all (WFT-79 Finding 2).**
 * The index-based scan above is itself incomplete on a Bun SQLite deployment
 * that predates the workflow visibility indexes and has not yet run the
 * one-time backfill (see
 * [Workflow Visibility Backfill](../../../documentation/guides/workflow-visibility-backfill.md)):
 * such a workflow has no `wf-idx-status:running:<id>` row to enumerate. If
 * that workflow is the outgoing engine's live holder at the moment an
 * incoming engine's `recoverAll()` sweep runs, recovery correctly skips it
 * (the holder is not yet expired); if the outgoing engine then disposes
 * gracefully, `releaseAll()` deletes the holder record and the workflow is
 * left `running` with no holder AND no visibility-index entry — invisible to
 * both scans above. Left there, it is stranded indefinitely: nothing else
 * re-scans for it.
 *
 * This module closes that second gap with a bounded, cursor-rotated fallback
 * scan directly over the authoritative `wf:<id>` workflow records (the same
 * source `recoverAll()`'s own preflight already scans at boot — see
 * `lifecycle/transition.ts`'s `preflightRecoverAll`), decoding each record
 * and including only genuinely holderless `running` ones not already found
 * by either scan above. This IS a store-wide operation and therefore more
 * expensive than the index-based scans, so it is bounded per pass to
 * {@link WORKFLOW_CLAIM_RECLAIM_AUTHORITATIVE_SCAN_LIMIT} records rather than
 * scanning the entire keyspace on every call. A per-storage cursor (advanced
 * past the last key read, and wrapped back to the start once a pass reaches
 * the end of the keyspace) rotates the scanned window across passes, so a
 * store with more un-backfilled workflows than the per-pass limit still gets
 * full coverage over several reclaim-scan passes rather than only ever
 * re-scanning the same lexicographically-first window. This fallback is
 * expected to do genuine work only on deployments that have not yet run the
 * visibility backfill; run that backfill to eliminate this scan's ongoing
 * cost entirely.
 *
 * @module core/engine/workflow-claim-reclaim-scan
 */

import { KEYS, tryDecodeStorageKeyComponent, type Storage } from '../../storage/interface.ts';
import { decodeWorkflowState } from './validation.ts';

const RUNNING_STATUS = 'running';

/**
 * Per-pass bound on the authoritative-record fallback scan
 * ({@link listOwnerlessRunningCandidatesFromAuthoritativeRecords}). This
 * fallback is a store-wide scan, unlike the two index-based scans above, so
 * it is capped rather than run to exhaustion on every pass — see the module
 * doc's "Workflows with no visibility-index entry at all" section for why
 * the cap is safe (a per-storage cursor rotates the scanned window across
 * passes, so a store with more un-backfilled workflows than this limit still
 * gets full coverage over several passes).
 */
export const WORKFLOW_CLAIM_RECLAIM_AUTHORITATIVE_SCAN_LIMIT = 500;

/**
 * Per-storage scan cursor for
 * {@link listOwnerlessRunningCandidatesFromAuthoritativeRecords}, keyed by
 * `Storage` instance so distinct engines/stores (and distinct tests, each
 * constructing a fresh `Storage`) never share scan position. `undefined`
 * means "start from the beginning of the `wf:` keyspace".
 */
const authoritativeScanCursors = new WeakMap<Storage, string | undefined>();

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
 * List every `running`-status workflow id discovered by a bounded scan
 * directly over the authoritative `wf:<id>` workflow records, that currently
 * has NO `wf-owner-holder:<id>` record — the "no visibility-index entry at
 * all" shape described in the module doc's "Workflows with no
 * visibility-index entry at all" section. This is the fallback for a
 * workflow the two index-based scans above cannot see because it predates
 * the visibility-index backfill.
 *
 * Bounded to {@link WORKFLOW_CLAIM_RECLAIM_AUTHORITATIVE_SCAN_LIMIT} records
 * read per call via a per-storage cursor in {@link authoritativeScanCursors}:
 * the scan resumes just past the last key it read last time, and wraps back
 * to the start of the `wf:` keyspace once a call reads fewer than the limit
 * (proof it reached the end). `seen`/`excludeWorkflowIds` skip ids already
 * classified by an earlier scan in this same pass, and a record that fails
 * to decode, or is a workflow-adjacent record sharing the `wf:` prefix
 * (checkpoint, timeline) rather than a workflow-state record itself, is
 * skipped rather than surfaced.
 */
/**
 * Decide whether one `wf:`-prefixed scan entry is a genuinely holderless,
 * `running`-status workflow record this pass should surface as a candidate.
 * Extracted from {@link listOwnerlessRunningCandidatesFromAuthoritativeRecords}
 * purely to keep that function's cyclomatic complexity within the
 * repository's lint ceiling — the classification logic itself is unchanged.
 */
async function classifyAuthoritativeScanEntry(
  storage: Storage,
  prefix: string,
  key: string,
  value: Uint8Array,
  excludeWorkflowIds: ReadonlySet<string>,
  seen: ReadonlySet<string>,
  alreadyCollected: ReadonlySet<string>,
): Promise<string | null> {
  const workflowId = tryDecodeStorageKeyComponent(key.slice(prefix.length));
  if (workflowId === null) return null;
  // Reject workflow-adjacent records (checkpoint, timeline) that share the
  // `wf:` prefix by requiring the key match the exact workflow-record key
  // for the decoded id — cheaper and more robust than a suffix denylist.
  if (KEYS.workflow(workflowId) !== key) return null;
  if (
    excludeWorkflowIds.has(workflowId) ||
    seen.has(workflowId) ||
    alreadyCollected.has(workflowId)
  ) {
    return null;
  }

  let status: string;
  try {
    status = decodeWorkflowState(value).status;
  } catch {
    return null; // Undecodable record — not this scan's job to surface.
  }
  if (status !== RUNNING_STATUS) return null;

  const holderBytes = await storage.get(KEYS.workflowOwnerHolder(workflowId));
  if (holderBytes !== null) return null; // has a holder — an index-based scan already covers it if eligible.
  return workflowId;
}

async function listOwnerlessRunningCandidatesFromAuthoritativeRecords(
  storage: Storage,
  excludeWorkflowIds: ReadonlySet<string>,
  seen: ReadonlySet<string>,
): Promise<string[]> {
  const prefix = KEYS.workflow('');
  const cursor = authoritativeScanCursors.get(storage);
  const scanOptions =
    cursor === undefined
      ? { limit: WORKFLOW_CLAIM_RECLAIM_AUTHORITATIVE_SCAN_LIMIT }
      : { limit: WORKFLOW_CLAIM_RECLAIM_AUTHORITATIVE_SCAN_LIMIT, gt: cursor };

  const candidates: string[] = [];
  const collected = new Set<string>();
  let scannedCount = 0;
  let lastKey: string | undefined;
  for await (const [key, value] of storage.scan(prefix, scanOptions)) {
    scannedCount += 1;
    lastKey = key;

    const workflowId = await classifyAuthoritativeScanEntry(
      storage,
      prefix,
      key,
      value,
      excludeWorkflowIds,
      seen,
      collected,
    );
    if (workflowId === null) continue;
    collected.add(workflowId);
    candidates.push(workflowId);
  }

  // Advance the cursor past the last key read; wrap to the start once a call
  // reads fewer than the limit (the end of the `wf:` keyspace was reached).
  authoritativeScanCursors.set(
    storage,
    scannedCount < WORKFLOW_CLAIM_RECLAIM_AUTHORITATIVE_SCAN_LIMIT ? undefined : lastKey,
  );
  return candidates;
}

/**
 * Full candidate discovery for one reclaim-scan pass: every workflow id with
 * a currently-persisted holder record, every `running`-status workflow id
 * with NO holder record at all found via the visibility index (see the
 * module doc's "Ownerless-but-running workflows" section), and every
 * `running`-status, holderless workflow id found by the bounded
 * authoritative-record fallback for workflows with no visibility-index entry
 * at all (see the module doc's "Workflows with no visibility-index entry at
 * all" section) — excluding `excludeWorkflowIds` from all three.
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
  const authoritativeFallbackCandidates =
    await listOwnerlessRunningCandidatesFromAuthoritativeRecords(
      storage,
      excludeWorkflowIds,
      new Set([...holderCandidates, ...ownerlessCandidates]),
    );
  return [...holderCandidates, ...ownerlessCandidates, ...authoritativeFallbackCandidates];
}

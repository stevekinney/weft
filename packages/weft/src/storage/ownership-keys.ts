/**
 * Storage key builders for per-workflow ownership claims.
 *
 * These are spread into `KEYS` in `interface.ts` rather than declared there, so
 * the ownership keyspace can carry its full rationale without pushing that
 * file's documented line ceiling. Callers still reach them through `KEYS`, which
 * keeps one import contract for storage keys.
 *
 * The keyspace backs `ownership: 'workflow-lease'`, specified in
 * [ADR 0002](../../documentation/contributing/architecture-decisions/0002-multiengine-per-workflow-ownership.md).
 *
 * @module storage/ownership-keys
 */

import { encodeStorageKeyComponent } from './key-encoding.ts';

/**
 * Per-workflow ownership claim keys plus the store-wide ownership-mode marker.
 *
 * Spread into `KEYS`; not intended to be imported directly by engine code.
 */
export const OWNERSHIP_CLAIM_KEYS = {
  /**
   * The per-workflow fencing epoch. Holds an 8-byte big-endian uint64, encoded
   * exactly like `KEYS.leaseEpoch` so both fencing tokens share a representation.
   *
   * Changes on `acquire`, on `takeover`, and on any external terminal transition
   * (cancel, timeout, suspend, purge) — rotation there is what deposes a
   * still-running owner, whose next write then loses its precondition.
   *
   * Unlike the global lease epoch this key is **permanently retained**: never
   * deleted by release, purge, retention, or a mode downgrade. Retention is what
   * makes the token ABA-safe across workflow-id reuse via
   * `onTerminalConflict: 'start-new'`, because the counter is never reset and a
   * stale owner's cached epoch can never coincide with a later generation's.
   */
  workflowOwnerEpoch: (workflowId: string): string =>
    `wf-owner-epoch:${encodeStorageKeyComponent(workflowId)}`,
  /**
   * The current per-workflow claim holder, a JSON
   * `{ engineId, epoch, expiresAt, claimedAt }`.
   *
   * Its bytes churn on every renewal, so it must NOT be used as the fencing
   * token — that is `workflowOwnerEpoch`, kept separate for exactly the reason
   * `leaseEpoch` is kept separate from `leaseHolder`. Deleted at terminal or
   * suspend commit and as a best-effort graceful-shutdown release, but never at
   * ordinary park, so a workflow parked on a sleep or a signal keeps its claim.
   */
  workflowOwnerHolder: (workflowId: string): string =>
    `wf-owner-holder:${encodeStorageKeyComponent(workflowId)}`,
  /**
   * The store-wide ownership-mode marker, a JSON `{ mode, establishedAt }`.
   *
   * Stamped by the first fencing-mode engine to construct against a store and
   * compared by every later one. It is what makes `ownership: 'lease'` and
   * `ownership: 'workflow-lease'` mutually exclusive across processes rather
   * than only within a single process. `ownership: 'none'` engines never touch it.
   */
  ownershipModeMarker: (): string => 'ownership-mode-marker',
} as const;

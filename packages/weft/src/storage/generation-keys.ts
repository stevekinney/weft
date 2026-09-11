/**
 * Storage key builder for the durable per-workflow-id generation counter
 * (WFT-153).
 *
 * This is spread into `KEYS` in `interface.ts` rather than declared there, so
 * it can carry its full rationale without pushing that file's documented line
 * ceiling. Callers still reach it through `KEYS`, which keeps one import
 * contract for storage keys.
 *
 * @module storage/generation-keys
 */

import { encodeStorageKeyComponent } from './key-encoding.ts';

/**
 * A monotonic per-workflow-id generation counter, spread into `KEYS`; not
 * intended to be imported directly by engine code.
 *
 * `wf-gen:<id>` closes the explicit-id start fence's pre-CAS ABA (WFT-153,
 * following WFT-152): `start-terminal-conflict-purge.ts`'s duplicate-id
 * `conditionalBatch` precondition compares the observed `wf:<id>` VALUE, so
 * it cannot tell "this id was never used" from "a run existed here and was
 * purged" — if a racing winner completes and is purged before a slower
 * loser's batch commits, `wf:<id>` looks absent again and both starts
 * execute. This counter is bumped in the SAME atomic batch that deletes
 * `wf:<id>` on purge (`engine.purge()` and the retention sweep, plus a
 * `onTerminalConflict: 'start-new'` restart's own displacing purge), so a
 * duplicate-id start's `conditionalBatch` can carry an ADDITIONAL condition
 * on the exact generation bytes it observed — a purge in the read-to-commit
 * gap changes this key even though `wf:<id>` reads the same, so the stale
 * loser's condition fails where a value-only comparison could not detect it.
 *
 * Like `wf-owner-epoch:<id>` (`ownership-keys.ts`), which is the precedent
 * this key's mechanism and permanence both follow, this key is
 * **permanently retained**: never deleted by release, purge, retention, or a
 * mode downgrade. Retention is what makes the fence ABA-safe across
 * unbounded id reuse — the counter is never reset, so a stale reader's
 * captured value can never coincide with a later generation's.
 *
 * Unlike `wf-owner-epoch`, which is written only under
 * `ownership: 'workflow-lease'`, this key is written under EVERY ownership
 * mode (`'none'`, `'lease'`, `'workflow-lease'`): the ABA hole this closes
 * exists whenever an explicit-id start can race a purge, which has nothing
 * to do with per-workflow claim fencing — `'none'` and `'lease'` have no
 * epoch condition on the workflow record at all today.
 *
 * Encoded exactly like `wf-owner-epoch` — an 8-byte big-endian uint64 via
 * `encodeGeneration`/`decodeGeneration` (`core/engine/generation-codec.ts`,
 * which re-exports `lease-codec.ts`'s `encodeEpoch`/`decodeEpoch` under
 * generation-specific names) — so both permanently-retained monotonic
 * counters share one representation and one validity range.
 */
export const GENERATION_KEYS = {
  workflowGeneration: (workflowId: string): string =>
    `wf-gen:${encodeStorageKeyComponent(workflowId)}`,
} as const;

/**
 * The mechanical CAS-delete primitive `WorkflowCatalog.remove()` delegates
 * to, plus the tombstone primitives that make its own resolution
 * (restore-or-finalize) atomic too. Split into its own module to protect
 * `workflow-catalog.ts`'s size against the repository's 500-line
 * implementation-file ceiling — mirrors how `storage-io.ts`/`codec.ts`
 * already sit alongside `workflow-catalog.ts` rather than inline in it.
 *
 * Fences the delete on BOTH the exact entry bytes read AND the exact active
 * pointer bytes read, in one `conditionalBatch` — not entry bytes alone.
 * Between an in-memory "is this the active revision" check and the delete,
 * a concurrent `activateCandidate`/`activateRegistered` call (this process
 * or another sharing the same durable store) could make the target revision
 * active; fencing the active-pointer key too means that race loses the CAS
 * and surfaces as `'conflict'` (the caller re-decides) instead of silently
 * deleting a revision that became active a moment before the delete landed.
 *
 * Single-shot — no retry loop, matching `activateCandidate`'s own
 * no-retry-caller-decides precedent, since a removal decision (unlike
 * `activateRegistered`'s unconditional retry) already depends on reference
 * counts computed by the caller and should not blindly re-attempt against
 * possibly-stale counts.
 *
 * WFT-17/18 (Codex review, PR #958): a bare delete of the entry key, with
 * `removeWorkflowRevision`'s own reference re-check and possible restore as
 * a SEPARATE, later commit, left a crash window between the two commits
 * where the entry was durably gone but a run still referenced it, with NO
 * durable record of what was deleted for ANY process — including the one
 * that crashed — to recover from. {@link removeCatalogEntry} now writes a
 * `catalog-tombstone:<name>:<revision>` record (the exact deleted entry
 * bytes) in the SAME `conditionalBatch` as the delete, so "the entry is
 * gone" and "a durable record of what it was" land atomically together.
 * {@link finalizeCatalogTombstone} and {@link restoreCatalogEntryFromTombstone}
 * are the two possible resolutions, each its own single-CAS atomic
 * operation conditioned on the tombstone's exact bytes — so a concurrent
 * second attempt at resolving the SAME tombstone (this process retrying, or
 * `catalog-readiness.ts`'s boot-time sweep racing a live caller) loses its
 * CAS harmlessly rather than double-processing. Orphan resolution (a
 * tombstone left behind by a process that crashed between the delete and
 * its own resolution) is `resolveOrphanedCatalogTombstones` in
 * `core/engine/catalog-tombstone-recovery.ts` — deliberately OUTSIDE
 * `core/catalog/**`, not alongside these primitives, because it needs
 * `core/engine/nonterminal-revision-count.ts`'s durable non-terminal-run
 * scan and `core/catalog/**` never imports from `core/engine/**` (a
 * directional boundary `check-import-cycles.ts` enforces); see that
 * module's doc for why it lives there.
 *
 * @module core/catalog/removal
 */

import { KEYS, storageConditionalBatch, type Storage } from '../../storage/interface.ts';
import { decodeActivePointer } from './codec.ts';

/**
 * Decode `catalog-removal-generation:<name>:<revision>`'s current bytes into
 * a count — `null` (never removed) decodes as `0`. Bytes are the decimal
 * ASCII text of the count (`TextEncoder`-encoded), not a binary integer —
 * simplest deterministic encoding for a value only ever compared byte-for-byte
 * (`storageConditionalBatch`) or round-tripped through this exact
 * encode/decode pair; nothing else in the codebase ever needs to sort or
 * range-scan it. Throws on bytes that do not decode as a non-negative safe
 * integer — this counter is Weft's own durable bookkeeping, written only by
 * {@link removeCatalogEntry} below, so corrupt bytes are storage corruption,
 * not hostile input; fails closed rather than silently restarting the
 * counter at `0`, which would let a stale fenced install past a removal it
 * should have been fenced against.
 */
function decodeRemovalGeneration(bytes: Uint8Array | null): number {
  if (bytes === null) return 0;
  const text = new TextDecoder().decode(bytes);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(
      `The store's catalog removal-generation counter bytes ("${text}") do not decode as a ` +
        'non-negative integer. This counter is Weft-owned durable bookkeeping, never written by ' +
        'any other producer, so corrupt bytes indicate storage corruption. Resolve by operator ' +
        'repair: inspect the stored bytes and, only if certain no removal is actually pending ' +
        'reconciliation against this counter, delete the key so it restarts at 0.',
    );
  }
  return parsed;
}

/** Encode a removal-generation count for durable storage — see {@link decodeRemovalGeneration}. */
function encodeRemovalGeneration(generation: number): Uint8Array {
  return new TextEncoder().encode(String(generation));
}

/** Outcome of {@link removeCatalogEntry}. */
export type WorkflowCatalogRemovalOutcome =
  | Readonly<{ outcome: 'removed'; tombstoneBytes: Uint8Array }>
  | Readonly<{ outcome: 'not-found' }>
  | Readonly<{ outcome: 'active'; activeRevision: string }>
  | Readonly<{ outcome: 'conflict' }>;

/**
 * Durably delete the installed-revision record for `(name, revision)`,
 * atomically replacing it with a tombstone carrying the deleted bytes (see
 * this module's doc for why).
 *
 * Reads the current `catalog-entry:<name>:<revision>` bytes; `null` is
 * `'not-found'` (a no-op — the caller may already believe the revision is
 * gone). Reads the current `catalog-active:<name>` bytes and refuses with
 * `'active'` when they decode to exactly this revision — a structural
 * invariant independent of reference counts, since every future or
 * resuming run resolves the active pointer, not a specific installed
 * entry. Otherwise deletes the entry key, puts the tombstone key (CAS'd
 * on the tombstone being absent — a stale leftover from a previous,
 * unresolved removal of this exact `(name, revision)` is a durable-store
 * inconsistency this fails closed on rather than silently overwriting), and
 * bumps the durable `catalog-removal-generation:<name>:<revision>` counter
 * by exactly 1 (WFT-21, item Q7jH — see `KEYS.catalogRemovalGeneration`'s
 * own doc) via ONE `conditionalBatch`, also CAS'd on the exact entry bytes
 * AND the exact active-pointer bytes read above (present as a no-op
 * `put`-free precondition when active-pointer bytes are `null` — never
 * activated) AND the counter's own exact bytes read above. A CAS loss (any
 * of the four keys changed concurrently) surfaces as `'conflict'`. Unlike
 * the tombstone, the counter is never deleted — it outlives this removal's
 * own resolution (restore or finalize) so a caller that fenced an
 * in-flight `WorkflowCatalog.install()` against its pre-removal value stays
 * fenced even after the tombstone itself is gone.
 */
export async function removeCatalogEntry(
  storage: Storage,
  name: string,
  revision: string,
): Promise<WorkflowCatalogRemovalOutcome> {
  const entryKey = KEYS.catalogEntry(name, revision);
  const entryBytes = await storage.get(entryKey);
  if (entryBytes === null) {
    return { outcome: 'not-found' };
  }

  const activeKey = KEYS.catalogActive(name);
  const activeBytes = await storage.get(activeKey);
  const activePointer = activeBytes === null ? null : decodeActivePointer(activeBytes);
  if (activePointer !== null && activePointer.revision === revision) {
    return { outcome: 'active', activeRevision: activePointer.revision };
  }

  const tombstoneKey = KEYS.catalogTombstone(name, revision);
  const removalGenerationKey = KEYS.catalogRemovalGeneration(name, revision);
  const removalGenerationBytes = await storage.get(removalGenerationKey);
  const nextRemovalGenerationBytes = encodeRemovalGeneration(
    decodeRemovalGeneration(removalGenerationBytes) + 1,
  );

  const applied = await storageConditionalBatch(
    storage,
    [
      { key: entryKey, expectedValue: entryBytes },
      { key: activeKey, expectedValue: activeBytes },
      { key: tombstoneKey, expectedValue: null },
      { key: removalGenerationKey, expectedValue: removalGenerationBytes },
    ],
    [
      { type: 'delete', key: entryKey },
      { type: 'put', key: tombstoneKey, value: entryBytes },
      { type: 'put', key: removalGenerationKey, value: nextRemovalGenerationBytes },
    ],
  );

  return applied ? { outcome: 'removed', tombstoneBytes: entryBytes } : { outcome: 'conflict' };
}

/**
 * Resolve an outstanding tombstone by completing the removal: CAS-delete
 * the `catalog-tombstone:<name>:<revision>` key, conditioned on its exact
 * bytes still being `tombstoneBytes`. Returns `false` (a harmless no-op for
 * the caller, not an error) when the tombstone was already resolved by
 * someone else — this same process re-driving after a transient failure,
 * or a concurrent boot-time sweep on another process.
 */
export async function finalizeCatalogTombstone(
  storage: Storage,
  name: string,
  revision: string,
  tombstoneBytes: Uint8Array,
): Promise<boolean> {
  const tombstoneKey = KEYS.catalogTombstone(name, revision);
  return storageConditionalBatch(
    storage,
    [{ key: tombstoneKey, expectedValue: tombstoneBytes }],
    [{ type: 'delete', key: tombstoneKey }],
  );
}

/**
 * Resolve an outstanding tombstone by restoring the entry: ONE
 * `conditionalBatch` that both re-`put`s the `catalog-entry:<name>:<revision>`
 * key (byte-identical to what {@link removeCatalogEntry} deleted — the
 * tombstone bytes ARE the entry bytes) and deletes the tombstone key,
 * conditioned on the tombstone's exact bytes still being `tombstoneBytes`.
 * Atomic by construction — there is no intermediate durable state where the
 * entry is back but the tombstone still claims a removal is in flight, or
 * vice versa. Returns `false` (harmless no-op) when the tombstone was
 * already resolved by someone else.
 */
export async function restoreCatalogEntryFromTombstone(
  storage: Storage,
  name: string,
  revision: string,
  tombstoneBytes: Uint8Array,
): Promise<boolean> {
  const entryKey = KEYS.catalogEntry(name, revision);
  const tombstoneKey = KEYS.catalogTombstone(name, revision);
  return storageConditionalBatch(
    storage,
    [{ key: tombstoneKey, expectedValue: tombstoneBytes }],
    [
      { type: 'put', key: entryKey, value: tombstoneBytes },
      { type: 'delete', key: tombstoneKey },
    ],
  );
}

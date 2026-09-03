/**
 * The mechanical CAS-delete primitive `WorkflowCatalog.remove()` delegates
 * to. Split into its own module to protect `workflow-catalog.ts`'s size
 * against the repository's 500-line implementation-file ceiling — mirrors
 * how `storage-io.ts`/`codec.ts` already sit alongside `workflow-catalog.ts`
 * rather than inline in it.
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
 * @module core/catalog/removal
 */

import { KEYS, storageConditionalBatch, type Storage } from '../../storage/interface.ts';
import { decodeActivePointer } from './codec.ts';

/** Outcome of {@link removeCatalogEntry}. */
export type WorkflowCatalogRemovalOutcome =
  | Readonly<{ outcome: 'removed' }>
  | Readonly<{ outcome: 'not-found' }>
  | Readonly<{ outcome: 'active'; activeRevision: string }>
  | Readonly<{ outcome: 'conflict' }>;

/**
 * Durably delete the installed-revision record for `(name, revision)`.
 *
 * Reads the current `catalog-entry:<name>:<revision>` bytes; `null` is
 * `'not-found'` (a no-op — the caller may already believe the revision is
 * gone). Reads the current `catalog-active:<name>` bytes and refuses with
 * `'active'` when they decode to exactly this revision — a structural
 * invariant independent of reference counts, since every future or
 * resuming run resolves the active pointer, not a specific installed
 * entry. Otherwise deletes the entry key via a `conditionalBatch` CAS'd on
 * BOTH the exact entry bytes AND the exact active-pointer bytes read above
 * (present as a no-op `put`-free precondition when active-pointer bytes
 * are `null` — never activated). A CAS loss (either key changed
 * concurrently) surfaces as `'conflict'`.
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

  const applied = await storageConditionalBatch(
    storage,
    [
      { key: entryKey, expectedValue: entryBytes },
      { key: activeKey, expectedValue: activeBytes },
    ],
    [{ type: 'delete', key: entryKey }],
  );

  return applied ? { outcome: 'removed' } : { outcome: 'conflict' };
}

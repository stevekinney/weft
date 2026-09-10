/**
 * Storage key builders for the durable workflow catalog (WFT-9/WFT-10).
 *
 * Spread into `KEYS` in `interface.ts` rather than declared there, mirroring
 * `ownership-keys.ts`'s pattern — the catalog keyspace can carry its full
 * rationale without pushing `interface.ts` past its documented line ceiling.
 * Callers reach these through `KEYS`, which keeps one import contract for
 * storage keys.
 *
 * `catalog-entry:<name>:<revision>` is one immutable record per installed
 * `(name, revision)` pair, never overwritten once written. `catalog-active:<name>`
 * is the single mutable `{ revision, generation, activatedAt }` pointer per
 * workflow name, written only through `conditionalBatch` CAS — the exact
 * store-wide-singleton precedent `ownership-mode-marker.ts` establishes for
 * `KEYS.ownershipModeMarker()`.
 *
 * @module storage/catalog-keys
 */

import { encodeStorageKeyComponent } from './key-encoding.ts';

/**
 * Workflow catalog key builders. Spread into `KEYS`; not intended to be
 * imported directly by engine code.
 */
export const WORKFLOW_CATALOG_KEYS = {
  /**
   * One immutable installed-revision record for `name`. The initial write
   * IS `conditionalBatch` CAS-guarded ({@link import('../core/catalog/storage-io.ts').writeCatalogEntry}),
   * not a plain `put` — a caller-supplied, non-content-derived `revision`
   * (`buildWorkflowRevisionManifest`'s `options.revision` escape hatch)
   * means two racing writers are not guaranteed to agree on this key's
   * content, so the write must fail closed on a genuine conflict rather than
   * last-write-win. This key is also deleted, CAS-guarded on its own exact
   * bytes, by `removeCatalogEntry` (WFT-12) once a revision is no longer
   * active and no longer referenced.
   */
  catalogEntry: (name: string, revision: string): string =>
    `catalog-entry:${encodeStorageKeyComponent(name)}:${encodeStorageKeyComponent(revision)}`,
  /** Scan prefix for every installed revision of `name`. */
  catalogEntryPrefix: (name: string): string => `catalog-entry:${encodeStorageKeyComponent(name)}:`,
  /**
   * The active-revision pointer for `name`: a single mutable
   * `{ revision, generation, activatedAt }` record, written only through
   * `conditionalBatch` — the same CAS/store-wide-singleton precedent
   * `KEYS.ownershipModeMarker()` uses.
   */
  catalogActive: (name: string): string => `catalog-active:${encodeStorageKeyComponent(name)}`,
  /**
   * A durable, transient marker for a `(name, revision)` catalog entry
   * mid-removal (WFT-17/18): `removeCatalogEntry` puts this key — value is
   * the exact `catalog-entry:<name>:<revision>` bytes it just deleted — in
   * the SAME `conditionalBatch` as the entry delete, so "the entry is gone"
   * and "a durable record of what it was" land atomically together. A
   * process that crashes between that commit and the removal's own
   * post-delete reference re-check leaves this key behind as the ONLY
   * durable evidence a removal was in flight; `catalog-readiness.ts`'s
   * boot-time restore sweeps every `catalog-tombstone:` key and resolves
   * each one (restore the entry, or finalize the removal) from a FRESH
   * reference count, so no process — not just the one that crashed — is
   * needed to complete it. Present only for the brief window between the
   * delete committing and its own resolution (normally sub-millisecond,
   * same call); never present after a clean `removed`/`referenced` outcome.
   */
  catalogTombstone: (name: string, revision: string): string =>
    `catalog-tombstone:${encodeStorageKeyComponent(name)}:${encodeStorageKeyComponent(revision)}`,
  /** Scan prefix for every in-flight removal tombstone (should normally be empty). */
  catalogTombstonePrefix: (): string => `catalog-tombstone:`,
} as const;

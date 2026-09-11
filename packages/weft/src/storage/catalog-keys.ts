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
  /**
   * A durable, PERMANENT (never deleted) monotonic removal-generation
   * counter for one `(name, revision)` catalog entry (WFT-21, Codex review
   * round 14, P1 item Q7jH). Absent means "never removed" (generation 0);
   * `removeCatalogEntry` bumps it by exactly 1 in the SAME `conditionalBatch`
   * as the entry delete and tombstone put — so it survives past
   * `finalizeCatalogTombstone`'s own delete of the (transient) tombstone key,
   * unlike `catalogTombstone` itself.
   *
   * This is a NEW, additive reserved key family — no schema-version bump,
   * matching the WFT-9/WFT-10 precedent for `catalog-entry:`/`catalog-active:`
   * and the WFT-17/WFT-18 precedent for `catalog-tombstone:` itself: every
   * durable record this codebase persists is either a wholly new key family
   * (safe for an older reader, which simply never scans it) or an in-place
   * field addition to an existing record (guarded by the reader's own
   * structural validator). A durable generation counter that outlives the
   * tombstone closes the residual window the tombstone alone left open: a
   * dynamic-source load that began BEFORE a removal, and only calls
   * `catalog.install()` AFTER that removal's `finalizeCatalogTombstone()`
   * has already deleted the tombstone, would otherwise see both the entry
   * key and the tombstone key as `null` — indistinguishable from "never
   * installed" — and resurrect the just-removed revision. `WorkflowCatalog.install()`'s
   * loader callers (`runSharedSourceLoad`, `source-resolution.ts`) capture
   * this counter's bytes before invoking the loader and pass them through as
   * an install fence; the durable write additionally CAS-guards on the
   * counter still reading those exact bytes, so any removal that landed
   * during the load — even one whose tombstone has already resolved —
   * fails the fenced install closed instead of resurrecting stale content.
   * `engine.register()`'s drain path and a deliberate direct
   * `engine.workflows.install()` reinstall both omit the fence (no prior
   * observation to be stale against), so a genuine, caller-intended reinstall
   * after removal still succeeds and implicitly advances past whatever the
   * counter currently reads.
   */
  catalogRemovalGeneration: (name: string, revision: string): string =>
    `catalog-removal-generation:${encodeStorageKeyComponent(name)}:${encodeStorageKeyComponent(revision)}`,
} as const;

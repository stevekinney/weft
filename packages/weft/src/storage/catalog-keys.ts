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
   * One immutable installed-revision record for `name`. Written once via a
   * plain durable `put` — racing writers writing IDENTICAL bytes to this key
   * is safe (content-addressed by `(name, revision)`); the in-memory
   * conflict check in `WorkflowCatalog.install()` catches the
   * differing-content case before any write is attempted, so this key never
   * needs CAS protection.
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
} as const;

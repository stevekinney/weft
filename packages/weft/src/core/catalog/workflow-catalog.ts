/**
 * `WorkflowCatalog` — the immutable-entry, durable workflow catalog
 * (WFT-9/WFT-10).
 *
 * In-memory state is `Map<string, Map<string, WorkflowCatalogEntry>>` for
 * installed entries and `Map<string, WorkflowCatalogActivePointer>` for each
 * name's active pointer — nested maps, never delimiter-joined keys, so a
 * workflow `name` or `revision` equal to `'__proto__'`/`'toString'` or
 * containing a colon is always handled correctly.
 *
 * Two activation entry points exist, matching WFT-9/WFT-10's distinct
 * producers:
 *
 * - {@link WorkflowCatalog.activateRegistered} — unconditional, used
 *   exclusively by `engine.register()`'s drain path
 *   (`core/engine/catalog-readiness.ts`). Never consults
 *   `checkWorkflowCompatibility`; always wins via a bounded 5-attempt CAS
 *   retry loop, since registering a different version of an
 *   already-registered workflow must never hard-fail construction or
 *   registration (the `version-mismatch-recovery.test.ts` precedent).
 *   "Unconditional" is about bypassing `checkWorkflowCompatibility`, not
 *   immunity to failure in general: sustained contention can still exhaust
 *   the retry and throw {@link WorkflowCatalogActivationConflictError},
 *   which propagates out of `ensureWorkflowCatalogReady` and fails
 *   `Engine.create()` itself (safely — disposing the half-booted engine).
 * - {@link WorkflowCatalog.activateCandidate} — the guarded primitive:
 *   `checkWorkflowCompatibility`-gated, single-shot CAS (no retry — the
 *   caller decides whether to re-read and retry), refuses on incompatibility
 *   or a stale expected generation. Reachable via `engine.workflows.activate()`.
 *   Because a multi-writer caller can activate a revision this process's
 *   `#entries` cache never observed, the compatibility check reads through
 *   to durable storage rather than trusting the cache.
 *
 * @module core/catalog/workflow-catalog
 */

import {
  KEYS,
  requireStorageCapability,
  storageConditionalBatch,
  type Storage,
} from '../../storage/interface.ts';
import { compareCodepoint } from '../compare-codepoint.ts';
import type { WorkflowRevisionManifest } from '../contract/types.ts';
import { validateWorkflowOrActivityName } from '../types/name-grammar.ts';
import type { RegisteredWorkflowDefinition } from '../types/workflow-registry.ts';
import {
  refuseIncompatibleOrStaleCandidate,
  type ActivateCandidateOptions,
} from './activation-guards.ts';
import { encodeActivePointer, manifestsAreByteIdentical } from './codec.ts';
import {
  WorkflowCatalogActivationConflictError,
  WorkflowCatalogConflictError,
  WorkflowRevisionNotInstalledError,
} from './errors.ts';
import { removeCatalogEntry, type WorkflowCatalogRemovalOutcome } from './removal.ts';
import {
  readActivePointer,
  readCatalogEntry,
  revalidateCachedCatalogInstall,
  scanCatalogEntriesForName,
  throwForAbsentCatalogInstallRace,
  writeCatalogEntry,
  type CatalogInstallFence,
  type RestoredWorkflowCatalogState,
} from './storage-io.ts';
import type {
  WorkflowCatalogActivationResult,
  WorkflowCatalogActivePointer,
  WorkflowCatalogEntry,
  WorkflowRevisionRecord,
} from './types.ts';

/** Bounded CAS retry budget for {@link WorkflowCatalog.activateRegistered} — the repo-wide "cap at five" rule. */
const MAX_ACTIVATE_REGISTERED_ATTEMPTS = 5;

export type { ActivateCandidateOptions } from './activation-guards.ts';

export class WorkflowCatalog {
  readonly #storage: Storage;
  readonly #entries: Map<string, Map<string, WorkflowCatalogEntry>>;
  readonly #active: Map<string, WorkflowCatalogActivePointer>;

  constructor(storage: Storage, seed?: RestoredWorkflowCatalogState) {
    this.#storage = storage;
    this.#entries = seed?.entries ?? new Map();
    this.#active = seed?.active ?? new Map();
  }

  /** Look up one installed `(name, revision)` entry, or `undefined` when not installed. */
  getEntry(name: string, revision: string): WorkflowCatalogEntry | undefined {
    return this.#entries.get(name)?.get(revision);
  }

  /** Every installed revision of `name`, in no particular order. */
  listRevisions(name: string): readonly WorkflowCatalogEntry[] {
    const byName = this.#entries.get(name);
    return byName === undefined ? [] : [...byName.values()];
  }

  /** The current active pointer for `name`, or `undefined` when never activated. */
  resolveActive(name: string): WorkflowCatalogActivePointer | undefined {
    return this.#active.get(name);
  }

  /**
   * Resolve one installed `(name, revision)` entry as a public
   * {@link WorkflowRevisionRecord} — cache hit first, else a durable
   * read-through via {@link readCatalogEntry} (adopted into the local cache
   * on hit, exactly like `install()`'s own read-through), else `undefined`
   * when truly absent. No TOCTOU gap against a concurrent `install()` on
   * this same instance: JS is single-threaded and neither this method nor
   * `install()`'s fast (already-cached) path yields between the cache read
   * and its use.
   */
  async resolveEntry(name: string, revision: string): Promise<WorkflowRevisionRecord | undefined> {
    const cached = this.getEntry(name, revision);
    if (cached !== undefined) {
      return { manifest: cached.manifest, installedAt: cached.installedAt };
    }

    const durable = await readCatalogEntry(this.#storage, name, revision);
    if (durable === null) return undefined;

    this.#cacheEntry(name, revision, durable);
    return durable;
  }

  /**
   * Every durably installed revision of `name`, sorted by {@link compareCodepoint}
   * on `revision` for a deterministic order — never `localeCompare`, per
   * this codebase's determinism rule. Durable scan via
   * {@link scanCatalogEntriesForName}, validated the same fail-closed way
   * {@link restoreWorkflowCatalog} validates every entry it restores.
   * Returns an empty array for an unknown name rather than throwing.
   */
  async listInstalledRevisions(name: string): Promise<readonly WorkflowRevisionRecord[]> {
    const durable = await scanCatalogEntriesForName(this.#storage, name);
    return durable.toSorted((a, b) => compareCodepoint(a.manifest.revision, b.manifest.revision));
  }

  /**
   * Whether `(name, revision)` is already durably installed — checked
   * against this process's in-memory cache first, then, on a cache miss,
   * durable storage itself (a different process may have installed it).
   * Used by `catalog-events.ts`'s installed/activated/draining dispatch
   * helper to decide whether an activation call is installing genuinely
   * new content, since `install()`'s own cache-hit branch does not
   * distinguish "already known to this process" from "just installed a
   * moment ago by this same call."
   */
  async hasInstalled(name: string, revision: string): Promise<boolean> {
    if (this.getEntry(name, revision) !== undefined) return true;
    return (await readCatalogEntry(this.#storage, name, revision)) !== null;
  }

  /**
   * Durably resolve `name`'s active pointer — always reads through to
   * durable storage rather than trusting the in-memory `#active` cache.
   * Deliberately NOT cache-first like {@link hasInstalled}: `hasInstalled`'s
   * cache-hit short-circuit can only go stale in the SAFE direction (a
   * different process's `remove()` durably deleting an entry this
   * process's `#entries` still holds still lets `catalog.remove()`'s own
   * durable re-read refuse with `'not-found'` rather than double-deleting),
   * whereas a name's active pointer has no such one-directional guarantee —
   * a second engine/process can durably move it (e.g. via `activateCandidate`,
   * or a second engine holding the ADR&nbsp;0002 workflow-lease) to a
   * revision this process never installed, so a stale cache HIT here can
   * misreport a durably-active revision as inactive. Used by removal and diagnostics
   * (`core/engine/catalog-removal.ts`) so a durably-active revision is
   * never misreported as inactive/removable; `resolveActive` stays the
   * cheap, synchronous, best-effort accessor for in-process callers (e.g.
   * `reserveInFlightStart`) that only care about this process's own view.
   */
  async resolveActiveDurable(name: string): Promise<WorkflowCatalogActivePointer | undefined> {
    return (await readActivePointer(this.#storage, name)) ?? undefined;
  }

  /**
   * Durably remove the installed `(name, revision)` entry — delegates the
   * CAS mechanics to {@link removeCatalogEntry}. On success, evicts the
   * entry from this process's in-memory `#entries` cache too, so a
   * subsequent `getEntry`/`listRevisions` call never observes a removed
   * revision. Refuses (`'active'`) when `revision` is currently the active
   * pointer for `name` (see `core/engine/catalog-removal.ts`).
   */
  async remove(name: string, revision: string): Promise<WorkflowCatalogRemovalOutcome> {
    requireStorageCapability(this.#storage, 'conditionalBatch', 'workflow catalog removal');
    const result = await removeCatalogEntry(this.#storage, name, revision);
    if (result.outcome === 'removed') {
      this.#entries.get(name)?.delete(revision);
    }
    return result;
  }

  /**
   * Install `manifest` (paired with `definition`, when this process holds
   * one). Idempotent on a byte-identical reinstall for the same
   * `(name, revision)` key; throws {@link WorkflowCatalogConflictError} when
   * an existing entry for that key has different manifest content — checked
   * against BOTH this process's in-memory cache and, on a cache miss,
   * durable storage itself. The durable write is CAS-guarded
   * ({@link writeCatalogEntry}) rather than a plain `put`, so two processes
   * racing to install genuinely different content under the same key —
   * possible whenever `revision` is an explicit, non-content-derived caller
   * value — cannot silently last-write-win; the loser re-reads and resolves
   * through the same idempotent/conflict check.
   *
   * A cache HIT is also revalidated against durable storage (WFT-21, Codex
   * review round 14, P1 item TYR4) rather than trusted outright: a peer's
   * `remove()` + tombstone resolution can durably delete this exact entry
   * while it stays cached here from an earlier `install()`/`resolveEntry()`
   * call on this same process. A durable miss evicts the stale cache entry
   * and falls through to the ordinary not-cached path below, which
   * re-derives the correct outcome from scratch.
   *
   * Also CAS-guarded on the entry's tombstone key being absent (WFT-21,
   * items 1-3) — throws {@link import('./errors.ts').WorkflowRevisionTombstonedError} rather than
   * resurrecting an entry a concurrent removal is deleting/has deleted; see
   * that error's own JSDoc for the rationale and engine-layer translation.
   *
   * `fence`, when supplied, additionally CAS-guards the write on the
   * durable `catalog-removal-generation:<name>:<revision>` counter still
   * reading `fence.removalGeneration` (WFT-21, item Q7jH) — closes the
   * residual window a transient tombstone alone leaves open, where a
   * dynamic-source load that began BEFORE a removal only reaches this write
   * AFTER that removal's tombstone already resolved (entry and tombstone
   * both read `null`, indistinguishable from "never installed"). Only
   * `runSharedSourceLoad` (`core/engine/source-resolution.ts`) supplies a
   * fence, captured before invoking the host loader; every other caller
   * (`activateRegistered`, a deliberate direct `engine.workflows.install()`
   * reinstall) omits it and implicitly advances past whatever the counter
   * currently reads, matching a caller-intended reinstall after removal.
   *
   * Defensively re-validates `name` against the wire-safe name grammar even
   * though `engine.register()`'s own `validateWorkflowOrActivityName` check
   * already guarantees this for the only current producer.
   */
  async install(
    manifest: WorkflowRevisionManifest,
    definition?: RegisteredWorkflowDefinition,
    fence?: CatalogInstallFence,
  ): Promise<WorkflowCatalogEntry> {
    validateWorkflowOrActivityName(manifest.name, 'workflow');

    const cached = this.getEntry(manifest.name, manifest.revision);
    if (cached !== undefined) {
      if (await revalidateCachedCatalogInstall(this.#storage, manifest)) {
        return cached;
      }
      // Durably absent: a peer removed this exact entry since it was
      // cached. Evict the stale cache entry and fall through to the
      // ordinary not-cached path below.
      this.#entries.get(manifest.name)?.delete(manifest.revision);
    }

    // Not in this process's local cache (or just evicted as stale). Durable
    // storage is authoritative — read through before writing rather than
    // trusting cache absence alone.
    const durable = await readCatalogEntry(this.#storage, manifest.name, manifest.revision);
    if (durable !== null) {
      return this.#adoptDurableEntry(manifest, durable, definition);
    }

    const installedAt = Date.now();
    const applied = await writeCatalogEntry(this.#storage, manifest, installedAt, fence);
    if (!applied) {
      // Lost the CAS race: another writer installed this key, its
      // tombstone is present (WFT-21, items 1-3), or — when fenced — a
      // removal completed (tombstone and all) after this caller's own
      // observation (WFT-21, item Q7jH). Re-read to disambiguate.
      const raced = await readCatalogEntry(this.#storage, manifest.name, manifest.revision);
      if (raced === null) {
        return await throwForAbsentCatalogInstallRace(this.#storage, manifest, fence);
      }
      return this.#adoptDurableEntry(manifest, raced, definition);
    }

    return this.#cacheEntry(manifest.name, manifest.revision, {
      manifest,
      installedAt,
      ...(definition === undefined ? {} : { definition }),
    });
  }

  /**
   * Resolve a durable read (either the initial read-through, or the re-read
   * after losing the write's CAS race) against the manifest this call is
   * trying to install: byte-identical content adopts the durable record
   * into the local cache (idempotent), differing content is a conflict.
   */
  #adoptDurableEntry(
    manifest: WorkflowRevisionManifest,
    durable: { manifest: WorkflowRevisionManifest; installedAt: number },
    definition: RegisteredWorkflowDefinition | undefined,
  ): WorkflowCatalogEntry {
    if (!manifestsAreByteIdentical(durable.manifest, manifest)) {
      throw new WorkflowCatalogConflictError(manifest.name, manifest.revision);
    }
    return this.#cacheEntry(manifest.name, manifest.revision, {
      manifest: durable.manifest,
      installedAt: durable.installedAt,
      ...(definition === undefined ? {} : { definition }),
    });
  }

  /** Insert (or overwrite) one entry in the local `#entries` cache and return it. */
  #cacheEntry(name: string, revision: string, entry: WorkflowCatalogEntry): WorkflowCatalogEntry {
    let byName = this.#entries.get(name);
    if (byName === undefined) {
      byName = new Map();
      this.#entries.set(name, byName);
    }
    byName.set(revision, entry);
    return entry;
  }

  /**
   * Unconditionally activate `manifest` for `name`, installing it first if
   * needed. Used exclusively by `engine.register()`'s drain path — never
   * consults `checkWorkflowCompatibility`. Reactivating the currently active
   * revision is a no-op (generation unchanged); activating a different
   * revision bumps the generation by exactly 1. Retries the CAS write up to
   * {@link MAX_ACTIVATE_REGISTERED_ATTEMPTS} times under contention, throwing
   * {@link WorkflowCatalogActivationConflictError} on exhaustion.
   */
  async activateRegistered(
    name: string,
    manifest: WorkflowRevisionManifest,
    definition: RegisteredWorkflowDefinition,
  ): Promise<WorkflowCatalogActivePointer> {
    requireStorageCapability(this.#storage, 'conditionalBatch', 'workflow catalog activation');
    await this.install(manifest, definition);

    for (let attempt = 1; attempt <= MAX_ACTIVATE_REGISTERED_ATTEMPTS; attempt++) {
      const current = await readActivePointer(this.#storage, name);
      if (current !== null && current.revision === manifest.revision) {
        // Already active at this exact revision: no-op, generation unchanged.
        this.#active.set(name, current);
        return current;
      }

      const nextGeneration = current === null ? 1 : current.generation + 1;
      const nextPointer: WorkflowCatalogActivePointer = {
        revision: manifest.revision,
        generation: nextGeneration,
        activatedAt: Date.now(),
      };

      const applied = await storageConditionalBatch(
        this.#storage,
        [
          {
            key: KEYS.catalogActive(name),
            expectedValue: current === null ? null : encodeActivePointer(current),
          },
        ],
        [{ type: 'put', key: KEYS.catalogActive(name), value: encodeActivePointer(nextPointer) }],
      );

      if (applied) {
        this.#active.set(name, nextPointer);
        return nextPointer;
      }
      // Lost the CAS race: another writer activated concurrently. Re-read and retry.
    }

    throw new WorkflowCatalogActivationConflictError(name, MAX_ACTIVATE_REGISTERED_ATTEMPTS);
  }

  /**
   * The guarded activation primitive: reads the currently-active manifest
   * for `name` (absence is treated as automatically compatible — first
   * activation), checks `checkWorkflowCompatibility`, and refuses rather
   * than applies when incompatible or when `expectedGeneration` disagrees
   * with the durably-read generation. Single-shot CAS write — no retry; the
   * caller decides whether to re-read and retry.
   *
   * Installs `candidateManifest` first (via `install()`, unfenced — a
   * deliberate direct activation call, not a stale dynamic-source load, so
   * it advances past any prior removal like `activateRegistered` does),
   * then re-reads the freshly-durable entry bytes and CAS-fences the
   * active-pointer write on them (WFT-21, item TYR4): without this fence, a
   * peer's `remove()` + tombstone finalize landing between `install()`
   * returning and this method's own CAS could leave the active pointer
   * naming a revision whose catalog entry no longer exists. A CAS loss
   * re-reads the entry: durably absent means the race was that removal
   * (throws the already-public {@link WorkflowRevisionNotInstalledError});
   * still present is an ordinary concurrent-activation race (`{ applied:
   * false, reason: 'conflict' }`, the caller re-decides).
   */
  async activateCandidate(
    name: string,
    candidateManifest: WorkflowRevisionManifest,
    options?: ActivateCandidateOptions,
  ): Promise<WorkflowCatalogActivationResult> {
    requireStorageCapability(this.#storage, 'conditionalBatch', 'workflow catalog activation');
    await this.install(candidateManifest);

    // Keyed by `candidateManifest.name`/`.revision`, NOT the `name` param —
    // that is where `install()` above actually stores the entry
    // (`writeCatalogEntry` always keys by the manifest's own identity).
    // `name` is the public catalog name being activated, which in every
    // real caller equals `candidateManifest.name`; only a contrived
    // mismatched-name call (as some of this suite's own compatibility-only
    // tests deliberately do, to exercise `checkWorkflowCompatibility`
    // without caring about a real entry) would ever tell the two apart.
    const candidateEntryKey = KEYS.catalogEntry(candidateManifest.name, candidateManifest.revision);
    const candidateEntryBytes = await this.#storage.get(candidateEntryKey);
    if (candidateEntryBytes === null) {
      // `install()` just installed (or durably confirmed) this exact entry
      // above; its absence here can only mean a peer's `remove()` +
      // tombstone-finalize raced to completion in the narrow gap between
      // that call returning and this read.
      throw new WorkflowRevisionNotInstalledError(name, candidateManifest.revision);
    }

    const currentPointer = await readActivePointer(this.#storage, name);

    const refusal = await refuseIncompatibleOrStaleCandidate(
      (entryName, entryRevision) => this.resolveEntry(entryName, entryRevision),
      name,
      candidateManifest,
      currentPointer,
      options,
    );
    if (refusal !== undefined) return refusal;

    const nextGeneration = currentPointer === null ? 1 : currentPointer.generation + 1;
    const nextPointer: WorkflowCatalogActivePointer = {
      revision: candidateManifest.revision,
      generation: nextGeneration,
      activatedAt: Date.now(),
    };

    const applied = await storageConditionalBatch(
      this.#storage,
      [
        {
          key: KEYS.catalogActive(name),
          expectedValue: currentPointer === null ? null : encodeActivePointer(currentPointer),
        },
        { key: candidateEntryKey, expectedValue: candidateEntryBytes },
      ],
      [{ type: 'put', key: KEYS.catalogActive(name), value: encodeActivePointer(nextPointer) }],
    );

    if (!applied) {
      // Lost the CAS: either a concurrent activation moved the pointer, or
      // a peer's removal deleted the candidate entry between the read
      // above and this commit landing. Re-read the entry to give a genuine
      // removal the more specific typed error rather than a generic
      // 'conflict' the caller might blindly retry against a revision that
      // no longer exists.
      const stillInstalled = await this.#storage.get(candidateEntryKey);
      if (stillInstalled === null) {
        throw new WorkflowRevisionNotInstalledError(name, candidateManifest.revision);
      }
      return { applied: false, reason: 'conflict' };
    }

    this.#active.set(name, nextPointer);
    return { applied: true, pointer: nextPointer };
  }
}

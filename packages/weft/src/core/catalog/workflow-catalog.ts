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
 *   retry loop. Registering a different version of an already-registered
 *   workflow must never hard-fail construction or registration (the
 *   `version-mismatch-recovery.test.ts` precedent), which is why this path
 *   is unconditional. "Unconditional" is about bypassing
 *   `checkWorkflowCompatibility`, not immunity to failure in general: under
 *   sustained contention the bounded 5-attempt CAS retry can still exhaust
 *   and throw {@link WorkflowCatalogActivationConflictError}, which
 *   propagates out of `ensureWorkflowCatalogReady` and fails
 *   `Engine.create()` itself (safely — `Engine.create()`'s `try`/`catch`
 *   disposes the half-booted engine before rethrowing).
 * - {@link WorkflowCatalog.activateCandidate} — the guarded primitive:
 *   `checkWorkflowCompatibility`-gated, single-shot CAS (no retry — the
 *   caller decides whether to re-read and retry), refuses on incompatibility
 *   or a stale expected generation. Exercised by direct unit tests now;
 *   reused by later dynamic-loading work (WFT-13+).
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
import {
  checkWorkflowCompatibility,
  DEFAULT_WORKFLOW_COMPATIBILITY_POLICY,
  type WorkflowCompatibilityPolicy,
} from '../contract/compatibility.ts';
import type { WorkflowRevisionManifest } from '../contract/types.ts';
import { validateWorkflowOrActivityName } from '../types/name-grammar.ts';
import type { RegisteredWorkflowDefinition } from '../types/workflow-registry.ts';
import { encodeActivePointer, manifestsAreByteIdentical } from './codec.ts';
import { WorkflowCatalogActivationConflictError, WorkflowCatalogConflictError } from './errors.ts';
import {
  readActivePointer,
  readCatalogEntry,
  scanCatalogEntriesForName,
  writeCatalogEntry,
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

/** Options accepted by {@link WorkflowCatalog.activateCandidate}. */
export type ActivateCandidateOptions = {
  /** The generation this caller last observed; refused with `stale-generation` if it disagrees with the durable pointer. */
  expectedGeneration?: number;
  /** Compatibility policy; defaults to {@link DEFAULT_WORKFLOW_COMPATIBILITY_POLICY}. */
  policy?: WorkflowCompatibilityPolicy;
};

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
   * Install `manifest` (paired with `definition`, when this process holds
   * one). Idempotent on a byte-identical reinstall for the same
   * `(name, revision)` key; throws {@link WorkflowCatalogConflictError} when
   * an existing entry for that key has different manifest content —
   * checked against BOTH this process's in-memory cache and, on a cache
   * miss, durable storage itself (a different `WorkflowCatalog`
   * instance/process may already have installed this exact key). The
   * durable write is CAS-guarded ({@link writeCatalogEntry}) rather than a
   * plain `put`, so two processes racing to install genuinely different
   * content under the same key — possible whenever `revision` is an
   * explicit, non-content-derived caller value rather than the default
   * content hash — cannot silently last-write-win each other; the loser
   * re-reads and resolves through the same idempotent/conflict check.
   *
   * Defensively re-validates `name` against the wire-safe name grammar even
   * though `engine.register()`'s existing `validateWorkflowOrActivityName`
   * already guarantees this for the only current producer — `install()` is
   * deliberately safe for a future producer that is not `engine.register()`.
   */
  async install(
    manifest: WorkflowRevisionManifest,
    definition?: RegisteredWorkflowDefinition,
  ): Promise<WorkflowCatalogEntry> {
    validateWorkflowOrActivityName(manifest.name, 'workflow');

    const existing = this.getEntry(manifest.name, manifest.revision);
    if (existing !== undefined) {
      if (!manifestsAreByteIdentical(existing.manifest, manifest)) {
        throw new WorkflowCatalogConflictError(manifest.name, manifest.revision);
      }
      return existing;
    }

    // Not in this process's local cache. Durable storage is authoritative —
    // read through before writing rather than trusting cache absence alone.
    const durable = await readCatalogEntry(this.#storage, manifest.name, manifest.revision);
    if (durable !== null) {
      return this.#adoptDurableEntry(manifest, durable, definition);
    }

    const installedAt = Date.now();
    const applied = await writeCatalogEntry(this.#storage, manifest, installedAt);
    if (!applied) {
      // Lost the CAS race: another process durably installed this exact key
      // between our read above and this write. Re-read and resolve exactly
      // as the pre-write check above would have.
      const raced = await readCatalogEntry(this.#storage, manifest.name, manifest.revision);
      if (raced === null) {
        // The key existed a moment ago to lose the CAS race; storage
        // disagreeing now is itself an inconsistency. Fail closed rather
        // than silently proceeding to write over it.
        throw new WorkflowCatalogConflictError(manifest.name, manifest.revision);
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
   */
  async activateCandidate(
    name: string,
    candidateManifest: WorkflowRevisionManifest,
    options?: ActivateCandidateOptions,
  ): Promise<WorkflowCatalogActivationResult> {
    requireStorageCapability(this.#storage, 'conditionalBatch', 'workflow catalog activation');
    await this.install(candidateManifest);
    const currentPointer = await readActivePointer(this.#storage, name);

    const refusal = this.#refuseIncompatibleOrStaleCandidate(
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
      ],
      [{ type: 'put', key: KEYS.catalogActive(name), value: encodeActivePointer(nextPointer) }],
    );

    if (!applied) {
      return { applied: false, reason: 'conflict' };
    }

    this.#active.set(name, nextPointer);
    return { applied: true, pointer: nextPointer };
  }

  /**
   * The stale-generation and compatibility gates {@link activateCandidate}
   * checks before ever attempting a write — split out to keep that method's
   * complexity low. Returns the refusal result when the candidate should be
   * rejected, or `undefined` when it may proceed to the CAS write.
   */
  #refuseIncompatibleOrStaleCandidate(
    name: string,
    candidateManifest: WorkflowRevisionManifest,
    currentPointer: WorkflowCatalogActivePointer | null,
    options?: ActivateCandidateOptions,
  ): WorkflowCatalogActivationResult | undefined {
    if (currentPointer === null) {
      return this.#refuseStaleFirstActivation(options);
    }

    const generationRefusal = this.#refuseMissingOrStaleGeneration(currentPointer, options);
    if (generationRefusal !== undefined) return generationRefusal;

    return this.#refuseIncompatibleCandidate(name, candidateManifest, currentPointer, options);
  }

  /**
   * First-ever activation of a name (no active pointer yet): omitting
   * `expectedGeneration` (or supplying exactly 0, the "no prior generation"
   * value) bypasses the fence entirely — there is nothing to be stale
   * against yet, and the one existing test that calls `activateCandidate`
   * with no options at all must keep applying. Any OTHER explicit value is
   * a caller assertion about a generation that does not exist.
   */
  #refuseStaleFirstActivation(
    options?: ActivateCandidateOptions,
  ): WorkflowCatalogActivationResult | undefined {
    if (options?.expectedGeneration !== undefined && options.expectedGeneration !== 0) {
      return { applied: false, reason: 'stale-generation', currentGeneration: 0 };
    }
    return undefined;
  }

  /**
   * The generation fence for an existing active pointer: an omitted
   * `expectedGeneration` is exactly the "two refreshers silently
   * last-write-win" hazard this gate exists to close, so it is refused
   * rather than falling through to the compatibility check alone; a
   * supplied-but-wrong generation is refused as stale.
   */
  #refuseMissingOrStaleGeneration(
    currentPointer: WorkflowCatalogActivePointer,
    options?: ActivateCandidateOptions,
  ): WorkflowCatalogActivationResult | undefined {
    if (options?.expectedGeneration === undefined) {
      return {
        applied: false,
        reason: 'expected-generation-required',
        currentGeneration: currentPointer.generation,
      };
    }
    if (options.expectedGeneration !== currentPointer.generation) {
      return {
        applied: false,
        reason: 'stale-generation',
        currentGeneration: currentPointer.generation,
      };
    }
    return undefined;
  }

  /** The compatibility check itself, run only once the generation fence has already passed. */
  #refuseIncompatibleCandidate(
    name: string,
    candidateManifest: WorkflowRevisionManifest,
    currentPointer: WorkflowCatalogActivePointer,
    options?: ActivateCandidateOptions,
  ): WorkflowCatalogActivationResult | undefined {
    const currentEntry = this.getEntry(name, currentPointer.revision);
    if (currentEntry === undefined) return undefined;

    const verdict = checkWorkflowCompatibility(
      currentEntry.manifest,
      candidateManifest,
      options?.policy ?? DEFAULT_WORKFLOW_COMPATIBILITY_POLICY,
    );
    return verdict.compatible ? undefined : { applied: false, reason: 'incompatible', verdict };
  }
}

/**
 * Durable I/O for the workflow catalog: restoring catalog state at boot and
 * writing individual installed-revision entries.
 *
 * `restoreWorkflowCatalog` fails closed on any corrupt or unparseable
 * durable record — a corrupted catalog entry or active pointer is data
 * corruption in Weft's own durable store, not hostile external input, and
 * every other fail-closed precedent in this codebase (a corrupt lease epoch,
 * a corrupt ownership-mode marker) treats that the same way. Silently
 * dropping it could later resurrect a stale or wrong active revision.
 *
 * @module core/catalog/storage-io
 */

import {
  KEYS,
  storageConditionalBatch,
  type ConditionalBatchCondition,
  type Storage,
} from '../../storage/interface.ts';
import { tryDecodeStorageKeyComponent } from '../../storage/key-encoding.ts';
import { parseWorkflowRevisionManifest } from '../contract/manifest-parse.ts';
import type { WorkflowRevisionManifest } from '../contract/types.ts';
import { decodeActivePointer, manifestsAreByteIdentical } from './codec.ts';
import { WorkflowCatalogConflictError, WorkflowRevisionTombstonedError } from './errors.ts';
import type { WorkflowCatalogActivePointer, WorkflowCatalogEntry } from './types.ts';

/** In-memory catalog state hydrated from durable storage. */
export type RestoredWorkflowCatalogState = {
  entries: Map<string, Map<string, WorkflowCatalogEntry>>;
  active: Map<string, WorkflowCatalogActivePointer>;
};

// Both split functions use the non-throwing `tryDecodeStorageKeyComponent`
// (not `decodeStorageKeyComponent`) and return `null` on malformed
// percent-encoding, exactly like an unexpected part count — so every
// caller's existing `null` check routes uniformly into `failClosed()`'s
// operator-repair message rather than a raw `URIError` escaping instead.
function splitCatalogEntryKey(key: string): { name: string; revision: string } | null {
  const parts = key.split(':');
  if (parts.length !== 3) return null;
  const name = tryDecodeStorageKeyComponent(parts[1] ?? '');
  const revision = tryDecodeStorageKeyComponent(parts[2] ?? '');
  if (name === null || revision === null) return null;
  return { name, revision };
}

function splitCatalogActiveKey(key: string): string | null {
  const parts = key.split(':');
  if (parts.length !== 2) return null;
  return tryDecodeStorageKeyComponent(parts[1] ?? '');
}

function parseCatalogEntryRecord(
  bytes: Uint8Array,
): { manifest: unknown; installedAt: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record['installedAt'] !== 'number') return null;
  return { manifest: record['manifest'], installedAt: record['installedAt'] };
}

function failClosed(kind: string, key: string, reason: string): never {
  throw new Error(
    `The store's ${kind} ("${key}") exists but ${reason}. Treating it as absent would risk ` +
      'resurrecting a stale or wrong active workflow revision, so the workflow catalog fails ' +
      'closed instead. Resolve by operator repair: inspect the stored bytes and, only if certain ' +
      'no other engine relies on them, delete the key so it can be re-established.',
  );
}

/**
 * Restore the durable workflow catalog: every installed `(name, revision)`
 * entry and every name's active pointer. Every entry record is validated via
 * {@link parseWorkflowRevisionManifest}; every active-pointer record is
 * validated via {@link decodeActivePointer}. A corrupt or unparseable record
 * throws rather than being silently skipped. Restoring an empty store
 * returns empty maps.
 */
export async function restoreWorkflowCatalog(
  storage: Storage,
): Promise<RestoredWorkflowCatalogState> {
  const entries = new Map<string, Map<string, WorkflowCatalogEntry>>();
  const active = new Map<string, WorkflowCatalogActivePointer>();

  for await (const [key, bytes] of storage.scan('catalog-entry:')) {
    await restoreOneCatalogEntry(entries, key, bytes);
  }

  for await (const [key, bytes] of storage.scan('catalog-active:')) {
    restoreOneActivePointer(active, key, bytes);
  }

  return { entries, active };
}

/**
 * Decode and validate one durable catalog-entry record: parse as JSON,
 * validate as a manifest via {@link parseWorkflowRevisionManifest}, and check
 * that the decoded `(name, revision)` agrees with the caller-supplied
 * expectation (normally read from the storage key itself). Fails closed on
 * any disagreement — shared by {@link restoreWorkflowCatalog}'s per-entry
 * restore, {@link readCatalogEntry}'s single-key read, and the by-name scan
 * `WorkflowCatalog.listInstalledRevisions` uses, so the three consumers of
 * one durable record shape can never validate it three different ways.
 */
/**
 * Decode and validate a raw catalog-entry-record byte string against an
 * expected `(name, revision)` — exported for {@link import('./removal.ts').restoreCatalogEntryFromTombstone}'s
 * caller (`WorkflowCatalog.restoreFromTombstone`) and the boot-time orphan
 * sweep (`orphaned-tombstones.ts`) to re-populate the in-memory cache from
 * a tombstone's bytes, which are byte-identical to the entry bytes this
 * function already validates for {@link restoreWorkflowCatalog} and
 * {@link readCatalogEntry}.
 */
export async function decodeCatalogEntryRecord(
  key: string,
  bytes: Uint8Array,
  expectedName: string,
  expectedRevision: string,
): Promise<{ manifest: WorkflowRevisionManifest; installedAt: number }> {
  const parsedRecord = parseCatalogEntryRecord(bytes);
  if (parsedRecord === null) {
    failClosed('workflow catalog entry', key, 'could not be parsed as JSON');
  }

  const parsed = await parseWorkflowRevisionManifest(parsedRecord.manifest);
  if (!parsed.ok) {
    failClosed(
      'workflow catalog entry',
      key,
      'does not decode as a valid installed-revision record',
    );
  }

  const manifest = parsed.manifest;
  if (manifest.name !== expectedName || manifest.revision !== expectedRevision) {
    failClosed(
      'workflow catalog entry',
      key,
      'contains a manifest whose (name, revision) disagrees with its storage key',
    );
  }

  return { manifest, installedAt: parsedRecord.installedAt };
}

/** One `catalog-entry:` scan iteration, split out to keep {@link restoreWorkflowCatalog}'s complexity low. */
async function restoreOneCatalogEntry(
  entries: Map<string, Map<string, WorkflowCatalogEntry>>,
  key: string,
  bytes: Uint8Array,
): Promise<void> {
  const split = splitCatalogEntryKey(key);
  if (split === null) {
    failClosed(
      'workflow catalog entry key',
      key,
      'does not match the expected catalog-entry:<name>:<revision> shape',
    );
  }

  const { manifest, installedAt } = await decodeCatalogEntryRecord(
    key,
    bytes,
    split.name,
    split.revision,
  );

  let byName = entries.get(split.name);
  if (byName === undefined) {
    byName = new Map();
    entries.set(split.name, byName);
  }
  byName.set(split.revision, { manifest, installedAt });
}

/** One `catalog-active:` scan iteration, split out to keep {@link restoreWorkflowCatalog}'s complexity low. */
function restoreOneActivePointer(
  active: Map<string, WorkflowCatalogActivePointer>,
  key: string,
  bytes: Uint8Array,
): void {
  const name = splitCatalogActiveKey(key);
  if (name === null) {
    failClosed(
      'workflow catalog active pointer key',
      key,
      'does not match the expected catalog-active:<name> shape',
    );
  }
  const pointer = decodeActivePointer(bytes);
  if (pointer === null) {
    failClosed(
      'workflow catalog active pointer',
      key,
      'does not decode as a valid { revision, generation, activatedAt } record',
    );
  }
  active.set(name, pointer);
}

/**
 * Read one durable installed-revision record for `(name, revision)`, or
 * `null` when absent. Fails closed on corruption, exactly matching
 * {@link restoreWorkflowCatalog}'s per-entry validation — used by
 * `WorkflowCatalog.install()` to read through the local in-memory cache to
 * durable storage, which may already hold this `(name, revision)` key
 * courtesy of a different `WorkflowCatalog` instance/process.
 */
export async function readCatalogEntry(
  storage: Storage,
  name: string,
  revision: string,
): Promise<{ manifest: WorkflowRevisionManifest; installedAt: number } | null> {
  const key = KEYS.catalogEntry(name, revision);
  const bytes = await storage.get(key);
  if (bytes === null) return null;
  return decodeCatalogEntryRecord(key, bytes, name, revision);
}

/**
 * Durably scan every installed revision of `name` — the
 * `catalog-entry:<name>:` prefix `WORKFLOW_CATALOG_KEYS.catalogEntryPrefix`
 * builds. Each record is validated exactly like
 * {@link restoreWorkflowCatalog}'s per-entry restore (via
 * {@link decodeCatalogEntryRecord}, shared rather than duplicated); a
 * corrupt or unparseable entry fails closed rather than being silently
 * skipped. Returns entries in no particular order — callers that need a
 * deterministic order (`WorkflowCatalog.listInstalledRevisions`) sort the
 * result themselves.
 */
export async function scanCatalogEntriesForName(
  storage: Storage,
  name: string,
): Promise<Array<{ manifest: WorkflowRevisionManifest; installedAt: number }>> {
  const results: Array<{ manifest: WorkflowRevisionManifest; installedAt: number }> = [];
  for await (const [key, bytes] of storage.scan(KEYS.catalogEntryPrefix(name))) {
    const split = splitCatalogEntryKey(key);
    if (split === null) {
      failClosed(
        'workflow catalog entry key',
        key,
        'does not match the expected catalog-entry:<name>:<revision> shape',
      );
    }
    results.push(await decodeCatalogEntryRecord(key, bytes, split.name, split.revision));
  }
  return results;
}

/** Read one name's durable active pointer, or `null` when absent. */
export async function readActivePointer(
  storage: Storage,
  name: string,
): Promise<WorkflowCatalogActivePointer | null> {
  const bytes = await storage.get(KEYS.catalogActive(name));
  if (bytes === null) return null;
  const pointer = decodeActivePointer(bytes);
  if (pointer === null) {
    failClosed(
      'workflow catalog active pointer',
      KEYS.catalogActive(name),
      'does not decode as a valid { revision, generation, activatedAt } record',
    );
  }
  return pointer;
}

/**
 * A durable install fence (WFT-21, Codex review round 14, P1 item Q7jH): the
 * `catalog-removal-generation:<name>:<revision>` bytes a caller observed
 * BEFORE starting work whose eventual `writeCatalogEntry` call must not
 * resurrect a revision removed WHILE that work was in flight. Only a
 * dynamic-source loader (`runSharedSourceLoad`, `core/engine/source-resolution.ts`)
 * supplies one — it reads the counter immediately before invoking the host
 * loader, then threads the observed bytes through to `WorkflowCatalog.install()`
 * once the loader (and validation) finish. `null` means "observed as never
 * removed." A caller with no prior observation to be stale against (`engine.register()`'s
 * drain path, a deliberate direct `engine.workflows.install()` reinstall)
 * omits the fence entirely — see `KEYS.catalogRemovalGeneration`'s own doc
 * for the full rationale.
 */
export type CatalogInstallFence = { removalGeneration: Uint8Array | null };

function removalGenerationBytesEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * Read the raw bytes of `(name, revision)`'s durable removal-generation
 * counter — `null` when the revision has never been removed. Callers that
 * need to compare (not decode) this value, e.g. `WorkflowCatalog.install()`'s
 * CAS-loss disambiguation, use {@link catalogRemovalGenerationMatches}
 * instead of decoding it themselves.
 */
export async function readCatalogRemovalGeneration(
  storage: Storage,
  name: string,
  revision: string,
): Promise<Uint8Array | null> {
  return storage.get(KEYS.catalogRemovalGeneration(name, revision));
}

/**
 * Whether `(name, revision)`'s CURRENT durable removal-generation counter
 * still reads as `expected` — used by `WorkflowCatalog.install()` after a
 * fenced `writeCatalogEntry` loses its CAS, to tell a genuine content
 * conflict (the counter is unchanged; some other writer raced the entry
 * itself) apart from a stale-load resurrection attempt (the counter
 * advanced — a removal landed after `expected` was observed).
 */
export async function catalogRemovalGenerationMatches(
  storage: Storage,
  name: string,
  revision: string,
  expected: Uint8Array | null,
): Promise<boolean> {
  const current = await readCatalogRemovalGeneration(storage, name, revision);
  return removalGenerationBytesEqual(current, expected);
}

/**
 * Durably write one installed-revision entry, CAS-guarded on BOTH the entry
 * key being absent (`expectedValue: null`) AND the entry's tombstone key
 * being absent, and — when `fence` is supplied — additionally on the
 * `catalog-removal-generation:<name>:<revision>` counter still reading
 * `fence.removalGeneration` (WFT-21, item Q7jH; see
 * {@link CatalogInstallFence}'s own doc). Returns `true` when this write won
 * the race, `false` when ANY precondition failed — `WorkflowCatalog.install()`
 * distinguishes the causes itself (re-reading the entry, then the
 * tombstone, then — when fenced — the removal-generation counter, on
 * `false`) since a flat boolean cannot: a durable entry already installed
 * (idempotent-or-conflict, the original condition), a tombstone currently
 * present for this exact `(name, revision)` (WFT-21, Codex review items
 * 1-3 — refuse to resurrect a revision `removeCatalogEntry()` is deleting
 * or has deleted, until its tombstone is resolved), or a removal that
 * completed (including finalizing its own tombstone away) since a fenced
 * caller's own observation.
 *
 * CAS-protected rather than a plain `put`: "content-addressed by
 * `(name, revision)`, so racing writers always agree" only holds when
 * `revision` is content-derived. `buildWorkflowRevisionManifest`'s public
 * `options.revision` escape hatch lets a caller supply a non-content-derived
 * revision (e.g. a deploy tag), so two different `WorkflowCatalog`
 * instances/processes — each with their own, independently-seeded
 * in-memory cache — could otherwise race a differing-content write to the
 * same key past each other's in-memory-only conflict check with a plain
 * `put` (last write wins, silently).
 */
export async function writeCatalogEntry(
  storage: Storage,
  manifest: WorkflowRevisionManifest,
  installedAt: number,
  fence?: CatalogInstallFence,
): Promise<boolean> {
  const bytes = new TextEncoder().encode(JSON.stringify({ manifest, installedAt }));
  const key = KEYS.catalogEntry(manifest.name, manifest.revision);
  const tombstoneKey = KEYS.catalogTombstone(manifest.name, manifest.revision);
  const conditions: ConditionalBatchCondition[] = [
    { key, expectedValue: null },
    { key: tombstoneKey, expectedValue: null },
  ];
  if (fence !== undefined) {
    conditions.push({
      key: KEYS.catalogRemovalGeneration(manifest.name, manifest.revision),
      expectedValue: fence.removalGeneration,
    });
  }
  return storageConditionalBatch(storage, conditions, [{ type: 'put', key, value: bytes }]);
}

/**
 * `WorkflowCatalog.install()`'s cache-hit revalidation (WFT-21, Codex
 * review round 14, P1 item TYR4): re-reads durable storage rather than
 * trusting an in-process cache hit outright. A peer's `remove()` + tombstone
 * resolution can durably delete this exact `(name, revision)` while it
 * stays cached from an earlier `install()`/`resolveEntry()` call on this
 * same process. Returns `true` when durable storage still agrees the entry
 * exists (and matches `manifest`'s content — a mismatch throws
 * {@link WorkflowCatalogConflictError}, the same conflict `install()`'s own
 * durable read-through path already throws); `false` when durably absent,
 * telling the caller to evict its stale cache entry and fall through to the
 * ordinary not-cached path.
 */
export async function revalidateCachedCatalogInstall(
  storage: Storage,
  manifest: WorkflowRevisionManifest,
): Promise<boolean> {
  const durable = await readCatalogEntry(storage, manifest.name, manifest.revision);
  if (durable === null) return false;
  if (!manifestsAreByteIdentical(durable.manifest, manifest)) {
    throw new WorkflowCatalogConflictError(manifest.name, manifest.revision);
  }
  return true;
}

/**
 * `WorkflowCatalog.install()`'s CAS-loss disambiguation for the "still
 * durably absent after losing the write race" case. Always throws: a
 * present tombstone explains the absence directly
 * ({@link WorkflowRevisionTombstonedError}); a fenced caller whose observed
 * `catalog-removal-generation:<name>:<revision>` counter has since advanced
 * explains it too — a removal completed, tombstone and all, after the
 * fence was captured (WFT-21, item Q7jH); neither case is a genuine
 * writer-vs-writer conflict, so both are distinguished from the fallback
 * {@link WorkflowCatalogConflictError}.
 */
export async function throwForAbsentCatalogInstallRace(
  storage: Storage,
  manifest: WorkflowRevisionManifest,
  fence: CatalogInstallFence | undefined,
): Promise<never> {
  const tombstoneBytes = await storage.get(KEYS.catalogTombstone(manifest.name, manifest.revision));
  if (tombstoneBytes !== null) {
    throw new WorkflowRevisionTombstonedError(manifest.name, manifest.revision);
  }
  if (fence !== undefined) {
    const stillFenced = await catalogRemovalGenerationMatches(
      storage,
      manifest.name,
      manifest.revision,
      fence.removalGeneration,
    );
    if (!stillFenced) {
      throw new WorkflowRevisionTombstonedError(manifest.name, manifest.revision);
    }
  }
  throw new WorkflowCatalogConflictError(manifest.name, manifest.revision);
}

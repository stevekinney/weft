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

import { KEYS, storageConditionalBatch, type Storage } from '../../storage/interface.ts';
import { tryDecodeStorageKeyComponent } from '../../storage/key-encoding.ts';
import { parseWorkflowRevisionManifest } from '../contract/manifest-parse.ts';
import type { WorkflowRevisionManifest } from '../contract/types.ts';
import { decodeActivePointer } from './codec.ts';
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
  if (manifest.name !== split.name || manifest.revision !== split.revision) {
    failClosed(
      'workflow catalog entry',
      key,
      'contains a manifest whose (name, revision) disagrees with its storage key',
    );
  }

  let byName = entries.get(split.name);
  if (byName === undefined) {
    byName = new Map();
    entries.set(split.name, byName);
  }
  byName.set(split.revision, { manifest, installedAt: parsedRecord.installedAt });
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
  if (manifest.name !== name || manifest.revision !== revision) {
    failClosed(
      'workflow catalog entry',
      key,
      'contains a manifest whose (name, revision) disagrees with its storage key',
    );
  }

  return { manifest, installedAt: parsedRecord.installedAt };
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
 * Durably write one installed-revision entry, CAS-guarded on the key being
 * absent (`expectedValue: null`). Returns `true` when this write won the
 * race, `false` when another writer had already durably installed this
 * exact `(name, revision)` key first — `WorkflowCatalog.install()` re-reads
 * via {@link readCatalogEntry} on `false` to decide whether that concurrent
 * write was byte-identical (idempotent) or a genuine conflict.
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
): Promise<boolean> {
  const bytes = new TextEncoder().encode(JSON.stringify({ manifest, installedAt }));
  const key = KEYS.catalogEntry(manifest.name, manifest.revision);
  return storageConditionalBatch(
    storage,
    [{ key, expectedValue: null }],
    [{ type: 'put', key, value: bytes }],
  );
}

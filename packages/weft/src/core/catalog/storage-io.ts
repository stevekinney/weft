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

import { KEYS, type Storage } from '../../storage/interface.ts';
import { decodeStorageKeyComponent } from '../../storage/key-encoding.ts';
import { parseWorkflowRevisionManifest } from '../contract/manifest-parse.ts';
import type { WorkflowRevisionManifest } from '../contract/types.ts';
import { decodeActivePointer } from './codec.ts';
import type { WorkflowCatalogActivePointer, WorkflowCatalogEntry } from './types.ts';

/** In-memory catalog state hydrated from durable storage. */
export type RestoredWorkflowCatalogState = {
  entries: Map<string, Map<string, WorkflowCatalogEntry>>;
  active: Map<string, WorkflowCatalogActivePointer>;
};

function splitCatalogEntryKey(key: string): { name: string; revision: string } | null {
  const parts = key.split(':');
  if (parts.length !== 3) return null;
  return {
    name: decodeStorageKeyComponent(parts[1] ?? ''),
    revision: decodeStorageKeyComponent(parts[2] ?? ''),
  };
}

function splitCatalogActiveKey(key: string): string | null {
  const parts = key.split(':');
  if (parts.length !== 2) return null;
  return decodeStorageKeyComponent(parts[1] ?? '');
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
 * Durably write one installed-revision entry via a plain `put` — safe
 * without CAS protection because entries are content-addressed by
 * `(name, revision)` and `WorkflowCatalog.install()` already resolved
 * idempotency/conflict against in-memory state before calling this.
 */
export async function writeCatalogEntry(
  storage: Storage,
  manifest: WorkflowRevisionManifest,
  installedAt: number,
): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify({ manifest, installedAt }));
  await storage.put(KEYS.catalogEntry(manifest.name, manifest.revision), bytes);
}

import { BunSQLiteStorage } from './bun-sql.ts';
import { resolveStorageEnvironment } from './environment-configuration.ts';
import { IndexedDBStorage } from './indexeddb.ts';
import { NodeSQLiteStorage } from './node-sqlite.ts';
import { WebExtensionStorage } from './web-extension.ts';
/**
 * Runtime-detected default storage backend.
 *
 * Imported via `@lostgradient/weft`. Resolves a persistent
 * storage adapter appropriate for the current runtime:
 *
 *   1. Bun -> `BunSQLiteStorage`
 *   2. Node -> `NodeSQLiteStorage`
 *   3. WebExtension -> `WebExtensionStorage`
 *   4. Browser / Service Worker -> `IndexedDBStorage`
 *   5. otherwise -> throw
 *
 * SQLite path policy:
 *   - `process.env.WEFT_DEFAULT_STORAGE_PATH` if set
 *   - else `${tmpdir()}/weft-default/<cwd-hash>.db`
 *
 * The parent directory is created (recursive) before the SQLite path is
 * returned. Browser and extension adapters use their own defaults.
 *
 * `resolveDefaultStorage()` is for developer convenience. Production
 * deployments should pick an explicit adapter and pass it to
 * `new Engine({ storage })`.
 *
 * @module @lostgradient/weft
 */

import type { Storage as WeftStorage } from './interface.ts';

type RuntimeGlobalsLike = {
  Bun?: unknown;
  browser?: { storage?: unknown };
  chrome?: { storage?: unknown };
  indexedDB?: unknown;
  IDBKeyRange?: unknown;
  process?: {
    cwd?: () => string;
    env?: Record<string, string | undefined>;
    versions?: { node?: unknown };
  };
};

interface DetectionGlobals {
  hasBun: boolean;
  hasIndexedDB: boolean;
  hasNode: boolean;
  hasWebExtensionStorage: boolean;
}

function detectGlobals(runtimeGlobals: RuntimeGlobalsLike): DetectionGlobals {
  return {
    hasBun: typeof runtimeGlobals.Bun !== 'undefined',
    hasIndexedDB: typeof runtimeGlobals.indexedDB !== 'undefined',
    hasNode:
      runtimeGlobals.process !== undefined &&
      typeof runtimeGlobals.process.versions?.node === 'string',
    hasWebExtensionStorage:
      runtimeGlobals.browser?.storage !== undefined || runtimeGlobals.chrome?.storage !== undefined,
  };
}

function projectStorageHash(runtimeGlobals: RuntimeGlobalsLike): string {
  const { createHash } = process.getBuiltinModule('node:crypto');
  const cwd = runtimeGlobals.process?.cwd?.() ?? 'weft-default';
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

function defaultSqlitePath(runtimeGlobals: RuntimeGlobalsLike): string {
  const { mkdirSync } = process.getBuiltinModule('node:fs');
  const { tmpdir } = process.getBuiltinModule('node:os');
  const pathModule = process.getBuiltinModule('node:path');
  const override = resolveStorageEnvironment().weftDefaultStoragePath;
  const storagePath =
    override !== undefined && override.length > 0
      ? override
      : pathModule.join(tmpdir(), 'weft-default', `${projectStorageHash(runtimeGlobals)}.db`);
  mkdirSync(pathModule.dirname(storagePath), { recursive: true });
  return storagePath;
}

function describeGlobal(
  runtimeGlobals: RuntimeGlobalsLike,
  name: 'Bun' | 'process' | 'browser.storage',
): string {
  if (name === 'Bun') {
    return typeof runtimeGlobals.Bun;
  }
  if (name === 'browser.storage') {
    return typeof (runtimeGlobals.browser?.storage ?? runtimeGlobals.chrome?.storage);
  }
  return typeof runtimeGlobals.process;
}

function resolveWebExtensionNamespace(runtimeGlobals: RuntimeGlobalsLike): {
  readonly storage?: unknown;
} {
  if (runtimeGlobals.browser?.storage !== undefined) {
    return runtimeGlobals.browser;
  }

  if (runtimeGlobals.chrome?.storage !== undefined) {
    return runtimeGlobals.chrome;
  }

  return {};
}

function resolveIndexedDbRuntime(runtimeGlobals: RuntimeGlobalsLike): {
  indexedDB: Pick<typeof indexedDB, 'open'>;
  IDBKeyRange: Pick<typeof IDBKeyRange, 'bound'>;
} {
  const indexedDbFactory = runtimeGlobals.indexedDB;
  const keyRangeFactory = runtimeGlobals.IDBKeyRange;
  if (indexedDbFactory === undefined || keyRangeFactory === undefined) {
    throw new Error(
      'resolveDefaultStorage: IndexedDB resolution requires both indexedDB and IDBKeyRange.',
    );
  }
  return {
    indexedDB: indexedDbFactory as Pick<typeof indexedDB, 'open'>,
    IDBKeyRange: keyRangeFactory as Pick<typeof IDBKeyRange, 'bound'>,
  };
}

function describeIndexedDbSupport(runtimeGlobals: RuntimeGlobalsLike): string {
  const indexedDbType = typeof runtimeGlobals.indexedDB;
  const keyRangeType = typeof runtimeGlobals.IDBKeyRange;
  return `typeof indexedDB=${indexedDbType}, typeof IDBKeyRange=${keyRangeType}`;
}

/**
 * Resolve a runtime-appropriate persistent storage adapter.
 *
 * Bun and Node resolve to SQLite. WebExtension contexts resolve to
 * `WebExtensionStorage`; browser and Service Worker contexts with IndexedDB
 * resolve to `IndexedDBStorage`.
 *
 * @example
 * ```ts
 * import { Engine } from '@lostgradient/weft';
 * import { resolveDefaultStorage } from '@lostgradient/weft';
 *
 * await using storage = await resolveDefaultStorage();
 * await using engine = new Engine({ storage });
 * void engine;
 * ```
 */
export async function resolveDefaultStorage(
  runtimeGlobals: RuntimeGlobalsLike = globalThis,
): Promise<WeftStorage> {
  const detected = detectGlobals(runtimeGlobals);

  if (detected.hasBun) {
    return new BunSQLiteStorage(defaultSqlitePath(runtimeGlobals));
  }

  if (detected.hasNode) {
    return new NodeSQLiteStorage(defaultSqlitePath(runtimeGlobals));
  }

  if (detected.hasWebExtensionStorage) {
    return new WebExtensionStorage({}, resolveWebExtensionNamespace(runtimeGlobals));
  }

  if (detected.hasIndexedDB) {
    return new IndexedDBStorage('weft', resolveIndexedDbRuntime(runtimeGlobals));
  }

  throw new Error(
    'resolveDefaultStorage: requires Bun, Node, WebExtension storage, or IndexedDB. ' +
      `Detected: typeof Bun=${describeGlobal(runtimeGlobals, 'Bun')}, ` +
      `typeof process=${describeGlobal(runtimeGlobals, 'process')}, ` +
      `typeof browser.storage=${describeGlobal(runtimeGlobals, 'browser.storage')}, ` +
      `${describeIndexedDbSupport(runtimeGlobals)}.`,
  );
}

/**
 * Runtime-detected default storage backend.
 *
 * Imported via `@lostgradient/weft/storage/auto`. Resolves a persistent
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
 * @module @lostgradient/weft/storage/auto
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

async function projectStorageHash(runtimeGlobals: RuntimeGlobalsLike): Promise<string> {
  const { createHash } = await import('node:crypto');
  const cwd = runtimeGlobals.process?.cwd?.() ?? 'weft-default';
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

async function defaultSqlitePath(runtimeGlobals: RuntimeGlobalsLike): Promise<string> {
  const [{ mkdirSync }, { tmpdir }, pathModule] = await Promise.all([
    import('node:fs'),
    import('node:os'),
    import('node:path'),
  ]);
  const override = runtimeGlobals.process?.env?.['WEFT_DEFAULT_STORAGE_PATH'];
  const storagePath =
    override !== undefined && override.length > 0
      ? override
      : pathModule.join(tmpdir(), 'weft-default', `${await projectStorageHash(runtimeGlobals)}.db`);
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

function storageModuleSpecifier(sourceSpecifier: string, buildSpecifier: string): string {
  return import.meta.url.endsWith('.ts') ? sourceSpecifier : buildSpecifier;
}

async function importStorageModule<Module>(specifier: string): Promise<Module> {
  return (await import(specifier)) as Module;
}

function resolveWebExtensionNamespace(runtimeGlobals: RuntimeGlobalsLike): {
  readonly storage?: unknown;
} {
  return runtimeGlobals.browser ?? runtimeGlobals.chrome ?? {};
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

const BUN_SQLITE_STORAGE_MODULE = storageModuleSpecifier('./bun-sql.ts', './bun-sql.js');
const NODE_SQLITE_STORAGE_MODULE = storageModuleSpecifier('./node-sqlite.ts', './node-sqlite.js');
const INDEXEDDB_STORAGE_MODULE = storageModuleSpecifier('./indexeddb.ts', './indexeddb.js');
const WEB_EXTENSION_STORAGE_MODULE = storageModuleSpecifier(
  './web-extension.ts',
  './web-extension.js',
);

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
 * import { resolveDefaultStorage } from '@lostgradient/weft/storage/auto';
 *
 * await using storage = await resolveDefaultStorage();
 * await using engine = new Engine({ storage });
 * void engine;
 * ```
 */
export async function resolveDefaultStorage(
  runtimeGlobals: RuntimeGlobalsLike = globalThis as RuntimeGlobalsLike,
): Promise<WeftStorage> {
  const detected = detectGlobals(runtimeGlobals);

  if (detected.hasBun) {
    const { BunSQLiteStorage } =
      await importStorageModule<typeof import('./bun-sql.ts')>(BUN_SQLITE_STORAGE_MODULE);
    return new BunSQLiteStorage(await defaultSqlitePath(runtimeGlobals));
  }

  if (detected.hasNode) {
    const { NodeSQLiteStorage } = await importStorageModule<typeof import('./node-sqlite.ts')>(
      NODE_SQLITE_STORAGE_MODULE,
    );
    return new NodeSQLiteStorage(await defaultSqlitePath(runtimeGlobals));
  }

  if (detected.hasWebExtensionStorage) {
    const { WebExtensionStorage } = await importStorageModule<typeof import('./web-extension.ts')>(
      WEB_EXTENSION_STORAGE_MODULE,
    );
    return new WebExtensionStorage({}, resolveWebExtensionNamespace(runtimeGlobals));
  }

  if (detected.hasIndexedDB) {
    const { IndexedDBStorage } =
      await importStorageModule<typeof import('./indexeddb.ts')>(INDEXEDDB_STORAGE_MODULE);
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

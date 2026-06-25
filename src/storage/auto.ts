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

interface DetectionGlobals {
  hasBun: boolean;
  hasIndexedDB: boolean;
  hasNode: boolean;
  hasWebExtensionStorage: boolean;
}

function detectGlobals(): DetectionGlobals {
  const webExtensionGlobal = globalThis as typeof globalThis & {
    browser?: { storage?: unknown };
    chrome?: { storage?: unknown };
  };
  return {
    hasBun: typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined',
    hasIndexedDB: typeof globalThis.indexedDB !== 'undefined',
    hasNode:
      typeof process !== 'undefined' &&
      typeof (process as { versions?: { node?: unknown } }).versions?.node === 'string',
    hasWebExtensionStorage:
      webExtensionGlobal.browser?.storage !== undefined ||
      webExtensionGlobal.chrome?.storage !== undefined,
  };
}

async function projectStorageHash(): Promise<string> {
  const { createHash } = await import('node:crypto');
  const cwd = typeof process !== 'undefined' ? process.cwd() : 'weft-default';
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

async function defaultSqlitePath(): Promise<string> {
  const [{ mkdirSync }, { tmpdir }, pathModule] = await Promise.all([
    import('node:fs'),
    import('node:os'),
    import('node:path'),
  ]);
  const override =
    typeof process !== 'undefined' ? process.env['WEFT_DEFAULT_STORAGE_PATH'] : undefined;
  const storagePath =
    override !== undefined && override.length > 0
      ? override
      : pathModule.join(tmpdir(), 'weft-default', `${await projectStorageHash()}.db`);
  mkdirSync(pathModule.dirname(storagePath), { recursive: true });
  return storagePath;
}

function describeGlobal(name: 'Bun' | 'process' | 'browser.storage' | 'indexedDB'): string {
  if (name === 'Bun') {
    return typeof (globalThis as { Bun?: unknown }).Bun;
  }
  if (name === 'indexedDB') {
    return typeof globalThis.indexedDB;
  }
  if (name === 'browser.storage') {
    const webExtensionGlobal = globalThis as typeof globalThis & {
      browser?: { storage?: unknown };
      chrome?: { storage?: unknown };
    };
    return typeof (webExtensionGlobal.browser?.storage ?? webExtensionGlobal.chrome?.storage);
  }
  return typeof process;
}

function storageModuleSpecifier(sourceSpecifier: string, buildSpecifier: string): string {
  return import.meta.url.endsWith('.ts') ? sourceSpecifier : buildSpecifier;
}

async function importStorageModule<Module>(specifier: string): Promise<Module> {
  return (await import(specifier)) as Module;
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
export async function resolveDefaultStorage(): Promise<WeftStorage> {
  const detected = detectGlobals();

  if (detected.hasBun) {
    const { BunSQLiteStorage } =
      await importStorageModule<typeof import('./bun-sql.ts')>(BUN_SQLITE_STORAGE_MODULE);
    return new BunSQLiteStorage(await defaultSqlitePath());
  }

  if (detected.hasNode) {
    const { NodeSQLiteStorage } = await importStorageModule<typeof import('./node-sqlite.ts')>(
      NODE_SQLITE_STORAGE_MODULE,
    );
    return new NodeSQLiteStorage(await defaultSqlitePath());
  }

  if (detected.hasWebExtensionStorage) {
    const { WebExtensionStorage } = await importStorageModule<typeof import('./web-extension.ts')>(
      WEB_EXTENSION_STORAGE_MODULE,
    );
    return new WebExtensionStorage();
  }

  if (detected.hasIndexedDB) {
    const { IndexedDBStorage } =
      await importStorageModule<typeof import('./indexeddb.ts')>(INDEXEDDB_STORAGE_MODULE);
    return new IndexedDBStorage();
  }

  throw new Error(
    'resolveDefaultStorage: requires Bun, Node, WebExtension storage, or IndexedDB. ' +
      `Detected: typeof Bun=${describeGlobal('Bun')}, ` +
      `typeof process=${describeGlobal('process')}, ` +
      `typeof browser.storage=${describeGlobal('browser.storage')}, ` +
      `typeof indexedDB=${describeGlobal('indexedDB')}.`,
  );
}

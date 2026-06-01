/**
 * Runtime-detected default storage backend for **Bun and Node** processes.
 *
 * Imported via `@lostgradient/weft/storage/auto`. Resolves a persistent storage
 * adapter appropriate for the current runtime:
 *
 *   1. Bun → `BunSQLiteStorage`
 *   2. Node → `NodeSQLiteStorage`
 *   3. otherwise → throw
 *
 * Path policy:
 *   - `process.env.WEFT_DEFAULT_STORAGE_PATH` if set
 *   - else `${tmpdir()}/weft-default/<cwd-hash>.db`
 *
 * The parent directory is created (recursive) before the path is returned.
 *
 * **Not for browsers.** This module statically imports `node:fs`,
 * `node:os`, `node:path`, and `node:crypto`, so bundling it into a
 * browser target will fail. Browser/Service Worker contexts should use
 * `IndexedDBStorage` directly (or `setupServiceWorker()` from
 * `@lostgradient/weft/service-worker`, which constructs IndexedDB internally).
 *
 * `resolveDefaultStorage()` is for developer convenience. Production
 * deployments should pick an explicit adapter and pass it to
 * `new Engine({ storage })`.
 *
 * @module @lostgradient/weft/storage/auto
 */

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { Storage as WeftStorage } from './interface.ts';

interface DetectionGlobals {
  hasBun: boolean;
  hasNode: boolean;
}

function detectGlobals(): DetectionGlobals {
  return {
    hasBun: typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined',
    hasNode:
      typeof process !== 'undefined' &&
      typeof (process as { versions?: { node?: unknown } }).versions?.node === 'string',
  };
}

function projectStorageHash(): string {
  const cwd = typeof process !== 'undefined' ? process.cwd() : 'weft-default';
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

function defaultSqlitePath(): string {
  const override =
    typeof process !== 'undefined' ? process.env['WEFT_DEFAULT_STORAGE_PATH'] : undefined;
  const path =
    override !== undefined && override.length > 0
      ? override
      : join(tmpdir(), 'weft-default', `${projectStorageHash()}.db`);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

function describeGlobal(name: 'Bun' | 'process'): string {
  if (name === 'Bun') {
    return typeof (globalThis as { Bun?: unknown }).Bun;
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

/**
 * Resolve a runtime-appropriate persistent storage adapter for Bun or
 * Node. Throws in browser/Service Worker contexts (and any environment
 * that exposes neither `Bun` nor a Node-shaped `process`).
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
    return new BunSQLiteStorage(defaultSqlitePath());
  }

  if (detected.hasNode) {
    const { NodeSQLiteStorage } = await importStorageModule<typeof import('./node-sqlite.ts')>(
      NODE_SQLITE_STORAGE_MODULE,
    );
    return new NodeSQLiteStorage(defaultSqlitePath());
  }

  throw new Error(
    'resolveDefaultStorage: requires Bun or Node. ' +
      `Detected: typeof Bun=${describeGlobal('Bun')}, typeof process=${describeGlobal('process')}. ` +
      'In browser/Service Worker contexts, use `IndexedDBStorage` directly ' +
      'or `setupServiceWorker()` from `@lostgradient/weft/service-worker`.',
  );
}

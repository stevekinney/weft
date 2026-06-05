/**
 * Declarative storage configuration types and the `ResolvedStorage` mapping.
 * Split out from `resolve.ts` so that module stays focused on the runtime
 * resolver/validator logic; the public `@lostgradient/weft/storage/resolve`
 * subpath re-exports everything here, so these types keep their documented
 * import path.
 *
 * @module storage/storage-configuration
 */

import type { HTTPStorage } from './http.ts';
import type { IndexedDBStorage } from './indexeddb.ts';
import type { Storage } from './interface.ts';
import type { LMDBStorage } from './lmdb.ts';
import type { MemoryStorage } from './memory.ts';
import type { NeonStorage } from './neon.ts';
import type { SQLiteStorageInstance } from './sqlite.ts';
import type { TursoStorage } from './turso.ts';
import type { WebExtensionStorage } from './web-extension.ts';

/**
 * Runtime configuration for in-memory storage.
 *
 * @example
 * ```ts
 * import { resolveStorage, type MemoryStorageConfiguration } from '@lostgradient/weft/storage/resolve';
 *
 * const configuration: MemoryStorageConfiguration = { type: 'memory' };
 * const storage = await resolveStorage(configuration);
 * void storage;
 * ```
 */
export type MemoryStorageConfiguration = {
  type: 'memory';
};

/**
 * Runtime configuration for SQLite storage.
 *
 * @example
 * ```ts
 * import { resolveStorage, type SQLiteStorageConfiguration } from '@lostgradient/weft/storage/resolve';
 *
 * const configuration: SQLiteStorageConfiguration = { type: 'sqlite', path: './weft.db' };
 * const storage = await resolveStorage(configuration);
 * void storage;
 * ```
 */
export type SQLiteStorageConfiguration = {
  type: 'sqlite';
  path?: string;
};

/**
 * Runtime configuration for LMDB storage.
 *
 * @example
 * ```ts
 * import { resolveStorage, type LMDBStorageConfiguration } from '@lostgradient/weft/storage/resolve';
 *
 * const configuration: LMDBStorageConfiguration = { type: 'lmdb', path: './weft-data' };
 * const storage = await resolveStorage(configuration);
 * void storage;
 * ```
 */
export type LMDBStorageConfiguration = {
  type: 'lmdb';
  path: string;
};

/**
 * Runtime configuration for Turso/libSQL storage.
 *
 * @example
 * ```ts
 * import { resolveStorage, type TursoStorageConfiguration } from '@lostgradient/weft/storage/resolve';
 *
 * const configuration: TursoStorageConfiguration = { type: 'turso', url: 'file:weft.db' };
 * const storage = await resolveStorage(configuration);
 * void storage;
 * ```
 */
export type TursoStorageConfiguration = {
  type: 'turso';
  url: string;
  authToken?: string;
};

/**
 * Runtime configuration for Neon (or any Postgres) storage.
 *
 * @example
 * ```ts
 * import { resolveStorage, type NeonStorageConfiguration } from '@lostgradient/weft/storage/resolve';
 *
 * const configuration: NeonStorageConfiguration = {
 *   type: 'neon',
 *   url: 'postgresql://user:password@host.neon.tech/weft?sslmode=require',
 * };
 * const storage = await resolveStorage(configuration);
 * void storage;
 * ```
 */
export type NeonStorageConfiguration = {
  type: 'neon';
  url: string;
};

/**
 * Runtime configuration for browser IndexedDB storage.
 *
 * @example
 * ```ts
 * import { resolveStorage, type IndexedDBStorageConfiguration } from '@lostgradient/weft/storage/resolve';
 *
 * const configuration: IndexedDBStorageConfiguration = { type: 'indexeddb', databaseName: 'weft' };
 * const storage = await resolveStorage(configuration);
 * void storage;
 * ```
 */
export type IndexedDBStorageConfiguration = {
  type: 'indexeddb';
  databaseName?: string;
};

/**
 * Runtime configuration for WebExtension storage.
 *
 * @example
 * ```ts
 * import { resolveStorage, type WebExtensionStorageConfiguration } from '@lostgradient/weft/storage/resolve';
 *
 * const configuration: WebExtensionStorageConfiguration = { type: 'web-extension', area: 'local' };
 * const storage = await resolveStorage(configuration);
 * void storage;
 * ```
 */
export type WebExtensionStorageConfiguration = {
  type: 'web-extension';
  area?: 'local' | 'sync' | 'session' | 'managed';
};

/**
 * Runtime configuration for remote HTTP storage.
 *
 * @example
 * ```ts
 * import { resolveStorage, type HTTPStorageConfiguration } from '@lostgradient/weft/storage/resolve';
 *
 * const configuration: HTTPStorageConfiguration = { type: 'http', baseUrl: 'https://weft.example.com' };
 * const storage = await resolveStorage(configuration);
 * void storage;
 * ```
 */
export type HTTPStorageConfiguration = {
  type: 'http';
  baseUrl: string | URL;
  headers?: Record<string, string>;
};

/**
 * Runtime configuration for automatic storage selection.
 *
 * @example
 * ```ts
 * import { resolveStorage, type AutoStorageConfiguration } from '@lostgradient/weft/storage/resolve';
 *
 * const configuration: AutoStorageConfiguration = { type: 'auto' };
 * const storage = await resolveStorage(configuration);
 * void storage;
 * ```
 */
export type AutoStorageConfiguration = {
  type: 'auto';
};

/**
 * Union of supported runtime-driven storage configurations.
 *
 * @example
 * ```ts
 * import { resolveStorage, type StorageConfiguration } from '@lostgradient/weft/storage/resolve';
 *
 * const configuration: StorageConfiguration = { type: 'memory' };
 * const storage = await resolveStorage(configuration);
 * void storage;
 * ```
 */
export type StorageConfiguration =
  | MemoryStorageConfiguration
  | SQLiteStorageConfiguration
  | LMDBStorageConfiguration
  | TursoStorageConfiguration
  | NeonStorageConfiguration
  | IndexedDBStorageConfiguration
  | WebExtensionStorageConfiguration
  | HTTPStorageConfiguration
  | AutoStorageConfiguration;

/** Discriminant union of every supported `StorageConfiguration` `type`. */
export type StorageConfigurationType = StorageConfiguration['type'];

/**
 * Storage adapter type resolved for a concrete {@link StorageConfiguration}.
 *
 * Use this when a configuration value is already narrowed and downstream code
 * needs the adapter-specific instance type that {@link resolveStorage} returns.
 *
 * @example
 * ```ts
 * import type { HTTPStorageConfiguration, ResolvedStorage } from '@lostgradient/weft/storage/resolve';
 *
 * type RemoteStorage = ResolvedStorage<HTTPStorageConfiguration>;
 * declare const storage: RemoteStorage;
 * void storage;
 * ```
 */
export type ResolvedStorage<Configuration extends StorageConfiguration> =
  Configuration extends MemoryStorageConfiguration
    ? MemoryStorage
    : Configuration extends SQLiteStorageConfiguration
      ? SQLiteStorageInstance
      : Configuration extends LMDBStorageConfiguration
        ? LMDBStorage
        : Configuration extends TursoStorageConfiguration
          ? TursoStorage
          : Configuration extends NeonStorageConfiguration
            ? NeonStorage
            : Configuration extends IndexedDBStorageConfiguration
              ? IndexedDBStorage
              : Configuration extends WebExtensionStorageConfiguration
                ? WebExtensionStorage
                : Configuration extends HTTPStorageConfiguration
                  ? HTTPStorage
                  : Storage;

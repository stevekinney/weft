import type { HTTPStorage } from './http.ts';
import type { IndexedDBStorage } from './indexeddb.ts';
import type { Storage } from './interface.ts';
import type { LMDBStorage } from './lmdb.ts';
import { MemoryStorage } from './memory.ts';
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
  | IndexedDBStorageConfiguration
  | WebExtensionStorageConfiguration
  | HTTPStorageConfiguration
  | AutoStorageConfiguration;

type StorageConfigurationType = StorageConfiguration['type'];

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
          : Configuration extends IndexedDBStorageConfiguration
            ? IndexedDBStorage
            : Configuration extends WebExtensionStorageConfiguration
              ? WebExtensionStorage
              : Configuration extends HTTPStorageConfiguration
                ? HTTPStorage
                : Storage;

type StorageResolverMap = {
  [Type in StorageConfigurationType]: (
    configuration: Extract<StorageConfiguration, { type: Type }>,
  ) => Promise<Storage>;
};

type StorageConfigurationValidatorMap = {
  [Type in StorageConfigurationType]: (
    configuration: Record<string, unknown>,
  ) => Extract<StorageConfiguration, { type: Type }>;
};

function storageModuleSpecifier(sourceSpecifier: string, buildSpecifier: string): string {
  return import.meta.url.endsWith('.ts') ? sourceSpecifier : buildSpecifier;
}

async function importStorageModule<Module>(specifier: string): Promise<Module> {
  return (await import(specifier)) as Module;
}

const BUN_SQLITE_STORAGE_MODULE = storageModuleSpecifier('./bun-sql.ts', './bun-sql.js');
const NODE_SQLITE_STORAGE_MODULE = storageModuleSpecifier('./node-sqlite.ts', './node-sqlite.js');
const LMDB_STORAGE_MODULE = storageModuleSpecifier('./lmdb.ts', './lmdb.js');
const TURSO_STORAGE_MODULE = storageModuleSpecifier('./turso.ts', './turso.js');
const INDEXEDDB_STORAGE_MODULE = storageModuleSpecifier('./indexeddb.ts', './indexeddb.js');
const WEB_EXTENSION_STORAGE_MODULE = storageModuleSpecifier(
  './web-extension.ts',
  './web-extension.js',
);
const HTTP_STORAGE_MODULE = storageModuleSpecifier('./http.ts', './http.js');
const AUTO_STORAGE_MODULE = storageModuleSpecifier('./auto.ts', './auto.js');

function isBunRuntime(): boolean {
  return typeof Bun !== 'undefined';
}

function isNodeRuntime(): boolean {
  return (
    typeof globalThis.process === 'object' &&
    globalThis.process !== null &&
    typeof globalThis.process.versions === 'object' &&
    typeof globalThis.process.versions.node === 'string'
  );
}

function hasWebExtensionStorage(): boolean {
  const candidate = globalThis as typeof globalThis & {
    browser?: { storage?: unknown };
    chrome?: { storage?: unknown };
  };
  return candidate.browser?.storage !== undefined || candidate.chrome?.storage !== undefined;
}

function hasIndexedDB(): boolean {
  return typeof globalThis.indexedDB !== 'undefined';
}

async function resolveSQLiteStorage(path?: string): Promise<Storage> {
  if (isBunRuntime()) {
    const { BunSQLiteStorage } =
      await importStorageModule<typeof import('./bun-sql.ts')>(BUN_SQLITE_STORAGE_MODULE);
    return new BunSQLiteStorage(path);
  }

  if (isNodeRuntime()) {
    const { NodeSQLiteStorage } = await importStorageModule<typeof import('./node-sqlite.ts')>(
      NODE_SQLITE_STORAGE_MODULE,
    );
    return new NodeSQLiteStorage(path);
  }

  throw new Error('SQLite storage is only available in Bun or Node runtimes.');
}

async function resolveAutoStorage(): Promise<Storage> {
  if (isBunRuntime() || isNodeRuntime()) {
    const { resolveDefaultStorage } =
      await importStorageModule<typeof import('./auto.ts')>(AUTO_STORAGE_MODULE);
    return resolveDefaultStorage();
  }

  if (hasWebExtensionStorage()) {
    const { WebExtensionStorage } = await importStorageModule<typeof import('./web-extension.ts')>(
      WEB_EXTENSION_STORAGE_MODULE,
    );
    return new WebExtensionStorage();
  }

  if (hasIndexedDB()) {
    const { IndexedDBStorage } =
      await importStorageModule<typeof import('./indexeddb.ts')>(INDEXEDDB_STORAGE_MODULE);
    return new IndexedDBStorage();
  }

  return new MemoryStorage();
}

const storageResolvers = {
  memory: async (_configuration: MemoryStorageConfiguration) => new MemoryStorage(),
  sqlite: async (configuration: SQLiteStorageConfiguration) =>
    resolveSQLiteStorage(configuration.path),
  lmdb: async (configuration: LMDBStorageConfiguration) => {
    const { LMDBStorage } =
      await importStorageModule<typeof import('./lmdb.ts')>(LMDB_STORAGE_MODULE);
    return new LMDBStorage(configuration.path);
  },
  turso: async (configuration: TursoStorageConfiguration) => {
    const { TursoStorage } =
      await importStorageModule<typeof import('./turso.ts')>(TURSO_STORAGE_MODULE);
    return new TursoStorage({
      url: configuration.url,
      ...(configuration.authToken === undefined ? {} : { authToken: configuration.authToken }),
    });
  },
  indexeddb: async (configuration: IndexedDBStorageConfiguration) => {
    const { IndexedDBStorage } =
      await importStorageModule<typeof import('./indexeddb.ts')>(INDEXEDDB_STORAGE_MODULE);
    return new IndexedDBStorage(configuration.databaseName);
  },
  'web-extension': async (configuration: WebExtensionStorageConfiguration) => {
    const { WebExtensionStorage } = await importStorageModule<typeof import('./web-extension.ts')>(
      WEB_EXTENSION_STORAGE_MODULE,
    );
    return new WebExtensionStorage(
      configuration.area === undefined ? {} : { area: configuration.area },
    );
  },
  http: async (configuration: HTTPStorageConfiguration) => {
    const { HTTPStorage } =
      await importStorageModule<typeof import('./http.ts')>(HTTP_STORAGE_MODULE);
    return new HTTPStorage({
      baseUrl: configuration.baseUrl,
      ...(configuration.headers === undefined ? {} : { headers: configuration.headers }),
    });
  },
  auto: async (_configuration: AutoStorageConfiguration) => resolveAutoStorage(),
} satisfies StorageResolverMap;

function readStorageConfigurationType(configuration: unknown): string {
  if (typeof configuration !== 'object' || configuration === null) {
    return 'unknown';
  }

  if (!('type' in configuration)) {
    return 'unknown';
  }

  return typeof configuration.type === 'string' ? configuration.type : 'unknown';
}

function readRecord(configuration: unknown): Record<string, unknown> {
  if (typeof configuration !== 'object' || configuration === null || Array.isArray(configuration)) {
    throw new Error('Storage configuration must be an object.');
  }
  return configuration as Record<string, unknown>;
}

function readRequiredString(
  configuration: Record<string, unknown>,
  field: string,
  backendName: string,
): string {
  const value = configuration[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${backendName} storage configuration requires "${field}" as a string.`);
  }
  return value;
}

function readOptionalString(
  configuration: Record<string, unknown>,
  field: string,
  backendName: string,
): string | undefined {
  const value = configuration[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`${backendName} storage configuration field "${field}" must be a string.`);
  }
  return value;
}

function readRequiredStringOrUrl(
  configuration: Record<string, unknown>,
  field: string,
  backendName: string,
): string | URL {
  const value = configuration[field];
  if (typeof value === 'string' || value instanceof URL) return value;
  throw new Error(`${backendName} storage configuration requires "${field}" as a string or URL.`);
}

function readOptionalHeaders(
  configuration: Record<string, unknown>,
): Record<string, string> | undefined {
  const value = configuration['headers'];
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('HTTP storage configuration field "headers" must be a string record.');
  }

  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== 'string') {
      throw new Error('HTTP storage configuration field "headers" must be a string record.');
    }
    headers[key] = headerValue;
  }
  return headers;
}

function readWebExtensionArea(
  configuration: Record<string, unknown>,
): WebExtensionStorageConfiguration['area'] {
  const value = configuration['area'];
  if (value === undefined) return undefined;
  if (value === 'local' || value === 'sync' || value === 'session' || value === 'managed') {
    return value;
  }
  throw new Error(
    'WebExtension storage configuration field "area" must be one of local, sync, session, or managed.',
  );
}

const storageConfigurationValidators = {
  memory: (_configuration) => ({ type: 'memory' }),
  sqlite: (configuration) => {
    const path = readOptionalString(configuration, 'path', 'SQLite');
    return path === undefined ? { type: 'sqlite' } : { type: 'sqlite', path };
  },
  lmdb: (configuration) => ({
    type: 'lmdb',
    path: readRequiredString(configuration, 'path', 'LMDB'),
  }),
  turso: (configuration) => {
    const authToken = readOptionalString(configuration, 'authToken', 'Turso');
    return {
      type: 'turso',
      url: readRequiredString(configuration, 'url', 'Turso'),
      ...(authToken === undefined ? {} : { authToken }),
    };
  },
  indexeddb: (configuration) => {
    const databaseName = readOptionalString(configuration, 'databaseName', 'IndexedDB');
    return databaseName === undefined ? { type: 'indexeddb' } : { type: 'indexeddb', databaseName };
  },
  'web-extension': (configuration) => {
    const area = readWebExtensionArea(configuration);
    return area === undefined ? { type: 'web-extension' } : { type: 'web-extension', area };
  },
  http: (configuration) => {
    const headers = readOptionalHeaders(configuration);
    return {
      type: 'http',
      baseUrl: readRequiredStringOrUrl(configuration, 'baseUrl', 'HTTP'),
      ...(headers === undefined ? {} : { headers }),
    };
  },
  auto: (_configuration) => ({ type: 'auto' }),
} satisfies StorageConfigurationValidatorMap;

function validateStorageConfiguration(
  configuration: unknown,
  type: StorageConfigurationType,
): StorageConfiguration {
  return storageConfigurationValidators[type](readRecord(configuration));
}

function isStorageConfigurationType(value: string): value is StorageConfigurationType {
  return Object.hasOwn(storageResolvers, value);
}

/**
 * Resolve a storage backend from runtime configuration.
 *
 * The helper lazy-loads backends so optional native dependencies are only
 * required when their configuration is selected.
 *
 * @example
 * ```ts
 * import { resolveStorage } from '@lostgradient/weft/storage/resolve';
 *
 * const storage = await resolveStorage({ type: 'sqlite', path: './weft.db' });
 * void storage;
 * ```
 */
export function resolveStorage<Configuration extends StorageConfiguration>(
  configuration: Configuration,
): Promise<ResolvedStorage<Configuration>>;
export async function resolveStorage(configuration: StorageConfiguration): Promise<Storage> {
  const type = readStorageConfigurationType(configuration);
  if (!isStorageConfigurationType(type)) {
    throw new Error(`Unsupported storage configuration type: ${type}`);
  }

  const validatedConfiguration = validateStorageConfiguration(configuration, type);
  const resolver = storageResolvers[type] as (value: StorageConfiguration) => Promise<Storage>;
  return resolver(validatedConfiguration);
}

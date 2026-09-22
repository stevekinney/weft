import { resolveDefaultStorage } from './auto.ts';
import { BunSQLiteStorage } from './bun-sql.ts';
import { HTTPStorage } from './http.ts';
import { IndexedDBStorage } from './indexeddb.ts';
import type { Storage } from './interface.ts';
import { LMDBStorage } from './lmdb.ts';
import { MemoryStorage } from './memory.ts';
import { NeonStorage } from './neon.ts';
import { NodeSQLiteStorage } from './node-sqlite.ts';
import type {
  AutoStorageConfiguration,
  HTTPStorageConfiguration,
  IndexedDBStorageConfiguration,
  LMDBStorageConfiguration,
  MemoryStorageConfiguration,
  NeonStorageConfiguration,
  ResolvedStorage,
  SQLiteStorageConfiguration,
  StorageConfiguration,
  StorageConfigurationType,
  TursoStorageConfiguration,
  WebExtensionStorageConfiguration,
} from './storage-configuration.ts';
import { TursoStorage } from './turso.ts';
import { WebExtensionStorage } from './web-extension.ts';

export type {
  AutoStorageConfiguration,
  HTTPStorageConfiguration,
  IndexedDBStorageConfiguration,
  LMDBStorageConfiguration,
  MemoryStorageConfiguration,
  NeonStorageConfiguration,
  ResolvedStorage,
  SQLiteStorageConfiguration,
  StorageConfiguration,
  StorageConfigurationType,
  TursoStorageConfiguration,
  WebExtensionStorageConfiguration,
} from './storage-configuration.ts';

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
    return new BunSQLiteStorage(path);
  }

  if (isNodeRuntime()) {
    return new NodeSQLiteStorage(path);
  }

  throw new Error('SQLite storage is only available in Bun or Node runtimes.');
}

async function resolveAutoStorage(): Promise<Storage> {
  if (isBunRuntime() || isNodeRuntime()) {
    return resolveDefaultStorage();
  }

  if (hasWebExtensionStorage()) {
    return new WebExtensionStorage();
  }

  if (hasIndexedDB()) {
    return new IndexedDBStorage();
  }

  return new MemoryStorage();
}

const storageResolvers = {
  memory: async (_configuration: MemoryStorageConfiguration) => new MemoryStorage(),
  sqlite: async (configuration: SQLiteStorageConfiguration) =>
    resolveSQLiteStorage(configuration.path),
  lmdb: async (configuration: LMDBStorageConfiguration) => {
    return new LMDBStorage(
      configuration.path,
      configuration.durability === undefined ? {} : { durability: configuration.durability },
    );
  },
  turso: async (configuration: TursoStorageConfiguration) => {
    return new TursoStorage({
      url: configuration.url,
      ...(configuration.authToken === undefined ? {} : { authToken: configuration.authToken }),
    });
  },
  neon: async (configuration: NeonStorageConfiguration) => {
    return new NeonStorage({ url: configuration.url });
  },
  indexeddb: async (configuration: IndexedDBStorageConfiguration) => {
    return new IndexedDBStorage(configuration.databaseName);
  },
  'web-extension': async (configuration: WebExtensionStorageConfiguration) => {
    return new WebExtensionStorage(
      configuration.area === undefined ? {} : { area: configuration.area },
    );
  },
  http: async (configuration: HTTPStorageConfiguration) => {
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

function readLmdbDurability(
  configuration: Record<string, unknown>,
): LMDBStorageConfiguration['durability'] {
  const value = configuration['durability'];
  if (value === undefined) return undefined;
  if (value === 'full' || value === 'relaxed') {
    return value;
  }
  throw new Error('LMDB storage configuration field "durability" must be one of full or relaxed.');
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
  lmdb: (configuration) => {
    const durability = readLmdbDurability(configuration);
    return {
      type: 'lmdb',
      path: readRequiredString(configuration, 'path', 'LMDB'),
      ...(durability === undefined ? {} : { durability }),
    };
  },
  turso: (configuration) => {
    const authToken = readOptionalString(configuration, 'authToken', 'Turso');
    return {
      type: 'turso',
      url: readRequiredString(configuration, 'url', 'Turso'),
      ...(authToken === undefined ? {} : { authToken }),
    };
  },
  neon: (configuration) => ({
    type: 'neon',
    url: readRequiredString(configuration, 'url', 'Neon'),
  }),
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
 * import { resolveStorage } from '@lostgradient/weft';
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

# Storage API

Weft's storage layer is a key-value interface with ordered range scans and atomic batch writes. `SQLiteStorage` is the default durable backend, and `MemoryStorage` is the test and ephemeral backend. All storage adapters implement the `Storage` interface.

## `Storage` Interface

```ts partial
interface Storage extends Disposable {
  capabilities(): StorageCapabilities;
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]>;
  batch(operations: BatchOperation[]): Promise<void>;
  query?<T>(sql: string, params?: unknown[]): Promise<T[]>;
}
```

### `capabilities()`

```ts partial
capabilities(): StorageCapabilities
```

Required on every adapter. Returns the backend's honest consistency and feature profile. The engine reads this to decide what is safe; `conditionalBatch` is enforced at runtime via `requireStorageCapability`. See [`StorageCapabilities`](#storagecapabilities) and the [Consistency & capabilities](../guides/storage.md#consistency-capabilities) guide.

### `get()`

```ts partial
get(key: string): Promise<Uint8Array | null>
```

Retrieve a value by exact key. Returns `null` if the key does not exist.

### `put()`

```ts partial
put(key: string, value: Uint8Array): Promise<void>
```

Write a key-value pair. Overwrites any existing value at the same key.

### `delete()`

```ts partial
delete(key: string): Promise<void>
```

Remove a key-value pair. No-op if the key does not exist.

### `scan()`

```ts partial
scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]>
```

Iterate over all key-value pairs whose keys start with `prefix`, in lexicographic order. Returns an async iterable of `[key, value]` tuples.

### `batch()`

```ts partial
batch(operations: BatchOperation[]): Promise<void>
```

Execute multiple put/delete operations atomically. In `BunSQLiteStorage`, this runs inside a SQLite transaction.

### `query()` (optional)

```ts partial
query?<T>(sql: string, params?: unknown[]): Promise<T[]>
```

Raw SQL passthrough. Only available on `BunSQLiteStorage`. Useful for dashboard queries and debugging.

### `[Symbol.dispose]()`

All storage adapters implement `Disposable`. For `BunSQLiteStorage`, this closes the database. For `MemoryStorage`, this clears the in-memory map.

---

## Types

### `BatchOperation`

```ts partial
type BatchOperation =
  | { type: 'put'; key: string; value: Uint8Array }
  | { type: 'delete'; key: string };
```

### `StorageCapabilities`

```ts partial
type StorageCapabilities = {
  readAfterWrite: 'linearizable' | 'session' | 'eventual';
  scanConsistency: 'snapshot' | 'best-effort';
  atomicBatch: boolean;
  conditionalBatch: boolean;
  boundedRangeDelete: boolean;
};
```

The self-reported guarantee profile returned by [`capabilities()`](#capabilities). `conditionalBatch` is the only runtime-gated capability; `atomicBatch`/`readAfterWrite`/`scanConsistency` are trusted correctness contracts the engine does not verify, and `boundedRangeDelete` is an operational hint. The per-adapter matrix and the opaque-value invariant live in the [Consistency & capabilities](../guides/storage.md#consistency-capabilities) guide. Gate a feature with `requireStorageCapability(storage, 'conditionalBatch', featureName)`, whose capability parameter is typed [`GatedStorageCapabilityKey`](#gatedstoragecapabilitykey); it throws a clear diagnostic at first use when the capability is `false`.

### `GatedStorageCapabilityKey`

```ts partial
type GatedStorageCapabilityKey = 'conditionalBatch';
```

The boolean capabilities the engine enforces at runtime via `requireStorageCapability`. Today this is only `'conditionalBatch'`. It is deliberately narrower than "every boolean capability": `atomicBatch`/`readAfterWrite`/`scanConsistency` are trusted contracts and `boundedRangeDelete` is an operational hint, so gating on them would be meaningless. A future gated capability is added to this type by an explicit edit.

### `ScanOptions`

```ts
interface ScanOptions {
  limit?: number;
  reverse?: boolean;
  gt?: string;
  lt?: string;
  gte?: string;
  lte?: string;
}
```

| Field     | Type      | Description                            |
| --------- | --------- | -------------------------------------- |
| `limit`   | `number`  | Maximum number of entries to return    |
| `reverse` | `boolean` | Iterate in reverse lexicographic order |
| `gt`      | `string`  | Exclusive lower bound on key           |
| `lt`      | `string`  | Exclusive upper bound on key           |
| `gte`     | `string`  | Inclusive lower bound on key           |
| `lte`     | `string`  | Inclusive upper bound on key           |

---

## `KEYS`

```ts partial
const KEYS: {
  workflow: (id: string) => string;
  checkpoint: (id: string) => string;
  checkpointHistory: (id: string, step: number) => string;
  operation: (queue: string, scheduledAt: number, id: string) => string;
  operationInflight: (id: string) => string;
  event: (workflowId: string, sequence: number) => string;
  signal: (workflowId: string, name: string, id: string) => string;
  deadline: (deadline: number, workflowId: string) => string;
  attribute: (workflowId: string) => string;
  attributeIndex: (attributeName: string, encodedValue: string, workflowId: string) => string;
  update: (workflowId: string, updateId: string) => string;
  updateResponse: (updateId: string) => string;
  updateIdempotency: (workflowId: string, key: string) => string;
  budget: (namespace: string, period: string, date: string) => string;
  review: (workflowId: string, reviewId: string) => string;
  archive: (workflowId: string, key: string) => string;
  stateExecution: (ownerWorkflowId: string, key: string) => string;
  stateWorkflow: (workflowType: string, key: string) => string;
};
```

Key layout constants for hierarchical key encoding. All timestamps are zero-padded to 16 digits for correct lexicographic ordering. The `KEYS` object is the canonical source for key construction -- never hand-build keys.

```ts
import { KEYS } from 'weft';

const key = KEYS.workflow('my-workflow-id');
// => "wf:my-workflow-id"

const signalKey = KEYS.signal('wf-123', 'approval', 'sig-456');
// => "sig:wf-123:approval:sig-456"

const executionStateKey = KEYS.stateExecution('wf-123', 'counter');
// => "state:execution:wf-123:counter"
```

---

## `SQLiteStorage`

```ts partial
class SQLiteStorage implements Storage
```

SQLite-backed storage. The `weft/storage/sqlite` subpath resolves to `BunSQLiteStorage` under Bun and `NodeSQLiteStorage` under Node.js. Use `weft/storage/sqlite/bun` or `weft/storage/sqlite/node` when you need an explicit runtime override.

### Constructor

```ts partial
new SQLiteStorage(path?: string)
```

| Parameter | Type     | Default      | Description                                                                    |
| --------- | -------- | ------------ | ------------------------------------------------------------------------------ |
| `path`    | `string` | `':memory:'` | File path for the SQLite database. Use `':memory:'` for an in-memory database. |

The constructor automatically creates the `kv` table if it does not exist and configures SQLite pragmas:

- `journal_mode = WAL`
- `synchronous = NORMAL`
- `cache_size = -64000` (64 MB)

```ts
import { SQLiteStorage } from 'weft/storage/sqlite';

const storage = new SQLiteStorage('./data/weft.db');
```

### Methods

All methods from the `Storage` interface, plus:

#### `query()`

```ts partial
async query<T>(sql: string, parameters?: SQLQueryBindings[]): Promise<T[]>
```

Execute raw SQL against the underlying database. Returns all matching rows. This method is available on `BunSQLiteStorage` from `weft/storage/sqlite/bun`. The runtime-neutral `weft/storage/sqlite` type intentionally sticks to the common SQLite surface because it may resolve to `NodeSQLiteStorage`.

```ts partial
import { BunSQLiteStorage } from 'weft/storage/sqlite/bun';

const storage = new BunSQLiteStorage('./data/weft.db');
const rows = await storage.query<{ key: string }>('SELECT key FROM kv WHERE key LIKE ?', ['wf:%']);
```

#### `[Symbol.dispose]()`

Closes the SQLite database connection.

---

## `MemoryStorage`

```ts partial
class MemoryStorage implements Storage
```

In-memory storage backed by a `Map<string, Uint8Array>`. Ideal for tests, development, and short-lived workflows that do not need persistence.

### Constructor

```ts partial
new MemoryStorage();
```

No configuration needed.

### Methods

All methods from the `Storage` interface, plus:

#### `size` (getter)

```ts partial
get size(): number
```

Number of entries currently stored.

#### `clear()`

```ts partial
clear(): void
```

Remove all entries.

#### `has()`

```ts partial
has(key: string): Promise<boolean>
```

Check whether a key exists.

#### `keys()`

```ts partial
keys(prefix: string, options?: ScanOptions): AsyncIterable<string>
```

Iterate over all keys with the given prefix in lexicographic order.

#### `snapshot()`

```ts partial
snapshot(): Map<string, Uint8Array>
```

Return a deep copy of all stored data. Useful for test assertions and engine recovery simulations.

#### `[Symbol.dispose]()`

Clears all stored data.

---

## `IndexedDBStorage`

```ts partial
class IndexedDBStorage implements Storage
```

IndexedDB-backed storage for browser environments. Uses a single `kv` object store with string keys and `Uint8Array` values. Suitable for Service Worker deployments where the engine runs entirely in the browser.

```ts
import { IndexedDBStorage } from 'weft/storage/indexeddb';
```

Browser consumers should use browser-safe subpath imports such as `weft/storage/indexeddb` or `weft/storage/web-extension` and avoid server-only storage adapters.

### Constructor

```ts partial
new IndexedDBStorage(databaseName?: string)
```

| Parameter      | Type     | Default  | Description                    |
| -------------- | -------- | -------- | ------------------------------ |
| `databaseName` | `string` | `'weft'` | Name of the IndexedDB database |

```ts partial
const storage = new IndexedDBStorage('my-app');
```

### Methods

All required Storage methods are supported. `query()` is not available since IndexedDB has no SQL engine.

| Method     | Supported | Notes                                     |
| ---------- | --------- | ----------------------------------------- |
| `get()`    | Yes       |                                           |
| `put()`    | Yes       |                                           |
| `delete()` | Yes       |                                           |
| `scan()`   | Yes       | Uses IndexedDB cursor iteration           |
| `batch()`  | Yes       | Atomic via a single IndexedDB transaction |
| `query()`  | No        | Not available -- IndexedDB has no SQL     |

#### `[Symbol.dispose]()`

Closes the IndexedDB database connection. Supports the `using` pattern for automatic cleanup.

```ts partial
{
  using storage = new IndexedDBStorage('weft');
  // storage is open...
} // database connection closed here
```

---

## `LMDBStorage`

```ts partial
class LMDBStorage implements Storage
```

Memory-mapped key-value storage backed by [LMDB](https://www.symas.com/lmdb). Optional dependency: `lmdb`. Suitable for high-throughput workloads where SQLite is no longer fast enough on the read path.

```ts
import { LMDBStorage } from 'weft/storage/lmdb';
```

### Constructor

```ts partial
new LMDBStorage(path: string)
```

| Parameter | Type     | Default | Description                                                                    |
| --------- | -------- | ------- | ------------------------------------------------------------------------------ |
| `path`    | `string` | —       | Directory path for the LMDB database. The parent directory must already exist. |

If the `lmdb` package is not installed, the module import fails with the upstream package's missing-module error.

```ts partial
import { LMDBStorage } from 'weft/storage/lmdb';

await using storage = new LMDBStorage('./weft-data');
```

### Methods

All methods from the `Storage` interface, plus `conditionalBatch`. The `query()` method is not available—LMDB has no SQL engine.

#### `[Symbol.asyncDispose]()`

Closes the LMDB environment. Supports the `await using` pattern.

---

## `TursoStorage`

```ts partial
class TursoStorage implements Storage
```

libSQL/Turso storage for edge or serverless deployments. Optional dependency: `@libsql/client`.

```ts
import { TursoStorage } from 'weft/storage/turso';
```

### Constructor

```ts partial
new TursoStorage(options: TursoStorageOptions)
```

```ts partial
type TursoStorageOptions = {
  url: string;
  authToken?: string;
};
```

| Field       | Type     | Default | Description                                                                                        |
| ----------- | -------- | ------- | -------------------------------------------------------------------------------------------------- |
| `url`       | `string` | —       | Database URL. Accepts `libsql://your-db.turso.io`, `file:local.db`, or `file::memory:`.            |
| `authToken` | `string` | —       | Auth token for remote Turso databases. Required for `libsql://` URLs; ignored for local file URLs. |

If the `@libsql/client` package is not installed, the module import fails with the upstream package's missing-module error.

```ts partial
import { TursoStorage } from 'weft/storage/turso';

await using storage = new TursoStorage({
  url: 'libsql://your-db.turso.io',
  authToken: process.env.TURSO_AUTH_TOKEN,
});
```

### Methods

All methods from the `Storage` interface, plus `conditionalBatch`. Like SQLite, batch operations run inside a transaction.

---

## `WebExtensionStorage`

```ts partial
class WebExtensionStorage implements Storage
```

WebExtension-context storage backed by `chrome.storage` or `browser.storage`. Values are stored as JSON envelopes with base64-encoded `Uint8Array` payloads.

```ts
import { WebExtensionStorage } from 'weft/storage/web-extension';
```

### Constructor

```ts partial
new WebExtensionStorage(options?: WebExtensionStorageOptions)
```

```ts partial
type WebExtensionStorageOptions = {
  area?: 'local' | 'sync' | 'session' | 'managed';
};
```

| Field  | Type                                          | Default   | Description                                                                                                                       |
| ------ | --------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `area` | `'local' \| 'sync' \| 'session' \| 'managed'` | `'local'` | Which storage area to use. `managed` is read-only; `sync` writes are checked against the browser's per-area storage limits first. |

The constructor resolves either `globalThis.browser` or `globalThis.chrome` and accesses the matching `storage` namespace. If neither is present, the constructor throws immediately with: `WebExtensionStorage requires globalThis.browser.storage or globalThis.chrome.storage.`

```ts
import { WebExtensionStorage } from 'weft/storage/web-extension';

using storage = new WebExtensionStorage({ area: 'local' });
```

The extension manifest must include the `storage` permission:

```json
{ "permissions": ["storage"] }
```

### Methods

All required `Storage` methods. `query()` is not available—`chrome.storage` has no SQL engine.

---

## `HTTPStorage`

```ts partial
class HTTPStorage implements Storage
```

Remote storage over HTTP. Talks to Weft's storage REST routes (see [the server API reference](./api-server.md#storage-operations)). Suitable for distributed deployments where a single Weft server owns the storage and other clients connect over the network.

```ts
import { HTTPStorage } from 'weft/storage/http';
```

### Constructor

```ts partial
new HTTPStorage(options: HTTPStorageOptions)
```

```ts partial
type HTTPStorageOptions = {
  baseUrl: string | URL;
  headers?: Record<string, string>;
};
```

| Field     | Type                     | Default | Description                                                                                  |
| --------- | ------------------------ | ------- | -------------------------------------------------------------------------------------------- |
| `baseUrl` | `string \| URL`          | —       | Base URL of the Weft server. Routes are appended (`/v1/storage/...`).                        |
| `headers` | `Record<string, string>` | `{}`    | Headers sent with every request. Use this for `authorization` and any other request headers. |

```ts partial
import { HTTPStorage } from 'weft/storage/http';

using storage = new HTTPStorage({
  baseUrl: 'https://weft.example.com',
  headers: { authorization: `Bearer ${process.env.WEFT_TOKEN}` },
});
```

### Methods

All required `Storage` methods, plus `conditionalBatch`. Single-value operations use `application/octet-stream`. Scans stream NDJSON with base64-encoded values; if the response would exceed 64MB the client throws explicitly. `query()` is not available.

---

## `CompressedStorage`

```ts partial
class CompressedStorage implements Storage
```

A wrapper that compresses values before delegating to another `Storage`. Useful for large payloads where storage size matters more than CPU.

```ts
import { CompressedStorage } from 'weft/storage/compressed';
```

### Constructor

```ts partial
new CompressedStorage(inner: Storage)
```

| Parameter | Type      | Default | Description                                         |
| --------- | --------- | ------- | --------------------------------------------------- |
| `inner`   | `Storage` | —       | The wrapped storage that receives compressed bytes. |

Disposing the `CompressedStorage` disposes the inner adapter.

---

## `resolveStorage()`

```ts partial
function resolveStorage<Configuration extends StorageConfiguration>(
  configuration: Configuration,
): Promise<ResolvedStorage<Configuration>>;
```

Resolves a storage backend from runtime configuration. Lazy-loads adapter modules so optional dependencies (like `lmdb` or `@libsql/client`) are only required when their configuration type is selected.

```ts
import { resolveStorage } from 'weft/storage';

const storage = await resolveStorage({ type: 'sqlite', path: './weft.db' });
```

Available from both `weft/storage` and `weft/storage/resolve`.

### `StorageConfiguration`

Discriminated union of supported runtime configurations.

```ts partial
type StorageConfiguration =
  | { type: 'memory' }
  | { type: 'sqlite'; path?: string }
  | { type: 'lmdb'; path: string }
  | { type: 'turso'; url: string; authToken?: string }
  | { type: 'indexeddb'; databaseName?: string }
  | { type: 'web-extension'; area?: 'local' | 'sync' | 'session' | 'managed' }
  | { type: 'http'; baseUrl: string | URL; headers?: Record<string, string> }
  | { type: 'auto' };
```

| Variant         | Required fields | Optional fields                   |
| --------------- | --------------- | --------------------------------- |
| `memory`        | —               | —                                 |
| `sqlite`        | —               | `path` (defaults to `:memory:`)   |
| `lmdb`          | `path`          | —                                 |
| `turso`         | `url`           | `authToken`                       |
| `indexeddb`     | —               | `databaseName` (default `'weft'`) |
| `web-extension` | —               | `area` (default `'local'`)        |
| `http`          | `baseUrl`       | `headers`                         |
| `auto`          | —               | —                                 |

### `ResolvedStorage<Configuration>`

Return-type narrowing helper. Use when a configuration value is already narrowed and downstream code needs the adapter-specific instance type:

```ts partial
import type { HTTPStorageConfiguration, ResolvedStorage } from 'weft/storage/resolve';

type RemoteStorage = ResolvedStorage<HTTPStorageConfiguration>;
// RemoteStorage is HTTPStorage
```

The mapping:

| Configuration variant              | Resolved type           |
| ---------------------------------- | ----------------------- |
| `MemoryStorageConfiguration`       | `MemoryStorage`         |
| `SQLiteStorageConfiguration`       | `SQLiteStorageInstance` |
| `LMDBStorageConfiguration`         | `LMDBStorage`           |
| `TursoStorageConfiguration`        | `TursoStorage`          |
| `IndexedDBStorageConfiguration`    | `IndexedDBStorage`      |
| `WebExtensionStorageConfiguration` | `WebExtensionStorage`   |
| `HTTPStorageConfiguration`         | `HTTPStorage`           |
| `AutoStorageConfiguration`         | `Storage`               |

### Auto-detection order

`resolveStorage({ type: 'auto' })` checks runtimes in this order:

1. If `globalThis.Bun` is defined, returns `BunSQLiteStorage` via `resolveDefaultStorage()`.
2. Else if `process.versions.node` is a string, returns `NodeSQLiteStorage` via `resolveDefaultStorage()`.
3. Else if `chrome.storage` or `browser.storage` is defined, returns `WebExtensionStorage` (default `area: 'local'`).
4. Else if `globalThis.indexedDB` is defined, returns `IndexedDBStorage` (default `databaseName: 'weft'`).
5. Else returns `MemoryStorage`.

For a Bun-or-Node-only helper that throws in browsers (instead of falling through), use `resolveDefaultStorage()` from `weft/storage/auto`.

---

## `resolveDefaultStorage()`

```ts partial
function resolveDefaultStorage(): Promise<Storage>;
```

Picks a SQLite-backed storage adapter for the current runtime. Bun returns `BunSQLiteStorage`; Node returns `NodeSQLiteStorage`; everything else throws.

```ts
import { resolveDefaultStorage } from 'weft/storage/auto';

await using storage = await resolveDefaultStorage();
```

The path is resolved as:

1. `process.env.WEFT_DEFAULT_STORAGE_PATH` if set, else
2. `${tmpdir()}/weft-default/<cwd-hash>.db` where `<cwd-hash>` is the first 16 hex characters of the SHA-256 of `process.cwd()`.

The parent directory is created (recursive) before the path is returned.

> [!WARNING]
> `weft/storage/auto` statically imports `node:fs`, `node:os`, `node:path`, and `node:crypto`. Bundling it for a browser target will fail. Browser and Service Worker contexts should use `IndexedDBStorage` directly, or `setupServiceWorker()` from `weft/service-worker`.

This helper is for development convenience. Production deployments should pick an explicit adapter and pass it to `new Engine({ storage })`.

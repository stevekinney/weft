# Storage

Every checkpoint, workflow state, signal, and timer in Weft is ultimately a key-value pair written to storage. The storage layer is a thin abstraction—five required methods plus a dispose hook—that lets you swap backends without touching workflow code.

## Quick start

SQLite is the default for Bun and Node. IndexedDB is the browser default. For local Bun or Node work, `resolveDefaultStorage()` picks the matching SQLite backend and gives you a persistent database without extra setup.

```ts
import { Engine } from 'weft';
import { resolveDefaultStorage } from 'weft/storage/auto';

await using storage = await resolveDefaultStorage();
await using engine = new Engine({ storage });
void engine;
```

This works under Bun and Node. The path lives under `${tmpdir()}/weft-default/<cwd-hash>.db` (or `WEFT_DEFAULT_STORAGE_PATH` if set).

> [!WARNING]
> `weft/storage/auto` requires Bun or Node. For browsers, import `IndexedDBStorage` from `weft/storage/indexeddb` directly, or use `setupServiceWorker()` from `weft/service-worker`.

`resolveDefaultStorage()` is for development, demos, and Hello World. Production deployments usually pick an explicit adapter so the storage path and backend are part of deployment configuration.

## Choosing a backend

Use the narrowest adapter that matches where the engine runs:

| Backend                | Environment       | Persistence | Optional dep     | Notes                                     |
| ---------------------- | ----------------- | ----------- | ---------------- | ----------------------------------------- |
| `MemoryStorage`        | All               | No          | None             | Tests/demos only—data lost on restart.    |
| `SQLiteStorage` (Bun)  | Bun               | Yes         | None             | Default for the Bun runtime.              |
| `SQLiteStorage` (Node) | Node >= 22        | Yes         | None             | Default for the Node runtime.             |
| `LMDBStorage`          | Bun/Node          | Yes         | `lmdb`           | High-throughput memory-mapped key-value.  |
| `TursoStorage`         | Bun/Node          | Yes         | `@libsql/client` | libSQL/Turso for edge or serverless.      |
| `IndexedDBStorage`     | Browser           | Yes         | None             | Browser native; no SQL passthrough.       |
| `WebExtensionStorage`  | Browser extension | Yes         | None             | `chrome.storage` / `browser.storage`.     |
| `HTTPStorage`          | All               | Remote      | None             | Connects to a remote Weft storage API.    |
| `CompressedStorage`    | All               | Wrapper     | None             | Wraps another adapter; compresses values. |

## Advanced: choosing a backend explicitly

Use a direct adapter import when you know the deployment target:

```ts
import { Engine } from 'weft';
import { SQLiteStorage } from 'weft/storage/sqlite';

using storage = new SQLiteStorage('./weft.db');
using engine = new Engine({ storage });
void engine;
```

Use `resolveStorage(configuration)` when backend choice comes from configuration. It accepts a discriminated `StorageConfiguration` union and lazy-loads the matching adapter, so optional dependencies are only required when you select that backend.

```ts
import { Engine } from 'weft';
import { resolveStorage } from 'weft/storage';

await using storage = await resolveStorage({ type: 'sqlite', path: './weft.db' });
await using engine = new Engine({ storage });
void engine;
```

Every variant of the union, the required fields for each, and the `ResolvedStorage<Configuration>` mapping that narrows the return type to the matching adapter live in the [`StorageConfiguration`](../reference/api-storage.md#storageconfiguration) reference.

Two `auto`-style resolvers exist, and the difference matters:

- `resolveStorage({ type: 'auto' })` falls through Bun → Node → WebExtension → IndexedDB → `MemoryStorage`. Reach for it when one configuration object must run across several runtimes. See [Auto-detection order](../reference/api-storage.md#auto-detection-order) for the exact sequence.
- `resolveDefaultStorage()` is Bun/Node-only and _throws_ in browser and WebExtension contexts instead of falling through — the thrown error tells you to use `IndexedDBStorage` or `setupServiceWorker()` directly. See [`resolveDefaultStorage()`](../reference/api-storage.md#resolvedefaultstorage).

> [!WARNING]
> The final `MemoryStorage` fallback is non-durable. Do not use `resolveStorage({ type: 'auto' })` for production recovery unless you also validate that the resolved adapter is persistent for your deployment target.

## The Storage interface

All adapters implement the same `Storage` interface — `get`, `put`, `delete`, `scan`, and `batch`, plus disposal. Everything is `Uint8Array` in and out; Weft handles its own serialization (via a CBOR-like codec) before writing, so adapters never need to understand the data format. See the [`Storage` interface](../reference/api-storage.md#storage-interface) reference for the full method signatures.

The `scan` method returns an `AsyncIterable` of key-value pairs matching a prefix, with optional bounds and ordering:

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

The `batch` method writes multiple operations atomically. This is critical for consistency—Weft often updates a workflow state and writes a checkpoint in a single atomic operation.

```ts partial
type BatchOperation =
  | { type: 'put'; key: string; value: Uint8Array }
  | { type: 'delete'; key: string };
```

Adapters can opt into optional methods for performance and feature parity: `conditionalBatch` (compare-and-swap), `has`, `deletePrefix`, `keys`, `count`, `scoped`, and `query` (SQL passthrough, adapter-specific). Adapters that omit optional methods receive generic fallbacks via wrapper functions (`storageHas`, `storageKeys`, etc.).

## Consistency & capabilities

Every adapter implements `capabilities(): StorageCapabilities` — an honest, self-reported profile of what the backend actually guarantees. The engine reads these to decide what is safe, and one capability (`conditionalBatch`) is enforced at runtime.

```ts partial
type StorageCapabilities = {
  readAfterWrite: 'linearizable' | 'session' | 'eventual';
  scanConsistency: 'snapshot' | 'best-effort';
  atomicBatch: boolean;
  conditionalBatch: boolean;
  boundedRangeDelete: boolean;
};
```

The engine depends on four guarantees. **`atomicBatch`** keeps a checkpoint commit all-or-nothing. **`readAfterWrite`** lets a resume observe the checkpoint it just wrote. **`scanConsistency`** keeps visibility and index scans from seeing torn writes. **`conditionalBatch`** backs compare-and-swap state and tenant-quota reservation.

The honest profile per built-in adapter:

| Adapter               | readAfterWrite | scanConsistency | atomicBatch | conditionalBatch | boundedRangeDelete |
| --------------------- | -------------- | --------------- | ----------- | ---------------- | ------------------ |
| `MemoryStorage`       | `linearizable` | `snapshot`      | yes         | yes              | yes                |
| `BunSQLiteStorage`    | `linearizable` | `snapshot`      | yes         | yes              | yes                |
| `NodeSQLiteStorage`   | `linearizable` | `snapshot`      | yes         | yes              | no                 |
| `LMDBStorage`         | `linearizable` | `snapshot`      | yes         | yes              | yes                |
| `IndexedDBStorage`    | `linearizable` | `best-effort`   | yes         | yes              | yes                |
| `TursoStorage`        | `session`      | `snapshot`      | yes         | yes              | yes                |
| `HTTPStorage`         | `eventual`     | `best-effort`   | yes         | no (opt-in)      | no                 |
| `WebExtensionStorage` | `session`      | `best-effort`   | yes         | no               | no                 |

Two kinds of capability, treated differently:

- **`conditionalBatch` is runtime-gated.** A backend may legitimately omit compare-and-swap, so its absence has a clean failure path: the first feature that needs it (`AtomicState` updates, the `storage.conditionalBatch` server operation, CAS-requiring tenant quotas) throws a clear diagnostic naming the feature and the capability. `WebExtensionStorage` and `CompressedStorage` report `false` here. `HTTPStorage` reports `false` by default — the client cannot know whether the remote server's backend supports CAS, so a gated feature fails fast locally rather than via a remote `501`; pass `remoteConditionalBatch: true` when you have verified the server supports it.
- **`atomicBatch`, `readAfterWrite`, and `scanConsistency` are trusted contracts.** The engine reads them but does not verify them at runtime. If an adapter reports `atomicBatch: true` but applies batches non-atomically, the failure mode is checkpoint corruption — so adapter authors must report honestly.

> [!WARNING] Eventual read-after-write
> `HTTPStorage` reports `readAfterWrite: eventual`: the client offers no read-your-writes guarantee, so a resume immediately after a checkpoint write may read stale state. There is no runtime gate for this. Operators choosing an eventual backend accept that visibility trade-off; the built-in `linearizable` single-process adapters do not have it.

**The opaque-value invariant:** adapters and decorators must treat stored values as opaque bytes and must not inspect or depend on value contents — values may later be encrypted or compressed. The engine ranges only over keys, never value bytes. This is why `CompressedStorage`, which transforms value bytes, downgrades `conditionalBatch` to `false`: a caller-supplied `expectedValue` can never byte-match the compressed stored value.

> [!NOTE] `boundedRangeDelete`
> `true` means `deletePrefix()` is a single range-scoped delete (one SQL `DELETE`, an `IDBKeyRange` delete, or an LMDB range delete). `false` means the adapter falls back to the derived scan-and-delete loop — `deletePrefix()` still works, it just is not a single bounded operation.

## Key layout

Weft encodes structure into hierarchical keys. The `KEYS` constants define the layout.

```
wf:{id}                                       -- workflow state
wf:{id}:ckpt                                  -- latest checkpoint
wf:{id}:ckpt:{step}                           -- checkpoint history
op:{queue}:{scheduled}:{id}                   -- operation (sorted by queue + time)
ev:{workflowId}:{seq}                         -- event (sorted by workflow + sequence)
sig:{workflowId}:{name}:{id}                  -- signal
wf-deadline:{deadline}:{workflowId}           -- timeout deadline
attr:{workflowId}                             -- search attributes
idx:{attrName}:{encodedValue}:{workflowId}    -- secondary index for search
upd:{workflowId}:{updateId}                   -- pending update request
upr:{updateId}                                -- update response
```

This listing covers the primary keys. The full canonical list---including `wf:{id}:timeline:`, `schedule:`, `op:inflight:`, `tag:`, `upk:` (idempotency), `budget:`, `quota:`, `archive:`, `state:execution:`, `state:workflow:`, `state:tenant:`, `blob:`, and others---is in `KEYS` in `src/storage/interface.ts`.

All timestamps are zero-padded to 16 digits for correct lexicographic ordering. So `scan("op:default:")` returns all operations on the "default" queue in scheduled order—the core hot path is a single range scan, regardless of backend.

## Per-backend configuration

Backend transaction guarantees live with each adapter below. `SQLiteStorage`, `IndexedDBStorage`, `LMDBStorage`, and `TursoStorage` apply `batch()` operations atomically; remote or wrapper adapters inherit the guarantee of the storage they delegate to.

### `MemoryStorage`

For tests and ephemeral workflows. A `Map<string, Uint8Array>` with the same interface, running entirely in memory. Fast, deterministic, no cleanup needed.

```ts
import { MemoryStorage, Engine } from 'weft';

const storage = new MemoryStorage();
const engine = new Engine({ storage });
```

It also exposes `MemoryStorage`-only conveniences: the `size` getter, `clear()`, and `snapshot()` (deep copy of the internal map). The `has()` and `keys()` methods are part of the optional `Storage` interface and available on other adapters too.

If you don't pass a `storage` option to `Engine`, it defaults to `MemoryStorage`—so for quick experiments and tests, you can skip storage configuration entirely:

```ts partial
const engine = new Engine(); // uses MemoryStorage
```

### `SQLiteStorage`

The default for production persistence on Bun and Node. Import `SQLiteStorage` from `weft/storage/sqlite`; export conditions resolve it to `BunSQLiteStorage` under Bun and `NodeSQLiteStorage` under Node.js.

```ts partial
import { SQLiteStorage } from 'weft/storage/sqlite';

using storage = new SQLiteStorage('./weft.db');
const engine = new Engine({ storage });
```

Use `weft/storage/sqlite/bun` or `weft/storage/sqlite/node` only when you need to force one implementation.

Under the hood, it creates a single `kv` table (`key TEXT PRIMARY KEY, value BLOB NOT NULL`) using `WITHOUT ROWID` for optimal key-value performance. WAL mode is enabled, `synchronous = NORMAL`, and the cache size is bumped—sensible defaults for a write-heavy workload.

`BunSQLiteStorage` exposes an optional `query()` method for ad-hoc SQL queries, invaluable for debugging and dashboards. `NodeSQLiteStorage` intentionally sticks to the portable `Storage` interface and does not expose SQL passthrough. Import the Bun override directly when you need SQL passthrough:

```ts partial
import { BunSQLiteStorage } from 'weft/storage/sqlite/bun';

using storage = new BunSQLiteStorage('./weft.db');
const rows = await storage.query<{ key: string }>('SELECT key FROM kv WHERE key LIKE ?', ['wf:%']);
```

Batch operations run inside a SQLite transaction, so they're atomic—a batch that writes a workflow state and a checkpoint either both succeed or neither does.

### `LMDBStorage`

Memory-mapped key-value backend for high-throughput workloads. Optional dependency: `lmdb`.

```ts
import { LMDBStorage } from 'weft/storage/lmdb';

await using storage = new LMDBStorage('./weft-data');
```

The constructor takes a directory path. LMDB creates and manages the database files inside that directory; the parent must exist. The `lmdb` package must be installed separately—if it isn't, the import throws at module load with the upstream package's missing-module error.

LMDB excels at zero-copy reads, which is unbeatable for hot-path operations like task claiming. SQLite handles most workloads well (roughly 50K writes/sec in WAL mode, 100K reads/sec). If you're pushing past 30K workflows per second and need maximum read throughput, consider LMDB.

### `TursoStorage`

libSQL/Turso backend for edge or serverless deployments. Optional dependency: `@libsql/client`.

```ts partial
import { TursoStorage } from 'weft/storage/turso';

await using storage = new TursoStorage({
  url: 'libsql://your-db.turso.io',
  authToken: process.env.TURSO_AUTH_TOKEN,
});
```

The `url` accepts `libsql://` (remote Turso), `file:` (local libSQL), or `file::memory:` (in-memory libSQL). `authToken` is required for remote databases and ignored for local files.

Like SQLite, the underlying schema is a single `kv` table using `WITHOUT ROWID`. Batch operations run inside a transaction.

### `IndexedDBStorage`

Browser-native storage—the equivalent of SQLite for the browser. Persists workflow state to IndexedDB, suitable for Service Worker deployments where the engine runs entirely in the browser.

```ts partial
import { IndexedDBStorage } from 'weft/storage/indexeddb';

using storage = new IndexedDBStorage('weft');
const engine = new Engine({ storage });
```

The constructor takes an optional database name (defaults to `'weft'`). Under the hood, it creates a single `kv` object store with string keys and `Uint8Array` values—the same logical structure as the SQLite `kv` table.

`IndexedDBStorage` implements the full `Storage` interface except `query()`. IndexedDB has no SQL engine, so raw queries aren't available. All other methods—`get`, `put`, `delete`, `scan`, `batch`—work identically to the other adapters.

The `batch()` method is atomic. All operations run inside a single IndexedDB transaction, so a batch that writes a workflow state and a checkpoint either both succeed or neither does.

The `using` pattern works for cleanup: `[Symbol.dispose]()` closes the underlying IndexedDB database connection.

Browser consumers should use browser-safe subpath imports (`weft/storage/indexeddb`, `weft/storage/web-extension`) and avoid server-only adapters.

### `WebExtensionStorage`

Persists bytes through `browser.storage` or `chrome.storage` in extension contexts. Values are JSON envelopes with base64-encoded `Uint8Array` payloads.

```ts
import { WebExtensionStorage } from 'weft/storage/web-extension';

using storage = new WebExtensionStorage({ area: 'local' });
```

The `area` option accepts `local`, `sync`, `session`, or `managed`. The `managed` area is read-only; `sync` writes are checked against the storage area's quota before committing.

The required permission in your extension manifest:

```json
{ "permissions": ["storage"] }
```

### `HTTPStorage`

Remote storage over HTTP—talks to Weft's storage REST routes for distributed deployments.

```ts
import { HTTPStorage } from 'weft/storage/http';

const token = 'example-token';
using storage = new HTTPStorage({
  baseUrl: 'https://weft.example.com',
  headers: { authorization: `Bearer ${token}` },
});
```

Single-value operations use `application/octet-stream`. Scans stream NDJSON with base64-encoded values and a 64MB response size limit—if your scan would exceed that, narrow the prefix or use `limit` and `gt` to paginate. Conditional batches map to the server-side compare-and-swap route.

The constructor accepts a `baseUrl` (string or URL) and optional `headers` for authentication. See [the storage REST API reference](../reference/api-server.md#storage-operations) for the full route surface.

### `CompressedStorage`

A wrapper that compresses values before delegating to another adapter. Useful when you're storing large payloads and want to trade CPU for storage size.

```ts
import { CompressedStorage } from 'weft/storage/compressed';
import { SQLiteStorage } from 'weft/storage/sqlite';

using inner = new SQLiteStorage('./weft.db');
const storage = new CompressedStorage(inner);
```

Wraps any `Storage` implementation. Disposing the `CompressedStorage` disposes the inner adapter.

## Troubleshooting

**Missing optional dependencies (`lmdb`, `@libsql/client`).** `LMDBStorage` and `TursoStorage` import their dependencies lazily. If the package isn't installed, you'll see an error like `Cannot find module 'lmdb'` or `Cannot find module '@libsql/client'` when you first call `resolveStorage` or instantiate the adapter. Install with `bun add lmdb` or `bun add @libsql/client`.

**`weft/storage/auto` in a browser bundler.** The module statically imports Node built-ins, so bundlers like Vite or webpack will fail or warn when targeting the browser. Switch to `weft/storage/indexeddb` directly, or use `setupServiceWorker()` from `weft/service-worker`. If you need a single configuration that works across runtimes including browsers, use `resolveStorage({ type: 'auto' })` instead—it lazy-loads adapters and includes browser fallbacks.

**HTTP storage connectivity issues.** `HTTPStorage` returns the underlying `fetch` errors. For 4xx responses, the response body usually contains an error message; for network errors, the `fetch` exception propagates. If scans hit the 64MB response limit, the client throws explicitly—narrow the prefix or paginate with `limit` and `gt`.

# Storage

Every checkpoint, workflow state, signal, and timer in Weft is ultimately a key-value pair written to storage. The storage layer is a thin abstraction—five required methods plus a dispose hook—that lets you swap backends without touching workflow code.

## Quick start

SQLite is the default for Bun and Node. WebExtension storage is the browser-extension default, and IndexedDB is the browser and Service Worker default. `resolveDefaultStorage()` picks the matching persistent backend and gives you durable local storage without environment branches.

```ts
import { Engine } from '@lostgradient/weft';
import { resolveDefaultStorage } from '@lostgradient/weft/storage/auto';

await using storage = await resolveDefaultStorage();
await using engine = new Engine({ storage });
void engine;
```

Under Bun and Node, the SQLite path lives under `${tmpdir()}/weft-default/<cwd-hash>.db` (or `WEFT_DEFAULT_STORAGE_PATH` if set). Browser and extension adapters use their own default store names.

`resolveDefaultStorage()` is for development, demos, and Hello World. Production deployments usually pick an explicit adapter so the storage path and backend are part of deployment configuration. For the production topology itself—one engine per durable store, enforced at the infrastructure layer—see [Running Weft as a Singleton Service](singleton-service-deployment.md).

## Choosing a backend

Use the narrowest adapter that matches where the engine runs:

| Backend                | Environment       | `capabilities().persistence`      | Stability tier                 | Optional dep               | Notes                                         |
| ---------------------- | ----------------- | --------------------------------- | ------------------------------ | -------------------------- | --------------------------------------------- |
| `MemoryStorage`        | All               | `ephemeral`                       | Candidate-stable for tests/dev | None                       | Tests/demos only—data lost on restart.        |
| `SQLiteStorage` (Bun)  | Bun               | `ephemeral` or `local`            | Candidate-stable, provisional  | None                       | Default for the Bun runtime.                  |
| `SQLiteStorage` (Node) | Node >= 22        | `ephemeral` or `local`            | Candidate-stable, provisional  | `better-sqlite3`           | Default for the Node runtime.                 |
| `LMDBStorage`          | Bun/Node          | `local`                           | Candidate-stable, provisional  | `lmdb`                     | High-throughput memory-mapped key-value.      |
| `TursoStorage`         | Bun/Node          | `ephemeral`, `local`, or `remote` | Experimental                   | `@libsql/client`           | Stable tier is pending conformance proof.     |
| `NeonStorage`          | Bun/Node          | `remote`                          | Experimental                   | `@neondatabase/serverless` | Neon/Postgres for durable remote deployments. |
| `IndexedDBStorage`     | Browser           | `local`                           | Experimental                   | None                       | Browser native; no SQL passthrough.           |
| `WebExtensionStorage`  | Browser extension | `ephemeral`, `local`, or `remote` | Experimental                   | None                       | `chrome.storage` / `browser.storage`.         |
| `HTTPStorage`          | All               | `remote`                          | Experimental                   | None                       | Connects to a remote Weft storage API.        |
| `CompressedStorage`    | All               | Same as wrapped storage           | Experimental                   | None                       | Wraps another adapter; compresses values.     |

> [!NOTE]
> Candidate-stable is provisional while the [Tier-0 Behavioral Contract](../architecture/tier-0-behavioral-contract.md) is still shaping failure semantics. The storage adapters above keep their current capability contracts, but Tier-0 work may still add guarded failure modes when a deployment asks for behavior a backend cannot provide. The experimental browser adapters (`IndexedDBStorage`, `WebExtensionStorage`) graduate on a separate, mechanical criterion: their real-browser smoke tests must be green in a required CI gate. See the [browser-surface promotion gate](../roadmap-to-1.0.md#browser-surface-promotion-gate).

## Advanced: choosing a backend explicitly

Use a direct adapter import when you know the deployment target:

```ts
import { Engine } from '@lostgradient/weft';
import { SQLiteStorage } from '@lostgradient/weft/storage/sqlite';

using storage = new SQLiteStorage('./weft.db');
using engine = new Engine({ storage });
void engine;
```

Use `resolveStorage(configuration)` when backend choice comes from configuration. It accepts a discriminated `StorageConfiguration` union and lazy-loads the matching adapter, so optional dependencies are only required when you select that backend.

```ts
import { Engine } from '@lostgradient/weft';
import { resolveStorage } from '@lostgradient/weft/storage';

await using storage = await resolveStorage({ type: 'sqlite', path: './weft.db' });
await using engine = new Engine({ storage });
void engine;
```

Every variant of the union, the required fields for each, and the `ResolvedStorage<Configuration>` mapping that narrows the return type to the matching adapter live in the [`StorageConfiguration`](../reference/api-storage.md#storageconfiguration) reference.

Two `auto`-style resolvers exist, and the difference matters:

- `resolveStorage({ type: 'auto' })` falls through Bun -> Node -> WebExtension -> IndexedDB -> `MemoryStorage`. Reach for it when one configuration object must run across several runtimes and a non-durable fallback is acceptable. See [Auto-detection order](../reference/api-storage.md#auto-detection-order) for the exact sequence.
- `resolveDefaultStorage()` follows the same durable runtime order through IndexedDB, but _throws_ instead of falling through to `MemoryStorage`. See [`resolveDefaultStorage()`](../reference/api-storage.md#resolvedefaultstorage).

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

## Implementing a custom adapter

A custom adapter starts with the same five required methods: `get`, `put`, `delete`, `scan`, and `batch`, plus `[Symbol.dispose]()` and an honest `capabilities()` row. Keep values opaque `Uint8Array` bytes. Do not decode, inspect, compress, or compare them outside the storage contract unless you are writing a wrapper that documents that transformation.

Use the public conformance suite from `@lostgradient/weft/storage/testing` in your adapter's Bun tests. The suite registers `bun:test` cases, so it belongs in test files rather than production code:

```ts
import {
  runBasicStorageContract,
  runBinaryAndLargeScanStorageConformance,
  runConcurrentConditionalBatchConformance,
  runStorageCapabilityConformance,
} from '@lostgradient/weft/storage/testing';
import { MemoryStorage, type StorageCapabilities } from '@lostgradient/weft/storage';

class MyStorage extends MemoryStorage {}

const expectedCapabilities = {
  persistence: 'ephemeral',
  readAfterWrite: 'linearizable',
  scanConsistency: 'snapshot',
  atomicBatch: true,
  conditionalBatch: true,
  boundedRangeDelete: true,
} satisfies StorageCapabilities;

runBasicStorageContract('MyStorage', {
  create: () => new MyStorage(),
});

runStorageCapabilityConformance('MyStorage', {
  create: () => new MyStorage(),
  expected: expectedCapabilities,
});

runConcurrentConditionalBatchConformance('MyStorage', {
  create: () => new MyStorage(),
});

runBinaryAndLargeScanStorageConformance('MyStorage', {
  create: () => new MyStorage(),
});
```

Replace the `MyStorage` class body and `expectedCapabilities` row with your adapter implementation and its actual guarantees.

These helpers prove the adapter behavior that Weft can check from one process: basic key/value semantics, prefix-scan ordering and bounds, binary values, large scans, declared capability shape, read-after-write behavior, snapshot scan isolation, and compare-and-swap behavior when `conditionalBatch` is reported as available. Call `runConcurrentConditionalBatchConformance()` only for adapters that can stage two in-flight write transactions against shared state; omit it for single-connection backends that serialize writers locally.

The package subpath is intentionally `@lostgradient/weft/storage/testing`, not `@lostgradient/weft/testing`, because adapter conformance and workflow test engines serve different audiences. The `weft conformance` CLI still covers remote worker protocol compatibility; storage-adapter conformance through the CLI is a separate feature.

## Consistency & capabilities

Every adapter implements `capabilities(): StorageCapabilities` — an honest, self-reported profile of what the backend actually guarantees. The engine reads these to decide what is safe, and one capability (`conditionalBatch`) is enforced at runtime.

```ts partial
type StorageCapabilities = {
  persistence: 'ephemeral' | 'local' | 'remote';
  readAfterWrite: 'linearizable' | 'session' | 'eventual';
  scanConsistency: 'snapshot' | 'best-effort';
  atomicBatch: boolean;
  conditionalBatch: boolean;
  boundedRangeDelete: boolean;
};
```

The engine depends on four consistency guarantees. **`atomicBatch`** keeps a checkpoint commit all-or-nothing. **`readAfterWrite`** lets a resume observe the checkpoint it just wrote. **`scanConsistency`** keeps visibility and index scans from seeing torn writes. **`conditionalBatch`** backs compare-and-swap state, including storage-backed workflow state and operations that must commit only if the current value still matches the caller's expectation.

`persistence` describes where data survives: `ephemeral` storage is process- or session-local, `local` storage is durable in the local runtime or browser origin, and `remote` storage is owned by another service or synchronized storage area.

The Tier-0 failure-semantics contract relies on this capability split for activity reconciliation, signal idempotency, and checkpoint ownership. See [Tier-0 Behavioral Contract](../architecture/tier-0-behavioral-contract.md) for the implementation gates.

The honest profile per built-in adapter:

| Adapter               | persistence                       | readAfterWrite | scanConsistency | atomicBatch            | conditionalBatch | boundedRangeDelete |
| --------------------- | --------------------------------- | -------------- | --------------- | ---------------------- | ---------------- | ------------------ |
| `MemoryStorage`       | `ephemeral`                       | `linearizable` | `snapshot`      | yes                    | yes              | yes                |
| `BunSQLiteStorage`    | `ephemeral` or `local`            | `linearizable` | `snapshot`      | yes                    | yes              | yes                |
| `NodeSQLiteStorage`   | `ephemeral` or `local`            | `linearizable` | `snapshot`      | yes                    | yes              | no                 |
| `LMDBStorage`         | `local`                           | `linearizable` | `snapshot`      | yes                    | yes              | no                 |
| `IndexedDBStorage`    | `local`                           | `linearizable` | `best-effort`   | yes                    | yes              | yes                |
| `TursoStorage`        | `ephemeral`, `local`, or `remote` | `session`      | `snapshot`      | yes                    | yes              | yes                |
| `NeonStorage`         | `remote`                          | `linearizable` | `snapshot`      | yes                    | yes              | yes                |
| `HTTPStorage`         | `remote`                          | `eventual`     | `best-effort`   | yes                    | no (opt-in)      | no                 |
| `WebExtensionStorage` | `ephemeral`, `local`, or `remote` | `session`      | `best-effort`   | no (same context only) | no               | no                 |

Three kinds of capability, treated differently:

- **`conditionalBatch` is runtime-gated.** It is the only capability the engine enforces. A backend may legitimately omit compare-and-swap, so its absence has a clean failure path: the first feature that needs it (`AtomicState` updates or the `storage.conditionalBatch` server operation) throws a clear diagnostic naming the feature and the capability. `WebExtensionStorage` and `CompressedStorage` report `false` here. `HTTPStorage` reports `false` by default — the client cannot know whether the remote server's backend supports CAS, so a gated feature fails fast locally rather than via a remote `501`; pass `remoteConditionalBatch: true` when you have verified the server supports it.
- **`atomicBatch`, `readAfterWrite`, and `scanConsistency` are trusted correctness contracts.** The engine reads them but does not verify them at runtime. If an adapter reports `atomicBatch: true` but applies batches non-atomically, the failure mode is checkpoint corruption — so adapter authors must report honestly.
- **`boundedRangeDelete` is an operational hint.** It describes whether `deletePrefix()` is a single bounded range op or a scan-and-delete fallback (see the note below). It affects performance, not correctness, and nothing gates on it.

> [!WARNING] Eventual read-after-write
> `HTTPStorage` reports `readAfterWrite: eventual`: the client offers no read-your-writes guarantee, so a resume immediately after a checkpoint write may read stale state. There is no runtime gate for this. Operators choosing an eventual backend accept that visibility trade-off; the built-in `linearizable` single-process adapters do not have it.

> [!WARNING] WebExtension batch scope
> `WebExtensionStorage` serializes `batch()` calls only inside the same JavaScript context. Browser extension contexts that share `chrome.storage` or `browser.storage` do not get a cross-context transaction, so the adapter reports `atomicBatch: false`. `assertDurableStorageForRecovery()` rejects it even when the selected area is persistent.

For applications that should fail boot when durable recovery is misconfigured, call [`assertDurableStorageForRecovery()`](../reference/api-storage.md#assertdurablestorageforrecovery). It accepts `persistence: 'local'` or `'remote'`, `readAfterWrite: 'linearizable'`, `scanConsistency: 'snapshot'`, `atomicBatch: true`, and `conditionalBatch: true`. A `remote` backend such as `NeonStorage` passes only because the other four axes still hold at full strength; `ephemeral` is the only persistence value it rejects.

```ts
import { assertDurableStorageForRecovery } from '@lostgradient/weft';
import { SQLiteStorage } from '@lostgradient/weft/storage/sqlite';

await using storage = new SQLiteStorage('./weft.db');
assertDurableStorageForRecovery(storage);
```

**The opaque-value invariant:** adapters and decorators must treat stored values as opaque bytes and must not inspect or depend on value contents — values may later be encrypted or compressed. The engine ranges only over keys, never value bytes. This is why `CompressedStorage`, which transforms value bytes, downgrades `conditionalBatch` to `false`: a caller-supplied `expectedValue` can never byte-match the compressed stored value.

> [!NOTE] `boundedRangeDelete`
> `true` means `deletePrefix()` or `deleteRange()` runs as a single native bounded operation (one SQL `DELETE` or an `IDBKeyRange` delete). `false` means the adapter uses a two-phase scan-and-delete approach — first collecting matching keys into memory, then deleting them in a batch — or falls back to the derived scan-and-delete loop. The operation still works either way; this is a performance claim, not a correctness gate.

`deleteRange(prefix, options)` deletes only keys under `prefix` that also satisfy at least one lexicographic bound (`gt`, `gte`, `lt`, or `lte`). The public `storageDeleteRange()` dispatcher validates the bounds, rejects unbounded requests, normalizes `limit`, and falls back to a bounded `scan()` plus `batch()` loop when the adapter does not provide a native method. Use it for checkpoint-history or event-log truncation below a known watermark; use `deletePrefix()` for intentional whole-prefix cleanup.

## Key layout

Weft encodes structure into hierarchical keys. The `KEYS` constants define the layout.

```
wf:{id}                                       -- workflow state
wf:{id}:ckpt                                  -- latest checkpoint
wf:{id}:ckpt:{step}                           -- checkpoint history
op:{queue}:{scheduled}:{id}                   -- operation (sorted by queue + time)
ev:{workflowId}:{seq}                         -- event (sorted by workflow + sequence)
ev:{workflowId}:watermark                     -- compaction watermark for truncated events
sig:{workflowId}:{encodedName}:{class}:{id}   -- buffered signal payload
sigres:{workflowId}:{encodedName}:{id}        -- accepted signal response
wf-deadline:{deadline}:{workflowId}           -- timeout deadline
attr:{workflowId}                             -- search attributes
idx:{attrName}:{encodedValue}:{workflowId}    -- secondary index for search
upd:{workflowId}:{updateId}                   -- pending update request
upr:{updateId}                                -- update response
```

This listing covers the primary keys. Signal names are encoded before key construction so names such as `order` and `order:placed` cannot prefix-alias each other. Buffered signal payload keys include a sort-class component: `0` for the initial `startOrSignal` start-signal and `1` for normal signals, so a same-tick start-signal is consumed first; deduplication is keyed by the class-independent `sigres:` accepted-response record. The full canonical list—including `wf:{id}:timeline:`, `schedule:`, `op:inflight:`, `tag:`, `upk:` (idempotency), `budget:`, `archive:`, `state:execution:`, `state:workflow:`, `blob:`, and others—is in `KEYS` in `src/storage/interface.ts`.

All timestamps are zero-padded to 16 digits for correct lexicographic ordering. So `scan("op:default:")` returns all operations on the "default" queue in scheduled order—the core hot path is a single range scan, regardless of backend.

[`WEFT_RESERVED_KEY_PREFIXES`](../reference/api-storage.md#weft_reserved_key_prefixes) is the stable list of Weft-owned prefixes. Application data in a shared store should use its own namespace:

```ts
import { MemoryStorage, scopedStorage, textValueStore } from '@lostgradient/weft/storage';

await using storage = new MemoryStorage();
const applicationStorage = textValueStore(scopedStorage(storage, 'app:my-service'), {
  disposeUnderlyingStorage: false,
});
await applicationStorage.set('session:1', '...');
```

When using `textValueStore()` or `withCodec()` over a storage instance also owned by the engine, pass `{ disposeUnderlyingStorage: false }` so closing the wrapper does not close the engine's storage.

Both wrappers expose `conditionalBatch()` for compare-and-swap application state. Text wrappers compare and write UTF-8 strings; typed wrappers compare and write values through their codec before delegating to raw storage CAS.

`jsonCodec()` accepts only values that round-trip through JSON without changing their meaning. It rejects `NaN`, infinities, cyclic structures, unsupported object types, and `-0`; JavaScript's `JSON.stringify(-0)` emits `0`, so accepting negative zero would silently erase information before the value reached storage.

### Importing an existing string KV database

For an existing SQLite database with a string-valued `kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)` table, import rows into a Weft database under an application prefix:

```bash
bun scripts/import-string-kv-sqlite-to-weft.ts \
  --source ./application.db \
  --target ./weft.db \
  --target-prefix app:my-service
```

The script copies rows into the target Weft keyspace and leaves the source database untouched. It rejects identical source and target paths, validates the source table name, writes values as UTF-8 bytes, and refuses to overwrite existing target keys.

### Event-log compaction

Long-running workflows can reclaim old event-log records with `new Engine({ history: { retentionWindow } })`. The canonical checkpoint is the compacted state used for resume, so compaction deletes only records older than a confirmed checkpoint and writes `ev:{workflowId}:watermark` atomically with that checkpoint commit. Verification starts from the watermark and still checks the surviving tail against the event-log head, so a compacted log is not treated as corrupt merely because its prefix was intentionally removed.

Compaction is bounded and incremental. The watermark only moves forward, so raising `retentionWindow` later cannot restore records that were already deleted. `history.maxEvents` still counts lifetime event-log sequence; compaction reclaims storage but does not make the workflow semantically younger. When `archive` is configured, compacted ranges are exported after deletion commits; archive failures do not roll back the checkpoint.

## Per-backend configuration

Backend transaction guarantees live with each adapter below. `SQLiteStorage`, `IndexedDBStorage`, `LMDBStorage`, and `TursoStorage` apply `batch()` operations atomically; remote or wrapper adapters inherit the guarantee of the storage they delegate to.

### `MemoryStorage`

For tests and ephemeral workflows. A `Map<string, Uint8Array>` with the same interface, running entirely in memory. Fast, deterministic, no cleanup needed.

```ts
import { MemoryStorage, Engine } from '@lostgradient/weft';

const storage = new MemoryStorage();
const engine = new Engine({ storage });
```

It also exposes `MemoryStorage`-only conveniences: the `size` getter, `clear()`, and `snapshot()` (deep copy of the internal map). The `has()` and `keys()` methods are part of the optional `Storage` interface and available on other adapters too.

If you don't pass a `storage` option to `Engine`, it defaults to `MemoryStorage`—so for quick experiments and tests, you can skip storage configuration entirely:

```ts partial
const engine = new Engine(); // uses MemoryStorage
```

### `SQLiteStorage`

The default for production persistence on Bun and Node. Import `SQLiteStorage` from `@lostgradient/weft/storage/sqlite`; export conditions resolve it to `BunSQLiteStorage` under Bun and `NodeSQLiteStorage` under Node.js.

```ts partial
import { SQLiteStorage } from '@lostgradient/weft/storage/sqlite';

using storage = new SQLiteStorage('./weft.db');
const engine = new Engine({ storage });
```

Use `@lostgradient/weft/storage/sqlite/bun` or `@lostgradient/weft/storage/sqlite/node` only when you need to force one implementation.

Under the hood, it creates a single `kv` table (`key TEXT PRIMARY KEY, value BLOB NOT NULL`) using `WITHOUT ROWID` for optimal key-value performance. WAL mode is enabled, `synchronous = NORMAL`, and the cache size is bumped—sensible defaults for a write-heavy workload.

`BunSQLiteStorage` exposes an optional `query()` method for ad-hoc SQL queries, invaluable for debugging and dashboards. `NodeSQLiteStorage` intentionally sticks to the portable `Storage` interface and does not expose SQL passthrough. Import the Bun override directly when you need SQL passthrough:

```ts partial
import { BunSQLiteStorage } from '@lostgradient/weft/storage/sqlite/bun';

using storage = new BunSQLiteStorage('./weft.db');
const rows = await storage.query<{ key: string }>('SELECT key FROM kv WHERE key LIKE ?', ['wf:%']);
```

Batch operations run inside a SQLite transaction, so they're atomic—a batch that writes a workflow state and a checkpoint either both succeed or neither does.

### `LMDBStorage`

Memory-mapped key-value backend for high-throughput workloads. Optional dependency: `lmdb`.

```ts
import { LMDBStorage } from '@lostgradient/weft/storage/lmdb';

await using storage = new LMDBStorage('./weft-data');
```

The constructor takes a directory path. LMDB creates and manages the database files inside that directory; the parent must exist. The `lmdb` package must be installed separately—if it isn't, the import throws at module load with the upstream package's missing-module error.

LMDB excels at zero-copy reads, which is unbeatable for hot-path operations like task claiming. SQLite handles most workloads well (roughly 50K writes/sec in WAL mode, 100K reads/sec). If you're pushing past 30K workflows per second and need maximum read throughput, consider LMDB.

### `TursoStorage`

libSQL/Turso backend for edge or serverless deployments. Optional dependency: `@libsql/client`.

```ts partial
import { TursoStorage } from '@lostgradient/weft/storage/turso';

await using storage = new TursoStorage({
  url: 'libsql://your-db.turso.io',
  authToken: process.env.TURSO_AUTH_TOKEN,
});
```

The `url` accepts `libsql://` (remote Turso), `file:` (local libSQL), or `file::memory:` (in-memory libSQL). `authToken` is required for remote databases and ignored for local files.

Like SQLite, the underlying schema is a single `kv` table using `WITHOUT ROWID`. Batch operations run inside a transaction.

> [!WARNING]
> `TursoStorage` always reports `readAfterWrite: 'session'`, so it always fails
> `assertDurableStorageForRecovery()`. Use it for development, testing, or
> deployments that pin all reads and writes to one libSQL connection and accept
> session-level read-after-write. For durable production recovery, use
> `NeonStorage`, `SQLiteStorage`/`BunSQLiteStorage`, or `LMDBStorage`.

### `NeonStorage`

Neon serverless Postgres for durable, remote deployments. Optional dependency: `@neondatabase/serverless`. Point it at the **primary** endpoint—`capabilities()` reports `readAfterWrite: 'linearizable'`, which a read-replica connection string would violate.

```ts partial
import { NeonStorage } from '@lostgradient/weft/storage/neon';

await using storage = new NeonStorage({
  url: process.env.NEON_DATABASE_URL,
});
```

The underlying schema is a single `kv (key TEXT COLLATE "C", value BYTEA)` table. The `COLLATE "C"` is load-bearing: Postgres `TEXT` otherwise sorts by the database locale, which reorders punctuation and would break the lexicographic prefix scans the engine relies on—`COLLATE "C"` restores byte-wise ordering. The adapter creates the table on first use and verifies the collation; if a `kv` table already exists with a different collation, it refuses to operate with an actionable error rather than silently corrupting scan order. Point the adapter at an empty database or one whose `kv` table it owns.

`batch()` and `conditionalBatch()` each run on a single pinned pool connection inside one transaction, so a multi-statement batch is atomic. `conditionalBatch()` uses `SERIALIZABLE` isolation (not `SELECT ... FOR UPDATE`, which cannot lock an absent row) and retries the whole transaction on a serialization failure (`40001`) or a deadlock (`40P01`), so concurrent compare-and-swap—the start-idempotency path—converges on exactly one winner. Each phase of a batch collapses to one statement regardless of operation count: the batch resolves to its net effect per key (last write wins, matching sequential execution), then writes the put-set as one `unnest`-driven multi-row upsert and the delete-set as one bulk delete; `conditionalBatch` reads every precondition with one `key = ANY(...)` query. A checkpoint commit—the checkpoint record plus event-log, visibility-index, and signal-bookkeeping keys—therefore pays a fixed handful of round trips instead of one per key, which over the Neon serverless WebSocket driver (a round trip per query) keeps per-step storage latency flat as the operation count grows.

The `pool` option lets you reuse a pool you manage instead of one built from `url`. An injected pool stays **caller-owned**: disposing the `NeonStorage` will not close it, so it can be shared safely. A pool the adapter builds from `url` is closed on disposal.

The `schema` and `table` options point the adapter at a configured `"schema"."table"` instead of the default unqualified `kv`. Set `schema` to keep Weft in its own Postgres schema alongside the application's tables in **one** database: Drizzle (or similar) drift/push tooling scoped to the schemas it manages coexists safely with an unmanaged sibling schema—no CI drift noise, no accidental-drop risk—and one point-in-time-restore line covers both the application data and Weft's checkpoints. When `schema` is set, the adapter runs `CREATE SCHEMA IF NOT EXISTS` before creating the qualified table, and the collation check is scoped to that table. Both names are validated as strict Postgres identifiers at construction. With neither option set, the emitted SQL is byte-identical to prior versions—existing deployments are unaffected.

```ts partial
import { NeonStorage } from '@lostgradient/weft/storage/neon';

// Weft's kv table lives in a dedicated "weft" schema; app tables stay in public.
await using scopedStorage = new NeonStorage({
  url: process.env.NEON_DATABASE_URL,
  schema: 'weft',
});
```

Both the direct and the connection-pooler (PgBouncer) Neon endpoints work, including the `SERIALIZABLE` compare-and-swap path through transaction-pooling. Use the **primary** endpoint either way—`capabilities()` reports `readAfterWrite: 'linearizable'`, which a read-replica would violate.

The Neon driver connects over WebSocket. Bun and Node 22+ provide a global `WebSocket`, so no extra wiring is needed; on Node ≤21, install `ws` and set `neonConfig.webSocketConstructor` before first use.

### `IndexedDBStorage`

Browser-native storage—the equivalent of SQLite for the browser. Persists workflow state to IndexedDB, suitable for Service Worker deployments where the engine runs entirely in the browser.

```ts partial
import { IndexedDBStorage } from '@lostgradient/weft/storage/indexeddb';

using storage = new IndexedDBStorage('weft');
const engine = new Engine({ storage });
```

The constructor takes an optional database name (defaults to `'weft'`). Under the hood, it creates a single `kv` object store with string keys and `Uint8Array` values—the same logical structure as the SQLite `kv` table.

`IndexedDBStorage` implements the full `Storage` interface except `query()`. IndexedDB has no SQL engine, so raw queries aren't available. All other methods—`get`, `put`, `delete`, `scan`, `batch`—work identically to the other adapters.

The `batch()` method is atomic. All operations run inside a single IndexedDB transaction, so a batch that writes a workflow state and a checkpoint either both succeed or neither does.

The `using` pattern works for cleanup: `[Symbol.dispose]()` closes the underlying IndexedDB database connection.

Browser consumers should use browser-safe subpath imports (`@lostgradient/weft/storage/indexeddb`, `@lostgradient/weft/storage/web-extension`) and avoid server-only adapters.

### `WebExtensionStorage`

Persists bytes through `browser.storage` or `chrome.storage` in extension contexts. Values are JSON envelopes with base64-encoded `Uint8Array` payloads.

```ts
import { WebExtensionStorage } from '@lostgradient/weft/storage/web-extension';

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
import { HTTPStorage } from '@lostgradient/weft/storage/http';

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
import { CompressedStorage } from '@lostgradient/weft/storage/compressed';
import { SQLiteStorage } from '@lostgradient/weft/storage/sqlite';

using inner = new SQLiteStorage('./weft.db');
const storage = new CompressedStorage(inner);
```

Wraps any `Storage` implementation. Disposing the `CompressedStorage` disposes the inner adapter.

## Troubleshooting

**Missing optional dependencies (`better-sqlite3`, `lmdb`, `@libsql/client`, `@neondatabase/serverless`).** `NodeSQLiteStorage`, `LMDBStorage`, `TursoStorage`, and `NeonStorage` import their dependencies lazily. If the package isn't installed, you'll see an error when you first call `resolveStorage` or instantiate the adapter. Install the adapter you selected with `bun add better-sqlite3`, `bun add lmdb`, `bun add @libsql/client`, or `bun add @neondatabase/serverless`.

**Unexpected `MemoryStorage` from automatic resolution.** `resolveStorage({ type: 'auto' })` intentionally falls back to `MemoryStorage` when no durable runtime backend is available. Use `resolveDefaultStorage()` when automatic selection must be durable or fail loudly.

**HTTP storage connectivity issues.** `HTTPStorage` returns the underlying `fetch` errors. For 4xx responses, the response body usually contains an error message; for network errors, the `fetch` exception propagates. If scans hit the 64MB response limit, the client throws explicitly—narrow the prefix or paginate with `limit` and `gt`.

# Database Decisions

The question was: what database should a durable execution engine use by default? The answer shaped more of Weft's architecture than you might expect.

## SQLite as the default

Weft uses SQLite via `bun:sqlite` as its default storage backend. Not Postgres. Not MySQL. Not Redis. SQLite.

The reasoning is straightforward. `bun:sqlite` ships _inside_ the Bun runtime. It compiles into single binaries with `bun build --compile`—zero configuration, zero native addons, zero external processes. And it gives us SQL, which is invaluable for the dashboard, ad-hoc debugging queries, and the list/filter API.

For development, this means `bun add @lostgradient/weft` and you're running. No Docker Compose, no connection strings, no database server to manage. For small-to-medium production deployments, SQLite in WAL mode handles the load without operational complexity.

## LMDB as the high-performance option

For teams running Weft at high scale—north of 30,000 workflows per second—LMDB is available as an alternative. LMDB's memory-mapped, zero-copy reads are unbeatable for hot-path operations like task claiming.

Here's how the options compare.

|                          | SQLite (bun:sqlite)        | LMDB (lmdb-js)                           |
| ------------------------ | -------------------------- | ---------------------------------------- |
| **Built into Bun**       | Yes                        | No—npm dependency with native addon      |
| **Compiles into binary** | Automatically              | Needs native addon bundled               |
| **Read performance**     | ~100K reads/sec            | ~1M+ reads/sec (memory-mapped zero-copy) |
| **Write performance**    | ~50K writes/sec (WAL mode) | ~100K+ writes/sec (batched async)        |
| **Concurrent readers**   | Unlimited in WAL mode      | Unlimited (MVCC, zero locks)             |
| **Multi-process safe**   | Yes                        | Yes (shared memory)                      |
| **Browser equivalent**   | sql.js (WASM) or OPFS      | No browser equivalent                    |
| **Query flexibility**    | Full SQL                   | Key-value only, range scans              |
| **Crash safety**         | ACID                       | ACID, crash-proof by design              |

The tradeoff is clear: LMDB is faster for pure key-value workloads, but SQLite gives you ergonomics and deployment simplicity that matter more for most teams.

## Why not Postgres or MySQL

Embedded beats networked for this workload. A Temporal-style architecture requires a separate database server, which means network round-trips on every storage operation. Weft's SQLite reads complete in ~10 microseconds (in-process). A networked database read takes ~1 millisecond—100x slower. That difference compounds across every checkpoint write, every task claim, every timer check.

The durable execution hot path is _many small reads and writes_, not complex relational queries. An embedded database eliminates the network entirely.

This is a default, not a prohibition. Embedded SQLite and LMDB remain the right call for the in-process hot path, but some deployments want their durable state owned by a managed, externally-durable service rather than a local file—point-in-time restore, branching, and zero local disk to back up. For those, [`NeonStorage`](../guides/storage.md#choosing-a-backend) is a deliberate _remote_ option over Neon/Postgres. You trade the in-process latency above for managed durability; whether that trade is right depends on your operational constraints, not on throughput alone. See [Running Weft as a Singleton Service](../guides/singleton-service-deployment.md) for the deployment model a remote durable store fits into.

## The storage interface

The storage interface is KV-oriented (not SQL-oriented) so it can support SQLite, LMDB, and IndexedDB with the same contract.

```typescript partial
interface Storage {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]>;
  batch(operations: BatchOperation[]): Promise<void>;

  // Optional: SQL passthrough for dashboard/debugging (SQLite only)
  query?<T>(sql: string, params?: unknown[]): Promise<T[]>;
}
```

> [!NOTE]
> The full interface in `src/storage/interface.ts` extends `Disposable` and includes additional optional methods: `conditionalBatch`, `has`, `deletePrefix`, `keys`, `count`, and `scoped`.

The `scan` method returns entries in key order, which is the foundation of the entire key layout design. The `batch` method provides atomic multi-key writes—critical for operations like "update the checkpoint and schedule the next operation" in a single transaction.

## Key layout conventions

Hierarchical keys encode structure. The key prefix determines the data type, and sort order within each prefix gives you efficient range scans.

```
wf:{id}                                       → workflow state blob
wf:{id}:ckpt                                  → checkpoint blob
op:{queue}:{scheduled}:{id}                   → operation blob (sorted by queue + time)
ev:{workflow_id}:{seq}                         → event blob (sorted by workflow + sequence)
sig:{workflow_id}:{encoded_name}:{id}          → signal blob
wf-deadline:{deadline}:{workflowId}            → timeout deadline entry
attr:{workflow_id}                             → search attribute blob
idx:{attr_name}:{encoded_value}:{workflow_id}  → secondary index for search attributes
upd:{workflow_id}:{update_id}                  → pending update request
upr:{update_id}                                → update response
```

Signal names are encoded as a single key component before writing `sig:` records. This keeps a signal named `order:placed` distinct from the `order` prefix scan. This layout means `scan("op:default:")` returns all operations on the "default" queue in scheduled order. The core hot path—claiming the next task from a queue—is a single range scan, whether that's implemented as a SQLite `SELECT ... WHERE key >= ? AND key < ?` or an LMDB `cursor.getRange()`.

## SQLite implementation details

The SQLite backend uses a single `WITHOUT ROWID` table.

```sql
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value BLOB NOT NULL,
  expires_at INTEGER
) WITHOUT ROWID
```

`WITHOUT ROWID` tells SQLite to store data directly in the B-tree index. For a key-value table where the key _is_ the primary key, this avoids a level of indirection and makes lookups roughly 2x faster. It's the right optimization for a workload that's almost entirely primary key lookups and prefix range scans.

The performance PRAGMAs matter too.

```sql
PRAGMA journal_mode = WAL;       -- Write-ahead logging: readers don't block writers
PRAGMA synchronous = NORMAL;     -- Durability with less fsync overhead
PRAGMA cache_size = -64000;      -- 64MB page cache
-- Also set in src/storage/bun-sql.ts:
PRAGMA mmap_size = 268435456;    -- Memory-mapped I/O
PRAGMA temp_store = MEMORY;      -- Keep temporary tables in memory
PRAGMA wal_autocheckpoint = 10000;
```

WAL mode is essential. It allows unlimited concurrent readers while writes happen—the workflow engine reads checkpoints constantly while periodically writing new ones.

## IndexedDB for browsers

The browser storage backend uses IndexedDB, which provides the same key-value semantics. Range scans use `IDBKeyRange.bound()`, and batch writes use a single `readwrite` transaction.

```typescript partial
class IndexedDBStorage implements Storage {
  async get(key: string): Promise<Uint8Array | null> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readonly');
      const request = tx.objectStore('kv').get(key);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  }
  // ...
}
```

The same key layout, the same scan semantics, the same atomic batch writes. Different platform, same interface.

This is why the storage interface is KV-oriented rather than SQL-oriented. SQL would lock us into backends that support it. A KV interface runs on SQLite (with SQL as a bonus), LMDB, IndexedDB, and anything else that can store and retrieve bytes by key.

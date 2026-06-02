# Runtime and Deployment

This companion document was split out of [../architecture.md](../architecture.md) so the roadmap can stay checklist-first. It covers storage, binary distribution, browser/service-worker runtime, HTTP and WebSocket serving, and remote-worker execution.

The long-form research write-up now lives in [./research.md](./research.md). The transport roadmap described in [../architecture.md](../architecture.md) must continue to treat HTTP, WebSocket, SSE, and future JSON-RPC surfaces as adapters over the same engine execution and messaging primitives rather than alternate runtime systems.

### 7. The Database Decision: SQLite (via Bun.SQL) + LMDB Option

**The question was: SQLite vs LevelDB vs LMDB?**

**The answer: SQLite as default, LMDB as high-performance option. Not LevelDB.**

Here's the reasoning:

|                          | SQLite (Bun.SQL)                                | LMDB (lmdb-js)                                             | LevelDB                               |
| ------------------------ | ----------------------------------------------- | ---------------------------------------------------------- | ------------------------------------- |
| **Built into Bun**       | Yes — `Bun.SQL` ships with the runtime          | No — npm dependency with native addon                      | No — npm dependency with native addon |
| **Compiles into binary** | `bun build --compile` includes it automatically | Needs native addon bundled                                 | Needs native addon bundled            |
| **Read performance**     | Fast (~100K reads/sec)                          | Fastest possible (~1M+ reads/sec, memory-mapped zero-copy) | Good (~200K reads/sec)                |
| **Write performance**    | ~50K writes/sec (WAL mode)                      | ~100K+ writes/sec (batched async)                          | ~30K writes/sec                       |
| **Concurrent readers**   | Unlimited in WAL mode                           | Unlimited (MVCC, zero locks)                               | Single-process only                   |
| **Multi-process safe**   | Yes                                             | Yes (shared memory)                                        | No — single process lock              |
| **Browser equivalent**   | sql.js (WASM) or OPFS                           | No browser equivalent                                      | IndexedDB (via abstract-level)        |
| **Query flexibility**    | Full SQL — ad-hoc queries, JOINs, aggregation   | Key-value only, range scans                                | Key-value only, range scans           |
| **Bun support**          | First-class                                     | Official (uses Node-API)                                   | Unofficial                            |
| **Used in production**   | Everywhere                                      | Parcel, HarperDB, Kibana, Gatsby                           | Chrome (internal)                     |
| **Crash safety**         | ACID                                            | ACID, crash-proof by design                                | Good, but not full ACID               |

> **Why not LevelDB?** It's single-process only (no multi-process access), slower on writes than both alternatives, and its main advantage — the `abstract-level` ecosystem with browser backends — doesn't justify the tradeoffs when we already have a clean storage interface pattern. LMDB is strictly better for our server-side workload.

> **Why not LMDB as default?** Because `Bun.SQL` (SQLite) ships inside the Bun runtime. It compiles into single binaries with zero configuration. It requires no native addons. And it gives us SQL — which is invaluable for the dashboard, ad-hoc debugging queries, and the list/filter API. LMDB is faster for pure KV workloads, but the ergonomic and deployment advantages of built-in SQLite outweigh the raw performance difference for v1.

> **When should you use LMDB?** When you're running Weft in server mode at high scale (>30K workflows/sec) and you need maximum read throughput. LMDB's memory-mapped, zero-copy reads are unbeatable for hot-path operations like task claiming. The `lmdb-js` package officially supports Bun with Node-API bindings.

**The storage interface is KV-oriented** (not SQL-oriented) to support both:

```typescript
interface Storage {
  // Core KV operations
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;

  // Range scans (ordered by key)
  scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]>;

  // Atomic batch writes (multiple puts/deletes in one transaction)
  batch(operations: BatchOperation[]): Promise<void>;

  // Optional: SQL passthrough for dashboard/debugging (SQLite only)
  query?<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

interface ScanOptions {
  limit?: number;
  reverse?: boolean;
  gt?: string; // greater than
  lt?: string; // less than
  gte?: string; // greater than or equal
  lte?: string; // less than or equal
}
```

**Key design pattern:** Hierarchical keys encode structure:

```
wf:{id}                                       → workflow state blob
wf:{id}:ckpt                                  → checkpoint blob
op:{queue}:{scheduled}:{id}                   → operation blob (sorted by queue + time)
ev:{workflow_id}:{seq}                         → event blob (sorted by workflow + sequence)
sig:{workflow_id}:{name}:{id}                  → signal blob
wf-deadline:{deadline}:{workflowId}            → timeout deadline entry (execution or run)
attr:{workflow_id}                             → search attribute blob (all attrs for a workflow)
idx:{attr_name}:{encoded_value}:{workflow_id}  → secondary index entry for search attributes
upd:{workflow_id}:{update_id}                  → pending update request
upr:{update_id}                                → update response
upk:{workflow_id}:{idempotency_key}            → update idempotency mapping
```

This key layout means `scan("op:default:")` returns all operations on the "default" queue in scheduled order — the core hot path is a single range scan, whether that's implemented as a SQLite `SELECT ... WHERE key >= ? AND key < ?` or an LMDB `cursor.getRange()`.

#### Bun.SQL Implementation (Default)

```typescript
import { SQL } from 'bun';

class BunSQLiteStorage implements Storage {
  private db: SQL;

  constructor(path: string = 'weft.db') {
    // Bun.SQL's unified API — tagged template literals
    this.db = new SQL(`sqlite://${path}`);
    this.#init();
  }

  async #init() {
    // Single KV table — simple, fast, indexes do the heavy lifting
    await this.db`
      CREATE TABLE IF NOT EXISTS kv (
        key   TEXT PRIMARY KEY,
        value BLOB NOT NULL,
        expires_at INTEGER
      ) WITHOUT ROWID
    `;
    // WITHOUT ROWID: Tells SQLite to store data directly in the B-tree index.
    // For a KV table where the key IS the primary key, this avoids a level of
    // indirection and makes lookups ~2x faster.

    // Partial index: only index rows with an expiration (for TTL cleanup)
    await this.db`
      CREATE INDEX IF NOT EXISTS idx_expires
      ON kv(expires_at) WHERE expires_at IS NOT NULL
    `;

    // Performance PRAGMAs
    await this.db`PRAGMA journal_mode = WAL`;
    await this.db`PRAGMA synchronous = NORMAL`;
    await this.db`PRAGMA cache_size = -64000`;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const [row] = await this.db`SELECT value FROM kv WHERE key = ${key}`;
    return row?.value ?? null;
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    await this.db`
      INSERT INTO kv (key, value) VALUES (${key}, ${value})
      ON CONFLICT(key) DO UPDATE SET value = ${value}
    `;
  }

  async delete(key: string): Promise<void> {
    await this.db`DELETE FROM kv WHERE key = ${key}`;
  }

  async *scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]> {
    // Range scan: all keys starting with prefix
    const end = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
    const rows = await this.db`
      SELECT key, value FROM kv
      WHERE key >= ${options?.gte ?? prefix} AND key < ${options?.lt ?? end}
      ORDER BY key ${options?.reverse ? this.db`DESC` : this.db`ASC`}
      ${options?.limit ? this.db`LIMIT ${options.limit}` : this.db``}
    `;
    for (const row of rows) {
      yield [row.key, row.value];
    }
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    await this.db.begin(async (tx) => {
      for (const op of operations) {
        if (op.type === 'put') {
          await tx`INSERT INTO kv (key, value) VALUES (${op.key}, ${op.value})
                   ON CONFLICT(key) DO UPDATE SET value = ${op.value}`;
        } else {
          await tx`DELETE FROM kv WHERE key = ${op.key}`;
        }
      }
    });
  }

  // Bonus: SQL passthrough for dashboard queries
  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    // Only available on the SQL backend — LMDB and IndexedDB don't have this
    return (await this.db.unsafe(sql, params)) as T[];
  }
}
```

#### LMDB Implementation (High-Performance Option)

```typescript
import { open, RootDatabase } from 'lmdb';

class LMDBStorage implements Storage {
  private db: RootDatabase;

  constructor(path: string = './weft-data') {
    this.db = open({
      path,
      // LMDB is memory-mapped: reads are zero-copy pointers into mmap'd pages.
      // This is why it's so fast — no serialization/deserialization for reads.
      mapSize: 2 * 1024 * 1024 * 1024, // 2GB initial map (auto-grows)
      maxDbs: 1,
      // lmdb-js handles write batching automatically:
      // Multiple put() calls are coalesced into one transaction commit,
      // which happens asynchronously on a separate thread.
    });
  }

  async get(key: string): Promise<Uint8Array | null> {
    // Synchronous! LMDB reads are memory-mapped — no I/O, no event loop delay.
    // lmdb-js returns the value directly from mmap'd memory.
    return this.db.getBinary(key) ?? null;
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    // Asynchronous: lmdb-js batches this write with others and commits
    // on a background thread. The promise resolves when flushed to disk.
    await this.db.put(key, value);
  }

  async delete(key: string): Promise<void> {
    await this.db.remove(key);
  }

  async *scan(prefix: string, options?: ScanOptions): AsyncIterable<[string, Uint8Array]> {
    // LMDB stores keys in sorted order — range scans are native and fast
    const range = this.db.getRange({
      start: options?.gte ?? prefix,
      end:
        options?.lt ??
        prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1),
      reverse: options?.reverse,
      limit: options?.limit,
    });
    for (const { key, value } of range) {
      yield [key as string, value as Uint8Array];
    }
  }

  async batch(operations: BatchOperation[]): Promise<void> {
    // lmdb-js supports explicit atomic transactions
    await this.db.transaction(() => {
      for (const op of operations) {
        if (op.type === 'put') {
          this.db.putSync(op.key, op.value);
        } else {
          this.db.removeSync(op.key);
        }
      }
    });
  }
}
```

#### IndexedDB Implementation (Browser)

```typescript
class IndexedDBStorage implements Storage {
  private db: IDBDatabase | null = null;
  private dbName: string;

  constructor(dbName: string = 'weft') {
    this.dbName = dbName;
  }

  private async open(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('kv')) {
          db.createObjectStore('kv');
        }
      };
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async get(key: string): Promise<Uint8Array | null> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readonly');
      const request = tx.objectStore('kv').get(key);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ... scan uses IDBKeyRange.bound() for range queries
  // ... batch uses a single readwrite transaction
}
```

### 8. Single Binary Distribution

`bun build --compile` produces standalone executables that include the Bun runtime, all your code, and embedded assets (including the web dashboard). End users download one file and run it.

```bash
# Build for all platforms from any OS
bun build --compile --target=bun-darwin-arm64  src/cli.ts --outfile dist/weft-darwin-arm64
bun build --compile --target=bun-darwin-x64    src/cli.ts --outfile dist/weft-darwin-x64
bun build --compile --target=bun-linux-x64     src/cli.ts --outfile dist/weft-linux-x64
bun build --compile --target=bun-linux-arm64   src/cli.ts --outfile dist/weft-linux-arm64
bun build --compile --target=bun-windows-x64   src/cli.ts --outfile dist/weft-windows-x64.exe

# Windows gets proper metadata
# (via Bun 1.2.21+ compile options for title, version, publisher, etc.)
```

**What ships inside the binary:**

- The Bun runtime (includes SQLite, HTTP server, WebSocket, etc.)
- Weft engine, server, worker code
- The web dashboard (pre-built React SPA, embedded as assets)
- Default configuration

**What does NOT ship inside the binary** (and shouldn't):

- LMDB native bindings (opt-in via `bun add lmdb` when using LMDB storage)
- Workflow and activity code (user's code, loaded at runtime or built into their own binary)

```typescript
// src/cli.ts — the entry point compiled into the binary
import { parseArgs } from 'util';
import { serve } from './server/index.ts';
import { Engine, BunSQLiteStorage } from './core/index.ts';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: 'string', default: '7233' },
    data: { type: 'string', default: './weft-data' },
    ui: { type: 'boolean', default: true },
    storage: { type: 'string', default: 'sqlite' }, // "sqlite" | "lmdb"
  },
});

// Embed the dashboard as a file asset
import dashboardHTML from './ui/dist/index.html' with { type: 'file' };

const storage =
  values.storage === 'lmdb'
    ? new (await import('./storage/lmdb.ts')).LMDBStorage(values.data)
    : new BunSQLiteStorage(`${values.data}/weft.db`);

serve({
  port: parseInt(values.port),
  storage,
  dashboard: values.ui ? dashboardHTML : undefined,
});
```

**User distribution modes:**

```bash
# Mode 1: Standalone server (download and run)
curl -L https://github.com/weft/weft/releases/download/v1/weft-darwin-arm64 -o weft
chmod +x weft
./weft --port 7233

# Mode 2: Library (import into your project)
bun add @lostgradient/weft

# Mode 3: User compiles their own binary with workflows baked in
bun build --compile src/my-app.ts --outfile my-app
# my-app includes Weft engine + your workflow code in one binary
```

### 9. Service Worker: The Browser Runtime

> **What is a Service Worker?** A Service Worker is a special kind of Web Worker that acts as a proxy between your web app and the network. It intercepts `fetch` events, can cache responses, and crucially — **it runs in the background even when the tab is closed.** It has access to IndexedDB for persistent storage and `setTimeout`-like scheduling. It's how PWAs (Progressive Web Apps) work offline.

For Weft, a Service Worker is the **browser equivalent of the Bun server process**:

```
┌──────────────────────────────────────────────────────┐
│ Browser Tab (your app)                               │
│                                                      │
│  const weft = new WeftClient();                      │
│  await weft.start("order", { orderId: "abc" });      │
│                                                      │
│  // This fetch() is intercepted by the Service Worker│
│  fetch("/weft/v1/workflows", { method: "POST", ... })│
│                                                      │
└──────────────────┬───────────────────────────────────┘
                   │ fetch event
┌──────────────────▼───────────────────────────────────┐
│ Service Worker (weft-sw.ts)                          │
│                                                      │
│  self.addEventListener("fetch", (event) => {         │
│    if (event.request.url.includes("/weft/")) {       │
│      event.respondWith(engine.handleRequest(event)); │
│    }                                                 │
│  });                                                 │
│                                                      │
│  Engine(IndexedDBStorage) ← same engine code!        │
│                                                      │
│  // Durable timers via IndexedDB + periodic check    │
│  // Workflow execution in spawned Web Workers         │
│  // Survives tab close (Service Worker lifecycle)     │
└──────────────────────────────────────────────────────┘
```

**What this enables:**

- **Offline-first durable workflows.** An app starts a workflow (e.g., "sync these photos when online"). The Service Worker persists the workflow to IndexedDB. Even if the user closes the tab, the Service Worker can resume when the browser wakes it up.
- **Same API surface.** The Weft client library calls `fetch("/weft/v1/workflows", ...)`. In server mode, this goes over the network to a Weft server. In browser mode, the Service Worker intercepts it. The client code is identical.
- **Hybrid mode.** The Service Worker can be a local cache/queue that syncs with a remote Weft server. Start workflows locally, sync state when online.

```typescript
// weft-sw.ts — installed as a Service Worker
/// <reference lib="webworker" />

import { Engine } from '@lostgradient/weft';
import { IndexedDBStorage } from '@lostgradient/weft/storage/indexeddb';
import { handleRequest } from '@lostgradient/weft/server/handler'; // Pure request→response, no Bun.serve dependency

const engine = new Engine({
  storage: new IndexedDBStorage('weft'),
});

// Intercept fetch events — same API as the HTTP server
self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/weft/')) {
    event.respondWith(handleRequest(event.request, engine));
  }
});

// Periodic timer check (Service Worker wakeup)
// Browsers can wake a Service Worker periodically via the Periodic Background Sync API
self.addEventListener('periodicsync', (event: PeriodicSyncEvent) => {
  if (event.tag === 'weft-timers') {
    event.waitUntil(engine.processExpiredTimers());
  }
});
```

> **Limitation:** Service Workers don't have unlimited background execution time. Browsers limit how long a Service Worker can run after the page is closed. For truly long-running workflows, you'd still need a server. The Service Worker is ideal for: queuing work, short workflows, offline caching, and syncing state with a remote server.

### 10. HTTP + WebSocket — No gRPC, No Protobuf

The current implementation is already HTTP-first and authenticates the incoming `Request` before accepting a WebSocket upgrade. Track 8 extends this section with a shared runtime operation catalog that generates OpenAPI for REST-ish HTTP routes and OpenRPC for JSON-RPC over HTTP, WebSocket, and opt-in stdio. That work does not replace the existing `Engine`, `EventTarget`, `BroadcastChannel`, or Worker `postMessage` internals; it exposes them through machine-readable contracts and a transport-neutral authorization layer.

Modern Bun releases include route-based `Bun.serve()`, which is the most idiomatic way to define an HTTP API:

```typescript
import { serve } from 'bun';

const server = serve({
  port: 7233,

  routes: {
    // Workflow Management (JSON API)
    'POST /api/v1/workflows': async (req) => {
      const body = await req.json();
      const handle = await engine.start(body.type, body.input, {
        idempotencyKey: body.idempotencyKey,
        executionTimeout: body.executionTimeout,
        searchAttributes: body.searchAttributes,
      });
      return Response.json({ id: handle.id, status: 'running' }, { status: 201 });
    },

    'GET /api/v1/workflows/:id': async (req) => {
      const workflow = await engine.get(req.params.id);
      if (!workflow) return new Response('Not found', { status: 404 });
      return Response.json(workflow);
    },

    'DELETE /api/v1/workflows/:id': async (req) => {
      await engine.cancel(req.params.id);
      return new Response(null, { status: 204 });
    },

    'POST /api/v1/workflows/:id/signal/:name': async (req) => {
      const payload = await req.json();
      await engine.signal(req.params.id, req.params.name, payload);
      return Response.json({ delivered: true });
    },

    'GET /api/v1/workflows/:id/query/:name': async (req) => {
      const result = await engine.query(req.params.id, req.params.name);
      return Response.json(result);
    },

    // Search Attributes
    'GET /api/v1/workflows/:id/attributes': async (req) => {
      const attributes = await engine.getAttributes(req.params.id);
      if (!attributes) return new Response('Not found', { status: 404 });
      return Response.json(attributes);
    },

    'PATCH /api/v1/workflows/:id/attributes': async (req) => {
      const attributes = await req.json();
      await engine.setAttributes(req.params.id, attributes);
      return Response.json({ updated: true });
    },

    // Synchronous Updates
    'POST /api/v1/workflows/:id/update/:name': async (req) => {
      const { payload, timeout, idempotencyKey } = await req.json();
      try {
        const result = await engine.update(req.params.id, req.params.name, payload, {
          timeout: timeout ?? 30_000,
          idempotencyKey,
        });
        return Response.json({ result });
      } catch (error) {
        if (error instanceof UpdateTimeoutError) {
          return Response.json({ error: 'timeout', updateId: error.updateId }, { status: 408 });
        }
        throw error;
      }
    },

    'GET /api/v1/updates/:updateId': async (req) => {
      const response = await engine.getUpdateResponse(req.params.updateId);
      if (!response) return Response.json({ status: 'pending' }, { status: 202 });
      return Response.json({ status: 'completed', result: response.result, error: response.error });
    },

    'GET /api/v1/workflows': async (req) => {
      const url = new URL(req.url);
      const filter: ListFilter = {
        status: url.searchParams.get('status'),
        type: url.searchParams.get('type'),
        limit: parseInt(url.searchParams.get('limit') ?? '50'),
        cursor: url.searchParams.get('cursor'),
        attributes: [],
      };
      // Parse attribute filters: ?attr.customerId=abc&attr.priority.gte=8
      for (const [param, value] of url.searchParams) {
        if (!param.startsWith('attr.')) continue;
        const parts = param.slice(5).split('.');
        const key = parts[0];
        const operator = parts[1] ?? 'eq';
        const existing = filter.attributes!.find((a) => a.key === key) ?? { key };
        if (!filter.attributes!.includes(existing)) filter.attributes!.push(existing);
        switch (operator) {
          case 'eq':
            existing.value = value;
            break;
          case 'gte':
            existing.gte = value;
            break;
          case 'lte':
            existing.lte = value;
            break;
          case 'gt':
            existing.gt = value;
            break;
          case 'lt':
            existing.lt = value;
            break;
        }
      }
      const result = await engine.list(filter);
      return Response.json(result);
    },

    // Agent-Specific Endpoints
    'GET /api/v1/workflows/:id/conversation': async (req) => {
      const agentConversation = query<void, AgentConversation>('agentConversation');
      const conversation = await engine.query(req.params.id, agentConversation);
      if (!conversation) return new Response('Not found', { status: 404 });
      return Response.json(conversation);
    },

    'GET /api/v1/workflows/:id/cost': async (req) => {
      const agentCostWaterfall = query<void, AgentCostWaterfall>('agentCostWaterfall');
      const cost = await engine.query(req.params.id, agentCostWaterfall);
      if (!cost) return new Response('Not found', { status: 404 });
      return Response.json(cost);
    },

    'GET /api/v1/reviews': async (req) => {
      const reviews = await engine.listReviews({
        status: req.query.status,
        workflowId: req.query.workflowId,
        reviewType: req.query.reviewType,
      });
      return Response.json(reviews);
    },

    'GET /api/v1/workflows/:id/review/:reviewId': async (req) => {
      // getReview() lives on HumanReviewCoordinator, not Engine directly
      const reviews = await engine.listReviews({ workflowId: req.params.id });
      const review = reviews.find(
        (r) => r.reviewId === req.params.reviewId && r.workflowId === req.params.id,
      );
      if (!review) return new Response('Not found', { status: 404 });
      return Response.json(review);
    },

    'POST /api/v1/reviews/:reviewId/decision': async (req) => {
      const { decision, reviewer, feedback } = await req.json();
      await engine.submitReview(req.params.reviewId, {
        decision,
        reviewer,
        feedback,
      });
      return Response.json({ submitted: true });
    },

    // Health + Metrics
    'GET /v1/health': () => Response.json({ status: 'ok' }),
    'GET /v1/metrics': async () =>
      new Response(await engine.metrics(), {
        headers: { 'Content-Type': 'text/plain' },
      }),

    // Dashboard (embedded SPA) — mounted at its specific top-level page
    // routes, never a blanket `/*` (which would shadow the API, since Bun
    // matches the `routes` map before the `fetch` fallback).
    '/': (req) => new Response(Bun.file(dashboardHTML)),
    '/workflows': (req) => new Response(Bun.file(dashboardHTML)),
    '/workflows/*': (req) => new Response(Bun.file(dashboardHTML)),
    '/reviews': (req) => new Response(Bun.file(dashboardHTML)),
    '/workers': (req) => new Response(Bun.file(dashboardHTML)),
  },

  // WebSocket upgrade handling
  async fetch(req, server) {
    const url = new URL(req.url);

    // Worker task stream
    if (url.pathname.match(/^\/v1\/tasks\/[\w-]+\/stream$/)) {
      const queue = url.pathname.split('/')[3];
      if (server.upgrade(req, { data: { type: 'worker', queue } })) return;
    }

    // Workflow observation stream
    if (url.pathname.match(/^\/v1\/workflows\/[\w-]+\/watch$/)) {
      const id = url.pathname.split('/')[3];
      if (server.upgrade(req, { data: { type: 'watch', workflowId: id } })) return;
    }

    // Token streaming
    if (url.pathname.match(/^\/v1\/workflows\/[\w-]+\/stream$/)) {
      const id = url.pathname.split('/')[3];
      if (server.upgrade(req, { data: { type: 'tokens', workflowId: id } })) return;
    }

    // Agent-specific streaming (turns + tokens + tool calls)
    if (url.pathname.match(/^\/v1\/workflows\/[\w-]+\/agent-stream$/)) {
      const id = url.pathname.split('/')[3];
      if (server.upgrade(req, { data: { type: 'agent', workflowId: id } })) return;
    }

    return new Response('Not Found', { status: 404 });
  },

  websocket: {
    open(ws) {
      const { type } = ws.data;
      if (type === 'worker') ws.subscribe(`tasks:${ws.data.queue}`);
      if (type === 'watch') ws.subscribe(`events:${ws.data.workflowId}`);
      if (type === 'tokens') ws.subscribe(`tokens:${ws.data.workflowId}`);
      if (type === 'agent') ws.subscribe(`agent:${ws.data.workflowId}`);
    },
    message(ws, msg) {
      /* task completion from workers */
    },
    close(ws) {
      /* cleanup subscriptions */
    },
  },
});
```

> **Note the `ws.subscribe()` / `ws.publish()` pattern.** Bun's WebSocket server has built-in pub/sub — you don't need Redis or any external message broker. `ws.subscribe("events:wf-abc")` means this connection receives any message published to that topic. This is how we fan out workflow events to multiple observers without maintaining subscriber lists ourselves.

### 11. Remote Workers

In library mode, workflows and activities run in-process via Web Workers. In server mode, **remote workers** connect to the Weft server over WebSocket and execute activities on separate machines or processes — the same model Temporal uses. This is how you scale activity execution horizontally: the Weft server owns scheduling, checkpointing, and coordination; remote workers own compute.

#### Activity Registration and Connection

A remote worker is a standalone process that connects to a Weft server, declares which task queue it serves and which activities it can execute, then loops waiting for tasks. The worker registers its activity functions locally — the server never sees or evaluates user code.

```typescript
// my-worker.ts — runs as a separate process, connects to a Weft server
import { RemoteWorker } from '@lostgradient/weft';

import { charge } from './activities/charge.ts';
import { ship } from './activities/ship.ts';
import { sendEmail } from './activities/email.ts';

const worker = new RemoteWorker({
  serverUrl: 'ws://weft-server:7233/api/v1/tasks/default/stream',
  queue: 'default',
  identity: `worker-${crypto.randomUUID()}`, // unique per process
  concurrency: 10, // max simultaneous activities
  activities: { charge, ship, sendEmail }, // name → function map
});

await worker.run(); // connects, registers, begins processing tasks
```

```bash
# Run 3 workers on different machines, all serving the same queue
bun run my-worker.ts  # machine A
bun run my-worker.ts  # machine B
bun run my-worker.ts  # machine C
```

The server doesn't need to know about workers in advance. Workers are ephemeral — they connect, process tasks, and can disconnect at any time. The server detects disconnection and reassigns in-flight tasks.

#### Task Claiming Protocol

Task dispatch is **server-push over WebSocket**, not client-poll. This eliminates the polling overhead and latency that come with pull-based models. The protocol works as follows:

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Worker connects: WS /api/v1/tasks/:queue/stream                 │
│ 2. Worker sends REGISTER: { identity, activities, concurrency } │
│ 3. Server tracks worker capacity (concurrency - in_flight)      │
│ 4. Server pushes TASK to worker when capacity > 0               │
│ 5. Worker sends RESULT (success/failure) when done              │
│ 6. Server updates capacity, may push next task immediately      │
└─────────────────────────────────────────────────────────────────┘
```

**No race conditions.** The server assigns each task to exactly one worker. Unlike a pull model where multiple workers poll and race to claim, the server makes the assignment decision and pushes to a single connection. If the chosen worker disconnects before acknowledging, the server reassigns.

```typescript
// ─── WebSocket message types (server ↔ worker) ───

// Worker → Server
type WorkerMessage =
  | { type: 'register'; identity: string; activities: string[]; concurrency: number }
  | {
      type: 'result';
      operationId: string;
      outcome: 'completed' | 'failed';
      value?: unknown;
      error?: string;
    }
  | { type: 'heartbeat'; operationId: string; details?: unknown }
  | { type: 'updateResult'; updateId: string; result?: unknown; error?: string };

// Server → Worker
type ServerMessage =
  | {
      type: 'task';
      operationId: string;
      activityName: string;
      input: unknown;
      attempt: number;
      headers: Record<string, string>;
    }
  | { type: 'cancel'; operationId: string; reason: string }
  | { type: 'shutdown'; reason: string; gracePeriodMs: number }
  | { type: 'update'; updateId: string; name: string; payload: unknown };
```

**Queue-based routing.** When a workflow dispatches an activity with `yield* ctx.run(charge, order, { queue: "payments" })`, the server enqueues the task on the `"payments"` queue. Only workers subscribed to that queue receive it. This lets you route CPU-heavy work to beefy machines, GPU work to GPU nodes, and so on — without the workflow knowing or caring about the topology.

#### Visibility Timeout and Heartbeats

When the server pushes a task to a worker, it starts a **visibility timeout** — a deadline by which the worker must either complete the task or send a heartbeat proving it's still working. If the timeout expires with no heartbeat and no result, the server assumes the worker is dead and reassigns the task to another worker.

```typescript
// Server-side: visibility timeout management
const VISIBILITY_TIMEOUT_MS = 30_000; // 30 seconds default, configurable per activity

function dispatchTask(worker: WebSocket, operation: Operation) {
  worker.send(
    JSON.stringify({
      type: 'task',
      operationId: operation.id,
      activityName: operation.activityName,
      input: operation.input,
      attempt: operation.attempt,
    }),
  );

  // Start the visibility clock — stored in the database, not in memory,
  // so it survives server restarts too
  storage.batch([
    {
      type: 'put',
      key: `op:inflight:${operation.id}`,
      value: encode({
        workerId: worker.data.identity,
        assignedAt: Date.now(),
        visibilityDeadline: Date.now() + VISIBILITY_TIMEOUT_MS,
      }),
    },
  ]);
}

// Scheduler periodically scans for expired visibility timeouts
async function reclaimExpiredTasks() {
  for await (const [key, value] of storage.scan('op:inflight:')) {
    const info = decode(value);
    if (Date.now() > info.visibilityDeadline) {
      // Worker missed the deadline — reassign the task
      await requeueOperation(info);
      await storage.delete(key);
    }
  }
}
```

**Worker-side heartbeats.** For long-running activities (large file uploads, ML inference, multi-step API calls), the worker sends periodic heartbeats to extend the visibility deadline. Heartbeats can carry progress details that are queryable from the workflow.

```typescript
// Worker-side: heartbeat during a long activity
async function executeWithHeartbeat(
  ws: WebSocket,
  operationId: string,
  fn: Function,
  input: unknown,
  heartbeatIntervalMs: number = 10_000,
) {
  const controller = new AbortController();

  // Heartbeat loop — runs in parallel with the activity
  const heartbeatInterval = setInterval(() => {
    ws.send(
      JSON.stringify({
        type: 'heartbeat',
        operationId,
        details: { timestamp: Date.now() },
      }),
    );
  }, heartbeatIntervalMs);

  // Listen for cancellation from server
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'cancel' && msg.operationId === operationId) {
      controller.abort(new Error(msg.reason));
    }
  });

  try {
    const result = await fn(input, { signal: controller.signal });
    return { outcome: 'completed' as const, value: result };
  } catch (error) {
    return { outcome: 'failed' as const, error: String(error) };
  } finally {
    clearInterval(heartbeatInterval);
  }
}
```

Each heartbeat resets the visibility deadline on the server:

```typescript
// Server-side: heartbeat extends the deadline
function handleHeartbeat(operationId: string, details?: unknown) {
  storage.put(
    `op:inflight:${operationId}`,
    encode({
      ...existingInfo,
      visibilityDeadline: Date.now() + VISIBILITY_TIMEOUT_MS,
      lastHeartbeat: Date.now(),
      heartbeatDetails: details,
    }),
  );
}
```

```typescript partial
const activityProgressQuery = query<void, { timestamp: number }>('activityProgress');
```

Heartbeat details are queryable from the workflow via `handle.query(activityProgressQuery)`, enabling progress UIs without custom plumbing.

#### Worker Identity and Routing

Every remote worker has a unique **identity** string (defaulting to a UUID). The server uses identity for:

- **Logging and debugging.** Every task assignment is logged with the worker identity, so you can trace exactly which machine ran which activity.
- **Sticky routing (opt-in).** For workflows that benefit from cache locality — e.g., an ML workflow where the first activity loads a model into GPU memory — the server can prefer routing subsequent activities from the same workflow to the same worker. This is opt-in via `ctx.run(fn, args, { sticky: true })`.
- **Graceful shutdown.** When a worker receives a `shutdown` message (e.g., during a rolling deploy), it stops accepting new tasks, finishes in-flight work, then disconnects. The server tracks which workers are draining and avoids routing to them.

```typescript
// Server-side: worker tracking
class WorkerRegistry {
  #workers = new Map<string, WorkerInfo>();

  register(ws: WebSocket, identity: string, activities: string[], concurrency: number) {
    this.#workers.set(identity, {
      ws,
      identity,
      activities: new Set(activities),
      concurrency,
      inFlight: 0,
      draining: false,
    });
  }

  // Find the best worker for a task on a given queue
  route(activityName: string, stickyWorkerId?: string): WorkerInfo | undefined {
    // Prefer sticky worker if healthy and available
    if (stickyWorkerId) {
      const sticky = this.#workers.get(stickyWorkerId);
      if (
        sticky &&
        !sticky.draining &&
        sticky.inFlight < sticky.concurrency &&
        sticky.activities.has(activityName)
      ) {
        return sticky;
      }
    }

    // Otherwise: least-loaded worker that supports this activity
    let best: WorkerInfo | undefined;
    for (const worker of this.#workers.values()) {
      if (worker.draining) continue;
      if (!worker.activities.has(activityName)) continue;
      if (worker.inFlight >= worker.concurrency) continue;
      if (!best || worker.inFlight < best.inFlight) {
        best = worker;
      }
    }
    return best;
  }

  deregister(identity: string) {
    this.#workers.delete(identity);
  }
}
```

#### Retry After Worker Failure

When a remote worker crashes (WebSocket closes unexpectedly) or misses its visibility timeout, the server must recover gracefully. The process is:

1. **Detect failure.** Either the WebSocket `close` event fires (immediate detection) or the visibility timeout expires (delayed detection for network partitions).
2. **Mark in-flight tasks as reclaimable.** The server scans `op:inflight:*` for tasks assigned to the dead worker and moves them back to the task queue. The `attempt` counter increments.
3. **Respect retry policy.** Each activity has a retry policy (`maxAttempts`, `initialBackoff`, `backoffMultiplier`, `maxBackoff`, `nonRetryableErrors`). If the attempt count exceeds `maxAttempts`, the activity is marked as permanently failed and the workflow is notified.
4. **Dispatch to another worker.** The requeued task goes through normal routing — any healthy worker on the same queue can pick it up.

```typescript
// Server-side: handle worker disconnection
function handleWorkerDisconnect(identity: string) {
  // Find all tasks assigned to this worker
  for (const [key, value] of storage.scanSync('op:inflight:')) {
    const info = decode(value);
    if (info.workerId !== identity) continue;

    const operationId = key.slice('op:inflight:'.length);
    const operation = decode(await storage.get(`op:pending:${operationId}`));

    if (operation.attempt >= operation.retryPolicy.maxAttempts) {
      // Exhausted retries — fail permanently
      storage.batch([
        { type: 'delete', key },
        {
          type: 'put',
          key: `op:failed:${operationId}`,
          value: encode({
            ...operation,
            error: `Worker ${identity} disconnected, max retries (${operation.retryPolicy.maxAttempts}) exhausted`,
          }),
        },
      ]);
      engine.dispatchEvent(
        new ActivityFailedEvent(operationId, operation.workflowId, operation.activityName),
      );
    } else {
      // Requeue with incremented attempt and backoff delay
      const backoff = calculateBackoff(operation.attempt, operation.retryPolicy);
      storage.batch([
        { type: 'delete', key },
        {
          type: 'put',
          key: `op:${operation.queue}:${Date.now() + backoff}:${operationId}`,
          value: encode({
            ...operation,
            attempt: operation.attempt + 1,
          }),
        },
      ]);
    }
  }

  workerRegistry.deregister(identity);
}
```

> **Key invariant:** A task is always in exactly one of three states: queued (waiting for a worker), in-flight (assigned to a worker with a visibility deadline), or resolved (completed or permanently failed). There is no state where a task is lost. The visibility timeout is the mechanism that prevents "assigned but forgotten" — the server-side equivalent of a dead letter queue.

#### Long-Poll Fallback

For environments where WebSocket connections aren't possible (restrictive proxies, serverless functions, simple scripts), the server provides an HTTP long-poll endpoint. The worker holds a `GET` request open until a task is available or the timeout expires.

```typescript
// Server route: long-poll task claiming
"GET /api/v1/tasks/:queue": async (req) => {
  const queue = req.params.queue;
  const url = new URL(req.url);
  const timeout = parseInt(url.searchParams.get("timeout") ?? "30000");
  const activities = url.searchParams.get("activities")?.split(",") ?? [];
  const identity = url.searchParams.get("identity") ?? crypto.randomUUID();

  // Check for an immediately available task
  const task = await claimNextTask(queue, activities, identity);
  if (task) return Response.json(task);

  // No task available — hold the connection until one arrives or timeout
  const { promise, resolve } = Promise.withResolvers<Response>();

  const signal = AbortSignal.timeout(timeout);
  const unsubscribe = taskNotifier.subscribe(queue, (task) => {
    if (activities.length && !activities.includes(task.activityName)) return;
    resolve(Response.json(task));
  });

  signal.addEventListener("abort", () => {
    resolve(Response.json({ type: "no_tasks" }, { status: 204 }));
  });

  try {
    return await promise;
  } finally {
    unsubscribe();
  }
},

// Result submission via POST (pairs with long-poll)
"POST /api/v1/tasks/:queue/result": async (req) => {
  const body = await req.json();
  await handleTaskResult(body.operationId, body.outcome, body.value, body.error);
  return Response.json({ accepted: true });
},
```

```typescript
// Minimal long-poll worker client — works anywhere fetch() works
async function longPollWorker(
  serverUrl: string,
  queue: string,
  activities: Record<string, Function>,
) {
  const activityNames = Object.keys(activities).join(',');

  while (true) {
    const response = await fetch(
      `${serverUrl}/api/v1/tasks/${queue}?timeout=30000&activities=${activityNames}`,
    );

    if (response.status === 204) continue; // No tasks, poll again

    const task = await response.json();
    const fn = activities[task.activityName];

    let outcome: 'completed' | 'failed';
    let value: unknown;
    let error: string | undefined;

    try {
      value = await fn(task.input);
      outcome = 'completed';
    } catch (err) {
      outcome = 'failed';
      error = String(err);
    }

    await fetch(`${serverUrl}/api/v1/tasks/${queue}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId: task.operationId, outcome, value, error }),
    });
  }
}
```

The long-poll client is intentionally simple — it can run in Deno, Cloudflare Workers, Node.js, or even a browser. The tradeoff versus WebSocket is higher latency (up to the poll timeout) and no server-push cancellation. For most use cases, WebSocket is preferred; long-poll is the compatibility escape hatch.

## Authoring vs runtime split (8-top-2)

`engine.register()`, workflow and activity declarations, provider configuration, storage adapter selection, interceptor chains, and execution-strategy wiring are in-process authoring surfaces. You call them at startup, in TypeScript, against the local `Engine` instance.

None of these are exposed over REST, JSON-RPC HTTP, JSON-RPC WebSocket, or the stdio session. The transport-parity surface Track 8 defines covers runtime operations only—the catalog of things you can invoke against a running workflow. Authoring is deliberately not part of that catalog.

Why? Because authoring APIs require code, not data. You cannot send a function over JSON. Wiring a new workflow type into the engine means shipping and loading code, which is a deployment concern, not a runtime-API concern. Keeping authoring TypeScript-only preserves this boundary and avoids a category of API that could never be honestly transport-neutral.

The operation catalog (`src/server/operation-catalog.ts`) reflects this: every `defineOperation` entry maps to an `Engine` _method call_, not to `engine.register()` or any authoring surface. If you look at the catalog and find an entry that calls `engine.register()`, that is a bug, not a feature.

## 8a-1: No second orchestration layer

Track 8's runtime transports—`POST /api/jsonrpc`, WebSocket on `/api/jsonrpc`, and the opt-in stdio session—all route through `src/server/operation-catalog.ts`'s `executeOperation` against the live `Engine` instance. `/openrpc.json` is not in this list: it is a discovery document generated from the same catalog, served as documentation rather than executed as an operation. There is no parallel orchestration system, no shadow event bus, no second state machine sitting between transport and engine.

`executeOperation` calls the same `Engine` methods that the REST bindings have always called. The transport decides how to frame the request and response; the catalog decides what to invoke and how to map errors. The `Engine` itself is unchanged.

To verify: trace any JSON-RPC call. It enters `src/server/json-rpc-dispatch.ts`, which looks up the method in the registry built from `src/server/operation-catalog.ts`, calls `executeOperation`, and gets back a result or an `OperationFault`. No second execution path, no alternative routing. A second orchestration layer would let Track 8's transports diverge from the REST surface over time; sharing one catalog and one `executeOperation` makes that divergence structurally impossible.

## 8a-3: BroadcastChannel remains internal

`BroadcastChannel` is used inside `src/core/` and `src/server/` for cross-worker coordination—signal delivery, event fan-out between the engine thread and worker threads. No transport file imports `BroadcastChannel` directly.

Every external subscription is a projection from the operation catalog's `EventTarget` events, not from a raw `BroadcastChannel` channel. `src/server/engine-event-feed-backend.ts` is the projection boundary: it listens to engine events and translates them into the feed that `src/server/workflow-event-feed.ts` exposes to transports. Transports consume the feed; they never talk to `BroadcastChannel` directly.

This matters because exposing `BroadcastChannel` to transports would couple the transport layer to an internal concurrency primitive. That primitive may change—number of channels, naming scheme, message shape—without any transport needing to care. Keeping `BroadcastChannel` inside the core boundary means the transport surface is stable even as the internal coordination model evolves.

To verify: `grep -r "BroadcastChannel" src/server/` should show results only in files that are part of the server-internal coordination, not in `json-rpc-dispatch.ts`, `json-rpc-http.ts`, `json-rpc-websocket.ts`, or `rest-bindings.ts`.

## 8a-4: Worker postMessage remains internal

`WorkerInboundMessage` and `WorkerOutboundMessage` are defined in `src/workers/` and represent the private protocol between the engine's main thread and the Web Workers that execute workflow and activity code. They are not part of any external transport.

The JSON-RPC dispatcher (`src/server/json-rpc-dispatch.ts`) uses `JsonRpcRequest` and `JsonRpcResponse` types—its own wire types—not `WorkerInboundMessage` or `WorkerOutboundMessage`. The two type systems do not overlap. A caller sending JSON-RPC over WebSocket has no way to inject a message directly into the worker execution path; they can only invoke operations through the catalog. The same reasoning as 8a-3 applies: worker messages are a concurrency primitive, not an API, so keeping them internal lets the worker protocol evolve without breaking external callers.

## 8a-5: `ExecutionStrategy` is the untrusted-workflow isolation boundary

Workflows are user-supplied code. The one seam across which the engine drives that code is `ExecutionStrategy` (`src/core/execution-strategy.ts`), and it is the only place that decides _where a workflow generator steps_. `InlineExecutionStrategy` steps it in the engine's own isolate—no isolation, appropriate only for trusted workflows. `WorkerExecutionStrategy` steps it inside a Web Worker and talks to the engine purely through `postMessage`, so untrusted workflow code never executes in the engine isolate. The engine selects the worker strategy when `workerExecution` is configured; the `createExecutionStrategyBundle` worker branch then returns `inlineStrategy: null`, and every engine path that would step a workflow generator is guarded on `inlineStrategy` and is therefore unreachable in worker mode.

A repository-wide audit confirms no worker-path site steps the user workflow generator in the engine isolate. The audited call sites:

- **Inline-only, never reached in worker mode.** `launchWorkflowFromCheckpoint` (`src/core/engine/lifecycle/transition.ts`) branches on `inlineStrategy`; the inline branch (`launchInlineWorkflowFromCheckpoint`) is the only one that calls `registration.handler`, and it hard-throws if `inlineStrategy` is `null`. The resume path mirrors this: `relaunchInlineWorkflowAfterResume` (`src/core/engine/lifecycle/resume.ts`) early-returns when `inlineStrategy` is `null` and is dispatch-guarded the same way. `feedOperationResult` (`src/core/engine/strategy-helpers.ts`) steps the generator (`continueWorkflow`/`throwIntoWorkflow`) only on the inline branch; the worker branch only calls `strategy.resumeWorkflow`. `ctx.speculate()` (`src/core/engine/operations-speculate.ts`) throws `ctx.speculate() requires inline execution mode` when `inlineStrategy` is `null`.
- **Worker-only.** The worker runs its own generator-stepping in `src/workers/workflow-runner.ts`, inside the Worker isolate.
- **Not the workflow generator.** `src/core/engine/operations-activity.ts` steps the activity-_interceptor_ pipeline, not the workflow generator. `primeParallelOperations` (`src/core/context/child-workflow-pipe.ts`) is a `Context` helper that runs in whichever isolate hosts the workflow—the Worker under worker mode.

**Security contract (worker strategy).** _Memory isolation (execution):_ the workflow generator's locals, closures, and heap live in the Worker isolate; the engine sees only serialized checkpoint `ArrayBuffer`s. The engine→worker direction sends the workflow input, the checkpoint buffer (`serializeCheckpoint`), and operation results; the worker→engine direction sends only `checkpoint`/`completed`/`failed` `WorkerOutboundMessage`s—there is no sanitization layer beyond those shapes, and the contract claims none. _No engine-heap access:_ worker-side code runs in a separate isolate and cannot reach the engine's registration map, checkpoints, scheduler, or storage. _Crash containment:_ a thrown error inside the worker becomes a `failed` message (`src/workers/workflow-runner.ts`), and an outright worker crash is caught by `#handleWorkerError` (`src/core/worker-execution-strategy.ts`), surfaced as `failed`, and the crashed worker is discarded from the pool so it cannot be reused. Runaway-loop / nonresponsive-worker detection is _not_ part of this contract—no watchdog implements it today.

**Honest caveats.** The engine still _holds_ the workflow handler function in its registration map under worker mode; it simply never _invokes_ it. That is execution isolation, not a claim that the engine never possesses the workflow code. How a worker obtains its copy of that code is a property of the caller's worker bundle—a bundle that serializes handlers via `Function.prototype.toString` is why closures over local state do not survive that path—not a property of the `ExecutionStrategy` interface. Some context-dependent features are inline-only and unavailable under worker isolation: queries throw (`src/core/engine/queries.ts`), and `ctx.speculate()` throws; update/signal/child-context lookups that route through `inlineStrategy?.getContext(...)` resolve to `undefined`. These are an accepted consequence of the boundary, not defects; a future worker-mode capability-diagnostics improvement could surface them more clearly.

**Transport-agnostic.** `ExecutionStrategy`'s methods return `void` and all coupling flows through serializable messages plus `onMessage`, so the same interface admits a future out-of-process or remote workflow worker. The existing RemoteWorker WebSocket protocol (`documentation/reference/remote-worker-protocol.md`) is activity dispatch and is not suitable for stateful workflow checkpoint execution, so it is not that transport.

## Current auth state (8d-1)

HTTP authentication exists today. `src/server/authentication.ts` handles it. `serve()` authenticates the incoming `Request` before accepting a WebSocket upgrade—the principal is established at upgrade time, not per-frame.

The `serve()` configuration accepts two auth modes:

- `auth: { jwt: { secret } }` — validates a Bearer token using the provided secret
- `auth: { apiKeys: [...] }` — validates against a static list of API keys

Unauthenticated requests to authenticated endpoints get a `401` over REST and `-32010 Unauthorized` over JSON-RPC. The same policy applies to the WebSocket upgrade handshake: an unauthenticated upgrade attempt is rejected before the connection is established.

Wave 1 added tests confirming auth-parity for `weft.workflows.replay` across REST and JSON-RPC WebSocket (the representative authenticated operation). Wave 2's discovery-parity tests confirm that the auth declarations in the OpenAPI and OpenRPC documents match the actual enforcement in the catalog. The auth surface documented here is the same surface those tests exercise.

stdio is opt-in and disabled by default—`serve()` does not start a stdio session unless explicitly configured. When enabled, it uses the same per-operation authorization hook as the other transports.

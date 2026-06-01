# Performance and Examples

This companion document was split out of [../architecture.md](../architecture.md) so the roadmap can stay checklist-first. It keeps the performance framing, module map, hello-world walkthrough, and other explanatory examples together in one place.

## Performance Profile

### Weft vs Temporal

| Dimension                | Temporal                           | Weft (SQLite)                           | Weft (LMDB)                             |
| ------------------------ | ---------------------------------- | --------------------------------------- | --------------------------------------- |
| **Recovery**             | O(n) replay                        | O(1) checkpoint                         | O(1) checkpoint                         |
| **Storage read**         | ~1ms (network)                     | ~10μs (in-process)                      | ~1μs (memory-mapped)                    |
| **Storage write**        | ~2ms (network)                     | ~20μs (WAL)                             | ~10μs (batched)                         |
| **Task claim**           | gRPC round-trip                    | 1 SQL statement                         | 1 range read + put                      |
| **Cold start**           | seconds (Go + DB pool)             | <50ms (Bun + SQLite)                    | <50ms (Bun + mmap)                      |
| **Memory / workflow**    | ~50KB (history cache)              | ~2KB (checkpoint)                       | ~2KB (checkpoint)                       |
| **Single binary?**       | No                                 | Yes                                     | No (native addon)                       |
| **Browser?**             | No                                 | No                                      | No                                      |
| **Browser (IndexedDB)?** | —                                  | Yes (same engine)                       | —                                       |
| **History growth**       | O(n) with activity count           | O(1) fixed-size                         | O(1) fixed-size                         |
| **Dev environment**      | Docker Compose (~minutes)          | `bun add @lostgradient/weft` (~seconds) | `bun add @lostgradient/weft` (~seconds) |
| **Bundle step**          | Webpack per workflow change        | None                                    | None                                    |
| **Max workflow length**  | ~50K events (then `continueAsNew`) | Unlimited                               | Unlimited                               |

### Platform Primitive Performance Wins

| Primitive                       | Performance Impact                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Transferable` in `postMessage` | Zero-copy checkpoint transfer between threads. A 10KB checkpoint moves in O(1) instead of O(n) copy.                                       |
| `WeakRef` checkpoint cache      | GC-friendly caching — memory usage stays bounded under load instead of growing linearly with workflow count.                               |
| `FinalizationRegistry`          | Automatic cleanup of dead cache entries — no periodic sweep needed, no timer overhead.                                                     |
| `Symbol.dispose` / `using`      | Deterministic resource release — prevents file handle leaks, dangling DB connections, orphaned Workers that plague long-running processes. |
| `AbortSignal.any()`             | Single signal for compound cancellation — no manual bookkeeping of multiple abort sources.                                                 |
| `structuredClone` with transfer | Zero-copy deep clone when transferring data to Workers.                                                                                    |
| `Promise.withResolvers()`       | Avoids closure allocation for deferred promises. Marginal per-call, significant at 50K+ workflows/sec.                                     |
| `EventTarget` over EventEmitter | Native C++ implementation in Bun — lower overhead than userland EventEmitter for dispatch.                                                 |
| `#private` fields               | V8/JSC can optimize access to private fields more aggressively than string-keyed properties.                                               |
| `BroadcastChannel`              | Kernel-level IPC between Workers — faster than manual postMessage routing through the main thread.                                         |
| `WITHOUT ROWID` tables          | SQLite stores data directly in the B-tree for KV workloads — eliminates rowid lookup indirection.                                          |
| Prepared statements             | SQL compilation happens once, execution happens millions of times. Critical for the task-claim hot path.                                   |

---

## The Module Map

```
weft/
├── core/                  # ZERO platform dependencies (web standards only)
│   ├── engine.ts          # Workflow lifecycle, state machine
│   ├── context.ts         # ctx.run, ctx.sleep, ctx.signal, ctx.all,
│   │                      # ctx.setAttribute, ctx.onUpdate, ctx.waitForUpdate,
│   │                      # ctx.review, ctx.state
│   ├── checkpoint.ts      # Generator serialization via structuredClone
│   ├── scheduler.ts       # Timer/retry scheduling logic (no I/O)
│   ├── interceptor.ts     # WorkflowInterceptor, ActivityInterceptor interfaces + chain composition
│   ├── search-attributes.ts # Attribute index encoding, diff logic, sortable key encoding
│   ├── updates.ts         # Synchronous update request/response coordination
│   ├── codec.ts           # MessagePack encode/decode (pure JS)
│   ├── atomic-state.ts    # AtomicState primitive: durable concurrent KV with optimistic concurrency
│   └── types.ts           # TypeScript types
│
├── storage/               # Storage adapters (one per platform)
│   ├── interface.ts       # KV-oriented Storage interface
│   ├── bun-sql.ts         # Bun.SQL (SQLite) — default, ships in binary
│   ├── lmdb.ts            # LMDB — high-performance server option
│   ├── indexeddb.ts        # Browser IndexedDB
│   ├── memory.ts          # In-memory (testing, WASM)
│   └── turso.ts           # Turso/libSQL (distributed SQLite)
│
├── workers/               # Web Worker executors
│   ├── workflow-runner.ts # Worker script: runs workflow generators
│   ├── activity-runner.ts # Worker script: runs activity functions
│   └── pool.ts            # Worker pool management (spawn, reuse, terminate)
│
├── server/                # Bun.serve() HTTP + WebSocket server
│   ├── index.ts           # Server entry point (Bun-specific)
│   ├── handler.ts         # Pure request→response handler (platform-agnostic!)
│   ├── auth.ts            # API keys, JWT, Bun.password
│   └── ui/                # Pre-built React dashboard
│
├── service-worker/        # Browser deployment target
│   ├── sw.ts              # Service Worker entry point
│   └── timer-sync.ts      # Periodic Background Sync for durable timers
│
├── worker/                # Remote activity worker client
│   ├── index.ts           # WebSocket-based worker (primary)
│   ├── long-poll.ts       # HTTP long-poll worker (fallback)
│   ├── heartbeat.ts       # Visibility timeout keepalive
│   └── registry.ts        # Server-side worker tracking and routing
│
├── observability/          # Opt-in OpenTelemetry integration
│   ├── index.ts           # createObservabilityInterceptors() factory
│   ├── propagation.ts     # W3C trace context helpers (headerMapGetter/Setter)
│   └── metrics.ts         # OpenTelemetry metrics definitions (histograms, counters)
│
├── client/                # Client SDK (library/server parity — same API, two modes)
│   ├── index.ts           # HTTP/WS client (server mode: network calls to Weft server)
│   └── local.ts           # Direct engine client (library mode: in-process, no network)
│
├── testing/               # First-class test utilities
│   ├── test-engine.ts     # TestEngine: real engine with MemoryStorage + time control
│   ├── time-control.ts    # Deterministic time advancement (no real timers in tests)
│   └── mocks.ts           # Type-safe activity mocking + invocation recording
│
├── cli.ts                 # CLI entry point (compiled into standalone binary)
└── index.ts               # Main library export
```

**Key structural note:** `server/handler.ts` contains the pure `(Request) → Response` logic with zero Bun dependencies. The Bun-specific `server/index.ts` wraps it in `Bun.serve()`. The Service Worker's `sw.ts` wraps the exact same handler in `self.addEventListener("fetch", ...)`. One handler, two deployment targets.

**Library/server parity:** The library mode and server mode examples below use different deployment wrappers, but the workflow code, engine API, and client interface are identical. Moving between modes is a configuration change, not a code change.

---

## Hello World

```typescript
// Library mode — embed in your app
import { Engine, BunSQLiteStorage } from '@lostgradient/weft';

const engine = new Engine({
  storage: new BunSQLiteStorage('./weft.db'),
});

async function greet(name: string) {
  return `Hello, ${name}!`;
}
async function notify(msg: string) {
  await fetch('https://hooks.slack.com/...', {
    method: 'POST',
    body: JSON.stringify({ text: msg }),
  });
}

async function* welcomeWorkflow(ctx: Context, user: { name: string }) {
  const greeting = yield* ctx.run(greet, user.name);
  yield* ctx.sleep('1 hour');
  yield* ctx.run(notify, `${user.name} completed onboarding`);
  return { greeting, onboarded: true };
}

engine.register('welcome', welcomeWorkflow);
const handle = await engine.start('welcome', { name: 'Steve' });
console.log(await handle.result()); // { greeting: "Hello, Steve!", onboarded: true }
```

```bash
# Server mode — single binary
curl -L https://releases.weft.dev/v1/weft-darwin-arm64 -o weft && chmod +x weft
./weft --port 7233

# That's it. SQLite database created automatically. Dashboard at localhost:7233/
# Register workflows by connecting a worker:
bun run my-workflows.ts  # connects to weft server via WebSocket
```

### Compared to Temporal

The equivalent workflow in Temporal's TypeScript SDK:

```typescript
// activities.ts — must be a separate file
import Stripe from 'stripe';
export async function greet(name: string) {
  return `Hello, ${name}!`;
}
export async function notify(msg: string) {
  await fetch('https://hooks.slack.com/...', {
    method: 'POST',
    body: JSON.stringify({ text: msg }),
  });
}
```

```typescript
// workflows.ts — runs in Webpack sandbox, cannot import activities directly
import { proxyActivities, sleep } from '@temporalio/workflow';
import type * as activities from './activities';

const { greet, notify } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
});

export async function welcomeWorkflow(user: {
  name: string;
}): Promise<{ greeting: string; onboarded: boolean }> {
  const greeting = await greet(user.name);
  await sleep('1 hour'); // Must be Temporal's deterministic sleep
  await notify(`${user.name} completed onboarding`);
  return { greeting, onboarded: true };
}
```

```typescript
// worker.ts — separate process required
import { Worker } from '@temporalio/worker';
const worker = await Worker.create({
  workflowsPath: require.resolve('./workflows'), // Webpack bundles this
  activities: await import('./activities'),
  taskQueue: 'default',
});
await worker.run();
```

```bash
# Server — requires Docker or Temporal Cloud
docker compose up -d   # PostgreSQL + Elasticsearch + 4 Temporal services
# ... or temporal server start-dev
```

Three files. Webpack bundling. `proxyActivities` ceremony. Separate worker process. Docker for the server. Compare to Weft's single file above.

---

## Open Questions — Resolved

1. **Checkpoint serialization format:** `structuredClone` semantics. Enforced. `ctx.memo()` for derived values.

2. **Generator depth:** Child workflows independently checkpointed via separate KV entries. Max depth 10 (configurable).

3. **Determinism:** Not required. Opt-in `deterministic` mode available for testing.

4. **SQLite write bottleneck:** LMDB adapter for high-throughput deployments. Turso for distributed. v1 ships SQLite; documented scaling path.

5. **Database choice:** SQLite (via Bun.SQL) as default for zero-config + single-binary. LMDB as opt-in for max perf. Not LevelDB (LMDB is strictly better for our workload, LevelDB is single-process only).

6. **Single binary:** `bun build --compile` with cross-compilation targets. Dashboard embedded as file assets. SQLite included via runtime.

7. **Web Workers:** Yes — workflow and activity execution isolated in Workers. BroadcastChannel for coordination. Same model works in browser.

8. **Service Workers:** Yes — the browser deployment target. Same engine, IndexedDB storage, fetch event interception. Limited by browser background execution budget.

9. **Naming:** Weft. Ship it.

10. **Workflow versioning:** Version pinned at start, stored in workflow state, optional migration function on resume. No patching API needed — checkpoint model avoids replay compatibility concerns.

11. **Workflow timeouts:** Execution timeout (maximum wall-clock time for a workflow), stored as absolute deadline in storage, enforced by the scheduler via AbortController.

12. **Search attributes:** KV-based secondary indexes (`idx:{attr}:{value}:{wfId}`), works identically on all storage backends, updated atomically with checkpoint writes.

---

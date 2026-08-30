# Performance

Weft's performance advantage isn't the result of micro-optimizations. It's architectural. Checkpoint-based recovery is fundamentally faster than replay-based recovery. Embedded storage is fundamentally faster than networked storage. Platform primitives are fundamentally faster than userland abstractions.

## Weft versus Temporal

Here's the head-to-head comparison.

| Dimension               | Temporal                           | Weft (SQLite)                           | Weft (LMDB)                             |
| ----------------------- | ---------------------------------- | --------------------------------------- | --------------------------------------- |
| **Recovery**            | O(n) replay                        | O(1) checkpoint                         | O(1) checkpoint                         |
| **Storage read**        | ~1ms (network)                     | ~10us (in-process)                      | ~1us (memory-mapped)                    |
| **Storage write**       | ~2ms (network)                     | ~20us (WAL)                             | ~10us (batched)                         |
| **Task claim**          | gRPC round-trip                    | 1 SQL statement                         | 1 range read + put                      |
| **Cold start**          | Seconds (Go + DB pool)             | <50ms (Bun + SQLite)                    | <50ms (Bun + mmap)                      |
| **Memory per workflow** | ~50KB (history cache)              | ~2KB (checkpoint)                       | ~2KB (checkpoint)                       |
| **Single binary**       | No                                 | Yes                                     | No (native addon)                       |
| **Browser**             | No                                 | Yes (IndexedDB)                         | No                                      |
| **History growth**      | O(n) with activity count           | O(1) fixed-size                         | O(1) fixed-size                         |
| **Dev environment**     | Docker Compose (~minutes)          | `bun add @lostgradient/weft` (~seconds) | `bun add @lostgradient/weft` (~seconds) |
| **Bundle step**         | Webpack per workflow change        | None                                    | None                                    |
| **Max workflow length** | ~50K events (then `continueAsNew`) | Unlimited                               | Unlimited                               |

The numbers that matter most: 100x faster storage reads (in-process versus network), O(1) versus O(n) recovery, and 25x less memory per workflow.

## Platform primitive performance wins

Every platform primitive Weft uses was chosen partly for correctness and partly for performance. Here's where the wins come from.

| Primitive                       | Performance Impact                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `Transferable` in `postMessage` | Zero-copy checkpoint transfer between threads. A 10KB checkpoint moves in O(1) instead of O(n) copy.         |
| `WeakRef` checkpoint cache      | GC-friendly caching—memory usage stays bounded under load instead of growing linearly with workflow count.   |
| `FinalizationRegistry`          | Automatic cleanup of dead cache entries. No periodic sweep needed, no timer overhead.                        |
| `Symbol.dispose` / `using`      | Deterministic resource release. Prevents file handle leaks, dangling database connections, orphaned Workers. |
| `AbortSignal.any()`             | Single signal for compound cancellation. No manual bookkeeping of multiple abort sources.                    |
| `structuredClone` with transfer | Zero-copy deep clone when transferring data to Workers.                                                      |
| `Promise.withResolvers()`       | Avoids closure allocation for deferred promises. Marginal per-call, significant at 50K+ workflows/sec.       |
| `EventTarget` over EventEmitter | Native C++ implementation in Bun—lower overhead than userland EventEmitter for dispatch.                     |
| `#private` fields               | V8/JSC can optimize access to private fields more aggressively than string-keyed properties.                 |
| `BroadcastChannel`              | Kernel-level IPC between Workers—faster than manual postMessage routing through the main thread.             |
| `WITHOUT ROWID` tables          | SQLite stores data directly in the B-tree for KV workloads. Eliminates rowid lookup indirection.             |
| Prepared statements             | SQL compilation happens once, execution happens millions of times. Critical for the task-claim hot path.     |

None of these are exotic optimizations. They're the natural result of using platform primitives for their intended purpose instead of building userland alternatives.

## Performance targets

These are the benchmarks Weft is built to hit.

- **Workflow starts:** >50K/sec (single node, SQLite)
- **Activity completions:** >30K/sec (single node, SQLite)
- **Workflow recovery:** <1ms (O(1) checkpoint load)
- **Memory per workflow:** <=2KB (checkpoint blob)
- **Cold start:** <100ms (binary mode), <50ms (library mode)
- **Token stream latency:** <10ms (engine to WebSocket client)
- **Event dispatch:** <100us (EventTarget overhead per event)
- **Worker spawn:** <5ms (Web Worker creation in Bun)
- **10x faster than Temporal** on workflow start (benchmarked head-to-head)
- **100x faster on workflow recovery** (O(1) versus O(n) replay)
- **5x lower memory per workflow** (~2KB versus ~50KB+)

The recovery target is the headline. A Temporal workflow with 10,000 events in its history takes proportionally longer to recover—replay must re-execute the entire history. A Weft workflow with 10,000 completed activities recovers in the same time as one with 10. One checkpoint read, one resume. Done.

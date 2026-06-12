# Task 04: Worker task result storage failure → silent double-execution

**Severity:** high

## Storage-write failure after in-memory task completion leaves orphaned inflight record causing double-execution

- **Severity:** high (durability)
- **Files:** `src/server/runtime/websocket-worker.ts`, `src/server/runtime/task-reconciliation.ts`

**Evidence:** websocket-worker.ts:242-265: completeTask() and deadlineTracker.remove() execute synchronously before async transitionInflightToResolved. The entire async block is fire-and-forget via void (async () => {...})().catch(). On storage write failure, the inflight record survives; next reconciliation scan finds a stale record past its deadline and calls reassignOrExpireTask, dispatching the activity a second time. The heartbeat path at line 293 already uses withRetry for the same kind of storage write — the omission here is inconsistent.

**Required fix:** Retry transitionInflightToResolved with the existing withRetry helper (already used at line 293 for heartbeat storage updates). If all retries are exhausted, emit an application-level event or mark the operationId in a dead-letter set so the reconciliation scan does not re-dispatch it.

## server.stop() does not drain in-flight remote worker tasks before tearing down

- **Severity:** medium (durability)
- **Files:** `src/server/serve-internals.ts`, `src/server/runtime/shutdown.ts`, `src/cli-main.ts`

**Evidence:** registerStackDisposers disposal chain never calls shutdownAllWorkers. CLI SIGINT/SIGTERM handlers call server.stop() directly with no preceding shutdownAllWorkers. Connected workers receive no shutdown frame; inflight taskResult messages arriving on a closed socket are silently lost. At-least-once is preserved via storage but causes unnecessary re-execution and incremented attempt counters.

**Required fix:** In registerStackDisposers, add a disposal step that calls shutdownAllWorkers with a configurable timeout (defaulting to DEFAULT_SHUTDOWN_TIMEOUT_MS) before stopping the Bun server. Update the stop() JSDoc to document the drain behavior.

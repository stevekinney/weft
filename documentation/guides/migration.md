# Migration Guide

This guide walks through the upgrade path for in-flight breaking changes. Pre-1.0 doesn't ship a permanent changelog—what you'll find here is the active migration work, structured around the surfaces that actually moved.

> [!NOTE]
> Once everyone on a given upgrade has migrated, the corresponding section of this guide can be archived. Treat it as a working document, not historical record.

## `Storage` Requires a `capabilities()` Method

The `Storage` interface now requires `capabilities(): StorageCapabilities`, a self-reported profile of the backend's consistency and feature guarantees. Every built-in adapter already implements it; this only affects custom adapters and inline `Storage` test doubles.

```typescript partial
import type { Storage, StorageCapabilities } from '@lostgradient/weft';

class MyStorage implements Storage {
  capabilities(): StorageCapabilities {
    return {
      persistence: 'local', // 'ephemeral' | 'local' | 'remote'
      readAfterWrite: 'linearizable', // 'linearizable' | 'session' | 'eventual'
      scanConsistency: 'snapshot', // 'snapshot' | 'best-effort'
      atomicBatch: true, // batch() is all-or-nothing
      conditionalBatch: true, // compare-and-swap is supported
      boundedRangeDelete: true, // deletePrefix() is a single range op
    };
  }
  // get/put/delete/scan/batch/[Symbol.dispose] as before…
}
```

**Choosing values honestly:** report what your backend actually provides, not what you wish it did. `atomicBatch` and the consistency levels are trusted contracts the engine does not verify at runtime — a `true` you cannot back up means checkpoint corruption, not a caught error. If your backend lacks compare-and-swap, report `conditionalBatch: false`; the first feature that needs it then fails fast with:

```text
Feature "AtomicState compare-and-swap" requires storage capability "conditionalBatch", but this storage backend does not provide it.
```

If you wrap another `Storage`, delegate `capabilities()` to the inner store — and downgrade `conditionalBatch`/`boundedRangeDelete` to `false` if your wrapper transforms value bytes (as `CompressedStorage` does), per the opaque-value invariant. See the [Consistency & capabilities](./storage.md#consistency-capabilities) guide for the full contract and the built-in adapter matrix.

## `recoverAll` Throws on Unknown Workflow Types

`engine.recoverAll()` used to silently skip running workflows whose type was not registered on the current engine. Storage that referenced a retired or renamed workflow type would boot cleanly and leave those workflows abandoned mid-flight.

The new behavior is to throw `WorkflowTypeNotRegisteredForRecoveryError` listing the missing types. If you call `recoverAll()` against a database that holds running workflows of types your build no longer registers, the call will throw before resuming anything.

**To upgrade:**

- The common case requires no change: storage with no drift recovers exactly as before.
- If you're rolling deploys where old pods own workflow types the new build doesn't know about, pass `acknowledgeUnknownWorkflowTypes: true` to `recoverAll()` (or to `Engine.create()`) for the duration of the rollover. See the [Recovery and deploys guide](./recovery-and-deploys.md).
- The HTTP `weft.recover.all` operation returns `409 Conflict` with `{ missingTypes, missingWorkflowCount, samplesTruncated }` when drift is detected. Workflow IDs are never serialized over HTTP, and the `acknowledgeUnknownWorkflowTypes` opt-out is intentionally not exposed over the public HTTP surface — operators who need the dangerous skip can call `engine.recoverAll({ acknowledgeUnknownWorkflowTypes: true })` from their boot code.

## `Engine.create` Replaces Registration Boilerplate

The manual `new Engine() → register(activity) → register(workflow) → recoverAll()` boot sequence still works, but `Engine.create()` collapses the registration portion into a single `await`:

```typescript partial
const engine = await Engine.create({
  storage: new SQLiteStorage('./weft.db'),
  activities: { sendEmail, chargeCard },
  workflows: { processOrder },
});
```

`Engine.create()` registers activities first, then workflows, and then runs `recoverAll()` by default. Pass `recover: false` to skip recovery (for tests or pre-migration inspection). Map keys must match each definition's `name` field — `Engine.create({ workflows: { greet: farewellDefinition } })` throws `EngineCreateNameMismatchError` rather than silently registering `farewell` under the wrong key.

The constructor and `register()` remain available for tests and dynamic plugin loading.

## AI Agent Surface Removal

Weft no longer ships an AI agent surface. Agent loops, declarations, coordination primitives, provider contracts, tool-call types, and agent events moved out of the core package. Weft now focuses on durable execution primitives: workflows, activities, checkpoints, signals, updates, shared state, and human review.

If you previously used Weft's built-in agent loop or coordination helpers, move that orchestration to an external agent framework, or build it directly on top of `ctx.run()` and `ctx.review()`.

### Consumer Migration Checklist

Most callers will:

1. Remove imports for the old agent loop, provider, tool, conversation, coordination, and agent-event exports.
2. Replace embedded agent operations with ordinary workflow code that calls activities through `ctx.run()`.
3. Use `ctx.review()` for human approval points that need to persist across crashes.
4. Keep model routing, provider SDK wrappers, cost accounting, and tool discovery outside Weft.
5. Drain or restart any in-flight workflows that depended on the removed agent surface before deploying this version.

## Storage Resolver and Auto-Detection

Two new entry points landed alongside the storage adapter expansion:

- `resolveDefaultStorage()` from `@lostgradient/weft/storage/auto`—the developer-convenience helper that picks a SQLite backend based on Bun vs. Node.
- `resolveStorage(configuration)` from `@lostgradient/weft/storage` or `@lostgradient/weft/storage/resolve`—the configuration-driven resolver covering every backend, including browser and remote.

If you've been constructing storage adapters by hand, neither helper is required. They're additive. But if you're shipping a quick example, `resolveDefaultStorage()` collapses three lines of imports into one. See [the storage guide](./storage.md) for when to use which.

## Service Worker Setup Helper

`setupServiceWorker()` from `@lostgradient/weft/service-worker` wires up an engine with `IndexedDBStorage`, fetch handler, lifecycle handlers, and Periodic Background Sync in one call. The lower-level handlers (`createFetchHandler`, `createLifecycleHandlers`, `createPeriodicSyncHandler`, `ServiceWorkerScheduler`) remain available as the manual-setup escape hatch.

If you're already using the lower-level handlers, no change is required. If you want to simplify, see [the service worker guide](./service-worker.md).

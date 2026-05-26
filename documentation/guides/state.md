# State

Most workflow state lives in local variables and is checkpointed whenever the workflow yields. That is still the right default. `ctx.state` is for the cases where you need a named state slot with an explicit scope.

Checkpoints hold local variables. For named persistent state shared across runs, use `ctx.state.execution()` when the value should be shared within this execution tree.

## Session State

Session state is the default state handle to reach for. It lives inside the current workflow checkpoint, is private to one workflow execution, and is synchronous because it is updated with the rest of the checkpoint.

```typescript partial
const attempts = ctx.state.session<number>('chargeAttempts', { initial: 0 });

attempts.increment();
if (attempts.get()! > 3) {
  attempts.delete();
}
```

Session state is useful for counters, flags, and small pieces of private workflow bookkeeping. It is not shared with children or other workflow runs.

## Durable State

Execution and workflow state handles live in storage and can be shared outside the current checkpoint. They use the same method names as session state, but their methods are workflow operations:

```typescript partial
const findings = ctx.state.execution<{ articles: string[]; totalCost: number }>('findings', {
  initial: { articles: [], totalCost: 0 },
});

yield * findings.merge({ articles: ['https://example.com/research'] });
```

The durable scopes are backed by `AtomicState`. Updates use compare-and-swap with automatic retry. If another writer commits between your read and write, Weft rereads the latest value and reruns your update function.

Durable state options accept `initial` and `maxRetries`. `initial` is captured when the handle is constructed. `maxRetries` controls how many compare-and-swap attempts an `update`, `set`, `delete`, or convenience method can make before emitting `exhausted` and throwing `AtomicStateConflictError`.

## Scope Reference

Use the narrowest scope that matches the job:

| Scope         | Workflow API                         | Lifetime and sharing                                                                                |
| ------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| **Session**   | `ctx.state.session(key, options?)`   | Checkpoint-local state private to one workflow execution.                                           |
| **Execution** | `ctx.state.execution(key, options?)` | Storage-backed state shared by a parent workflow, durable child workflows, and concurrent branches. |
| **Workflow**  | `ctx.state.workflow(key, options?)`  | Storage-backed state shared by every run of the current workflow type.                              |

Session state is cheapest because it is checkpoint-local. The other scopes are CAS-backed storage records and require `yield*` because the engine commits them as durable operations.

## Admin Access

Outside a workflow, use `engine.state` for the durable scopes:

```typescript
import { Engine } from 'weft';

const engine = new Engine();

const workflowCounter = engine.state.workflow<number>('invoice-review', 'processed', {
  initial: 0,
});
await workflowCounter.increment();

const executionCounter = engine.state.execution<number>('workflow-owner-id', 'branchesDone', {
  initial: 0,
});
await executionCounter.increment();
```

There is no `engine.state.session()` because session state is checkpoint-local and only exists while a workflow context is being driven.

## Initial Values

For `ctx.state.session`, `delete()` removes the stored value. After deletion, `get()` returns the handle's captured `initial` value if you provided one, otherwise `undefined`.

For durable `AtomicState` handles, `options.initial` is captured when the handle is constructed. `get()` returns that value only before the storage slot has ever been written. Once a durable value has been written or deleted, an absent value reads as `undefined`.

```typescript partial
const counter = engine.state.workflow<number>('invoice-review', 'counter', { initial: 0 });

await counter.get(); // 0
await counter.set(1);
await counter.delete();
await counter.get(); // undefined
```

Deletes keep a version tombstone, so a delete still participates in compare-and-swap and cannot be silently overwritten by a stale writer.

## Convenience Methods

State handles expose:

- `get()`
- `update(fn)`
- `set(value)`
- `delete()`
- `increment(amount?)`
- `decrement(amount?)`
- `merge(patch)`
- `append(item)`
- `removeFirst()`
- `removeLast()`

`AtomicState` also extends `EventTarget`, exposes `[Symbol.observable]()`, and implements `[Symbol.asyncIterator]()` for the local `change`, `conflict`, and `exhausted` event stream.

## Storage Keys

The built-in scopes use encoded storage keys:

```text
state:execution:${ownerWorkflowId}:${key}
state:workflow-scope:default:${workflowType}:${key}
```

Execution-scoped state is deleted when the owning execution is purged or terminal cleanup runs. Workflow-scoped state persists until you explicitly delete it.

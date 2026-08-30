# Session State

Some workflows need a small amount of mutable state that lives with one workflow execution: a counter that survives recovery, a conversation handle, or a feature flag that one signal handler flips and another reads. `ctx.state.session<T>(key, options?)` is the checkpoint-local option for that.

Session state is the narrowest scope in the [`ctx.state`](./state.md) ladder. It is private to the current workflow instance. It is not shared with child workflows, other workflow runs, or external callers.

## Reading and Writing a Slot

`ctx.state.session<T>(key, options?)` returns a `WorkflowSessionState<T>` handle. The core methods are `get`, `set`, `update`, `delete`, and `run`.

```ts partial
import { workflow, type WorkflowContext } from '@lostgradient/weft';

engine.register(
  workflow({ name: 'counter' }).execute(async function* (ctx: WorkflowContext) {
    const counter = ctx.state.session<number>('count', { initial: 0 });

    counter.increment();
    return counter.get();
  }),
);
```

`get()` returns the current value or `undefined` if the slot has never been written. `options.initial` primes the handle: `get()` returns it until something else writes.

`set(value)` writes the value and returns it. `update((current) => next)` reads, transforms, and writes in one call:

```ts partial
counter.update((current) => (current ?? 0) + 1);
```

`delete()` removes the stored value. After deletion, `get()` returns the handle's captured `initial` value if you provided one, otherwise `undefined`.

## Survives Recovery

The slot's value is part of the workflow's checkpoint locals, so recovery preserves whatever was written before the last checkpoint.

```ts partial
engine.register(
  workflow({ name: 'survives-crashes' }).execute(async function* (ctx: WorkflowContext) {
    const counter = ctx.state.session<number>('count', { initial: 0 });
    counter.increment();

    yield* ctx.waitForSignal('resume');

    return counter.get();
  }),
);
```

## Running Sticky Activities

`run(fn, input?, options?)` executes a function as a generator-yielding durable operation that's automatically routed through sticky worker execution. This is the typical path for activities that need to be co-located with their session state—cache-heavy lookups, connection-aware calls, or anything where moving between workers would lose useful warm context.

```ts partial
async function* example(ctx: Context) {
  const session = ctx.state.session<number>('conversation', { initial: 0 });

  const reply = yield* session.run(async (input: string) => {
    return `processed: ${input}`;
  }, 'hello');

  return reply;
}
```

The activity dispatched by `session.run` carries `sticky: true` and any other activity options you pass through. The function itself runs as a regular activity: it does not directly read or write the session slot from inside.

## Validation

The slot has guardrails:

- Keys must be 1 to 256 characters. Empty strings throw `SessionStateValidationError`.
- The reserved prototype keys `__proto__`, `constructor`, and `prototype` are rejected.
- A workflow can store up to 256 session keys.
- Total serialized session state for one workflow is capped at 32 KB.

If you hit either size limit, use a different durability mechanism. `ctx.run()` is the right tool for activity results. Shared cross-workflow state belongs in [`ctx.state.execution` or `ctx.state.workflow`](./state.md).

## Values Are Cloned

`get()` and `set()` use `structuredClone` so caller mutation cannot leak into durable state.

```ts partial
const draft = ctx.state.session<{ items: string[] }>('draft');

const stored = draft.set({ items: ['a'] });
stored.items.push('b'); // does not affect the stored value

const next = draft.get();
console.log(next); // { items: ['a'] }
```

The same applies to `options.initial`: the slot snapshots it when the handle is created.

## Session State vs. `ctx.run`

| Concern        | `ctx.state.session`                                       | `ctx.run`                                                  |
| -------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| What it stores | A small mutable value scoped to one workflow              | Activity results, immutable once recorded                  |
| Where it lives | Checkpoint locals attached to the workflow                | Activity history                                           |
| Mutability     | Read-write, supports `update()` and `delete()`            | Append-only                                                |
| Right for      | Counters, flags, conversation handles, small accumulators | Network calls, IO, anything you would not repeat on replay |

When in doubt: if the value would be wrong to recompute on replay, use `ctx.run`. If it is private workflow bookkeeping that needs to survive recovery, use `ctx.state.session`.

## Child Workflows

Child workflows start with empty session state. The parent's slots are not passed across the boundary. If you want a child to inherit context, pass values as part of the child's input. If parent and child need to update the same durable value, use `ctx.state.execution`.

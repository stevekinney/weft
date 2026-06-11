# Parallel Execution

You have three API calls that don't depend on each other, and you're running them one at a time. Each one checkpoints before the next can start. That's reliable, sure—but it's also needlessly slow. Weft gives you two primitives for running work concurrently: `ctx.all()` for fan-out-and-collect, and `ctx.race()` for first-one-wins.

## Fan-out with `ctx.all()`

`ctx.all()` takes an array of generator operations and runs them in parallel. Every branch gets its own checkpoint. When all branches complete, you get an array of results in the same order you passed the operations.

```typescript partial
async function* enrichOrder(ctx: Context, order: Order) {
  const [inventory, shipping, tax] = yield* ctx.all([
    ctx.run('checkInventory', order.items),
    ctx.run('calculateShipping', order.address),
    ctx.run('computeTax', { total: order.total, region: order.region }),
  ]);

  return { inventory, shipping, tax };
}
```

Rejection mirrors `Promise.all()`—any branch fails and the whole operation fails. If a branch rejects, surviving branches still finish and their values become recoverable on the next yield—see [Advanced: failure semantics](#advanced-failure-semantics).

You can mix operation types freely. Sleeps, signals, and activity calls all work inside `ctx.all()`:

```typescript partial
async function* example(ctx: Context) {
  const [result, _] = yield* ctx.all([
    ctx.run('longRunningTask', data),
    ctx.sleep('5s'), // timeout alongside the task
  ]);
}
```

> [!WARNING] `ctx.waitForSignal` inside `ctx.all` is unbounded
> `ctx.all()` waits for every branch and never aborts a sibling, so a `ctx.waitForSignal` branch blocks the whole `all` until its signal arrives—exactly like a top-level wait. A failing sibling does not unblock it. Guarantee the signal will be delivered, or pair the wait with a deadline using `ctx.race([ctx.waitForSignal('done'), ctx.sleep('30s')])` instead.

## Advanced: failure semantics

> [!IMPORTANT] Failure semantics contract
> Fulfilled branches' values go into the parent's in-memory cache entry **before** the rejection is thrown into the workflow. That entry becomes durable only when the workflow yields again. Miss that yield—let the rejection propagate all the way to termination—and you lose those partial results.

Here's what that means for your code:

1. **Design your catch blocks around the yield boundary.** If you catch the rejection and yield any operation (`ctx.run('retry')`, `ctx.sleep(1000)`, `ctx.waitForSignal(...)`), the next checkpoint locks in the partial entry and replays will reuse it. If you let the error propagate to termination without yielding, the partial entry is abandoned and you're back to duplicate side effects. Use idempotency keys for branches whose side effects must not happen twice.
2. **Slow siblings now delay rejection.** Surviving branches no longer abort when one fails—they run to completion so their results can be captured. A slow sibling will delay the parent's rejection until it settles. If you need cancel-on-first-failure, use `ctx.race` with a guard branch instead.
3. **`ctx.all` matches branches by position, not identity.** If your branch list is dynamic between attempts (`[sendEmail, scheduleShipping]` on attempt 1 → `[scheduleShipping, sendEmail]` on attempt 2), you risk silent slot mismatch. Prefer `ctx.runAll`—it keys on branch name and surfaces reordering as a `BranchTopologyChangedError`.
4. **Partial-failure preservation is top-level inline execution only.** A `ctx.all` nested inside another sub-operation lives inside its parent's slot; it gets no partial entry of its own. Workflows running through `workerExecution` also cannot persist partial branch slots because the worker protocol does not expose the inline context cache. If a worker-mode `ctx.all` or `ctx.runAll` has both a fulfilled branch and a failed sibling, Weft rejects with an explicit unsupported-boundary error. Use inline execution for this guarantee, or add idempotency keys.

## First-wins with `ctx.race()`

`ctx.race()` returns the result of whichever operation finishes first. The remaining operations are effectively abandoned—their results are discarded.

```typescript partial
async function* fetchWithFallback(ctx: Context, url: string) {
  const result = yield* ctx.race([
    ctx.run('fetchFromPrimary', url),
    ctx.run('fetchFromSecondary', url),
  ]);

  return result;
}
```

This is useful for timeout patterns, redundant fetches, and any scenario where you want the fastest answer. The engine records whichever result arrives first as the checkpoint, so on recovery you get the same winner.

> [!WARNING] Losers in `ctx.race` are abandoned
> Losers are aborted immediately—results discarded, side effects abandoned. Design race branches to be idempotent or pair them with compensation, because Weft will not clean up after a losing branch.

A common pattern pairs a real operation with a sleep to implement a deadline:

```typescript partial
async function* example(ctx: Context) {
  const result = yield* ctx.race([
    ctx.run('callExternalApi', payload),
    ctx.sleep('30s'), // returns undefined after 30 seconds
  ]);

  if (result === undefined) {
    // The sleep won—the API call took too long
    yield* ctx.run('notifyTimeout', payload);
  }
}
```

## Under the hood

Both `ctx.all()` and `ctx.race()` work by collecting the first yielded operation from each generator you pass in, then emitting a single `parallel` or `race` operation request. The engine handles the concurrent dispatch and result collection internally.

Note that `ctx.race()` emits `{ type: 'race', ... }` rather than `{ type: 'parallel', ... }`. Each sub-operation also advances the workflow's `stepIndex`, which is why subsequent steps remain replay-stable after a parallel or race completes.

```typescript partial
// What ctx.all() yields to the engine:
{
  type: 'parallel',
  operationId: '...',
  operations: [
    { type: 'activity', activityName: 'checkInventory', ... },
    { type: 'activity', activityName: 'calculateShipping', ... },
    { type: 'activity', activityName: 'computeTax', ... },
  ],
}
```

The result of a `ctx.all()` or `ctx.race()` is checkpointed as a single step. On replay, every fulfilled branch is reused without re-dispatch; non-fulfilled branches re-dispatch.

## When to use which

Use `ctx.all()` when you need _every_ result. Enrichment pipelines, multi-service aggregation, parallel approval requests where all must respond—these are `all` territory.

Use `ctx.race()` when you need _any_ result. Hedged requests, timeout wrappers, competing strategies where the fastest path wins—that's `race`.

If you're building something more complex—like "run five tasks, return when any three complete"—compose these primitives. Run the five tasks, track completions via [signals](./signals-and-queries.md), and use `ctx.race()` with a counter to detect when your threshold is met.

Both primitives nest cleanly. You can `all()` inside a `race()` or vice versa, and checkpointing works correctly at every level.

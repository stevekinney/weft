# Workflow Timeouts

A workflow that runs forever is a workflow that consumes resources forever. Activity-level timeouts catch individual operations that hang, but they don't cap the total wall-clock time of an entire execution. For SLA enforcement and runaway detection, you need execution timeouts.

## Setting an execution timeout

Pass `executionTimeout` when starting a workflow. It accepts any `Duration`—a number in milliseconds or a human-readable string.

```typescript partial
const handle = await engine.start('order', orderData, {
  executionTimeout: '24 hours',
});
```

The deadline is computed at start time (`startedAt + parseDuration(executionTimeout)`) and stored durably via `createDeadlineOperations()`. The key format is `wf-deadline:{deadline}:{workflowId}`, which means a single prefix scan sorted by timestamp can discover all expired workflows.

## Checking time remaining

Inside a workflow, `ctx.executionTimeRemaining` returns the milliseconds left before the deadline fires. It returns `Infinity` if no timeout was set.

```typescript partial
async function* orderWorkflow(ctx: Context, order: Order) {
  const payment = yield* ctx.run('charge', order);

  // Only run the slow path if we have time
  if (ctx.executionTimeRemaining > 60_000) {
    yield* ctx.run('enrichOrderData', order);
  }

  yield* ctx.run('ship', { order, payment });
  return { payment, shipped: true };
}
```

The standalone `timeRemaining()` utility does the same calculation outside of a context:

```typescript partial
import { timeRemaining } from '@lostgradient/weft';

const remaining = timeRemaining(deadline, Date.now());
```

## What happens when time runs out

The `checkExpiredDeadlines()` function scans storage for workflows whose deadline has passed. The engine calls this periodically. When a workflow times out:

1. The workflow's `AbortController` fires, cascading to all in-flight activities via the existing `ctx.signal` abort signal.
2. The workflow is marked as `'timed-out'`.
3. A `WorkflowTimeoutError` is thrown with the workflow ID, timeout type, elapsed time, and optional termination reason.

```typescript partial
try {
  const result = await handle.result();
} catch (error) {
  if (error instanceof WorkflowTimeoutError) {
    console.log(error.workflowId); // 'order-xyz'
    console.log(error.timeoutType); // 'execution' or 'run'
    console.log(error.elapsed); // milliseconds since start
    console.log(error.terminationReason); // undefined for deadline timeouts
  }
}
```

The `timeoutType` distinguishes between `'execution'` (total wall-clock cap) and `'run'` (single-run time limit). The optional `terminationReason` distinguishes a history circuit-breaker termination from an ordinary deadline: it is `'history-circuit-breaker'` when `history.maxEvents` forces termination and `undefined` for normal execution or run timeouts.

## Cleanup

Deadline keys are deleted when a workflow reaches any terminal state—completed, failed, cancelled, or timed out. The engine deletes the deadline key as part of the terminal-state batch write.

Activities that already accept `{ signal }` automatically respect workflow timeouts with no code changes. Review waits are also bounded by the workflow timeout. The `ctx.signal` property exposes a combined timeout-plus-cancellation signal, so everything downstream just works.

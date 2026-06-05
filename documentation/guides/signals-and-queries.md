# Signals and Queries

Sometimes a workflow needs to wait for something that is not an activity result or a timer. An approval from a human. A webhook from a payment provider. A configuration change pushed from an admin panel. Signals let you send data _into_ a running workflow from the outside world.

## Waiting for a signal

Inside a workflow, `yield* ctx.waitForSignal(handle)` pauses execution until a signal with that name arrives. The workflow is checkpointed at the pause point—it costs nothing to wait, even for days.

```typescript partial
const approvalSignal = signal<{ approved: boolean }>('approval');

engine.register(
  workflow({ name: 'approval' }).execute(async function* (ctx, input: { orderId: string }) {
    // Pauses here until 'approval' signal arrives
    const approval = yield* ctx.waitForSignal(approvalSignal);

    if (approval.approved) {
      yield* ctx.run('fulfillOrder', { orderId: input.orderId });
    } else {
      yield* ctx.run('cancelOrder', { orderId: input.orderId });
    }

    return { orderId: input.orderId, approved: approval.approved };
  }),
);
```

The typed handle is a runtime `{ name }` value with phantom TypeScript payload information, so the received payload is inferred without repeating a generic at the wait site.

## Sending a signal

From outside the workflow, use `engine.signal()` or `handle.signal()` to deliver data.

```typescript partial
const handle = await engine.start('approval', { orderId: 'order-1' });

// Some time later, when the human clicks "Approve":
await engine.signal(handle.id, approvalSignal, { approved: true });

const result = await handle.result();
// { orderId: 'order-1', approved: true }
```

You can also signal through the handle directly.

```typescript partial
await handle.signal(approvalSignal, { approved: true });
await engine.signal(handle.id, approvalSignal, { approved: true }, { signalId: 'approval-123' });
```

Both forms do the same thing. The handle version is convenient when you already have a reference; the engine version is useful when you only have a workflow ID (for example, from a webhook handler or a message queue consumer).

When retrying a sender request, pass a stable `signalId`. Weft uses it as an idempotency key for that workflow and signal name: the first delivery is accepted once, and duplicate retries return the same successful acknowledgement instead of queuing the signal again. This requires a storage adapter that supports `conditionalBatch`; plain signals without `signalId` continue to work without that capability.

## Starting or signalling atomically

Webhook-style integrations often need "start the workflow if this is the first event, otherwise deliver the event to the existing run." Use `engine.startOrSignal()` for that signal-with-start path.

```typescript partial
const handle = await engine.startOrSignal(
  'approval',
  { orderId: 'order-1' },
  { name: approvalSignal.name, payload: { approved: true } },
  { idempotencyKey: 'approval-webhook-order-1' },
);
```

An absent target is created and receives the first signal in the same durable batch. A running, pending, or suspended target receives the signal through the normal signal path. A terminal target returns a conflict; it is not replaced. Concurrent callers converge on one workflow and one signal only when they share `idempotencyKey`, or when they share both `id` and `signalId`. A bare `signalId` starts a fresh generated workflow id per absent-target caller, so it is useful for single-call signal identity but not for multi-caller convergence.

## Signal durability

Signals are persisted to [storage](storage.md) when they are sent. This means:

- If a signal arrives _before_ the workflow reaches its `waitForSignal` call, it is buffered in storage and delivered immediately when the workflow gets there.
- If the process crashes after a signal is sent but before it is consumed, the signal survives the restart and is delivered on recovery.
- Signals are fire-and-forget from the sender's perspective—`engine.signal()` resolves as soon as the signal is persisted, without waiting for the workflow to consume it.

This durability guarantee is what makes signals safe for human-in-the-loop workflows. You do not need to worry about race conditions between signal delivery and workflow execution.

## Multiple signals

A workflow can wait for multiple signals, either sequentially or with different names.

```typescript partial
const managerApproval = signal<{ approved: boolean }>('manager-approval');
const financeApproval = signal<{ approved: boolean }>('finance-approval');

engine.register(
  workflow({ name: 'multi-step-approval' }).execute(async function* (
    ctx,
    input: { orderId: string },
  ) {
    // Wait for manager approval
    const manager = yield* ctx.waitForSignal(managerApproval);
    if (!manager.approved) return { orderId: input.orderId, status: 'rejected-by-manager' };

    // Then wait for finance approval
    const finance = yield* ctx.waitForSignal(financeApproval);
    if (!finance.approved) return { orderId: input.orderId, status: 'rejected-by-finance' };

    yield* ctx.run('fulfillOrder', { orderId: input.orderId });
    return { orderId: input.orderId, status: 'approved' };
  }),
);
```

Each `waitForSignal` is an independent checkpoint boundary with its own signal name.

## Querying workflow state

You can inspect workflows from outside through the engine's `list()` method, which supports filtering by status and type.

```typescript partial
const running = await engine.list({ status: 'running' });
const failed = await engine.list({ status: 'failed', type: 'order' });
const all = await engine.list({ limit: 50, offset: 0 });
```

The result is paginated.

```typescript
interface PaginatedResult<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}
```

Each item is a `WorkflowSummary` with the workflow's `id`, `type`, `status`, `version`, `createdAt`, and `updatedAt`. This is enough to build dashboards, monitoring, and administrative tooling without querying the underlying storage directly.

For richer state inspection, workflows can set search attributes via `ctx.setAttribute()` and `ctx.setAttributes()`, which are indexed and queryable. See the [workflows guide](workflows.md) for details on search attributes.

Signals turn your workflows into interactive, event-driven processes. Combined with [durable timers](durable-timers.md), you can model arbitrarily complex human-in-the-loop processes—approval chains, escalation deadlines, SLA monitoring—all within a single workflow function.

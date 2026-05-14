# Key Concepts

Weft has a handful of core ideas that show up everywhere. This page defines each one so you have a shared vocabulary for the rest of the documentation.

## Workflow

A **workflow** is a multi-step durable process defined as a generator function. It's the orchestrator---it decides what to do and in what order. Workflows don't perform side effects directly. Instead, they dispatch activities and coordinate the results.

```typescript partial
engine.register('checkout', async function* (ctx, order) {
  const charge = yield* ctx.run(chargeCard, { payment: order.payment });
  yield* ctx.run(reserveInventory, { items: order.items });
  yield* ctx.run(sendConfirmation, { email: order.email, receiptId: charge.receiptId });
  return { status: 'completed' };
});
```

Every `yield*` in a workflow is a checkpoint boundary. The engine saves the workflow's position after each one, so it can resume from that exact point if something goes wrong.

## Activity

An **activity** is a named unit of work dispatched by a workflow. This is where side effects happen---API calls, database writes, sending emails. Locally, an activity can look like a regular async function. Durably, the engine dispatches it by name.

```typescript
import { activity } from 'weft';

const sendConfirmation = activity({
  name: 'sendConfirmation',
  execute: async (input: { email: string; receiptId: string }) => {
    await fetch('https://api.email.com/send', {
      method: 'POST',
      body: JSON.stringify({ to: input.email, receiptId: input.receiptId }),
    });
  },
});
```

Register activities with `engine.register(activity)` before workflows need them, then run them with `yield* ctx.run(activity, input)`. The function reference keeps local development pleasant, but remote workers receive the activity name and serialized input. If an activity throws, the engine retries it according to the retry policy. Activities are the boundary between your durable workflow logic and the messy outside world.

## Checkpoint

A **checkpoint** is a snapshot of a workflow's current position and local variables. Every time a workflow yields, the engine serializes its state and writes it to storage. If the process crashes, the engine loads the most recent checkpoint and resumes from there.

This is fundamentally different from replay-based systems like Temporal. Weft doesn't re-execute your workflow from the beginning. It literally picks up where it left off. That's why checkpoints are fixed-size---long-running workflows don't accumulate ever-growing history.

## Signal

A **signal** is an external message sent _into_ a running workflow. Use signals when something outside the workflow needs to tell it something---a user clicking "approve," a webhook arriving, a timer in another system firing.

```typescript partial
const approvalSignal = signal<{ approved: boolean }>('approval');

async function* example(ctx: Context) {
  // Inside the workflow:
  const approval = yield* ctx.waitForSignal(approvalSignal);
}

// From outside:
await engine.signal(workflowId, approvalSignal, { approved: true });
```

Signals are fire-and-forget from the sender's perspective. The workflow pauses at `waitForSignal()` until the signal arrives, which could be seconds or weeks.

## Update

An **update** is a synchronous message sent into a running workflow that blocks the caller until the workflow processes it and returns a result. Unlike signals (fire-and-forget), updates are request-response. Use them when the caller needs an answer back from the workflow.

## Query

A **query** is a read-only peek into a running workflow's state. Queries never mutate anything---they just let you inspect what a workflow is doing right now.

## Worker

A **worker** is a process or thread that executes activities. In library mode, activities run inline in the same process. In server mode, workers connect over WebSocket, pull tasks from the server, execute them, and report results back.

Weft also uses standard Web Workers internally to isolate workflow execution from the HTTP server's main thread.

## Search Attribute

A **search attribute** is user-defined indexed metadata on a workflow---things like customer ID, region, or priority. You set them inside a workflow with `ctx.setAttribute()`, and they become queryable through the list API. They're stored as secondary indexes in the storage layer.

```typescript partial
engine.register('order', async function* (ctx, input) {
  ctx.setAttribute('customerId', input.customerId);
  ctx.setAttribute('status', 'processing');
  // ... do work ...
  ctx.setAttribute('status', 'shipped');
  return 'done';
});
```

## Session State

**Session state** is checkpoint-local durable state addressable by key, returned as a typed `WorkflowSessionState<T>` slot from `ctx.state.session(key, options?)`. Unlike search attributes (which are queryable indexes), session state is private to the workflow and survives checkpoint recovery. Access it with `.get()`, `.set()`, `.update()`, `.delete()`, or `.run()` for memoized operations over the slot's value.

```typescript partial
engine.register('counter', async function* (ctx, input) {
  const counter = ctx.state.session<number>('count', { initial: 0 });
  counter.set((counter.get() ?? 0) + 1);
  return counter.get();
});
```

Because session state is checkpointed alongside the workflow, the counter persists across process restarts.

## Interceptor

An **interceptor** is a composable hook that wraps workflow context operations---activities, sleeps, signals---for cross-cutting concerns like tracing, validation, and encryption. Interceptors chain via `next()` delegation, so you can stack as many as you need without any of them knowing about each other.

## Shared State

**Shared state** is a CAS-backed (compare-and-swap) durable mutable state primitive. Multiple concurrent workflows can read from and write to it without clobbering each other's writes. Think of it as a durable, conflict-safe scratchpad.

## Human Review

**Human review** is a structured interaction protocol for human-in-the-loop workflows. When a workflow reaches a decision that needs human oversight, it can pause and request approval, rejection, escalation, or partial approval. The workflow stays checkpointed while waiting---it costs nothing to wait for a human.

```typescript partial
engine.register('payment-review', async function* (ctx, payment) {
  const decision = yield* ctx.review({
    artifact: payment,
    reviewType: 'payment-approval',
    timeout: 72 * 60 * 60 * 1000,
  });

  if (decision.decision !== 'approved') {
    return { status: 'rejected' };
  }

  return yield* ctx.run(chargeCard, payment);
});
```

## How They Fit Together

A workflow orchestrates activities, sleeping between them when needed. Signals, updates, and reviews let the outside world communicate with running workflows. Checkpoints make the whole thing durable. Storage, interceptors, and search attributes handle the operational concerns underneath.

That's the vocabulary. Now you can dig into the specific guides knowing what each term means.

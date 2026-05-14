# Activities

Your [workflow](workflows.md) is the orchestrator. It decides _what_ happens and _in what order_. But the actual work---calling an API, writing to a database, sending an email---lives in activities. Activities are the side-effecting functions your workflows call, and they are the unit of retry, timeout, and failure isolation.

## Calling an activity

You invoke an activity with `yield* ctx.run(activity, input)`. The function you pass is a real function reference, not a proxy or a type stub, so "Go to definition" still takes you to the implementation. But the durable operation is keyed by the activity name. In remote-worker mode, the worker receives that name and a serialized input payload; your in-process closure does not travel over the WebSocket.

```typescript partial
const greet = activity({
  name: 'greet',
  execute: async (input: { name: string }) => `Hello, ${input.name}!`,
});

const notify = activity({
  name: 'notify',
  execute: async (input: { message: string }) => `Notified: ${input.message}`,
});

engine.register(greet);
engine.register(notify);

engine.register('welcome', async function* (ctx, input: { name: string }) {
  const greeting = yield* ctx.run(greet, { name: input.name });
  yield* ctx.run(notify, { message: greeting });
  return { greeting, notified: true };
});
```

Each `yield* ctx.run()` is a checkpoint boundary. If the process crashes after `greet` completes but before `notify` starts, recovery picks up at the second call---`greet` does not run again. For that to be true in a fresh process, register the same activity names before calling `engine.recoverAll()` or `engine.resume(id)`.

## Retry policies

Activities fail. Networks flake, services go down, rate limits hit. Weft retries activities automatically using exponential backoff, and you control the behavior through a `RetryPolicy`.

```typescript partial
interface RetryPolicy {
  maxAttempts: number;
  initialBackoff: Duration; // number (ms) or string like "1s"
  backoffMultiplier: number;
  maxBackoff: Duration;
  nonRetryableErrors?: string[]; // error messages that skip retry
}
```

The default policy is sensible for most use cases.

```typescript partial
const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialBackoff: 1000, // 1 second
  backoffMultiplier: 2, // exponential: 1s, 2s, 4s...
  maxBackoff: 30_000, // capped at 30 seconds
};
```

So out of the box, a failing activity retries up to 3 times with backoff delays of 1 second, 2 seconds, and 4 seconds (capped at 30 seconds). The `nonRetryableErrors` array lets you short-circuit retries for errors you know are permanent---pass the error message strings and Weft will fail immediately instead of wasting time retrying a 404 or a validation error.

## ActivityContext

Every activity function can optionally receive an `ActivityContext` as its second argument. This gives you two things: a standard `AbortSignal` for cancellation, and a `heartbeat()` function for long-running work.

```typescript
interface ActivityContext {
  signal: AbortSignal;
  heartbeat(details?: unknown): void;
}
```

The `signal` is an `AbortSignal` that fires when the workflow is cancelled or the activity times out. Pass it to `fetch`, database clients, or anything else that accepts an abort signal.

```typescript partial
const fetchData = async (url: string, context?: ActivityContext) => {
  const response = await fetch(url, { signal: context?.signal });
  return response.json();
};
```

The `heartbeat()` function tells Weft your activity is still alive. For activities that run for minutes (processing a large file, running a machine learning job), heartbeating prevents Weft from assuming the activity is stuck and retrying it.

```typescript partial
const processLargeFile = async (path: string, context?: ActivityContext) => {
  const lines = await readLines(path);
  for (const [index, line] of lines.entries()) {
    await processLine(line);
    context?.heartbeat({ progress: index / lines.length });
  }
  return { processed: lines.length };
};
```

## Per-call options

You can override retry, timeout, queue, and idempotency settings on a per-invocation basis using `ActivityCallOptions`.

```typescript partial
interface ActivityCallOptions {
  timeout?: Duration;
  queue?: string;
  retry?: Partial<RetryPolicy>;
  idempotencyKey?: string;
  sticky?: boolean;
  visibilityTimeout?: Duration; // override the activity's claim/visibility timeout
}
```

Pass these as the last argument to `ctx.run()`.

```typescript partial
async function* example(ctx: Context) {
  const result = yield* ctx.run(fetchData, url, {
    timeout: '60s',
    retry: { maxAttempts: 5 },
    queue: 'external-api',
    idempotencyKey: `fetch-${url}`,
  });
}
```

The `timeout` kills the activity after the specified duration. The `queue` routes the activity to a specific worker queue (useful for rate limiting or resource isolation). The `idempotencyKey` ensures that if the same logical operation is attempted twice, Weft deduplicates it.

## Activity definitions

When you find yourself specifying the same retry policy and timeout at every call site, it is time to colocate that configuration with the activity itself using `ActivityDefinition`.

```typescript partial
interface ActivityDefinition<TInput, TOutput> {
  name: string;
  execute: ActivityFunction<TInput, TOutput>;
  retry?: RetryPolicy;
  timeout?: Duration;
  queue?: string;
  idempotent?: boolean;
}
```

See the JSDoc on `ActivityDefinition` for additional fields: `verify` (post-execution result verifier), `visibilityTimeout` (claim timeout override), `compensate` (saga rollback function), `resourceScope` (resource-level lock key), and a function-form `idempotencyKey` for per-input key generation.

Here is what that looks like in practice.

```typescript partial
const charge: ActivityDefinition<Order, PaymentResult> = {
  name: 'charge',
  retry: {
    maxAttempts: 3,
    initialBackoff: '1s',
    backoffMultiplier: 2,
    maxBackoff: '30s',
  },
  timeout: '30s',
  queue: 'payments',
  idempotent: true,

  async execute(order, context) {
    const result = await stripe.charges.create({
      amount: order.total,
      signal: context?.signal,
    });
    context?.heartbeat({ status: 'processing', chargeId: result.id });
    return { id: result.id, amount: result.amount };
  },
};
```

Now the workflow call is clean---configuration travels with the activity.

```typescript partial
async function* example(ctx: Context) {
  const payment = yield* ctx.run(charge, order);
}
```

## Running activities in parallel

When activities are independent of each other, run them concurrently with `ctx.all()`.

```typescript partial
const double = activity({
  name: 'double',
  execute: async (input: number) => input * 2,
});

const triple = activity({
  name: 'triple',
  execute: async (input: number) => input * 3,
});

engine.register(double);
engine.register(triple);

engine.register('parallel', async function* (ctx, input: number) {
  const [doubled, tripled] = yield* ctx.all([ctx.run(double, input), ctx.run(triple, input)]);
  return { doubled, tripled };
});
```

For named concurrent branches where each needs its own error handling, use `ctx.runAll()`.

```typescript partial
async function* example(ctx: Context) {
  const results = yield* ctx.runAll({
    payment: [charge, order],
    inventory: [reserveInventory, order.items],
    email: [sendConfirmation, order],
  });
  // results.payment, results.inventory, results.email
}
```

Both `ctx.all()` and `ctx.runAll()` create a single checkpoint boundary---all branches complete before the workflow advances.

Activities are where the real world meets your durable logic. Keep them focused, make them idempotent where possible, and let Weft handle the retries.

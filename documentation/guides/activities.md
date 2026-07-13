# Activities

Your [workflow](workflows.md) is the orchestrator. It decides _what_ happens and _in what order_. But the actual work—calling an API, writing to a database, sending an email—lives in activities. Activities are the side-effecting functions your workflows call, and they are the unit of retry, timeout, and failure isolation.

## Calling an activity

You invoke an activity with `yield* ctx.run('activityName', input)`. The first argument is the activity's registered name. The durable operation is keyed by that name: in remote-worker mode, the worker receives the name and a serialized input payload, and your in-process closure never travels over the WebSocket. `ctx.run` also accepts the activity function itself, but this guide uses the name string throughout—it is the form remote workers actually dispatch on, so local and remote behavior stay identical. When you build the workflow with a typed `.activities({ ... })` block (see below), your editor autocompletes the name and infers its input and result types.

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

engine.register(
  workflow({ name: 'welcome' }).execute(async function* (ctx, input: { name: string }) {
    const greeting = yield* ctx.run('greet', { name: input.name });
    yield* ctx.run('notify', { message: greeting });
    return { greeting, notified: true };
  }),
);
```

Each `yield* ctx.run()` is a checkpoint boundary. If the process crashes after `greet` completes but before `notify` starts, recovery picks up at the second call—`greet` does not run again. For that to be true in a fresh process, register the same activity names before calling `engine.recoverAll()` or `engine.resume(id)`.

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

So out of the box, a failing activity retries up to 3 times with backoff delays of 1 second, 2 seconds, and 4 seconds (capped at 30 seconds). The `nonRetryableErrors` array lets you short-circuit retries for errors you know are permanent—pass the error message strings and Weft will fail immediately instead of wasting time retrying a 404 or a validation error.

## ActivityContext

Every activity function can optionally receive an `ActivityContext` as its second argument. It exposes a standard `AbortSignal` for cancellation, a `heartbeat()` function for long-running work, the previous attempt's heartbeat via `lastHeartbeatDetails` (a best-effort, in-process-only resume hint—see the warning below), and `completeAsync()` for out-of-band completion.

```typescript
interface ActivityContext {
  signal: AbortSignal;
  // Stable for the same workflow run, rotated when start-new replaces a run.
  workflowExecutionToken?: string;
  // Unique to this activity dispatch attempt; changes on retry.
  activityAttemptToken?: string;
  heartbeat(details?: unknown): void;
  // The heartbeat the PREVIOUS attempt recorded, or `undefined` on the first
  // attempt / after a restart / for worker-executed activities — let a retry
  // resume mid-stream instead of re-running from the start.
  lastHeartbeatDetails?: unknown;
  // Park the workflow at this step and complete it later by durable task token.
  // See "Out-of-band completion" below.
  completeAsync(): never;
}
```

> [!WARNING] `lastHeartbeatDetails` only survives in-process retries
> `lastHeartbeatDetails` is held in engine memory, not in durable storage. It carries the previous attempt's heartbeat _only_ when the retry runs in the same engine process. It is `undefined` in three cases: the first attempt of a step, the first retry resumed after the engine process restarts (the prior process's heartbeat is gone—a later retry within that same new process can still read a heartbeat recorded after the restart), and _all_ worker-executed activities (the heartbeat lives on the host, not the worker). So the resumable-batch pattern below is a best-effort optimization, not a durability guarantee—write your activity so an `undefined` `lastHeartbeatDetails` simply restarts the batch from the beginning. If you need resume points that survive a restart, persist your own checkpoint (a cursor in your database, an offset in object storage) instead of relying on the heartbeat. In development mode, an inline retry (`attempt > 1`) that finds `lastHeartbeatDetails` undefined emits a coarse `DevelopmentWarningEvent`—it cannot tell whether the previous attempt never recorded heartbeat details (it never called `heartbeat()`, or called it with no details) or the process restarted, so it flags both.

The `signal` is an `AbortSignal` that fires when the **workflow is cancelled** (`engine.cancel(id)` / `handle.cancel()`). Pass it to `fetch`, database clients, or anything else that accepts an abort signal. It does _not_ fire when a `ctx.race` branch loses—see [Cancelling a running activity](#cancelling-a-running-activity) below.

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

### Cancelling a running activity

Activity cancellation in Weft is **cooperative**, and the `ActivityContext.signal` fires on workflow cancellation (`engine.cancel(id)` / `handle.cancel()`), an inline per-attempt `timeout` expiry configured through [Per-call options](#per-call-options), or when an inline activity loses a `ctx.race()`. On workflow cancellation Weft aborts the workflow's `AbortController`; on an inline timeout or race loss only that activity attempt's signal aborts. Worker-pool mode bounds an attempt with `visibilityTimeout`, the claim/visibility expiry; a worker-pooled activity does not observe an inline race-loss abort through `ctx.signal`. In every case the signal is an _offer_ to stop, not a forced interrupt—an activity that does nothing with it still runs to completion. This is different from Temporal's `CancellationScope.cancel()`, which interrupts at `await` boundaries preemptively. To make an activity actually stop, it has to check the signal:

```typescript partial
const pollUntilReady = async (jobId: string, context?: ActivityContext) => {
  while (true) {
    context?.signal.throwIfAborted(); // bail out promptly on workflow cancellation
    const status = await checkStatus(jobId);
    if (status === 'ready') return status;
    await sleep(1000);
  }
};
```

Pass `context.signal` straight through to anything that accepts one—`fetch`, streaming readers, database drivers—so the network request is interrupted too, not just your loop:

```typescript partial
const streamReport = async (url: string, context?: ActivityContext) => {
  const response = await fetch(url, { signal: context?.signal });
  return response.text();
};
```

> [!WARNING] `ctx.race` cancellation is cooperative
> When the sleep wins in `ctx.race([ctx.run('longJob'), ctx.sleep('5s')])`, the race stops awaiting `longJob`. For an inline activity, it also aborts `ActivityContext.signal`; the activity only stops if its implementation observes that signal. Worker-pooled work does not receive this race-loss abort, so its work and side effects can continue after the race settles.
>
> `ctx.race` is therefore not a preemptive `CancellationScope` replacement. Pass the signal into interruptible work and check it in long-running loops. Keep side effects idempotent or fenced because cooperative cancellation cannot roll back work that already happened.

### Fencing external writes

Idempotency keys protect against duplicate external calls when the provider supports lookup or replay. When the external system is a database or service you control, use Weft's execution tokens as a write fence instead: store `context.workflowExecutionToken` with rows owned by the whole workflow run, and store `context.activityAttemptToken` with rows that belong to one activity attempt.

`workflowExecutionToken` stays stable across recovery for the same run, but rotates when `onTerminalConflict: 'start-new'` replaces a terminal run under the same workflow ID. `activityAttemptToken` changes on each retry attempt. A conditional update that matches both the domain key and the current token rejects late writes from an older retry, a losing `ctx.race` branch, or a replaced run that reused the workflow ID.

```typescript
import type { ActivityContext } from '@lostgradient/weft';

declare const inventory: {
  updateReservation(input: {
    orderId: string;
    sku: string;
    workflowExecutionToken: string;
    activityAttemptToken: string;
  }): Promise<void>;
};

const reserveInventory = async (
  input: { orderId: string; sku: string },
  context?: ActivityContext,
) => {
  if (!context?.workflowExecutionToken || !context.activityAttemptToken) {
    throw new Error('Activity fencing tokens are required');
  }

  await inventory.updateReservation({
    orderId: input.orderId,
    sku: input.sku,
    workflowExecutionToken: context.workflowExecutionToken,
    activityAttemptToken: context.activityAttemptToken,
  });
};

void reserveInventory;
```

The tokens are not secrets. They are durable identity values for conditional writes, audit records, and stale-completion rejection. Continue to validate external inputs and keep auth on any route that accepts callbacks or operator mutations.

### Out-of-band completion

Some activities start work that finishes later somewhere else: a webhook callback, a human-operated job, or a third-party batch process. Call `context.completeAsync()` to park the workflow at that activity step and complete or fail it later by durable task token.

```typescript partial
const awaitWebhook = activity({
  name: 'awaitWebhook',
  execute: async (input: { callbackUrl: string }, context?: ActivityContext) => {
    const callbackUrl = new URL(input.callbackUrl);
    if (callbackUrl.origin !== 'https://callbacks.example.com') {
      throw new Error('Unsupported callback origin');
    }
    await fetch(callbackUrl, { method: 'POST' });
    return context!.completeAsync();
  },
});
```

The engine emits an `activity:async-pending` event with the token. Resolve it in-process with `engine.completeAsyncActivity(token, result)` / `engine.failAsyncActivity(token, error)`, through the transport-neutral client surface `client.activity.complete(token, result)` / `client.activity.completeExceptionally(token, error)`, or over REST:

```bash
curl -X POST http://localhost:7233/api/v1/activities/complete \
  -H 'content-type: application/json' \
  -d '{"token":"async-act:v1:workflow-123:4:1","result":{"ok":true}}'
```

Tokens are single-use. A replayed or unknown token returns `NotFound`; oversized completion and failure payloads return `InvalidParams` before the parked token is consumed, so the workflow remains waiting.

When a completion is accepted, the acknowledgement is durable before the call returns: one atomic batch consumes the token and persists the supplied outcome as a resolution record. A crash after a successful acknowledgement cannot lose the outcome — recovery redelivers the persisted resolution when replay re-parks on the same deterministic token — and a crash cannot leave a workflow result committed while the same completion token remains reusable. If the acknowledgement's storage write fails, the call rejects and the token remains completable, so callers should treat a rejected completion as retryable.

After a restart, register workflows and activities, then await `engine.recoverAll()` before accepting callback traffic if your application needs deterministic startup ordering. If a completion or failure races recovery after the token has been recovered but before replay has adopted the workflow generator, Weft buffers that outcome and delivers it when replay reaches the same async-activity token.

The token is a deterministic identifier, not a secret. Treat completion payloads as hostile external input, validate them the same way you validate signal payloads, and enable `serve({ auth })` before exposing completion endpoints outside a trusted boundary.

## Per-call options

You can override retry, timeout, queue, and idempotency settings on a per-invocation basis using `ActivityCallOptions`.

```typescript partial
interface ActivityCallOptions {
  timeout?: Duration; // per-attempt wall-clock cap, inline only (reset each attempt)
  scheduleToCloseTimeout?: Duration; // cumulative budget across all attempts + backoff
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
  const result = yield* ctx.run('fetchData', url, {
    timeout: '60s',
    retry: { maxAttempts: 5 },
    queue: 'external-api',
    idempotencyKey: `fetch-${url}`,
  });
}
```

The `timeout` is a **per-attempt wall-clock cap** for **inline** execution. It is measured fresh on each attempt: when an attempt overruns it, the workflow stops awaiting that attempt and fails it with an `ActivityPerAttemptTimeoutError` (a `timeout` failure category), and the activity's `AbortSignal` is aborted so a cooperating activity can stop promptly. Just like workflow cancellation, this is _cooperative_: Weft cannot forcibly preempt a running activity function, so an activity that ignores its signal keeps executing in the background until it returns—only the workflow stops waiting on it. If a retry policy is configured, the timed-out attempt retries with a fresh cap. In worker-pool mode use `visibilityTimeout` instead—`timeout` is enforced inline only.

The `scheduleToCloseTimeout` is the **cumulative budget across all attempts and the backoff waits between them** (close to Temporal's `scheduleToCloseTimeout`). It starts at the first dispatch and does _not_ reset between attempts: `timeout` bounds one attempt; `scheduleToCloseTimeout` bounds the whole retry sequence. It is enforced at the **retry-decision point**, not by waiting out the clock: when the next retry's backoff would start the attempt at or after the deadline (or an attempt has already overrun the budget), Weft skips that retry and fails the activity with an `ActivityScheduleToCloseTimeoutError` (also a `timeout` failure category). Unlike a per-attempt `timeout`, this does _not_ abort the in-flight attempt's `ActivityContext.signal`—it is only consulted when deciding whether another retry may begin. It has _no effect_ unless a retry policy is configured—a non-retried activity fails on its first error before the budget is consulted—and it applies to top-level `ctx.run` activities only, since an activity inside `ctx.all` / `ctx.race` does not retry.

The `queue` routes the activity to a specific worker queue (useful for rate limiting or resource isolation). The `idempotencyKey` lets Weft replay a completed reconciliation marker without rerunning the activity. When recovery only finds an ambiguous prior start marker, Weft fails closed unless the activity definition provides a Tier-0 verifier that can prove the external result or safe redispatch. It is not an exactly-once guarantee for external systems.

> [!WARNING]
> Activities are at-least-once side effects. Payment providers, queues, email APIs, and databases still need their own idempotency keys. Weft can replay a completed result it durably recorded, or ask your verifier whether a prior keyed side effect completed, but it cannot undo an external side effect that finished before Weft recorded the outcome. A keyed activity without a Tier-0 verifier can fail closed after a crash in that execution window because recovery sees only the prior start marker and cannot prove whether redispatch is safe.

## Plain async helper calls

Use `durableActivity()` when shared workflow logic already lives in plain async helper functions and you do not want to convert the whole helper stack to generators. The helper is intentionally narrow: it only works while an inline workflow is executing a `ctx.memo()` callback. Outside that activation boundary it rejects with `DurableActivityScopeError`.

```typescript
import { durableActivity, workflow } from '@lostgradient/weft';

interface Input {
  tool: { name: string; arguments: unknown };
  toolKey: string;
}

async function executeTool(input: Input['tool']): Promise<{ output: unknown }> {
  return { output: input.arguments };
}

async function sharedStep(input: Input): Promise<{ toolResult: unknown }> {
  const toolResult = await durableActivity('executeTool', input.tool, {
    idempotencyKey: input.toolKey,
  });
  return { toolResult };
}

const run = workflow({ name: 'agent-like-run' })
  .activities({ executeTool })
  .execute(async function* (ctx, input: Input) {
    return yield* ctx.memo('step-0', async () => sharedStep(input));
  });

void run;
```

Each `durableActivity()` call gets a deterministic sub-operation identity derived from the owning memo step, memo key, and call ordinal. That identity keeps retry state, heartbeat state, timeline labels, reconciliation metadata, and diagnostics separate from the surrounding memo operation. Calls in one memo callback must be awaited sequentially. If the callback returns while a helper activity promise is still pending, Weft fails the memo and closes the scope so no detached promise can later commit.

Keyed and unkeyed calls intentionally differ:

- With `options.idempotencyKey` (or a definition-level `idempotencyKey`), Weft commits the completed reconciliation record immediately through the same lease-fenced write path used by engine commits. If the process crashes after the activity returns but before the memo result is checkpointed, recovery replays the completed result without redispatching.
- Without an idempotency key, no immediate result record is written. A crash before the memo checkpoints keeps the existing at-least-once behavior and may run the activity again.

`durableActivity()` preserves the normal activity registration, name validation, retry, per-attempt timeout, schedule-to-close timeout, verifier, heartbeat, interceptor, and observability paths. It does not serialize helper locals; only the memo result and normal activity metadata become durable. Workflow cancellation and engine disposal abort pending helper activities and reject their promises; a late keyed result cannot write a completed reconciliation record after the memo owner is gone.

`ActivityContext.completeAsync()` is not supported from `durableActivity()`. Use `yield* ctx.run()` directly for async-completion activities, worker-mode workflows, parallel `ctx.all`/`ctx.race` activity branches, signals, timers, child workflows, or any helper code that cannot run inside a single `ctx.memo()` callback.

Verification checklist for this pattern:

- Give side-effecting helper activities stable idempotency keys.
- Keep helper activity calls sequential and awaited.
- Test fresh-process recovery after the helper activity returns but before the memo callback returns.
- Keep an unkeyed recovery test if you intentionally rely on at-least-once behavior.

## Activity definitions

When you find yourself specifying the same retry policy and timeout at every call site, it is time to colocate that configuration with the activity itself using `ActivityDefinition`.

```typescript partial
interface ActivityDefinition<TInput, TOutput> {
  name: string;
  execute: ActivityFunction<TInput, TOutput>;
  verify?: (
    result: TOutput | undefined,
    context: ActivityVerificationContext<TInput>,
  ) => Promise<ActivityVerificationResult<TOutput>> | ActivityVerificationResult<TOutput>;
  retry?: RetryPolicy;
  timeout?: Duration;
  queue?: string;
  idempotent?: boolean;
  idempotencyKey?: (input: TInput) => string;
}
```

See [the activity definition reference](../reference/api-definitions.md#activity-definitions) for advanced fields: `verify`, `visibilityTimeout`, `compensate`, `resourceScope`, and function-form `idempotencyKey`.

`verify` has two phases. During normal post-execution validation, return `true` to accept the activity result or `false` to reject it. During `pre-dispatch-reconciliation`, return one of the Tier-0 states:

- `not-completed`: the external system reports no completed side effect, so Weft may dispatch the activity.
- `{ status: 'completed-with-result', result }`: the external system reports completion and can reconstruct the workflow result.
- `completed-result-unavailable`: the side effect completed, but the workflow result cannot be reconstructed.
- `indeterminate`: the verifier cannot prove whether the side effect completed.

The last two states fail closed and do not redispatch the activity. A keyed activity that has a prior dispatch marker but no Tier-0 verifier also fails closed; retry policy does not turn that into a silent redispatch.

Here is what that looks like in practice.

```typescript partial
const charge: ActivityDefinition<Order, PaymentResult> = {
  name: 'charge',
  retry: { maxAttempts: 3, initialBackoff: '1s', backoffMultiplier: 2, maxBackoff: '30s' },
  timeout: '30s',
  queue: 'payments',
  async execute(order) {
    const result = await stripe.charges.create({ amount: order.total });
    return { id: result.id, amount: result.amount };
  },
};
```

Now the workflow call is clean—you reference the activity by name and its registered configuration travels with it.

```typescript partial
async function* example(ctx: Context) {
  const payment = yield* ctx.run('charge', order);
}
```

## Running activities in parallel

When activities are independent of each other, run them concurrently with `ctx.all()`, which fans out the activities and resumes once all of them resolve. For a complete runnable example, see [Running Activities in Parallel](../getting-started/hello-world.md#running-activities-in-parallel) in the getting-started tutorial.

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

Unlike `ctx.run`, each `ctx.runAll` branch is a tuple whose first element is the activity function itself (optionally followed by its input); the record key is the branch name. Both `ctx.all()` and `ctx.runAll()` create a single checkpoint boundary—all branches complete before the workflow advances.

Activities are where the real world meets your durable logic. Keep them focused, make them idempotent where possible, and let Weft handle the retries.

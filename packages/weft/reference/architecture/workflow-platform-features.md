# Workflow Platform Features

This companion document was split out of [../architecture.md](../architecture.md) so the roadmap can stay checklist-first. It covers the remaining workflow-platform primitives such as versioning, timeouts, search attributes, updates, interceptors, and observability.

### 12. Additional Platform Patterns

#### Promise.withResolvers() Throughout

```typescript
// Before: manual Promise construction
const signal = new Promise((resolve, reject) => {
  signalResolvers.set(key, { resolve, reject });
});

// After: Promise.withResolvers() — cleaner, no closure scope issues
const { promise, resolve, reject } = Promise.withResolvers<SignalPayload>();
signalResolvers.set(key, { resolve, reject });
const payload = await promise;
```

#### Transferable Objects in Worker Communication

```typescript
// When sending checkpoints to/from Web Workers, TRANSFER the ArrayBuffer
// instead of copying it. This is zero-copy — O(1) instead of O(n).

const checkpointBuffer = serializeCheckpoint(generatorState);

worker.postMessage(
  {
    type: 'run',
    workflowId: id,
    checkpoint: checkpointBuffer,
  },
  [checkpointBuffer],
); // Transfer list: ownership moves to worker, no copy
// checkpointBuffer is now detached (zero bytes) in the sender — enforced by the platform
```

#### AbortSignal.any() for Compound Cancellation

```typescript
// Activity execution has multiple cancellation sources:
// 1. Workflow-level cancellation
// 2. Activity-level timeout
// 3. Engine shutdown
// 4. Any caller-supplied signal (e.g. a userland budget guard)

async function executeActivity(
  fn: Function,
  input: unknown,
  signals: {
    workflow: AbortSignal;
    timeout: AbortSignal;
    shutdown: AbortSignal;
    extra?: AbortSignal; // optional caller-supplied signal, not an engine concept
  },
): Promise<unknown> {
  // AbortSignal.any() fires when ANY of the signals abort
  const combined = AbortSignal.any([
    signals.workflow,
    signals.timeout,
    signals.shutdown,
    ...(signals.extra ? [signals.extra] : []),
  ]);

  return await fn(input, { signal: combined });
}
```

#### AbortSignal.timeout() for Durable Timeouts

```typescript
// For activity-level timeouts — cleaner than manual setTimeout + AbortController
const result = await fetch(url, {
  signal: AbortSignal.timeout(30_000), // 30-second hard timeout
});
```

#### Private Fields (#) for True Encapsulation

All internal state uses `#private` fields — not `_underscore` convention. Private fields cannot be accessed from outside the class even with bracket notation or `Object.keys()`. This prevents users from depending on implementation details.

```typescript
class Engine extends EventTarget implements Disposable {
  // These are truly inaccessible from outside
  #storage: Storage;
  #workers: WorkerPool;
  #scheduler: Scheduler;
  #registry: ActivityRegistry;
  #handleRegistry: HandleRegistry;
  #checkpointCache: CheckpointCache;
  #abortController: AbortController;

  // Public API only exposes what users need
  get isRunning(): boolean { ... }
  start(type: string, input: unknown): Promise<WorkflowHandle> { ... }
  register(name: string, fn: WorkflowFunction): void { ... }
}
```

### 13. Workflow Versioning

When you deploy new workflow code while workflows are in-flight, you need to answer: which version of the code runs when a checkpointed workflow resumes?

Weft's checkpoint model makes this fundamentally simpler than Temporal. Since we resume from a checkpoint (not replay from the beginning), the compatibility requirement is explicit: the stored workflow version must match the registered version, the recorded version tuple must not drift, and the code must still understand the checkpoint shape at the specific step where execution paused. No patching API. No version gates in workflow code.

#### Registration API

```typescript
interface WorkflowRegistration {
  name: string;
  version: string; // Semver string, e.g., "2.0.0"
  handler: WorkflowFunction;
}

// Full registration with an explicit recovery boundary.
engine.register('order', {
  version: '2.0.0',
  handler: orderWorkflowV2,
});

// Shorthand still works — defaults to version "0.0.0".
engine.register('order', orderWorkflow);
```

#### Resume Logic

1. **Version pinned at start.** When `engine.start()` is called, the workflow state blob records the version of the currently registered handler.
2. **On resume, versions are compared.** If they match and the version tuple has not drifted: resume normally. If they differ: throw `VersionMismatchError`.
3. **Checkpoint shape remains the operator's responsibility.** The new code must understand the stored checkpoint at the paused step.
4. **Incompatible checkpoint = clear error.** Version and tuple mismatches fail with `VersionMismatchError` that includes both versions and the workflow ID.

#### Why Simpler Than Temporal

In Temporal, version changes require `workflow.getVersion()` / `patched()` because replay must follow the exact same code path as the original execution. Every branching point needs a version gate. In Weft:

- No replay means no code-path determinism requirement.
- The checkpoint captures the complete state at the pause point.
- Recovery starts from the checkpoint instead of replaying the full event history.
- Developers think about "can my new code resume this checkpoint under the same recorded version tuple?" rather than "is my new code deterministically compatible with the old event history?"

#### Usage Examples

```typescript
// Simple case: checkpoint shape did not change, just the logic after the current step.
engine.register('order', {
  version: '1.0.0',
  handler: orderWorkflowV2,
});

// Breaking case: V2 added a required `region` field.
engine.register('order', {
  version: '2.0.0',
  handler: orderWorkflowV2,
  // Running v1 checkpoints stop with VersionMismatchError until resolved.
});
```

### 14. Workflow-Level Timeouts

Activity timeouts exist but there is no mechanism to cap the total wall-clock time of an entire workflow execution. This is critical for SLA enforcement, runaway workflow detection, and resource budgeting.

#### API

```typescript
const handle = await engine.start('order', orderData, {
  executionTimeout: '24 hours',
});

try {
  const result = await handle.result();
} catch (error) {
  if (error instanceof WorkflowTimeoutError) {
    console.log(`Workflow timed out: ${error.timeoutType}`); // "execution" or "run"
  }
}
```

**Context access for runtime decisions:**

```typescript
interface Context {
  /** AbortSignal that fires when the workflow's timeout expires or cancel() is called. */
  readonly signal: AbortSignal;
  /** Remaining time before the execution timeout fires (milliseconds). */
  readonly executionTimeRemaining: number;
}

async function* orderWorkflow(ctx: Context, order: Order) {
  const payment = yield* ctx.run(charge, order);

  // Check if we have enough time for the slow path
  if (ctx.executionTimeRemaining > 60_000) {
    yield* ctx.run(enrichOrderData, order);
  }

  yield* ctx.run(ship, { order, payment });
  return { payment, shipped: true };
}
```

#### Mechanism

1. **Deadline stored in `wf:{id}` and indexed at `wf-deadline:{deadline}:{workflowId}`.** The scheduler scans deadline keys sorted by timestamp — only needs to check up to `Date.now()`.
2. **Timeout fires mid-activity.** The scheduler fires the workflow's `AbortController`, which cascades to all in-flight activities via the existing `AbortSignal.any()` compound cancellation pattern. The workflow is marked as `"timed-out"` and a `WorkflowTimedOutEvent` is dispatched.
3. **Cleanup.** Deadline keys are deleted when a workflow reaches any terminal state.

The `ctx.signal` property exposes the combined timeout + cancellation signal. Activities that already accept `{ signal }` automatically respect workflow timeouts with no code changes.

### 15. Search Attributes (Advanced Visibility)

Search attributes let workflows set custom indexed metadata that's queryable from the list API. The design uses KV-based secondary indexes that work identically on SQLite, LMDB, and IndexedDB — no SQL required.

#### Context API

```typescript
interface Context {
  /** Set a single search attribute. Persisted at next checkpoint boundary. */
  setAttribute(key: string, value: SearchAttributeValue): void;
  /** Set multiple attributes. Merge semantics: unmentioned keys are preserved. */
  setAttributes(attributes: SearchAttributes): void;
  /** Read the current value of an attribute. */
  getAttribute<T extends SearchAttributeValue = SearchAttributeValue>(key: string): T | undefined;
  /** Read all attributes. */
  getAttributes(): Readonly<SearchAttributes>;
}

type AttributeValue = string | number | boolean | Date;
type SearchAttributeValue = AttributeValue | string[]; // string[] for multi-value tags

type SearchAttributeDefinition =
  | { type: 'string'; format?: 'date-time' }
  | { type: 'number' | 'integer' | 'boolean' }
  | { type: 'array'; items: { type: 'string' } };
```

`setAttribute` and `setAttributes` are **synchronous in-workflow calls** — they do not yield. Persistence happens at the next checkpoint boundary, batched with the checkpoint write. This keeps the hot path to a single `batch()` operation.

#### Schema at Registration

```typescript
engine.register('order', orderWorkflow, {
  searchAttributes: {
    customerId: { type: 'string' },
    orderTotal: { type: 'number' },
    region: { type: 'string' },
    priority: { type: 'number' },
    tags: { type: 'array', items: { type: 'string' } },
  },
});
```

Unknown attribute keys are rejected at set time. This prevents typos and enforces a discoverable schema.

#### Usage

```typescript
async function* orderWorkflow(ctx: Context, order: Order) {
  ctx.setAttributes({
    customerId: order.customerId,
    region: order.region,
    orderTotal: order.total,
    tags: ['new', 'needs-review'],
  });

  const payment = yield* ctx.run(charge, order);

  ctx.setAttribute('tags', ['charged', 'processing']);
  ctx.setAttribute('paymentId', payment.id);

  const shipment = yield* ctx.run(ship, { order, payment });

  ctx.setAttribute('tags', ['completed', 'shipped']);
  ctx.setAttribute('trackingNumber', shipment.tracking);

  return { payment, shipment };
}
```

**Querying:**

```typescript
// Find all workflows for a specific customer
const result = await engine.list({
  attributes: [{ key: 'customerId', value: 'cust-123' }],
});

// Find high-priority orders in a specific region
const result = await engine.list({
  type: 'order',
  attributes: [
    { key: 'region', value: 'us-east' },
    { key: 'priority', gte: 8 },
  ],
});
```

**HTTP API:**

```
GET /api/v1/workflows?attr.customerId=cust-123
GET /api/v1/workflows?attr.region=us-east&attr.priority.gte=8
GET /api/v1/workflows?attr.orderTotal.gte=100&attr.orderTotal.lte=500
```

#### Index Mechanism

**Forward map:** `attr:{workflow_id}` stores all attributes for a workflow as a single blob.

**Inverted index:** `idx:{attr_name}:{encoded_value}:{workflow_id}` — one entry per attribute value per workflow. A range scan on `idx:region:s:us-east:` returns all matching workflow IDs.

**Sortable value encoding:** Index keys must sort correctly as strings so range scans produce correct results:

```typescript
function encodeAttributeValue(value: AttributeValue): string {
  if (typeof value === 'string') return `s:${value}`;
  if (typeof value === 'number') {
    // IEEE 754 float-to-sortable-string: ensures -1 < 0 < 1 < 100 lexicographically
    const buffer = new ArrayBuffer(8);
    new DataView(buffer).setFloat64(0, value);
    const bytes = new Uint8Array(buffer);
    if (value >= 0) bytes[0] ^= 0x80;
    else for (let i = 0; i < 8; i++) bytes[i] ^= 0xff;
    return `n:${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
  if (typeof value === 'boolean') return `b:${value ? '1' : '0'}`;
  if (value instanceof Date) return `d:${value.toISOString()}`;
  throw new Error(`Unsupported attribute value type: ${typeof value}`);
}
```

**String-array attributes:** Each element gets its own index entry. Setting `tags: ["charged", "processing"]` creates `idx:tags:s:charged:{id}` and `idx:tags:s:processing:{id}`.

**Atomic updates at checkpoint boundary:** The engine diffs previous vs current attributes, computing add/delete index operations, and writes everything in the same `batch()` call as the checkpoint. No partial index states.

**External mutation:** `handle.setAttributes()` and `PATCH /api/v1/workflows/:id/attributes` allow setting attributes from outside the workflow. Index updates happen atomically.

### 16. Synchronous Updates

Signals are fire-and-forget — the caller sends a message and doesn't wait for the workflow to process it. Updates are **request-response** — the caller blocks until the workflow processes the message and returns a result.

Use case: "Validate this coupon code against the current cart state before accepting it." The caller needs the workflow to inspect its internal state and respond with a yes/no.

#### Two Patterns

**Callback-style (`ctx.onUpdate`):** Register a handler that runs at any checkpoint boundary whenever an update of that name arrives. The handler is a plain function (not a generator) — it cannot yield. It can read/modify workflow state via closure over local variables.

```typescript
async function* cartWorkflow(ctx: Context, cart: Cart) {
  let appliedCoupons: string[] = [];
  let cartTotal = cart.total;

  ctx.onUpdate('validate_coupon', (payload: { code: string }) => {
    if (appliedCoupons.includes(payload.code)) {
      return { valid: false, reason: 'Coupon already applied' };
    }
    const discount = lookupCoupon(payload.code, cartTotal);
    if (!discount) {
      return { valid: false, reason: 'Invalid coupon code' };
    }
    appliedCoupons.push(payload.code);
    cartTotal -= discount.amount;
    return { valid: true, discount: discount.amount, newTotal: cartTotal };
  });

  ctx.onUpdate('get_cart_state', () => ({
    total: cartTotal,
    appliedCoupons,
    itemCount: cart.items.length,
  }));

  yield* ctx.waitForSignal('checkout');
  const payment = yield* ctx.run(charge, { amount: cartTotal });
  return { payment, total: cartTotal };
}
```

**Yield-style (`ctx.waitForUpdate`):** Explicitly suspends the workflow until a specific update arrives. Returns `{ payload, respond }` where `respond()` sends the result back.

```typescript
async function* approvalWorkflow(ctx: Context, document: Document) {
  const prepared = yield* ctx.run(prepareForReview, document);

  const { payload, respond } = yield* ctx.waitForUpdate<ReviewDecision>('review_decision');

  if (payload.approved) {
    respond({ accepted: true, message: 'Document will be published.' });
    yield* ctx.run(publish, prepared);
  } else {
    respond({ accepted: true, message: 'Document returned for revision.' });
    yield* ctx.run(notifyAuthor, { document, feedback: payload.feedback });
  }
}
```

#### Caller API

```typescript
const handle = engine.getHandle('wf-cart-abc');
const validateCoupon = update<{ code: string }, ValidationResult>('validate_coupon');

// Blocks until the workflow processes the update and responds
const result = await handle.update(
  validateCoupon,
  { code: 'SAVE20' },
  {
    timeout: 5000, // 5 seconds max wait
  },
);

if (result.valid) {
  showToast(`Coupon applied! New total: $${result.newTotal}`);
} else {
  showError(result.reason);
}
```

#### Mechanism

1. **Caller writes update request** to `upd:{workflowId}:{updateId}`.
2. **Engine detects pending updates** at the checkpoint boundary (same phase as pending signals). For `onUpdate` handlers: runs the handler, collects the result. For `waitForUpdate`: resumes the generator with `{ payload, respond }`.
3. **Response written atomically** with the checkpoint: `batch([delete upd:..., put upr:..., put wf:...:ckpt])`.
4. **Caller notified** via `BroadcastChannel` (`update:completed` message). The caller's `Promise.withResolvers` resolves without polling.
5. **Timeout handling.** The caller races against `AbortSignal.timeout()`. On timeout: `UpdateTimeoutError` with the `updateId`. The update is still pending — the caller can poll `GET /api/v1/updates/:updateId` later to retrieve the eventual response.
6. **Durability.** If the server crashes between receiving the request and delivering the response, the update request is already in storage. After recovery, the workflow processes it and writes the response. The caller retrieves via the poll endpoint.

**Idempotency:** An optional `idempotencyKey` maps to the `updateId` via `upk:{workflowId}:{key}`. Duplicate requests return the existing response.

**Response cleanup:** `upr:*` entries are deleted after a configurable TTL (default 5 minutes) to prevent unbounded storage growth.

### 17. Interceptors / Middleware

Interceptors are composable hooks that wrap workflow context operations for cross-cutting concerns. They are the foundation for observability (section 18), and can be used independently for validation, encryption, auth propagation, and more.

#### Design Principles

1. **Interceptors wrap context operations, not the generator itself.** Each `ctx.run()`, `ctx.sleep()`, etc. passes through a chain of interceptors. Workflow code is never modified.
2. **Interceptors compose via `next()` delegation.** Like Koa middleware. Each interceptor can modify inputs, modify outputs, handle errors, or skip `next()` entirely.
3. **Registered on the Engine.** Not on individual workflows.
4. **Two categories:** Workflow interceptors (wrap ctx operations in the workflow Worker) and activity interceptors (wrap activity execution in the activity Worker).

#### Interfaces

```typescript
// ─── Workflow Interceptor ───
interface WorkflowInterceptor {
  activity?<TInput, TOutput>(
    input: ActivityInterception<TInput>,
    next: (input: ActivityInterception<TInput>) => Generator<unknown, TOutput>,
  ): Generator<unknown, TOutput>;

  sleep?(
    input: SleepInterception,
    next: (input: SleepInterception) => Generator<unknown, void>,
  ): Generator<unknown, void>;

  waitForSignal?(
    input: SignalInterception,
    next: (input: SignalInterception) => Generator<unknown, unknown>,
  ): Generator<unknown, unknown>;

  workflowStart?(
    input: WorkflowStartInterception,
    next: (input: WorkflowStartInterception) => Generator<unknown, unknown>,
  ): Generator<unknown, unknown>;

  signalReceived?(
    input: SignalReceivedInterception,
    next: (input: SignalReceivedInterception) => void,
  ): void;

  query?(input: QueryInterception, next: (input: QueryInterception) => unknown): unknown;
}

// ─── Activity Interceptor ───
interface ActivityInterceptor {
  execute?<TInput, TOutput>(
    input: ActivityExecutionInterception<TInput>,
    next: (input: ActivityExecutionInterception<TInput>) => Promise<TOutput>,
  ): Promise<TOutput>;
}
```

All hooks are optional. Workflow interceptor hooks return generators (preserving `yield*` checkpoint semantics). Activity interceptor hooks return Promises (matching async activity execution).

#### Interception Context Types

```typescript
interface ActivityInterception<TInput = unknown> {
  readonly workflowId: string;
  readonly workflowType: string;
  readonly activityName: string;
  readonly operationId: string;
  readonly attempt: number;
  readonly queue: string;
  input: TInput; // mutable: interceptors can transform input
  headers: Map<string, string>; // propagated metadata (trace context, auth tokens, etc.)
}

interface SleepInterception {
  readonly workflowId: string;
  readonly workflowType: string;
  duration: string | number; // mutable
}

interface WorkflowStartInterception {
  readonly workflowId: string;
  readonly workflowType: string;
  input: unknown; // mutable
  headers: Map<string, string>;
}

interface ActivityExecutionInterception<TInput = unknown> {
  readonly activityName: string;
  readonly operationId: string;
  readonly attempt: number;
  readonly signal: AbortSignal;
  input: TInput;
  headers: Map<string, string>; // received from workflow-side propagation
}
```

#### The `headers` Map: Cross-Boundary Metadata Propagation

The `headers` field is a `Map<string, string>` that travels with each operation across thread and network boundaries:

- Workflow interceptor sets headers on `ActivityInterception` before calling `next()`.
- Engine serializes headers into `postMessage` (local Workers) or the WebSocket `task` message (remote Workers).
- Activity interceptor reads headers from `ActivityExecutionInterception`.

This is how trace context (W3C `traceparent`/`tracestate`), auth tokens, and encryption keys propagate — without special-casing any of them.

#### Composition

Interceptors chain in registration order (first registered = outermost):

```typescript
function composeActivityHooks(
  interceptors: WorkflowInterceptor[],
  final: (input: ActivityInterception) => Generator<unknown, unknown>,
): (input: ActivityInterception) => Generator<unknown, unknown> {
  let chain = final;
  for (let i = interceptors.length - 1; i >= 0; i--) {
    const interceptor = interceptors[i];
    if (!interceptor.activity) continue;
    const next = chain;
    chain = (input) => interceptor.activity!(input, next);
  }
  return chain;
}
```

The chain is constructed once per engine, not per operation. Zero overhead when no interceptors are registered.

#### Code Examples

**Input validation interceptor:**

```typescript
import { z, type ZodSchema } from 'zod';

function validationInterceptor(schemas: Record<string, ZodSchema>): WorkflowInterceptor {
  return {
    *activity(input, next) {
      const schema = schemas[input.activityName];
      if (schema) input.input = schema.parse(input.input);
      return yield* next(input);
    },
  };
}

engine.addInterceptor(
  validationInterceptor({
    charge: z.object({ amount: z.number().positive(), currency: z.string().length(3) }),
  }),
);
```

**Encryption interceptor:**

```typescript
function encryptionInterceptor(
  encrypt: (data: unknown) => unknown,
  decrypt: (data: unknown) => unknown,
): WorkflowInterceptor {
  return {
    *activity(input, next) {
      input.input = encrypt(input.input);
      const result = yield* next(input);
      return decrypt(result);
    },
  };
}
```

#### Interceptors vs EventTarget

These systems are complementary:

- **EventTarget** is for _observation_. Listeners receive events after things happen. They cannot modify inputs, outputs, or control flow.
- **Interceptors** are for _interception_. They wrap execution, can modify inputs/outputs, can skip or retry operations, and participate in the control flow.

### 18. Observability (OpenTelemetry Integration)

Observability is implemented as a pre-built interceptor pair. It uses standard OpenTelemetry APIs (`@opentelemetry/api`) and propagates context through the interceptor `headers` mechanism.

#### Design Principles

1. **Uses `@opentelemetry/api` directly.** No custom tracing layer. The API package is a lightweight no-op unless an SDK is configured — zero overhead if you don't enable tracing.
2. **Opt-in, not built-in.** Import from `@lostgradient/weft/observability`. If you don't import it, no OpenTelemetry code is loaded.
3. **Auto-created spans** for all context operations.
4. **W3C Trace Context propagation** via the interceptor `headers` Map.

#### API

```typescript
import { createObservabilityInterceptors } from '@lostgradient/weft/observability';

interface ObservabilityOptions {
  tracerName?: string; // Defaults to "weft"
  tracerVersion?: string;
  recordPayloads?: boolean; // Record activity inputs/outputs as span attributes. Off by default.
  maxPayloadSize?: number; // Truncate recorded payloads. Default: 1024 bytes.
  attributeExtractor?: (
    interception: WorkflowStartInterception | ActivityInterception,
  ) => Record<string, string | number | boolean>;
}

function createObservabilityInterceptors(options?: ObservabilityOptions): {
  workflow: WorkflowInterceptor;
  activity: ActivityInterceptor;
};
```

#### Usage

```typescript
const { workflow, activity } = createObservabilityInterceptors();

const engine = new Engine({ storage: new BunSQLiteStorage('./weft.db') });
engine.addInterceptor(workflow);
engine.addActivityInterceptor(activity);

// Remote workers get the activity interceptor
const worker = new Worker({
  serverUrl: 'ws://weft-server:7233/api/v1/tasks/default/stream',
  activities: { charge, ship },
  interceptors: [activity],
});
```

#### Span Hierarchy

Each workflow execution creates a root span. Context operations create child spans:

```
workflow:order (root span)
├── activity:charge (child span)
│   └── activity:execute:charge (child span, on the worker side)
│       └── fetch POST api.stripe.com (child span, from user code)
├── sleep (child span)
├── signal:wait:approval (child span)
└── activity:ship (child span)
    └── activity:execute:ship (child span, on the worker side)
```

Child workflows use **span links** (not parent-child) because they have independent lifecycle and can outlive their parent.

#### Trace Context Flow

**Local Workers:** The workflow interceptor injects `traceparent`/`tracestate` into the `headers` Map. These travel via `postMessage` to the activity Worker. The activity interceptor extracts the context and creates a child span.

**Remote Workers:** Same mechanism, but headers travel via the WebSocket `task` message's `headers` field.

```
Workflow Worker                         Activity Worker
───────────────                         ───────────────
creates span A                          extracts traceparent from headers
injects traceparent into headers        creates span B (child of A)
yields ctx.run(...)                     executes activity function
   ──── postMessage/WebSocket ────►     any fetch() calls → child spans of B
   (includes headers map)
   ◄── result ────
span A ends                             span B ends
```

#### Structured Logging

The interceptor sets span attributes (`weft.workflow.id`, `weft.workflow.type`, `weft.activity.name`, `weft.activity.operation_id`, `weft.activity.attempt`) that any OpenTelemetry-aware logger can read. No separate logging integration needed — if your logger reads OTel context, it automatically gets correlation IDs.

#### Metrics

```typescript
import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('weft');

const workflowDuration = meter.createHistogram('weft.workflow.duration', { unit: 'ms' });
const activityDuration = meter.createHistogram('weft.activity.duration', { unit: 'ms' });
const activityAttempts = meter.createCounter('weft.activity.attempts');
const activeWorkflows = meter.createUpDownCounter('weft.workflow.active');
```

These OTel metrics can be exported to Prometheus via `@opentelemetry/exporter-prometheus`, replacing the hand-rolled `/v1/metrics` endpoint with a standards-based approach.

#### Composing with Other Interceptors

```typescript
engine.addInterceptor(authInterceptor); // 1. Check auth
engine.addInterceptor(validationInterceptor); // 2. Validate inputs
engine.addInterceptor(observabilityWorkflow); // 3. Trace the validated, authorized call
engine.addInterceptor(encryptionInterceptor); // 4. Encrypt before sending to worker
```

---

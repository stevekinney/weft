# Synchronous Updates

Signals are great for fire-and-forget messages, but sometimes you need an answer. "Is this coupon valid against the current cart?" "What's the approval status right now?" You need the workflow to inspect its internal state, compute a response, and send it back before you continue. That's what updates do.

## Updates vs signals

**Signals** are one-way: the caller sends a payload and moves on. The workflow processes it eventually, but the caller never hears back directly.

**Updates** are request-response: the caller blocks until the workflow processes the message and returns a result. Think of it as an RPC call into a running workflow.

Use signals when you're pushing data in (e.g., "here's the customer's new address"). Use updates when you need data out (e.g., "validate this coupon against the current cart total").

## Registering an update handler

The callback-style pattern uses `ctx.onUpdate()` to register a handler that runs at any checkpoint boundary when an update of that name arrives. The handler is a plain function—not a generator—so it cannot yield. It reads and modifies workflow state through closure over local variables.

```typescript partial
async function* cartWorkflow(ctx: Context, cart: Cart) {
  let appliedCoupons: string[] = [];
  let cartTotal = cart.total;

  ctx.onUpdate('validate_coupon', (payload: unknown) => {
    const { code } = payload as { code: string };
    if (appliedCoupons.includes(code)) {
      return { valid: false, reason: 'Coupon already applied' };
    }
    const discount = lookupCoupon(code, cartTotal);
    if (!discount) {
      return { valid: false, reason: 'Invalid coupon code' };
    }
    appliedCoupons.push(code);
    cartTotal -= discount.amount;
    return { valid: true, discount: discount.amount, newTotal: cartTotal };
  });

  ctx.onUpdate('get_cart_state', () => ({
    total: cartTotal,
    appliedCoupons,
    itemCount: cart.items.length,
  }));

  yield* ctx.waitForSignal('checkout');
  const payment = yield* ctx.run('charge', { amount: cartTotal });
  return { payment, total: cartTotal };
}
```

You can register multiple update handlers. Each one handles a different update name. The handler's return value becomes the response sent back to the caller.

## Calling an update

From the caller side, use `handle.update()` on a workflow handle. It returns a promise that resolves when the workflow processes the update and responds.

```typescript partial
const handle = engine.getHandle('wf-cart-abc');
const validateCoupon = update<
  { code: string },
  { valid: boolean; newTotal?: number; reason?: string }
>('validate_coupon');

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

The `timeout` option defaults to 30 seconds. If the workflow doesn't respond in time, you get an `UpdateTimeoutError`.

The HTTP API offers the same capability:

```
POST /api/v1/workflows/:id/update/:name
{
  "payload": { "code": "SAVE20" },
  "timeout": 5000
}
```

## The UpdateCoordinator

Behind the scenes, the `UpdateCoordinator` class manages the full lifecycle. When you call `handle.update()`:

`handle.update()` takes one of two paths depending on context:

**Inline fast path** (when an inline execution context is active): the handler is invoked directly without any storage round-trip. The `UpdateReceivedEvent` and `UpdateCompletedEvent` are still dispatched, but no persistence occurs.

**Coordinated path** (used by HTTP/RPC and worker-execution mode): the numbered steps below apply.

1. The coordinator writes an update request to storage at `upd:{workflowId}:{updateId}`.
2. The engine detects pending updates at the next checkpoint boundary and runs the registered handler.
3. The response is written atomically with the checkpoint: the request is deleted, the response is stored at `upr:{updateId}`, and the checkpoint is updated—all in one `batch()` call.
4. The caller's promise resolves with the response.

If the server crashes between receiving the request and delivering the response, the update request is already persisted. After recovery, the workflow processes it and writes the response. The caller can poll `GET /api/v1/updates/:updateId` to retrieve it.

## Idempotency

For coordinated updates, an optional `idempotencyKey` prevents duplicate processing. If you send the same update twice with the same key, the second call returns the existing response without re-running the handler. The in-process handle path does not accept an idempotency key:

```typescript partial
const result = await handle.update(
  validateCoupon,
  { code: 'SAVE20' },
  {
    timeout: 5000,
  },
);
```

`handle.update()` accepts only `{ timeout }`—it is the in-process fast path and intentionally does not expose idempotency. For cross-process retries with idempotency guarantees, use `engine.submitCoordinatedUpdate()` directly or the HTTP path (`POST /api/v1/workflows/:id/update/:name` with an `idempotencyKey` field).

The mapping from idempotency key to update ID is stored at `upk:{workflowId}:{key}`.

## Timeout handling

When an update times out, the `UpdateTimeoutError` includes the `updateId`. The update is still pending in storage—the workflow will eventually process it. You can check the result later:

```typescript partial
try {
  const result = await handle.update(validateCoupon, payload, { timeout: 2000 });
} catch (error) {
  if (error instanceof UpdateTimeoutError) {
    // The update is still pending—check back later
    console.log(`Timed out. Update ID: ${error.updateId}`);
  }
}
```

Response entries are cleaned up automatically after a configurable TTL (default 24 hours) via `UpdateCoordinator.cleanupExpiredResponses()`.

## When to reach for updates

Updates shine when external code needs to _query_ workflow state or _validate_ something against it before proceeding. Cart validation, approval status checks, configuration queries—any case where the caller needs a synchronous response from the workflow's current perspective.

If you're just pushing data in and don't need a response, stick with [signals](./signals-and-queries.md). If you need to run a long-running operation triggered by external input, send a signal and use [search attributes](./search-attributes.md) to track progress.

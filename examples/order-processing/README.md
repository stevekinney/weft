# Order Processing Reference Example

This example is the next stop after Hello World. It keeps one concrete domain in view: an order is placed, inventory is reserved across warehouses, payment is charged, expensive orders wait for review, and shipment runs as a child workflow.

## Run It

Build the workspace package once so the example resolves the same package exports a published
consumer would use:

```bash
cd ../..
bun install
bun run build
```

Then run the example from this directory:

```bash
cd examples/order-processing
bun install
bun run verify
```

Start the local headless server:

```bash
bun run server
```

The REST API is available under `http://localhost:7321/api/v1/`; use `/v1/health`
as the root-stable health probe, and add an external dashboard or HTTP client when you want a
browser-facing operator surface.

The server stores state in `./order-processing.sqlite` by default. Set `WEFT_DATABASE_PATH` when
you want both terminals to use a different SQLite file.

Run the small client in another terminal. The client is intentionally local: it creates its own
`Engine` instance against the same SQLite file instead of calling the server over HTTP, so the
example stays focused on workflow APIs before introducing a network client.

```bash
bun run client place
bun run client approve
bun run client cancel
bun run client list
```

You can also boot the same server with Docker Compose:

```bash
docker compose up
```

## What This Exercises

The main workflow lives in `src/workflows/order.ts`.

- Activities: `reserveInventory`, `chargePayment`, `releaseInventory`, `refundPayment`, and `shipOrder` are public `activity()` definitions with retry and timeout settings.
- Parallel fan-out: inventory reservation groups items by warehouse and dispatches one durable reservation per warehouse through `ctx.all(...)`.
- Updates: `addItemUpdate` mutates an open order and returns the new item count and total.
- Queries: `orderStatusQuery` is registered as the read-only order status accessor.
- Search attributes: workflows index `customerId`, `orderStatus`, and `totalAmount`, and the tests prove `engine.list({ attributes: [...] })` finds pending review orders.
- Human review: orders above `highValueReviewThreshold` pause at `ctx.review(...)` until `engine.submitReview(...)` approves or rejects them.
- Signals: `cancelOrderSignal` cancels standard orders before shipment and drives the compensation path.
- Child workflows: approved high-value orders start `orderProcessingShipment` as a child workflow and pipe its tracking number back to the parent.
- Schedules: `orderProcessingSchedule` wires `orderProcessingSweepStaleOrders` as the recurring stale-order sweep.

The tests use `TestEngine` from `@lostgradient/weft/testing`; the runnable server uses `SQLiteStorage` from `@lostgradient/weft/storage/sqlite` and `serve()` from `@lostgradient/weft/server`. The imports are intentionally package-shaped so the files are copyable into an application.

## Why Each Message Type Exists

Use an update when the caller needs a response from the workflow. `addItemUpdate` validates whether the order is still open and returns the new total immediately.

Use a query when the caller needs a read-only view. `orderStatusQuery` exposes the current order state without changing workflow progress.

Use a signal when the caller wants to tell the workflow something happened and does not need a response. `cancelOrderSignal` persists a cancellation request and lets the workflow cleanly refund payment and release inventory.

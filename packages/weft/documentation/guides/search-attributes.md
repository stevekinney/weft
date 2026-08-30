# Search Attributes

Your workflows are running, but you can't find the one you need. Filtering by status or type only gets you so far—what you really want is to query workflows by _your_ domain data. "Show me all orders over $500 in the us-east region that are still processing." Search attributes make that possible.

## Declaring a schema

Search attributes are declared at registration time. This prevents typos and gives the engine enough type information to build correct indexes.

```typescript partial
const customerId = searchAttribute('customerId', 'string');
const orderTotal = searchAttribute('orderTotal', 'number');
const region = searchAttribute('region', 'string');
const priority = searchAttribute('priority', 'number');
const tags = searchAttribute('tags', { type: 'array', items: { type: 'string' } });

engine.register(
  workflow({ name: 'order' })
    .searchAttributes({
      customerId,
      orderTotal,
      region,
      priority,
      tags,
    })
    .execute(orderWorkflow),
);
```

The helper accepts primitive JSON Schema type names such as `string`, `number`, and `boolean`, plus JSON Schema fragments. Use `{ type: 'string', format: 'date-time' }` for dates and `{ type: 'array', items: { type: 'string' } }` for string arrays.

The TypeScript type backing these values is `SearchAttributeValue`:

```typescript partial
type SearchAttributeValue = string | number | boolean | Date | string[];
```

## Setting attributes inside a workflow

`ctx.setAttribute()` and `ctx.setAttributes()` are synchronous calls—they don't yield. You call them anywhere in your workflow, and the values are persisted at the next checkpoint boundary, batched with the checkpoint write. No extra I/O.

```typescript partial
async function* orderWorkflow(ctx: Context, order: Order) {
  ctx.setAttributes({
    [customerId.name]: order.customerId,
    [region.name]: order.region,
    [orderTotal.name]: order.total,
    [tags.name]: ['new', 'needs-review'],
  });

  const payment = yield* ctx.run('charge', order);

  ctx.setAttribute(tags, ['charged', 'processing']);
  ctx.setAttribute('paymentId', payment.id);

  const shipment = yield* ctx.run('ship', { order, payment });

  ctx.setAttribute(tags, ['completed', 'shipped']);
  ctx.setAttribute('trackingNumber', shipment.tracking);

  return { payment, shipment };
}
```

Notice how `setAttributes()` does a bulk set while `setAttribute()` sets a single key. Unmentioned keys are preserved—these are merge semantics, not replace.

## Reading attributes

You can read attribute values within the workflow using `ctx.getAttribute()` and `ctx.getAttributes()`:

```typescript partial
const currentRegion = ctx.getAttribute(region);
const allAttributes = ctx.getAttributes(); // Readonly snapshot
```

The generic parameter on `getAttribute` gives you type narrowing without a cast.

## Querying with `engine.list()`

The real payoff comes when you query. The `engine.list()` method accepts an `attributes` filter array with support for exact matches and range queries.

```typescript partial
// Find all workflows for a specific customer
const result = await engine.list({
  attributes: [{ key: customerId, value: 'cust-123' }],
});

// Find high-priority orders in a specific region
const result = await engine.list({
  type: 'order',
  attributes: [
    { key: region, value: 'us-east' },
    { key: priority, gte: 8 },
  ],
});

// Range query on order totals
const result = await engine.list({
  attributes: [
    { key: orderTotal, gte: 100 },
    { key: orderTotal, lte: 500 },
  ],
});
```

The `AttributeFilter` type supports `value` for exact match, plus `gt` (strict greater-than), `gte` (greater-than-or-equal), `lt` (strict less-than), and `lte` (less-than-or-equal) for range queries. Combine multiple filters for AND logic.

The [server](./server.md) exposes these same queries over HTTP:

```
GET /api/v1/workflows?attr.customerId=cust-123
GET /api/v1/workflows?attr.region=us-east&attr.priority.gte=8
GET /api/v1/workflows?attr.orderTotal.gte=100&attr.orderTotal.lte=500
```

## How the index works

Under the hood, Weft maintains two data structures per workflow's attributes:

A **forward map** at `attr:{workflow_id}` stores all attributes for a workflow as a single blob. This is what `ctx.getAttributes()` reads.

An **inverted index** at `idx:{attr_name}:{encoded_value}:{workflow_id}` enables queries. One entry per attribute value per workflow. A range scan on `idx:region:s:us-east:` returns all matching workflow IDs.

Values are encoded into sortable strings so range scans produce correct results across all types. Strings get an `s:` prefix, booleans get `b:0` or `b:1`, dates use ISO 8601 with a `d:` prefix, and numbers use an IEEE 754 float-to-sortable-hex encoding that preserves numeric ordering in lexicographic comparisons. (Yes, `-1` sorts before `0` sorts before `100`—the `encodeAttributeValue` function handles the bit manipulation.)

For string-array attributes, each element gets its own index entry. Setting `tags: ['charged', 'processing']` creates two index keys.

All index updates happen atomically at the checkpoint boundary. The engine diffs previous vs current attributes using `buildIndexOperations()`, computes the minimal set of add/delete operations, and writes everything in a single `batch()` call alongside the checkpoint. No partial index states, ever.

## External mutation

Attributes can also be set from _outside_ the workflow via `handle.setAttributes()` or `PATCH /api/v1/workflows/:id/attributes`. Index updates happen atomically in this case too. This is useful for administrative tagging—marking a workflow as "escalated" or "under review" without sending a signal.

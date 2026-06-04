# Testing

Durable workflows are inherently hard to test. They span time—sleeps, retries, timeouts—and depend on external services. You don't want your test suite waiting 30 real seconds for a timer to fire or hitting a real payment API. Weft's testing module gives you deterministic time control, activity mocking, and crash-recovery simulation.

> [!NOTE]
> [`TestEngine`](../reference/api-testing.md#testengine) is candidate-stable and provisional. It is the supported test harness for workflow behavior, virtual time, activity mocks, and restart simulation; compatibility is still subject to the Tier-0 contract before 1.0.

## TestEngine

`TestEngine` is a subclass of `Engine` backed by in-memory storage and a virtual clock. Everything behaves like the real engine, but you control time and can mock activities.

```typescript partial
import { workflow } from '@lostgradient/weft';
import { TestEngine } from '@lostgradient/weft/testing';

const engine = new TestEngine();

engine.register(workflow({ name: 'order' }).execute(orderWorkflow));

const handle = await engine.start('order', { items: ['widget'], total: 99 });
```

The constructor accepts an optional `startTime` (milliseconds since epoch) for the virtual clock. If omitted, it uses the real `Date.now()` at construction time.

```typescript partial
const engine = new TestEngine({ startTime: 1700000000000 });
```

## Advancing time

The killer feature. `advanceTime()` moves the virtual clock forward, firing any timers—both `TimeControl` timers and the engine's durable scheduler timers—that fall within the window.

```typescript partial
// Workflow sleeps for 1 hour
engine.register(
  workflow({ name: 'delayed' }).execute(async function* (ctx) {
    yield* ctx.sleep('1 hour');
    return 'done';
  }),
);

const handle = await engine.start('delayed', null);

// Jump forward—no real waiting
await engine.advanceTime('1 hour');

const result = await handle.result();
expect(result).toBe('done');
```

`advanceTime()` accepts any `Duration`—a number in milliseconds or a string like `'5m'`, `'2 hours'`, `'30s'`. After advancing, it ticks the scheduler and allows microtasks to settle.

Check the current virtual time with `engine.now`:

```typescript partial
console.log(engine.now); // milliseconds since epoch
```

## TimeControl

Under the hood, `TestEngine` uses a `TimeControl` instance. Use it directly only when you need a virtual clock without an engine attached—see [`TimeControl` in api-testing](../reference/api-testing.md#timecontrol).

## Mocking activities

`TestEngine.mock()` registers a fake implementation for an activity function. When the engine encounters that activity during workflow execution, it calls your mock instead.

```typescript partial
async function charge(order: Order): Promise<PaymentResult> {
  // Real implementation hits Stripe
}

const mockCharge = engine.mock(charge, (order) => ({
  id: 'pay_test_123',
  amount: order.total,
  status: 'succeeded',
}));
```

The mock is type-safe—the implementation must match the original function's signature.

## MockHandle

`mock()` returns a `MockHandle`—the object you reach for when assertions need to inspect what the engine called, or when a single test needs different mock behavior across attempts.

| Method or property           | Summary                                                         |
| ---------------------------- | --------------------------------------------------------------- |
| `calls`                      | Read-only array of every recorded call                          |
| `callCount`                  | Total number of times the mock was invoked                      |
| `lastCall`                   | The most recent call record, or `undefined`                     |
| `currentImplementation`      | The base implementation in effect after one-shots are exhausted |
| `mockImplementation(fn)`     | Replace the base implementation                                 |
| `mockReturnValueOnce(value)` | Queue a one-shot return value (chainable)                       |
| `mockRejectionOnce(error)`   | Queue a one-shot rejection (chainable)                          |
| `resetCalls()`               | Clear call history without touching implementations             |
| `restore()`                  | Remove the mock entirely                                        |

```typescript partial
const mockShip = engine.mock(ship, () => ({ tracking: 'TRACK-001' }));

mockShip
  .mockRejectionOnce(new Error('Carrier unavailable'))
  .mockReturnValueOnce({ tracking: 'TRACK-RETRY' });

// After a workflow that calls `ship` twice (e.g. one retry on failure):
expect(mockShip.callCount).toBe(2);
expect(mockShip.lastCall?.result).toEqual({ tracking: 'TRACK-RETRY' });
```

One-shots are consumed in order; once exhausted, the base implementation runs. See [`MockHandle` in api-testing](../reference/api-testing.md#mockhandle) for the full type signature and `MockCall` record shape.

## Crash recovery simulation

`TestEngine.recover()` creates a new engine backed by a copy of the current engine's storage, simulating a process restart. The new engine sees all persisted state but has fresh in-memory structures.

```typescript partial
engine.register(
  workflow({ name: 'resilient' }).execute(async function* (ctx) {
    const step1 = yield* ctx.run(doFirstThing);

    // Simulate crash here
    // step1 is checkpointed, so recovery picks up after it

    const step2 = yield* ctx.run(doSecondThing, step1);
    return step2;
  }),
);

const handle = await engine.start('resilient', null);
// Wait for step1 to complete and checkpoint
await Bun.sleep(10);

// Simulate crash and recovery
const recovered = engine.recover();
recovered.register(workflow({ name: 'resilient' }).execute(resilientWorkflow));

// The workflow resumes from the checkpoint—step1 doesn't re-execute
```

The recovered engine has its own `TimeControl` initialized to the current engine's virtual time.

## Draining inline work between tests

Inline workflow tests can queue promise continuations or a deferred inline launch just before a test disposes its engine. If the next test shares the same JavaScript process, that leftover work can run against the wrong timer state. Use the portable event-loop helpers from `@lostgradient/weft/testing` instead of test-runner-specific timer APIs:

```typescript partial
import { afterEach } from 'bun:test';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';

afterEach(yieldToPortableEventLoop);
```

`yieldToPortableEventLoop()` yields one macrotask turn and then drains microtasks. If you only need queued promise continuations to settle, use `flushPortableMicrotasks()`.

## Test patterns with Bun's test runner

Here's a complete test combining everything:

```typescript partial
import { describe, expect, it } from 'bun:test';
import { workflow } from '@lostgradient/weft';
import { TestEngine } from '@lostgradient/weft/testing';

describe('order workflow', () => {
  it('processes an order end to end', async () => {
    const engine = new TestEngine();

    const mockCharge = engine.mock(charge, (order) => ({
      id: 'pay_123',
      amount: order.total,
    }));

    const mockShip = engine.mock(ship, () => ({
      tracking: 'TRACK-001',
    }));

    engine.register(workflow({ name: 'order' }).execute(orderWorkflow));

    const handle = await engine.start('order', {
      items: ['widget'],
      total: 42,
    });

    const result = await handle.result();

    expect(result.payment.id).toBe('pay_123');
    expect(result.shipment.tracking).toBe('TRACK-001');
    expect(mockCharge.callCount).toBe(1);
    expect(mockShip.callCount).toBe(1);
  });

  it('handles payment failure gracefully', async () => {
    const engine = new TestEngine();

    engine.mock(charge, () => {
      throw new Error('Card declined');
    });

    engine.register(workflow({ name: 'order' }).execute(orderWorkflow));
    const handle = await engine.start('order', { total: 100 });

    await expect(handle.result()).rejects.toThrow('Card declined');
  });
});
```

Direct storage access via `engine.storage` (a `MemoryStorage` instance) lets you inspect persisted state in assertions when you need to verify checkpoint contents or attribute values. On `TestEngine`, `engine.storage` is overridden to expose the underlying `MemoryStorage`; on the production `Engine` the storage property is internal. The mock registry is also accessible at `engine.mocks` if you need to manage mocks programmatically.

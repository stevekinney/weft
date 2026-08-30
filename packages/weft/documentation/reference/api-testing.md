# Testing API

Weft ships a purpose-built testing layer with deterministic time control and activity mocking. `TestEngine` extends `Engine` with a virtual clock and mock registry so tests can advance time precisely, substitute activity implementations, and assert against call history -- all without touching real infrastructure.

## `TestEngine`

```ts partial
class TestEngine extends Engine
```

### Constructor

```ts partial
new TestEngine(options?: { startTime?: number })
```

| Option      | Type     | Default      | Description                                      |
| ----------- | -------- | ------------ | ------------------------------------------------ |
| `startTime` | `number` | `Date.now()` | Initial virtual time in milliseconds since epoch |

Creates an engine backed by `MemoryStorage` and a `TimeControl` virtual clock. The engine's `getNow` function is wired to the virtual clock, so all timers and timestamps use virtual time.

```ts
import { TestEngine } from '@lostgradient/weft/testing';

const engine = new TestEngine({ startTime: 0 });
```

### `advanceTime()`

```ts partial
async advanceTime(duration: Duration): Promise<void>
```

Advance virtual time by the given duration. This fires any `TimeControl` timers and scheduler durable timers that fall within the advanced window, then allows microtasks to settle.

| Parameter  | Type       | Description                                                 |
| ---------- | ---------- | ----------------------------------------------------------- |
| `duration` | `Duration` | Milliseconds or a human-readable string like `'5m'`, `'1h'` |

```ts partial
await engine.advanceTime('30s');
await engine.advanceTime(60_000);
```

### `now` (getter)

```ts partial
get now(): number
```

Current virtual time in milliseconds since epoch.

### `mock()`

```ts partial
mock<TInput, TResult>(
  activity: (input: TInput) => Promise<TResult> | TResult,
  implementation: (input: TInput) => TResult | Promise<TResult>,
): MockHandle<TInput, TResult>
```

Register a mock implementation for an activity function. When the engine encounters this activity during workflow execution, it calls the mock instead. Returns a `MockHandle` for configuring behavior and inspecting calls.

| Parameter        | Type       | Description                            |
| ---------------- | ---------- | -------------------------------------- |
| `activity`       | `Function` | The original activity function to mock |
| `implementation` | `Function` | The mock implementation to use instead |

```ts partial
const handle = engine.mock(sendEmail, async (input) => {
  return { messageId: 'mock-123' };
});
```

### `recover()`

```ts partial
recover(): TestEngine
```

Create a new `TestEngine` backed by a copy of the current storage, simulating an engine restart. The new engine sees all persisted state but has fresh in-memory structures (no active generators, resolvers, etc.). Useful for testing workflow recovery after process restarts. You must re-register workflow handlers on the recovered engine — only persisted state survives the simulated restart.

```ts partial
const recovered = engine.recover();
// recovered engine has the same storage data but no running workflows
// Re-register handlers before starting new workflows on the recovered engine
```

### `storage` (getter)

```ts partial
override get storage(): MemoryStorage
```

Direct access to the underlying `MemoryStorage`. Useful for assertions.

```ts partial
expect(engine.storage.size).toBeGreaterThan(0);
expect(await engine.storage.has(KEYS.workflow('my-id'))).toBe(true);
```

### `mocks` (getter)

```ts partial
get mocks(): ActivityMockRegistry
```

Direct access to the mock registry.

---

## Portable event-loop helpers

These helpers are exported from `@lostgradient/weft/testing` for tests that run inline workflows in a shared process. They avoid importing test-runner-only timer APIs and keep cleanup portable across Bun, Jest-like, and browser-adjacent runners.

### `flushPortableMicrotasks()`

```ts partial
async function flushPortableMicrotasks(turns = 3): Promise<void>;
```

Drain queued promise continuations without yielding a full event-loop turn.

```ts partial
import { flushPortableMicrotasks } from '@lostgradient/weft/testing';

let ran = false;
void Promise.resolve().then(() => {
  ran = true;
});

await flushPortableMicrotasks();
expect(ran).toBe(true);
```

### `yieldToPortableEventLoop()`

```ts partial
async function yieldToPortableEventLoop(): Promise<void>;
```

Yield one full event-loop turn, then drain microtasks. Use it in `afterEach` when a test starts inline workflow work that may have queued a deferred launch before disposal.

```ts partial
import { afterEach } from 'bun:test';
import { yieldToPortableEventLoop } from '@lostgradient/weft/testing';

afterEach(yieldToPortableEventLoop);
```

---

## `TimeControl`

```ts partial
class TimeControl
```

A deterministic virtual clock for testing. Does not monkey-patch global timers -- instead, provides an explicit `now` property and a `schedule` method for callbacks that fire when virtual time is advanced.

### Constructor

```ts partial
new TimeControl(startTime?: number)
```

| Parameter   | Type     | Default      | Description          |
| ----------- | -------- | ------------ | -------------------- |
| `startTime` | `number` | `Date.now()` | Initial virtual time |

### `now` (getter)

```ts partial
get now(): number
```

Current virtual time in milliseconds since epoch.

### `advance()`

```ts partial
async advance(duration: Duration): Promise<void>
```

Advance time by the given duration. Fires all timers that fall within the window, in chronological order, stepping the clock to each timer's fire time as it fires.

### `advanceTo()`

```ts partial
async advanceTo(timestamp: number): Promise<void>
```

Advance time to a specific timestamp. Throws if the target is in the past. Fires timers chronologically up to the target.

### `schedule()`

```ts partial
schedule(fireAt: number, callback: () => void | Promise<void>): () => void
```

Schedule a timer callback at a specific virtual time. Returns a cancel function.

```ts partial
const cancel = timeControl.schedule(timeControl.now + 5000, () => {
  console.log('5 seconds elapsed');
});

// Cancel if no longer needed:
cancel();
```

### `pendingTimerCount` (getter)

```ts partial
get pendingTimerCount(): number
```

Number of pending (non-cancelled, not-yet-fired) timers.

### `nextTimerAt` (getter)

```ts partial
get nextTimerAt(): number | undefined
```

The fire time of the next pending timer, or `undefined` if no timers are scheduled.

### `reset()`

```ts partial
reset(startTime?: number): void
```

Reset the clock to initial state. Clears all pending timers and resets the time.

---

## `ActivityMockRegistry`

```ts partial
class ActivityMockRegistry
```

Registry for activity mocks. Manages mock implementations and provides lookup during workflow execution.

### `mock()`

```ts partial
mock<TInput, TResult>(
  activity: (input: TInput) => Promise<TResult> | TResult,
  implementation: (input: TInput) => TResult | Promise<TResult>,
): MockHandle<TInput, TResult>
```

Register a mock for an activity function. Returns a `MockHandle` for configuring behavior and inspecting call history.

### `has()`

```ts partial
has(activity: Function): boolean
```

Check whether a mock is registered for the given activity.

### `get()`

```ts partial
get(activity: Function): MockedActivity | undefined
```

Retrieve the internal mock entry for an activity.

### `restore()`

```ts partial
restore(activity: Function): void
```

Remove the mock for a specific activity, restoring original behavior.

### `restoreAll()`

```ts partial
restoreAll(): void
```

Remove all registered mocks.

---

## `MockHandle`

```ts
interface MockHandle<TInput, TResult> {
  readonly calls: ReadonlyArray<MockCall<TInput, TResult>>;
  readonly callCount: number;
  readonly lastCall: MockCall<TInput, TResult> | undefined;
  readonly currentImplementation: (input: TInput) => TResult | Promise<TResult>;
  mockImplementation(implementation: (input: TInput) => TResult | Promise<TResult>): void;
  mockReturnValueOnce(value: TResult): MockHandle<TInput, TResult>;
  mockRejectionOnce(error: Error): MockHandle<TInput, TResult>;
  resetCalls(): void;
  restore(): void;
}
```

A handle to a mocked activity, returned by `testEngine.mock()` or `registry.mock()`.

| Property/Method              | Description                                                     |
| ---------------------------- | --------------------------------------------------------------- |
| `calls`                      | Read-only array of all recorded calls                           |
| `callCount`                  | Total number of times the mock was called                       |
| `lastCall`                   | The most recent call record, or `undefined`                     |
| `currentImplementation`      | The base implementation in effect after one-shots are exhausted |
| `mockImplementation(fn)`     | Replace the mock's base implementation                          |
| `mockReturnValueOnce(value)` | Queue a one-shot return value (chainable)                       |
| `mockRejectionOnce(error)`   | Queue a one-shot rejection (chainable)                          |
| `resetCalls()`               | Clear the call history                                          |
| `restore()`                  | Remove the mock from the registry                               |

```ts partial
const handle = engine.mock(sendEmail, async () => ({ messageId: 'ok' }));

// Queue a one-shot failure, then succeed
handle.mockRejectionOnce(new Error('SMTP down')).mockReturnValueOnce({ messageId: 'retry-ok' });

// After workflow runs:
expect(handle.callCount).toBe(2);
expect(handle.calls[0].error).toBeDefined();
expect(handle.calls[1].result).toEqual({ messageId: 'retry-ok' });
```

---

## `MockCall`

```ts
interface MockCall<TInput, TResult> {
  readonly input: TInput;
  readonly result: TResult | undefined;
  readonly error: Error | undefined;
  readonly timestamp: number;
}
```

A single recorded call to a mocked activity.

| Field       | Type                   | Description                                    |
| ----------- | ---------------------- | ---------------------------------------------- |
| `input`     | `TInput`               | Input the mock was called with                 |
| `result`    | `TResult \| undefined` | Return value if the call succeeded             |
| `error`     | `Error \| undefined`   | Error if the call threw                        |
| `timestamp` | `number`               | When the call was recorded (real `Date.now()`) |

---

## Complete Test Example

```ts partial
import { describe, it, expect } from 'bun:test';
import { workflow } from '@lostgradient/weft';
import { TestEngine } from '@lostgradient/weft/testing';

// Activities
async function fetchPrice(symbol: string): Promise<number> {
  // In production, this calls an API
  throw new Error('Not mocked');
}

async function sendAlert(input: { symbol: string; price: number }): Promise<void> {
  // In production, this sends a notification
  throw new Error('Not mocked');
}

// Workflow
async function* priceAlertWorkflow(context, symbol: string) {
  const price = yield* context.run('fetchPrice', symbol);
  if (price > 100) {
    yield* context.run('sendAlert', { symbol, price });
  }
  yield* context.sleep('1h');
  return price;
}

describe('priceAlertWorkflow', () => {
  it('sends an alert when price exceeds threshold', async () => {
    const engine = new TestEngine({ startTime: 0 });
    engine.register(workflow({ name: 'price-alert' }).execute(priceAlertWorkflow));

    const fetchMock = engine.mock(fetchPrice, async () => 150);
    const alertMock = engine.mock(sendAlert, async () => {});

    const handle = await engine.start('price-alert', 'AAPL');
    await engine.advanceTime('2h');

    const result = await handle.result();
    expect(result).toBe(150);
    expect(alertMock.callCount).toBe(1);
    expect(alertMock.lastCall?.input).toEqual({ symbol: 'AAPL', price: 150 });
  });
});
```

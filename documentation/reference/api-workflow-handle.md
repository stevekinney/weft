# WorkflowHandle API Reference

`WorkflowHandle` is the primary interface for interacting with a running (or completed) workflow. It extends `EventTarget` and implements `AsyncDisposable`, providing methods to read results, send signals, push updates, cancel execution, and observe lifecycle events via both the DOM event model and well-known Symbol protocols.

You get a handle from `engine.start()` or `engine.getHandle()`.

For a guided walkthrough, see the [Workflows guide](../guides/workflows.md).

---

## Class Signature

```ts partial
class WorkflowHandle extends EventTarget implements AsyncDisposable {
  readonly id: string;

  async result(): Promise<unknown>;
  async signal(name: string, payload?: unknown): Promise<void>;
  async update(name: string, payload?: unknown, options?: { timeout?: number }): Promise<unknown>;
  async cancel(): Promise<void>;

  async *[Symbol.asyncIterator](): AsyncIterableIterator<Event>;
  [Symbol.observable](): Observable;
  async [Symbol.asyncDispose](): Promise<void>;
}
```

---

## Properties

### `id`

```ts partial
readonly id: string;
```

The unique workflow identifier. This is either the ID you passed via `StartOptions.id` or an auto-generated UUID.

---

## Methods

### `result()`

```ts partial
async result(): Promise<unknown>;
```

Returns a promise that resolves with the workflow's return value when it completes. If the workflow fails, the promise rejects with the error. If the workflow is cancelled, the promise rejects with a cancellation error.

For workflows that are already complete when you call `result()`, the promise resolves immediately from stored state.

```ts partial
const handle = await engine.start('order-processing', { orderId: '123' });
const output = await handle.result();
```

### `signal(name, payload?)`

```ts partial
async signal(name: SignalDefinition): Promise<void>;
async signal<TInput>(name: SignalDefinition<TInput>, payload: TInput): Promise<void>;
async signal(name: string, payload?: unknown): Promise<void>;
```

Send a named signal to the workflow. If the workflow is currently waiting for this signal (via `ctx.waitForSignal(name)`), it resumes immediately. Otherwise, the signal is persisted and delivered when the workflow reaches a `waitForSignal` call for that name.

```ts partial
const approve = signal<{ approvedBy: string }>('approve');
await handle.signal(approve, { approvedBy: 'alice' });
```

### `update(name, payload?, options?)`

```ts partial
async update(
  name: UpdateDefinition<TInput, TOutput> | string,
  payload?: unknown,
  options?: { timeout?: number },
): Promise<unknown>;
```

Send a synchronous update to the workflow and wait for the result. Unlike signals, updates are request-response -- the workflow's registered `onUpdate` handler processes the payload and returns a value.

| Parameter         | Type      | Default     | Description                                           |
| ----------------- | --------- | ----------- | ----------------------------------------------------- |
| `name`            | `string`  | --          | Update handler name (registered via `ctx.onUpdate()`) |
| `payload`         | `unknown` | `undefined` | Payload passed to the handler                         |
| `options.timeout` | `number`  | `5000`      | Timeout in ms waiting for the handler to respond      |

Throws if the handler throws or the timeout is exceeded.

```ts partial
const getProgress = update<void, number>('getProgress');
const count = await handle.update(getProgress);
```

### `cancel()`

```ts partial
async cancel(): Promise<void>;
```

Cancel the workflow. This:

1. Aborts the workflow's `AbortController`
2. Cleans up the generator
3. Sets the workflow status to `'cancelled'`
4. Dispatches a `WorkflowCancelledEvent`
5. Rejects the `result()` promise with a cancellation error

```ts partial
await handle.cancel();
```

---

## EventTarget Interface

`WorkflowHandle` extends `EventTarget`, so you can listen for lifecycle events using the standard `addEventListener` / `removeEventListener` API. In-process handles receive events directly from the engine. Client handles preserve the same listener contract; `HttpClient` bridges workflow events over the per-workflow `/v1/workflows/:id/watch` WebSocket channel instead of polling `getEvents()`.

```ts partial
handle.addEventListener('workflow:completed', (event) => {
  console.log('Workflow completed!');
});

handle.addEventListener('workflow:failed', (event) => {
  console.error('Workflow failed');
});

handle.addEventListener('workflow:cancelled', (event) => {
  console.log('Workflow was cancelled');
});
```

Event types forwarded to the handle:

| Event Type           | Dispatched When                    |
| -------------------- | ---------------------------------- |
| `workflow:completed` | Workflow finishes successfully     |
| `workflow:failed`    | Workflow throws an unhandled error |
| `workflow:cancelled` | Workflow is cancelled              |
| `workflow:timed-out` | Workflow reaches a timeout policy  |

## Client Event Tails

`ClientHandle` values returned by `LocalClient` and `HttpClient` also expose `tail()`, and clients expose `client.tail(id)`. Both return a `WorkflowEventTail`:

```ts partial
const tail = handle.tail();
await tail.whenConnected();

for await (const event of tail) {
  console.log(event.type);
}
```

The tail is a single-consumer `AsyncIterable<WorkflowEvent>` with `close()` and `whenConnected()`. `whenConnected()` resolves after the transport is live and the initial history catch-up has run, so the common `await tail.whenConnected(); for await (...)` pattern still sees already-persisted events. Iteration ends on `workflow:completed`, `workflow:failed`, `workflow:cancelled`, `workflow:timed-out`, server close, or `tail.close()`.

In server mode, `HttpClient` uses the `/v1/workflows/:id/watch` WebSocket channel and performs `getEvents()` catch-up on connect and reconnect. If the runtime has no global `WebSocket`, or cannot send configured authentication headers through its WebSocket constructor, pass `HttpClientOptions.webSocketFactory`.

---

## Symbol Protocols

### `Symbol.asyncIterator`

```ts partial
async *[Symbol.asyncIterator](): AsyncIterableIterator<Event>;
```

Yields workflow lifecycle events as they occur. The iterator completes when the workflow reaches a terminal state (`workflow:completed`, `workflow:failed`, `workflow:cancelled`, or `workflow:timed-out`).

Listened event types: `workflow:completed`, `workflow:failed`, `workflow:cancelled`, `workflow:timed-out`, `activity:started`, `activity:completed`, `signal:received`, `update:received`, `update:completed`.

```ts partial
const handle = await engine.start('my-workflow', input);

for await (const event of handle) {
  console.log(event.type);
  if (event.type === 'workflow:completed') break;
}
```

### `Symbol.observable`

```ts partial
[Symbol.observable](): {
  subscribe: (observer: {
    next?: (event: Event) => void;
    complete?: () => void;
    error?: (error: Error) => void;
  }) => { unsubscribe: () => void };
};
```

Returns an observable-like object compatible with the TC39 Observable proposal. The observer receives lifecycle events via `next()`, a `complete()` call on `workflow:completed`, and an `error()` call on `workflow:failed`.

```ts partial
const observable = handle[Symbol.observable]();
const subscription = observable.subscribe({
  next: (event) => console.log(event.type),
  complete: () => console.log('Done!'),
  error: (error) => console.error(error),
});

// Later:
subscription.unsubscribe();
```

Observed event types: `workflow:completed`, `workflow:failed`, `workflow:cancelled`, `activity:started`, `activity:completed`.

### `Symbol.asyncDispose`

```ts partial
async [Symbol.asyncDispose](): Promise<void>;
```

No-op for now -- handles are lightweight and do not hold resources that need cleanup. This allows `WorkflowHandle` to be used with `await using`:

```ts partial
await using handle = await engine.start('my-workflow', input);
const result = await handle.result();
// handle is disposed when scope exits
```

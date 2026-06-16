# Events

You want to know when a workflow starts, when an activity fails, when a signal arrives. You want to build dashboards, trigger side effects, stream progress to a UI. Weft gives you all of that through a single, familiar interface: `EventTarget`.

## EventTarget, not EventEmitter

Both `Engine` and `WorkflowHandle` extend `EventTarget`—the same interface that DOM elements, `WebSocket`, `AbortSignal`, and `BroadcastChannel` use. No custom event emitter. No `.on()` / `.off()` / `.emit()`. Just `addEventListener`, `removeEventListener`, and `dispatchEvent`.

```typescript
import { Engine } from '@lostgradient/weft';

const engine = new Engine();

engine.addEventListener('workflow:completed', (event) => {
  console.log(`Workflow ${event.workflowId} completed in ${event.duration}ms`);
});

void engine;
```

This is a deliberate choice. `EventTarget` is a web standard with built-in support for `AbortSignal`-based cleanup, `once` listeners, and capture/bubble phases. Every JavaScript developer already knows the API.

## Typed event subclasses

Weft defines proper `Event` subclasses rather than wrapping data in `CustomEvent` with a `.detail` bag. This means you get named properties directly on the event object and full TypeScript inference without casts.

```typescript
import { Engine, WorkflowCompletedEvent } from '@lostgradient/weft';

const engine = new Engine();

engine.addEventListener(WorkflowCompletedEvent.type, (event) => {
  const workflowId: string = event.workflowId;
  const result: unknown = event.result;
  const duration: number = event.duration;
  void workflowId;
  void result;
  void duration;
});

void engine;
```

Each event class has a static `type` property that matches its event string. Use the class reference instead of raw strings—it keeps things type-safe and refactor-friendly.

## Core event types

Here is the primary set of events the engine dispatches. For the complete list, see `WeftEventMap` in `src/core/events.ts`.

_Workflow events:_

- `WorkflowStartedEvent` (`'workflow:started'`) -- carries `workflowId`, `workflowType`, and `input`
- `WorkflowCompletedEvent` (`'workflow:completed'`) -- carries `workflowId`, `result`, and `duration`
- `WorkflowFailedEvent` (`'workflow:failed'`) -- carries `workflowId` and `error` (an `Error` instance)
- `WorkflowCancelledEvent` (`'workflow:cancelled'`) -- carries `workflowId`
- `WorkflowTimedOutEvent` (`'workflow:timed-out'`) -- carries `workflowId`, `timeoutType` (`'execution'` or `'run'`), and `elapsed`

_Activity events:_

- `ActivityStartedEvent` (`'activity:started'`) -- carries `operationId`, `workflowId`, `activityName`, and `attempt`
- `ActivityCompletedEvent` (`'activity:completed'`) -- carries `operationId`, `workflowId`, `activityName`, and `duration`
- `ActivityFailedEvent` (`'activity:failed'`) -- carries `operationId`, `workflowId`, `activityName`, `error`, and `attempt`

_Signal and update events:_

- `SignalReceivedEvent` (`'signal:received'`) -- carries `workflowId`, `signalName`, and `payload`
- `SignalDeliveredEvent` (`'signal:delivered'`) -- carries `workflowId` and `signalName`
- `UpdateReceivedEvent` (`'update:received'`) -- carries `updateId`, `workflowId`, `name`, and `payload`
- `UpdateCompletedEvent` (`'update:completed'`) -- carries `updateId`, `workflowId`, `name`, `result`, and optional `error`

_Schedule events:_

- `ScheduleFiredEvent` (`'schedule:fired'`) -- carries `scheduleId`, `workflowId`, `firedAt`, and `occurrence`. Dispatched each time a schedule launches an occurrence — a fresh cadence tick, a `cancel-running` replacement, or a `queue`d run draining after the previous one finished. A fire means a run actually started, so the blocked policies (`skip`, and `queue` while a run is already active) do **not** emit. `occurrence` is the scheduled grid timestamp the run was due, or `undefined` for a `queue`-drained run whose original timestamp is not retained. Delivery is process-local and best-effort after the durable start commit: a crash after the run is committed but before synchronous event dispatch can drop the notification without affecting the run. This lets a consumer react to a firing without polling `engine.list()` or `getSchedule()`.

_Operational events:_

- `AttributesChangedEvent` (`'attributes:changed'`) -- carries `workflowId` and `changes`
- `ScheduleMissedFireEvent` (`'schedule:missed-fire'`) -- carries `scheduleId`, `missedCount`, `windowStart`, and `windowEnd` when a non-backfill schedule skips timers more than one second late
- `CheckpointSizeWarningEvent` (`'checkpoint:size-warning'`) -- carries `workflowId`, `sizeBytes`, and `step`
- `DevelopmentWarningEvent` (`'development:warning'`) -- carries `workflowId`, `message`, and `fieldPaths`

## Review events

When a workflow pauses for human review, review events track the request and the submitted decision.

- `ReviewRequestedEvent` (`'human-review:requested'`) -- carries `reviewId`, `reviewType`, and `reviewers`
- `ReviewCompletedEvent` (`'human-review:completed'`) -- carries `reviewId`, `decision`, `reviewer`, and `duration`

## The WeftEventMap

All event types are collected into `WeftEventMap`, a TypeScript interface that maps event type strings to their concrete event classes. Review-specific events are also available through `WeftReviewEventMap`. `Engine` implements the `WeftEventMap` listener surface directly, and `TypedEventTarget` is available for other event targets that expose the same shape.

```typescript
import { Engine, type WeftEventMap } from '@lostgradient/weft';

const engine = new Engine();

engine.addEventListener('workflow:completed', (event) => {
  const completed: WeftEventMap['workflow:completed'] = event;
  console.log(event.duration);
  void completed;
});

void engine;
```

## Four consumption patterns

_Pattern 1: addEventListener._ The classic approach. Best for persistent listeners that run for the lifetime of the engine.

```typescript
import { Engine, WorkflowCompletedEvent } from '@lostgradient/weft';

const engine = new Engine();
const controller = new AbortController();
const metrics = {
  recordCompletion(workflowId: string, duration: number): void {
    void workflowId;
    void duration;
  },
};

engine.addEventListener(
  WorkflowCompletedEvent.type,
  (event) => {
    metrics.recordCompletion(event.workflowId, event.duration);
  },
  { signal: controller.signal },
);

// Later, clean up all listeners at once:
controller.abort();

void engine;
```

Using `AbortSignal` for cleanup is the modern best practice. One `abort()` call removes every listener you attached with that signal—no need to track individual references.

_Pattern 2: Async iteration._ In-process `WorkflowHandle` implements `Symbol.asyncIterator`, so you can `for await...of` over events from a specific workflow.

```typescript
import type { WorkflowHandle } from '@lostgradient/weft';

declare const handle: WorkflowHandle<unknown>;

async function observeWorkflow(): Promise<void> {
  for await (const event of handle) {
    if (event.type === 'activity:completed') {
      console.log('Activity done');
    }
    if (event.type === 'workflow:completed') {
      console.log('Workflow finished');
      break; // terminal events end the iteration automatically
    }
  }
}

void observeWorkflow;
```

This is useful for streaming progress to code that already has an in-process engine handle. The iterator yields events as they happen and terminates when the workflow reaches a terminal state (completed, failed, cancelled, or timed out).

_Pattern 3: Client tails._ `LocalClient` and `HttpClient` expose `client.tail(id)` and `handle.tail()` for code that uses the client abstraction. The returned `WorkflowEventTail` is an `AsyncIterable` with `whenConnected()` and `close()`.

```typescript
import type { ClientHandle } from '@lostgradient/weft';

declare const handle: ClientHandle;

const tail = handle.tail();

async function observeTail(): Promise<void> {
  await tail.whenConnected();

  for await (const event of tail) {
    console.log(event.type);
  }
}

void observeTail;
```

`HttpClient` tails ride the `/v1/workflows/:id/watch` WebSocket channel and catch up from `getEvents()` on connect and reconnect. Raw watch sockets accept `?resumeFrom=<sequence>` and include `sequence` / `cursor` on each event frame. JSON-RPC clients can use `weft.workflows.subscribe` for one workflow or `weft.events.subscribe` for the fleet-wide event feed. `LocalClient` tails bridge the engine event stream and perform the same history catch-up. A tail is single-consumer: open a fresh `client.tail(id)` or `handle.tail()` for each independent reader.

_Pattern 4: Observable._ `WorkflowHandle` also implements `Symbol.observable`, making it compatible with RxJS and other reactive libraries.

```typescript
import type { WorkflowHandle } from '@lostgradient/weft';

declare const handle: WorkflowHandle<unknown>;

const observable = handle[Symbol.observable]();

const subscription = observable.subscribe({
  next(event) {
    console.log(event.type);
  },
  complete() {
    console.log('Workflow finished');
  },
  error(err) {
    console.error('Workflow failed:', err);
  },
});

// Later:
subscription.unsubscribe();
```

Pick the pattern that fits your use case. `addEventListener` for persistent observation, client tails for client-mode progress streams, in-process async iteration when you already hold an engine handle, and Observable when you are already in a reactive pipeline.

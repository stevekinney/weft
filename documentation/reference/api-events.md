# Events API

Weft uses the standard `EventTarget` API for lifecycle observability. The `Engine` and `WorkflowHandle` classes both extend `EventTarget`, emitting strongly-typed event subclasses. Core events cover workflow, activity, and review lifecycle.

All event classes extend the built-in `Event` with a static `type` property matching the event string.

## Core Events

### `WorkflowStartedEvent`

Emitted when a workflow begins execution.

```ts partial
class WorkflowStartedEvent extends Event {
  static readonly type = 'workflow:started';
  readonly workflowId: string;
  readonly workflowType: string;
  readonly input: unknown;
}
```

### `WorkflowCompletedEvent`

Emitted when a workflow finishes successfully.

```ts partial
class WorkflowCompletedEvent extends Event {
  static readonly type = 'workflow:completed';
  readonly workflowId: string;
  readonly result: unknown;
  readonly duration: number; // milliseconds
}
```

### `WorkflowFailedEvent`

Emitted when a workflow throws an unhandled error.

```ts partial
class WorkflowFailedEvent extends Event {
  static readonly type = 'workflow:failed';
  readonly workflowId: string;
  readonly error: Error;
}
```

### `WorkflowCancelledEvent`

Emitted when a workflow is explicitly cancelled.

```ts partial
class WorkflowCancelledEvent extends Event {
  static readonly type = 'workflow:cancelled';
  readonly workflowId: string;
}
```

### `WorkflowTimedOutEvent`

Emitted when a workflow exceeds its execution or run deadline.

```ts partial
class WorkflowTimedOutEvent extends Event {
  static readonly type = 'workflow:timed-out';
  readonly workflowId: string;
  readonly timeoutType: 'execution' | 'run';
  readonly elapsed: number; // milliseconds
}
```

### `WorkflowResumedEvent`

Emitted when a paused or suspended workflow is explicitly resumed.

```ts partial
class WorkflowResumedEvent extends Event {
  static readonly type = 'workflow:resumed';
  readonly workflowId: string;
}
```

### `ActivityStartedEvent`

Emitted when an activity begins executing.

```ts partial
class ActivityStartedEvent extends Event {
  static readonly type = 'activity:started';
  readonly operationId: string;
  readonly workflowId: string;
  readonly activityName: string;
  readonly attempt: number;
}
```

### `ActivityCompletedEvent`

Emitted when an activity finishes successfully.

```ts partial
class ActivityCompletedEvent extends Event {
  static readonly type = 'activity:completed';
  readonly operationId: string;
  readonly workflowId: string;
  readonly activityName: string;
  readonly duration: number; // milliseconds
}
```

### `ActivityFailedEvent`

Emitted when an activity throws an error (may be retried).

```ts partial
class ActivityFailedEvent extends Event {
  static readonly type = 'activity:failed';
  readonly operationId: string;
  readonly workflowId: string;
  readonly activityName: string;
  readonly error: Error;
  readonly attempt: number;
}
```

### `SignalReceivedEvent`

Emitted when a signal is delivered to the engine for a workflow.

```ts partial
class SignalReceivedEvent extends Event {
  static readonly type = 'signal:received';
  readonly workflowId: string;
  readonly signalName: string;
  readonly payload: unknown;
}
```

### `SignalDeliveredEvent`

Emitted when a signal is consumed by a waiting workflow.

```ts partial
class SignalDeliveredEvent extends Event {
  static readonly type = 'signal:delivered';
  readonly workflowId: string;
  readonly signalName: string;
}
```

### `UpdateReceivedEvent`

Emitted when an update request is sent to a workflow.

```ts partial
class UpdateReceivedEvent extends Event {
  static readonly type = 'update:received';
  readonly updateId: string;
  readonly workflowId: string;
  readonly name: string;
  readonly payload: unknown;
}
```

### `UpdateCompletedEvent`

Emitted when an update handler finishes processing.

```ts partial
class UpdateCompletedEvent extends Event {
  static readonly type = 'update:completed';
  readonly updateId: string;
  readonly workflowId: string;
  readonly name: string;
  readonly result: unknown;
  readonly error: string | undefined;
}
```

### `AttributesChangedEvent`

Emitted when search attributes are persisted.

```ts partial
class AttributesChangedEvent extends Event {
  static readonly type = 'attributes:changed';
  readonly workflowId: string;
  readonly changes: Record<string, unknown>;
}
```

### `CheckpointSizeWarningEvent`

Emitted when a checkpoint exceeds the configured size threshold.

```ts partial
class CheckpointSizeWarningEvent extends Event {
  static readonly type = 'checkpoint:size-warning';
  readonly workflowId: string;
  readonly sizeBytes: number;
  readonly step: number;
}
```

### `DevelopmentWarningEvent`

Emitted in development mode when a checkpoint round-trip detects non-serializable fields.

```ts partial
class DevelopmentWarningEvent extends Event {
  static readonly type = 'development:warning';
  readonly workflowId: string;
  readonly message: string;
  readonly fieldPaths: string[];
}
```

### `StorageSizeReportedEvent`

Emitted periodically with storage utilization metrics.

```ts partial
class StorageSizeReportedEvent extends Event {
  static readonly type = 'storage:size-reported';
  readonly totalBytes: number;
  readonly entryCount: number;
}
```

### `AlertFiredEvent`

Emitted when a metric crosses an alert threshold.

```ts partial
class AlertFiredEvent extends Event {
  static readonly type = 'alert:fired';
  readonly metric: string;
  readonly value: number;
  readonly threshold: number;
}
```

### `AlertResolvedEvent`

Emitted when a previously fired alert metric returns below its threshold.

```ts partial
class AlertResolvedEvent extends Event {
  static readonly type = 'alert:resolved';
  readonly metric: string;
  readonly value: number;
}
```

### `ConstraintViolatedEvent`

Emitted when a constraint is violated (e.g., a workflow creation rate limit).

```ts partial
class ConstraintViolatedEvent extends Event {
  static readonly type = 'constraint:violated';
  readonly constraint: string;
  readonly detail: string;
}
```

## Review Events

### `ReviewRequestedEvent`

Emitted when a workflow requests human review before proceeding.

```ts partial
class ReviewRequestedEvent extends Event {
  static readonly type = 'human-review:requested';
  readonly workflowId: string;
  readonly reviewId: string;
  readonly reviewType: string;
  readonly reviewers: string[];
}
```

### `ReviewCompletedEvent`

Emitted when a human review decision is submitted.

```ts partial
class ReviewCompletedEvent extends Event {
  static readonly type = 'human-review:completed';
  readonly workflowId: string;
  readonly reviewId: string;
  readonly decision: string;
  readonly reviewer: string;
  readonly duration: number;
}
```

---

## Event Map Types

### `WeftEventMap`

A complete mapping of event type strings to their event classes. Use this with `TypedEventTarget` for fully typed `addEventListener` calls.

```ts partial
interface WeftEventMap extends WeftReviewEventMap {
  'workflow:started': WorkflowStartedEvent;
  'workflow:completed': WorkflowCompletedEvent;
  'workflow:failed': WorkflowFailedEvent;
  'workflow:cancelled': WorkflowCancelledEvent;
  'workflow:timed-out': WorkflowTimedOutEvent;
  'workflow:resumed': WorkflowResumedEvent;
  'activity:started': ActivityStartedEvent;
  'activity:completed': ActivityCompletedEvent;
  'activity:failed': ActivityFailedEvent;
  'signal:received': SignalReceivedEvent;
  'signal:delivered': SignalDeliveredEvent;
  'attributes:changed': AttributesChangedEvent;
  'update:received': UpdateReceivedEvent;
  'update:completed': UpdateCompletedEvent;
  'checkpoint:size-warning': CheckpointSizeWarningEvent;
  'development:warning': DevelopmentWarningEvent;
  'storage:size-reported': StorageSizeReportedEvent;
  'alert:fired': AlertFiredEvent;
  'alert:resolved': AlertResolvedEvent;
  'constraint:violated': ConstraintViolatedEvent;
}
```

### `WeftReviewEventMap`

The review-specific subset of the event map.

```ts partial
interface WeftReviewEventMap {
  'human-review:requested': ReviewRequestedEvent;
  'human-review:completed': ReviewCompletedEvent;
}
```

### `TypedEventTarget`

A utility type that narrows `addEventListener` and `removeEventListener` to accept only known event types with their correct event class.

```ts
interface TypedEventTarget<TEventMap extends Record<string, Event>> {
  addEventListener<K extends keyof TEventMap & string>(
    type: K,
    listener: (event: TEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof TEventMap & string>(
    type: K,
    listener: (event: TEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ): void;
}
```

### Listening to Events

```ts partial
engine.addEventListener('workflow:completed', (event) => {
  // event is WorkflowCompletedEvent
  console.log(`Workflow ${event.workflowId} completed in ${event.duration}ms`);
});

engine.addEventListener('activity:failed', (event) => {
  // event is ActivityFailedEvent
  console.error(`Activity ${event.activityName} failed on attempt ${event.attempt}:`, event.error);
});
```

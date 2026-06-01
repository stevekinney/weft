# Interceptors API

Interceptors provide a middleware-like mechanism for cross-cutting concerns in workflow and activity execution. They compose like middleware -- the first registered interceptor is the outermost wrapper. Each interceptor receives an interception context and a `next` function that delegates to the next interceptor in the chain (or the final execute function at the end).

## `WorkflowInterceptor`

The workflow-side interceptor exposes seven optional hooks — `activity`, `sleep`, `waitForSignal`, `workflowStart`, `childWorkflow`, `query`, and `signalReceived` — covering the workflow operations you can wrap. See [`WorkflowInterceptor`](types.md#workflowinterceptor) for the full interface and the exact signature of each hook.

All hooks are optional. Implement only the ones you need. The `activity`, `sleep`, `waitForSignal`, and `query` hooks are generators — call `yield* next(interception)` to delegate to the rest of the chain. The `childWorkflow` hook is async and returns a `Promise`. The `workflowStart` and `signalReceived` hooks are plain functions.

```ts partial
import type { WorkflowInterceptor, ActivityInterception } from '@lostgradient/weft';

const loggingInterceptor: WorkflowInterceptor = {
  *activity(interception, next) {
    console.log(`Starting activity: ${interception.activityName}`);
    const result = yield* next(interception);
    console.log(`Completed activity: ${interception.activityName}`);
    return result;
  },
};

engine.addInterceptor(loggingInterceptor);
```

---

## `ActivityInterceptor`

```ts
interface ActivityInterceptor {
  execute?(
    interception: ActivityExecutionInterception,
    next: (interception: ActivityExecutionInterception) => Promise<unknown>,
  ): Promise<unknown>;
}
```

Activity interceptors run around activity execution specifically. Unlike workflow interceptors, the `execute` hook is async (not a generator), making it suitable for wrapping activity calls with retry logic, timeouts, or observability.

```ts partial
import type { ActivityInterceptor } from '@lostgradient/weft';

const timingInterceptor: ActivityInterceptor = {
  async execute(interception, next) {
    const start = performance.now();
    try {
      return await next(interception);
    } finally {
      console.log(`${interception.activityName} took ${performance.now() - start}ms`);
    }
  },
};

engine.addInterceptor(timingInterceptor);
```

---

## `Interceptor`

```ts partial
import type { WorkflowInterceptor, ActivityInterceptor } from '@lostgradient/weft';

interface Interceptor extends WorkflowInterceptor, ActivityInterceptor {}
```

`Interceptor` is the unified engine registration type. Implement workflow-side hooks, activity-side `execute`, or both. An interceptor that implements hooks from both sides participates in both pipelines.

Register unified interceptors with the constructor option or with `engine.addInterceptor()`:

```ts partial
const engine = new Engine({
  interceptors: [loggingInterceptor, timingInterceptor],
});

engine.addInterceptor(timingInterceptor);
```

---

## Interception Types

### `ActivityInterception`

Passed to the `WorkflowInterceptor.activity` hook.

```ts
interface ActivityInterception {
  activityName: string;
  input: unknown;
  attempt: number;
  headers: Map<string, string>;
}
```

| Field          | Type                  | Description                                             |
| -------------- | --------------------- | ------------------------------------------------------- |
| `activityName` | `string`              | Name of the activity being invoked                      |
| `input`        | `unknown`             | The activity's input (single arg or array for multiple) |
| `attempt`      | `number`              | Current retry attempt (starts at 1)                     |
| `headers`      | `Map<string, string>` | Propagation headers for tracing/context                 |

### `ActivityExecutionInterception`

Passed to the `ActivityInterceptor.execute` hook. Has the same shape as `ActivityInterception`.

```ts
interface ActivityExecutionInterception {
  activityName: string;
  input: unknown;
  attempt: number;
  headers: Map<string, string>;
}
```

### `SleepInterception`

Passed to the `WorkflowInterceptor.sleep` hook.

```ts
interface SleepInterception {
  duration: number;
  headers: Map<string, string>;
}
```

| Field      | Type                  | Description                    |
| ---------- | --------------------- | ------------------------------ |
| `duration` | `number`              | Sleep duration in milliseconds |
| `headers`  | `Map<string, string>` | Propagation headers            |

### `SignalInterception`

Passed to the `WorkflowInterceptor.waitForSignal` hook.

```ts
interface SignalInterception {
  signalName: string;
  payload: unknown;
  headers: Map<string, string>;
}
```

| Field        | Type                  | Description                        |
| ------------ | --------------------- | ---------------------------------- |
| `signalName` | `string`              | Name of the signal being waited on |
| `payload`    | `unknown`             | Signal payload                     |
| `headers`    | `Map<string, string>` | Propagation headers                |

### `WorkflowStartInterception`

Passed to the `WorkflowInterceptor.workflowStart` hook.

```ts
interface WorkflowStartInterception {
  workflowId: string;
  workflowType: string;
  input: unknown;
  headers: Map<string, string>;
}
```

| Field          | Type                  | Description                       |
| -------------- | --------------------- | --------------------------------- |
| `workflowId`   | `string`              | The workflow's ID                 |
| `workflowType` | `string`              | The registered workflow type name |
| `input`        | `unknown`             | Input data for the workflow       |
| `headers`      | `Map<string, string>` | Propagation headers               |

---

## Composition Functions

### `composeWorkflowInterceptors()`

```ts partial
function composeWorkflowInterceptors(
  interceptors: WorkflowInterceptor[],
): ComposedWorkflowInterceptor;
```

Compose an array of workflow interceptors into a single `ComposedWorkflowInterceptor`. The resulting object has fully-resolved `activity`, `sleep`, `waitForSignal`, and `workflowStart` hooks that chain through all registered interceptors in order.

The first interceptor in the array is the outermost wrapper; the last is closest to the final execute function.

```ts partial
import { composeWorkflowInterceptors } from '@lostgradient/weft';

const composed = composeWorkflowInterceptors([loggingInterceptor, tracingInterceptor]);
```

#### `ComposedWorkflowInterceptor`

```ts
interface ComposedWorkflowInterceptor {
  activity(
    interception: ActivityInterception,
    execute: (interception: ActivityInterception) => Generator<unknown, unknown, unknown>,
  ): Generator<unknown, unknown, unknown>;

  sleep(
    interception: SleepInterception,
    execute: (interception: SleepInterception) => Generator<unknown, void, unknown>,
  ): Generator<unknown, void, unknown>;

  waitForSignal(
    interception: SignalInterception,
    execute: (interception: SignalInterception) => Generator<unknown, unknown, unknown>,
  ): Generator<unknown, unknown, unknown>;

  workflowStart(
    interception: WorkflowStartInterception,
    execute: (interception: WorkflowStartInterception) => void,
  ): void;
}
```

### `composeActivityInterceptors()`

```ts partial
function composeActivityInterceptors(
  interceptors: ActivityInterceptor[],
): ComposedActivityInterceptor;
```

Compose an array of activity interceptors into a single `ComposedActivityInterceptor`.

#### `ComposedActivityInterceptor`

```ts
interface ComposedActivityInterceptor {
  execute(
    interception: ActivityExecutionInterception,
    execute: (interception: ActivityExecutionInterception) => Promise<unknown>,
  ): Promise<unknown>;
}
```

---

## Usage with Engine

Register interceptors on an engine instance before starting workflows:

```ts
import { Engine } from '@lostgradient/weft';
import type { ActivityInterceptor, WorkflowInterceptor } from '@lostgradient/weft';

const engine = new Engine();

// Workflow-level interceptor
engine.addInterceptor({
  *activity(interception, next) {
    interception.headers.set('x-trace-id', crypto.randomUUID());
    return yield* next(interception);
  },
  workflowStart(interception, next) {
    console.log(`Starting workflow ${interception.workflowId}`);
    next(interception);
  },
});

// Activity-level hook
engine.addInterceptor({
  async execute(interception, next) {
    const traceId = interception.headers.get('x-trace-id');
    console.log(`[${traceId}] Executing ${interception.activityName}`);
    return await next(interception);
  },
});
```

Interceptors are called in registration order for the outermost layer. The `headers` map on each interception context is the primary mechanism for propagating data (like trace IDs) from workflow interceptors through to activity interceptors.

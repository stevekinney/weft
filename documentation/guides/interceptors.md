# Interceptors

You want to log every activity call, propagate scoped metadata from workflows to activity workers, and validate inputs before they hit your business logic. You could sprinkle that code into every workflow and activity function, but you'd be duplicating it everywhere and coupling cross-cutting concerns to your domain code. Interceptors solve this cleanly.

## The mental model

Interceptors wrap workflow context operations---`ctx.run()`, `ctx.sleep()`, `ctx.waitForSignal()`---without modifying the workflow code itself. They compose like Koa middleware: each interceptor receives an interception context and a `next` function that delegates to the next interceptor in the chain (or the final operation). The first registered interceptor is the outermost wrapper.

There are two hook categories on one registration surface. **Workflow interceptor hooks** wrap operations inside the workflow generator. **Activity interceptor hooks** wrap activity execution on the worker side. Together, they let you instrument the full lifecycle of a durable operation.

## Workflow interceptors

The `WorkflowInterceptor` interface has seven optional hooks — `activity`, `sleep`, `waitForSignal`, `workflowStart`, `childWorkflow`, `query`, and `signalReceived`. Each wraps the matching workflow operation. The `activity` hook is the one this guide walks through; its shape is representative of the generator-style hooks:

```typescript partial
interface WorkflowInterceptor {
  activity?(
    interception: ActivityInterception,
    next: (interception: ActivityInterception) => Generator<unknown, unknown, unknown>,
  ): Generator<unknown, unknown, unknown>;
  // ...and six more: sleep, waitForSignal, workflowStart,
  // childWorkflow, query, signalReceived
}
```

For the complete interface with every hook signature, see the [Types Reference](../reference/types.md#workflowinterceptor).

Notice that `activity`, `sleep`, `waitForSignal`, and `query` are generators---they must use `yield*` to delegate to `next()`. This preserves checkpoint semantics. The `childWorkflow` hook is async and returns a `Promise`. The `workflowStart` and `signalReceived` hooks are plain functions because they run outside the durable generator.

## Activity interceptors

The `ActivityInterceptor` interface has a single hook:

```typescript
interface ActivityInterceptor {
  execute?(
    interception: ActivityExecutionInterception,
    next: (interception: ActivityExecutionInterception) => Promise<unknown>,
  ): Promise<unknown>;
}
```

This one is async (not a generator) because activity execution is a normal async function, not a durable generator. Register interceptors via the `interceptors` constructor option or `engine.addInterceptor()`—an interceptor implementing both workflow and activity hooks participates in both pipelines.

## Interception context types

Each hook receives a typed context object. Here are the key shapes:

```typescript
interface ActivityInterception {
  activityName: string;
  input: unknown; // mutable---interceptors can transform it
  attempt: number;
  headers: Map<string, string>;
}

interface SleepInterception {
  duration: number; // mutable
  headers: Map<string, string>;
}

interface SignalInterception {
  signalName: string;
  payload: unknown;
  headers: Map<string, string>;
}

interface WorkflowStartInterception {
  workflowId: string;
  workflowType: string;
  input: unknown; // mutable
  headers: Map<string, string>;
}

interface ActivityExecutionInterception {
  activityName: string;
  input: unknown; // mutable
  attempt: number;
  headers: Map<string, string>;
}
```

The `input` field is mutable by design---interceptors can validate, transform, or encrypt payloads before they reach the next layer.

## The `headers` Map

The `headers` field is how metadata crosses thread and network boundaries. A workflow interceptor sets headers on `ActivityInterception` before calling `next()`. The engine serializes those headers into the `postMessage` (local workers) or WebSocket message (remote workers). The activity interceptor reads them from `ActivityExecutionInterception`.

This is the mechanism for trace context, short-lived authorization claims, and opaque credential references---metadata you need to pass from the workflow side to the activity side. Do not propagate raw bearer tokens, encryption keys, or other long-lived secrets through interceptor headers. Resolve those from a worker-side secret store after validating the claim. See the [observability guide](./observability.md) for the canonical example.

## Writing an interceptor

Here's a logging interceptor that times every activity:

```typescript
import type { WorkflowInterceptor } from 'weft';

const loggingInterceptor: WorkflowInterceptor = {
  *activity(interception, next) {
    const start = Date.now();
    console.log(`[activity:start] ${interception.activityName}`);

    try {
      const result = yield* next(interception);
      console.log(`[activity:done] ${interception.activityName} (${Date.now() - start}ms)`);
      return result;
    } catch (error) {
      console.log(`[activity:error] ${interception.activityName} (${Date.now() - start}ms)`);
      throw error;
    }
  },
};
```

An input validation interceptor using Zod:

```typescript partial
function validationInterceptor(schemas: Record<string, ZodSchema>): WorkflowInterceptor {
  return {
    *activity(interception, next) {
      const schema = schemas[interception.activityName];
      if (schema) {
        interception.input = schema.parse(interception.input);
      }
      return yield* next(interception);
    },
  };
}
```

An auth propagation interceptor should pass a short-lived claim or opaque credential reference, not the underlying secret:

```typescript
import type { WorkflowInterceptor } from 'weft';

function authInterceptor(getCredentialReference: () => string): WorkflowInterceptor {
  return {
    *activity(interception, next) {
      interception.headers.set('x-weft-credential-reference', getCredentialReference());
      return yield* next(interception);
    },
  };
}
```

And the receiving side on the activity worker:

```typescript partial
const authActivityInterceptor: ActivityInterceptor = {
  async execute(interception, next) {
    const credentialReference = interception.headers.get('x-weft-credential-reference');
    if (!credentialReference) {
      throw new Error('Missing credential reference');
    }

    await secrets.assertCredential(credentialReference);
    interception.headers.delete('x-weft-credential-reference');

    return next(interception);
  },
};
```

## Composition

`composeWorkflowInterceptors()` and `composeActivityInterceptors()` combine multiple interceptors into a single chain. The chain is built once per engine, not per operation---zero overhead when no interceptors are registered.

```typescript partial
import { composeWorkflowInterceptors, composeActivityInterceptors } from 'weft';

const composed = composeWorkflowInterceptors([
  authInterceptor(getCredentialReference),
  validationInterceptor(schemas),
  loggingInterceptor,
]);
```

```typescript partial
engine.addInterceptor(composed);
engine.addInterceptor(composeActivityInterceptors([authActivityInterceptor]));
```

Register interceptors on the engine with `engine.addInterceptor()` or the constructor's `interceptors` option. The engine composes interceptors registered in sequence, so you can also call `addInterceptor` once per interceptor without manual composition.

Registration order matters. The first interceptor is the outermost wrapper. In the example above, auth runs first, then validation, then logging wraps the actual call. Think of it as nesting: `auth(validation(logging(execute)))`.

## Interceptors vs EventTarget

These are complementary systems. **EventTarget** is for observation---listeners receive events _after_ things happen and cannot modify inputs, outputs, or control flow. **Interceptors** are for interception---they wrap execution, can modify inputs and outputs, can skip or retry operations, and participate in the control flow.

If you just need to know that an activity ran, use events. If you need to change _how_ it runs, use interceptors.

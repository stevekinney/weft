# Design Philosophy: No Userland Where Platform Exists

Every framework eventually reinvents something the platform already provides. An event system here, a cloning utility there, a cancellation token that looks suspiciously like `AbortController` but isn't. The abstractions pile up, each one a thing you have to learn, debug, and maintain.

Weft takes a hard line: if the platform has it, we use it. No wrappers, no "improved" versions, no compatibility layers. The browser and Bun runtimes ship an enormous amount of well-tested, well-optimized infrastructure. Our job is to compose it, not rewrite it.

## The mapping

Here's what this looks like in practice. Every row is a pattern we _didn't_ build because the platform already solved it.

| Userland Pattern           | Platform Replacement                                    | Where in Weft                                                   |
| -------------------------- | ------------------------------------------------------- | --------------------------------------------------------------- |
| Node `EventEmitter`        | `EventTarget` + `Event` subclasses                      | Engine, WorkflowHandle, Worker                                  |
| RxJS / custom Observable   | `Symbol.observable` protocol + `AsyncIterator`          | Workflow observation, token streaming                           |
| Manual try/finally cleanup | `Symbol.dispose` / `using` declarations                 | Storage connections, Worker pools, Subscriptions                |
| Manual cache invalidation  | `WeakRef` + `FinalizationRegistry`                      | Checkpoint cache, Worker pool, Activity registry                |
| Custom deferred patterns   | `Promise.withResolvers()`                               | Signal waiting, result awaiting                                 |
| Custom ID generation       | `crypto.randomUUID()`                                   | Everywhere                                                      |
| Custom cloning             | `structuredClone()`                                     | Checkpoint serialization                                        |
| Custom cancellation        | `AbortController` / `AbortSignal`                       | Workflow cancellation, budget limits, timeouts                  |
| Custom streaming layer     | `ReadableStream` / `WritableStream` / `TransformStream` | Token streaming, context window management, stream multiplexing |

## Why this matters

Platform primitives beat library abstractions for three reasons.

First, _they're already debugged_. `AbortController` has been battle-tested across every major browser engine and Bun's runtime. Your hand-rolled cancellation token has been tested by your team. The error surface is incomparable.

Second, _they compose with everything else_. When Weft uses `AbortSignal` for cancellation, it automatically works with `fetch`, with `Bun.serve`, with any library that accepts an `AbortSignal`. A custom cancellation type would need adapters for each of those—and the adapters would be the source of bugs.

Third, _they're optimized at the engine level_. `EventTarget` in Bun is a native C++ implementation. `structuredClone` uses the same fast path as `postMessage`. `WeakRef` integrates directly with the garbage collector. No userland code can match those integration points.

The result is a smaller codebase, fewer concepts to learn, and interoperability you get for free. When you already know `EventTarget`, you already know how Weft emits events. When you already know `AbortController`, you already know how Weft cancels workflows.

We'd rather teach you zero things than teach you our custom version of something you already know.

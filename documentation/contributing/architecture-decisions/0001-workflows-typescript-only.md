# 0001 — Workflows Are TypeScript-Only by Design

**Status**: Accepted

## Context

Weft is a durable execution engine. Its defining design choice is **checkpoint-not-replay**: workflows are `AsyncGenerator` functions, and at each `yield*` boundary the engine captures the workflow's user-visible state — the values currently bound to local variables — and persists it. On recovery, the engine restarts the generator function from the top, but each `yield*` consults the checkpoint store and short-circuits to the previously-recorded value instead of re-executing. The author writes what looks like ordinary control flow; the engine threads checkpointed values through it.

That mechanism has one strict prerequisite: the values the workflow holds at a yield boundary must be serializable. Weft uses a MessagePack codec with `structuredClone`-compatible semantics, so workflow locals must be plain data — primitives, plain objects, arrays, `Date`, `Map`, `Set`, `RegExp`, `ArrayBuffer`, `TypedArray`. They cannot include functions, class instances with methods, sockets, or other live runtime objects.

JavaScript `AsyncGenerator` is the language feature that makes this ergonomic. The generator's `next()` protocol gives the engine a re-entry point at each `yield*`, and TypeScript's type system lets `yield*` thread typed return values back into the workflow without the author having to model the suspension explicitly. The workflow code reads like normal `await`-style control flow.

No other mainstream language pairs an async-iterable suspension primitive with a `structuredClone`-shaped serialization story in its standard library. Python `async def` coroutines have no public frame-serialization API and no equivalent of `yield*`'s typed return-value plumbing. Go goroutines, Java continuations, .NET async state machines — each has its own internal representation, and none of those representations are designed to be persisted to disk and revived in a different process. The closest commercial analog is Temporal's replay model, which sidesteps the problem entirely by re-running history rather than capturing live state.

## The constraint

If we want polyglot workflows, we have three theoretical paths:

**Path A — TypeScript-only workflows, polyglot activities.** Workflows run on the engine in TypeScript. Activities (the side-effecting work) can run in any language, communicating with the engine via the [`RemoteWorker` wire protocol](../../reference/remote-worker-protocol.md).

**Path B — Replay-determinism for non-TS workflows.** Abandon checkpoint-not-replay for workflows in other languages, falling back to Temporal's model. Each non-TS SDK would need to enforce determinism in that language, with all the restrictions that implies (no system time, no random IDs, no parallel goroutines without explicit deterministic scheduling, etc.).

**Path C — A separate state store for non-TS workflows.** Treat the workflow as a state machine driven by external messages and persist the state explicitly. The engine becomes a coordinator rather than an execution host.

## Decision

**We choose Path A.** Workflows are TypeScript-only by design. Activities can run in any language via the `RemoteWorker` protocol. The split is intentional and load-bearing — the checkpoint model requires single-process generator state, so workflow code is TypeScript-only.

## Why not B or C

**Path B was rejected** because it abandons the defining design choice. Temporal already does Path B and does it well; Weft's reason to exist is to do something different. Layering replay-determinism back into a system whose core design assumes the absence of replay would create two execution models in one engine, with all the testing, debugging, and onboarding cost of supporting both. If a team needs polyglot workflow code, Temporal is the right answer.

**Path C was rejected** because it collapses back to Path B in practice. A "state machine driven by external messages" with persistent state and re-driven from messages on recovery is replay with extra steps. It also abandons the ergonomic win of writing workflows as ordinary control flow with `await` and loops — the thing that makes the TypeScript SDK pleasant to use.

## Consequences

- **Workflow definitions** must be authored in TypeScript and run on Bun, Node, or browser JavaScript runtimes.
- **Activities** can be authored in any language. The `RemoteWorker` protocol is the contract; any language with a WebSocket and JSON library can implement it.
- **Tooling assumes TypeScript.** Lint rules, type-aware checks, schema generation, codegen targets, and the public API snapshot all assume TS workflow code. Cross-language polyglot work expresses itself as activities behind `RemoteWorker`.
- **Documentation positions Weft as a TypeScript engine.** The README says so. The `docs/architecture/` pages cross-link to this ADR. The "is Weft right for me?" decision becomes: do you want workflows in TypeScript, or do you need workflows in multiple languages? If the latter, Temporal is the right answer.
- **The protocol contract for activities is durable.** The `RemoteWorker` protocol is documented separately ([reference](../../reference/remote-worker-protocol.md)) so SDK authors in other languages can implement compatible workers without reverse-engineering source.

## Forces

- The checkpoint model's read latency, write throughput, and recovery time make Weft attractive for high-throughput durable execution. We don't want to give those up to satisfy a "but does it run Python?" checkbox.
- The team's primary language is TypeScript. Polyglot workflow runtimes multiply the surface area for non-determinism bugs across languages we don't routinely write — that's a real cost, not a hypothetical one.
- Activities cover the cross-language need in practice. Most "we have a Python ML model" stories are activity-shaped: stateless, called with input, returning output. The rare workflow-shaped problem in another language is better served by Temporal.

## Polyglot activity contract

- **`RemoteWorker` conformance.** Cross-language SDKs can run `weft conformance -- <worker-command>` to verify the worker protocol behavior against a local Weft server.
- **Protocol drift prevention.** The RemoteWorker protocol document is checked against the exported schema catalog so message names stay aligned with the TypeScript contract.
- **Protocol versioning.** The worker WebSocket protocol is versioned. v2 requires `register.protocolVersion: 2` and rejects missing or unsupported versions with `registerError`.

## See also

- [Checkpoint versus Replay](../../architecture/checkpoint-versus-replay.md) — the foundational design choice this constraint flows from.
- [RemoteWorker wire protocol](../../reference/remote-worker-protocol.md) — the contract polyglot SDKs implement against.
- [Architecture Decisions overview](../architecture-decisions.md) — the inline-summary index.

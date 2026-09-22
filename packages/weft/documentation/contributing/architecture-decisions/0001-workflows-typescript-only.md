# TypeScript workflows and polyglot activities

Status: accepted. This is architecture decision 0001.

## Context

Weft runs workflows as TypeScript async generators. A workflow yields durable operations, and the engine records their results together with its step counter, durable context state, and recovery metadata. After a restart, the engine creates a fresh generator and reuses recorded operation results while advancing to unfinished work.

The checkpoint is not a serialized JavaScript stack. It does not automatically preserve arbitrary local variables, closures, sockets, or class instances. Workflow code between durable operations runs again, so the order and shape of those operations must remain compatible with persisted work. Side effects belong in activities; values that must remain stable across recovery belong behind a durable boundary such as `ctx.memo()`.

Persisted values must satisfy the engine’s [serialization contract](../../../src/core/codec.ts). A live host capability belongs in per-run `services`, which the host re-provides during recovery, rather than in serialized workflow data. The [Weft overview](../../../README.md#how-it-works) explains the execution contract and activity crash window.

## Decision

Keep workflow authoring in TypeScript and allow activities in other languages through the [remote-worker protocol](../../reference/remote-worker-protocol.md).

This is a scope and implementation decision, not a claim that other languages cannot support durable execution. The engine, types, context operations, recovery checks, and testing tools all target one generator runtime. Supporting another workflow language would require defining and maintaining its execution and recovery semantics, not merely translating JSON messages.

Remote activities already provide the useful cross-language boundary: the engine dispatches a named operation with serializable input, and the worker returns a result or failure. A Python model server or another language’s integration library can perform that work without becoming a second workflow runtime.

## Alternatives considered

A second workflow runtime would need its own authoring SDK, operation ordering, cancellation, recovery validation, and compatibility rules. That would expand every execution boundary the repository has to test and operate.

An external state-machine protocol could also coordinate non-TypeScript workflows. It would require callers to represent and persist their own transitions, changing the authoring model and introducing another public contract. This decision keeps that work outside the current engine’s scope.

## Consequences

- Workflow definitions use the TypeScript API and run in a supported JavaScript host. The Bun server and browser hosts have different platform capabilities.
- Activities can use any language that implements the versioned worker transport, registration, execution identity, cancellation, and result-fencing rules.
- The engine persists operation data, not arbitrary process state. Recovery compatibility and activity idempotency remain application responsibilities.
- New workflow features must work within the existing generator and checkpoint contracts. Cross-language integrations should first be expressed as remote activities.

## Verification

The [worker protocol reference](../../reference/remote-worker-protocol.md) is checked against the exported message-schema catalog. Protocol v6 requires `register.protocolVersion: 6`; missing or unsupported versions receive `registerError`.

From the repository root, run `bun packages/weft/src/cli-main.ts conformance --help` for the worker conformance command. The [remote-worker guide](../../guides/remote-workers.md) covers transport setup, and the [recovery guide](../../guides/remote-task-recovery.md) covers durable result ownership and adoption.

The execution explanation is backed by [suspend/resume regressions](../../../src/core/engine/suspend-resume.test.ts), [checkpoint replay reconstruction](../../../src/core/engine/checkpoint-replay.ts), and [worker replay validation](../../../src/workers/worker-replay-state.ts).

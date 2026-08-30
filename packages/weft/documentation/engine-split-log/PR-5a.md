# PR 5a: Server Context

`serve()` now gathers its closure-captured server state into an internal
`ServerContext` record in `src/server/index.ts`.

The context owns the worker registry, task queue, WebSocket maps, sticky worker
affinity, workflow operation indexes, pending retry timers, deadline tracker,
live REST and JSON-RPC registries, event feed wiring, authentication promise,
and visibility reconciliation state. Nested helpers and callbacks now reach
that state through `context.fieldName` instead of capturing separate local
variables.

The Bun server handle stays outside `ServerContext` because `Bun.serve()`
creates it while also receiving callbacks that eventually reference it. Later
engine-split pull requests can extract those callbacks by passing
`ServerContext` directly without changing the public `serve()` signature or
`WeftServer` return type.

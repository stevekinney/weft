# Web Standards as the Foundation

Weft is built entirely on web standards. Not as a marketing claim—as a literal architectural constraint. Every layer of the engine maps to a standard that exists in browsers, in Bun, and often in Deno and Cloudflare Workers too.

The payoff is portability. Any code that only touches the engine layer—generators, `structuredClone`, `AbortController`, UUIDs—runs identically everywhere. Platform-specific code is confined to the storage and server layers, where it belongs.

## The stack

Here's how the layers break down.

```
┌─────────────────────────────────────────────────────────────┐
│                        Your Code                            │
│            async function* myWorkflow(ctx) { ... }          │
├─────────────────────────────────────────────────────────────┤
│                      Weft Engine                            │
│  Generators │ structuredClone │ AbortController │ UUIDs     │
├──────────────────────┬──────────────────────────────────────┤
│   Server (Bun)       │        Browser                       │
│   Bun.serve()        │   Service Worker (fetch event)       │
│   Web Workers        │   Web Workers                        │
│   bun:sqlite         │   IndexedDB                          │
│   BroadcastChannel   │   BroadcastChannel                   │
│   WebSocket          │   WebSocket (to remote server)       │
├──────────────────────┴──────────────────────────────────────┤
│                   Wire Protocol                             │
│    REST + SSE + JSON-RPC (HTTP / WebSocket / stdio) + MCP   │
│        JSON (wire) / MessagePack (checkpoint storage)       │
└─────────────────────────────────────────────────────────────┘
```

The engine row is the key. Everything there is a web standard that works in any JavaScript runtime. The server and browser rows are where platform-specific implementations live—but they implement the same interfaces.

The wire protocol uses JSON over HTTP, WebSocket, stdio, and [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) transports. MessagePack is the default codec for checkpoint storage, not an alternative HTTP body format.

## The primitive mapping

Every need in the engine maps to a specific web standard, with optional Bun-specific enhancements for server-side performance.

| Need                    | Web Standard                                 | Bun Enhancement                                |
| ----------------------- | -------------------------------------------- | ---------------------------------------------- |
| IDs                     | `crypto.randomUUID()`                        | —                                              |
| Serialization           | `structuredClone()`                          | Fast path for `postMessage`                    |
| Cancellation            | `AbortController` / `AbortSignal`            | —                                              |
| Timers                  | `setTimeout` (non-durable)                   | Stored as operations in the database (durable) |
| Parallelism             | `Worker` (Web Workers)                       | OS threads with shared I/O                     |
| Inter-thread messaging  | `postMessage` / `MessageChannel`             | Transferable optimizations                     |
| Pub/sub between threads | `BroadcastChannel`                           | Cross-worker event dispatch                    |
| HTTP server             | `fetch` event handler                        | `Bun.serve()` with native performance          |
| Streaming               | `ReadableStream` / `WritableStream`          | —                                              |
| Binary encoding         | `TextEncoder` / `TextDecoder`, `ArrayBuffer` | —                                              |

A few of these deserve explanation.

**`crypto.randomUUID()`** generates workflow and operation IDs. It's available in every modern runtime and produces cryptographically random UUIDs without any external dependency.

**`structuredClone()`** is how checkpoints are serialized. It's the same algorithm browsers use for `postMessage`, which means checkpoint data can be transferred between Web Workers with zero overhead.

**`AbortController` / `AbortSignal`** handles workflow cancellation, budget limits, and timeouts. Because it's the standard cancellation mechanism, it composes naturally with `fetch`, with Bun's server, and with any library that accepts an `AbortSignal`.

**`BroadcastChannel`** enables pub/sub coordination between workers without direct references. Create a named channel, and any worker subscribed to that name receives messages. It works identically in Bun and in browsers.

**`ReadableStream` / `WritableStream`** power event streaming, context window management, and stream multiplexing. These are the same stream primitives that `fetch` responses use.

## What runs where

The portability story breaks down into three tiers.

**Runs everywhere** (any JavaScript runtime): generators, `structuredClone`, `AbortController`, `crypto.randomUUID`, `ReadableStream`, `TextEncoder`/`TextDecoder`, `EventTarget`. This covers the entire engine core.

**Runs in Bun and browsers**: `Worker`, `BroadcastChannel`, `postMessage` with transferables, `WebSocket`. This covers execution isolation and inter-thread coordination.

**Bun-specific**: `Bun.serve()`, `bun:sqlite`, `bun build --compile`, the `smol` option for Workers. This covers the server shell and embedded storage.

The browser equivalents slot in naturally: `Bun.serve()` becomes a Service Worker `fetch` event handler, `bun:sqlite` (SQLite) becomes IndexedDB, and the rest is identical.

This layering means the same workflow code runs in both environments without modification. The engine doesn't know or care whether it's running on a server or in a browser tab. It just uses web standards, and the platform provides the implementations.

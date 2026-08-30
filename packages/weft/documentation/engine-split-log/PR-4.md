# PR 4: AI Subsystem Splits

This split removes the tracked max-lines disables from five oversized AI
modules without changing their import paths.

`src/ai/events.ts` is now a pure barrel over `src/ai/events/`. Turn, tool,
budget, context, model fallback, provider health, human review, and checkpoint
events each live in focused domain files. The directory `index.ts` rebuilds the
`WeftAgentEventMap` union and re-exports the event classes.

The former prompt-prefix cache split has been removed from the current public
agent surface. Historical notes should treat that work as superseded by the
AI Surface Shrinkage refactor.

`src/ai/coordination.ts` is now a pure barrel over `src/ai/coordination/`.
Trace propagation, conversation summarization, handoff, debate, supervised
execution, and supervise-only helpers now live in separate modules while the
directory `index.ts` preserves the public coordination exports.

`src/ai/streaming-agent.ts` is now a pure barrel over
`src/ai/streaming-agent/`. Streaming types moved to `types.ts`, chunk assembly
moved to `chunk-handler.ts`, token enqueueing moved to `token-enqueue.ts`,
provider wrapping moved to `provider-wrapper.ts`, crash-recovery helpers moved
to `checkpoint.ts`, and SSE formatting moved to `sse.ts`. The directory
`index.ts` keeps `executeStreamingAgent` and re-exports the existing public
streaming API.

`src/ai/agent.ts` is now a pure barrel over `src/ai/agent/`. Public and
internal agent loop types moved to `types.ts`, MCP/local tool initialization
moved to `tool-initialization.ts`, runtime setup and result construction moved
to `runtime.ts`, turn preparation moved to `turn.ts`, provider chat fallback
handling moved to `chat.ts`, tool execution and cache helpers moved to
`tool-execution.ts`, and turn completion/checkpoint warning dispatch moved to
`finalize.ts`. The directory `index.ts` keeps the main agent loop and public
agent re-exports.

# Agent-Native Engine (removed in v0.1.0)

Weft's built-in agent surface — `ctx.agent()`, `ctx.handoff()`, `ctx.debate()`, `ctx.supervise()`, the `weft.agent()` declaration, the agent runtime, and all agent types and events — was removed in v0.1.0. Weft does not ship an agent primitive.

Build durable agent loops on `ctx.run()` and `ctx.review()`, or run an external agent framework inside an activity. The choice affects recovery granularity. If you model each LLM call and tool call as its own `yield* ctx.run(...)` step, Weft checkpoints every one independently — a crash resumes mid-loop. If you run a whole framework loop as a single activity, the loop is opaque to the engine: it checkpoints only at the boundary, so a crash re-runs the entire loop. To get yield-level recovery, expose the internal turns as separate `ctx.run()` steps. Either way, `ctx.review()` provides the human-in-the-loop step, and cost tracking, budget enforcement, model routing, and context-window management live in your userland loop (or the framework), not in the engine.

See the [`CHANGELOG`](../../CHANGELOG.md) for the full list of removed exports and upgrade notes.

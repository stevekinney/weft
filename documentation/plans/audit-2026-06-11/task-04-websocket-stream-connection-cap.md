# Task 04: Cap stream/watch WebSocket connections per workflow

**Severity:** medium

## Finding: No per-workflow or global cap on stream/watch WebSocket connections

- **Severity:** medium (security)
- **Files (audit snapshot):** `src/server/runtime/websocket-stream.ts`, `src/server/runtime/websocket-upgrade.ts`

### Evidence

websocket-stream.ts:41-52 addStreamSocket adds to context.streamSockets with zero size guards. JSON-RPC WebSocket path has DEFAULT_MAX_SUBSCRIPTIONS=100 per session. Stream/watch upgrade path has no equivalent — an attacker can open thousands of sockets to a single workflow exhausting file descriptors.

### Required fix

Add a maxStreamConnectionsPerWorkflow cap (default 100, configurable in ServeOptions) enforced in addStreamSocket. If exceeded, close the incoming socket with 1008 Policy Violation. Mirror the pattern from DEFAULT_MAX_SUBSCRIPTIONS in json-rpc-websocket.ts.

## Acceptance criteria (all required — completion is binary)

- [ ] addStreamSocket enforces a per-workflow connection cap (default 100, configurable via ServeOptions); the cap constant is named and documented.
- [ ] A connection over the cap is closed with WebSocket close code 1008; regression test proves the cap and that closing one socket frees a slot.
- [ ] configuration.md / api-server.md document the new option.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.

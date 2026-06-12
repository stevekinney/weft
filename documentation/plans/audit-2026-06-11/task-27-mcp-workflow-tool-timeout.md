# Task 27: Timeout for per-workflow MCP tool calls

**Severity:** medium

## Context

`src/mcp/tools.ts:156-163` auto-generated per-workflow tools call `await handle.result()` with no timeout. If the workflow is suspended or waiting for a signal indefinitely, the tool call's HTTP response handler remains open until the MCP host's own connection timeout.

## Evidence

- `mcp/tools.ts:156-163`: `const result = await handle.result()` — no AbortSignal threading from the MCP request cancellation path through to the result await.
- `dispatcher.ts:91-96`: handles `notifications/cancelled` but only checks cancellation before start (line 153) and after start (line 159) — not during the result await.
- Suspended workflows (documented public API: `engine.suspend()`) have a `handle.result()` that is permanently pending until resumed.

## Proposed Design

1. Add an optional `timeoutMs` parameter to per-workflow MCP tools (default: 30,000ms).
2. If `handle.result()` does not resolve within the timeout, return a tool result with `isError: false` indicating the workflow is running but not yet complete, including the `workflowId` so the agent can call `get_workflow_state` to poll.
3. Properly thread the `notifications/cancelled` signal into the `handle.result()` promise via `AbortSignal`, so MCP host cancellation also unblocks the await.

## Acceptance Criteria

- A suspended workflow does not cause its MCP tool call to hang past the configured timeout.
- When the timeout fires, the tool returns a structured partial result with `workflowId` for subsequent polling.
- MCP `notifications/cancelled` aborts the `handle.result()` await.

## Acceptance criteria (all required — completion is binary)

- [ ] Per-workflow MCP tool calls have a configurable timeout (sensible default) that returns a structured timed-out-but-running result naming the workflow id and how to query it later — not a hung call and not a workflow cancellation.
- [ ] Regression test: a workflow parked on waitForSignal produces the timeout shape; the workflow keeps running.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.

# Task 21: MCP tools/list listChanged notifications for dynamic workflow registration

**Severity:** medium

## Finding: MCP tools/list returns listChanged: false permanently — agents miss dynamically registered workflows

- **Severity:** medium (dx)
- **Files (audit snapshot):** `src/mcp/dispatcher.ts`, `src/mcp/tools.ts`

### Evidence

dispatcher.ts:151 hardcodes tools: { listChanged: false }. No notifications/tools/list_changed message is ever sent. The WeakMap cache in tools.ts invalidates on definition changes so tools/list returns fresh data on explicit call, but clients trusting listChanged: false per MCP spec will cache stale tool lists. engine.register() is a supported public API callable post-startup.

### Required fix

Either hook engine.register() events to push notifications/tools/list_changed and flip capability to listChanged: true, or document the limitation explicitly in api-server.md so agents know to call tools/list on each session rather than caching.

## Acceptance criteria (all required — completion is binary)

- [ ] When the registered tool set changes, MCP sessions receive the standard listChanged notification and capability flags reflect reality.
- [ ] Regression test: register a workflow after session start, observe the notification and the updated tools/list.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.

# Task 06: server.stop() drains in-flight remote worker tasks before teardown

**Severity:** medium

## Finding: server.stop() does not drain in-flight remote worker tasks before tearing down

- **Severity:** medium (durability)
- **Files (audit snapshot):** `src/server/serve-internals.ts`, `src/server/runtime/shutdown.ts`, `src/cli-main.ts`

### Evidence

registerStackDisposers disposal chain never calls shutdownAllWorkers. CLI SIGINT/SIGTERM handlers call server.stop() directly with no preceding shutdownAllWorkers. Connected workers receive no shutdown frame; inflight taskResult messages arriving on a closed socket are silently lost. At-least-once is preserved via storage but causes unnecessary re-execution and incremented attempt counters.

### Required fix

In registerStackDisposers, add a disposal step that calls shutdownAllWorkers with a configurable timeout (defaulting to DEFAULT_SHUTDOWN_TIMEOUT_MS) before stopping the Bun server. Update the stop() JSDoc to document the drain behavior.

## Acceptance criteria (all required — completion is binary)

- [ ] Disposal calls shutdownAllWorkers (configurable timeout, defaulting to DEFAULT_SHUTDOWN_TIMEOUT_MS) before the Bun server stops, on both the server.stop() path and the CLI signal path.
- [ ] A connected worker receives the shutdown frame and an in-flight taskResult delivered during the drain window is persisted, not lost — regression test simulates this.
- [ ] stop() JSDoc documents the drain behavior.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.

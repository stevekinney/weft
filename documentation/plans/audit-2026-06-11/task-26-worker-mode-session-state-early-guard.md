# Task 26: Actionable worker-mode guard for ctx.state.session()

**Severity:** medium

## Context

`src/workers/workflow-runner.ts:90-96` stubs `ctx.state.session()` to throw at first call inside the generator. There is no construction-time or registration-time check. The failure surfaces deep in workflow execution after side-effecting steps may have already committed.

## Evidence

- `workflow-runner.ts:91-96`: `createWorkerStateNamespace` stubs `session` as `() => { throw new Error('ctx.state.session() is not supported in worker execution mode...') }`
- `documentation/reference/api-context.md:527-555`: documents `ctx.state.session()` with examples but no warning that it throws in worker mode.
- `api-context.md` step-form section (line 594) does carry a worker-mode incompatibility warning — the pattern is established but not applied to `ctx.state.session()`.

## Required fix

A registration-time or startup-time static check is not feasible — whether a workflow generator calls `ctx.state.session()` cannot be known without executing it, and the review committee rejected heuristic source scanning. The single required bar is an actionable first-call failure plus the documentation callout:

1. The worker-mode `ctx.state.session()` stub throws, on first call, an error naming the workflow type, the unsupported call, and both fix paths (switch the workflow to `workflowExecutionMode: 'inline'`, or use workflow-scoped `ctx.state` instead of session scope).
2. Add a `[!WARNING]` callout to `api-context.md` in the `ctx.state.session()` section, matching the pattern already established for the step-form worker-mode warning, pointing to the list of context features unavailable in worker mode.

## Acceptance criteria (all required — completion is binary)

- [ ] Calling ctx.state.session() in worker execution mode throws, on first call, an error naming the workflow type, the unsupported call, and both fix paths — pinned by a regression test.
- [ ] api-context.md carries the [!WARNING] callout in the ctx.state.session() section, and the workflowExecutionMode reference lists the unsupported context surfaces.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.

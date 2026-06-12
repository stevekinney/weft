# Task 20: Warn when recovery yields ctx.services === undefined

**Severity:** medium

## Finding: Omitting resolveWorkflowServices silently yields ctx.services === undefined on recovery with no warning emitted

- **Severity:** medium (dx)
- **Files (audit snapshot):** `src/core/engine/lifecycle/recovered-services.ts`, `documentation/guides/workflows.md`

### Evidence

recovered-services.ts:47-50: when resolver is null, the function returns false before checking the workflowHasServices marker. A workflow started with services: { db } that recovers without resolveWorkflowServices proceeds with ctx.services === undefined — silently. No event, no log, no diagnostic. The guide says to configure resolveWorkflowServices but does not warn what happens if you don't.

### Required fix

In reprovideRecoveredServices, when !resolver and the workflowHasServices storage marker is present, emit a DevelopmentWarningEvent (or log warning) naming the workflow and explaining that ctx.services will be undefined. Add a warning callout to the services section of workflows.md.

## Acceptance criteria (all required — completion is binary)

- [ ] Recovering a workflow that was started with services but cannot re-provide them (no resolveWorkflowServices) emits an actionable warning naming the workflow id and the option to set — and the run fails per the documented services contract rather than proceeding with undefined.
- [ ] Regression test covers running-recovery, delayed-start recovery, and scheduled-occurrence paths.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.

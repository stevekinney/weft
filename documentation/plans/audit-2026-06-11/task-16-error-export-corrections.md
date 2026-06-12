# Task 16: Error surface corrections: WorkflowSuspendNotSupportedError code, BranchTopologyChangedError export

**Severity:** medium

## Finding: WorkflowSuspendNotSupportedError exported from package root but absent from WeftErrorCode union

- **Severity:** medium (dx)
- **Files (audit snapshot):** `src/core/weft-error.ts`, `src/core/engine/errors.ts`, `src/index.ts`

### Evidence

errors.ts line 285 defines WorkflowSuspendNotSupportedError. index.ts line 50 re-exports it. weft-error.ts lines 90-121 publicWeftErrorCodeMap does not include it. isWeftErrorCode('WorkflowSuspendNotSupportedError') returns false. The breaking-changes policy classifies error code changes as breaking for WeftErrorCode-listed classes — this class has no stability contract despite being a public export.

### Required fix

Add 'WorkflowSuspendNotSupportedError' to the WeftErrorCode union type and to publicWeftErrorCodeMap in src/core/weft-error.ts. The map uses satisfies Record<WeftErrorCode, true> so both additions are required together.

## Finding: BranchTopologyChangedError mentioned in docs and thrown publicly but not exported from package root

- **Severity:** medium (dx)
- **Files (audit snapshot):** `src/core/context/parallel-cache-entry.ts`, `src/index.ts`, `documentation/guides/parallel-execution.md`

### Evidence

parallel-execution.md:46 and api-context.md:237 both reference BranchTopologyChangedError by class name as something to catch. src/core/context/parallel-cache-entry.ts:65 defines it. Zero exports in src/index.ts. Also absent from WeftErrorCode. Users cannot write catch (e) { if (e instanceof BranchTopologyChangedError) ... } without an internal import path.

### Required fix

Export BranchTopologyChangedError from src/index.ts and add it to WeftErrorCode. Update parallel-execution.md to show the catch pattern with instanceof.

## Acceptance criteria (all required — completion is binary)

- [ ] WorkflowSuspendNotSupportedError has a WeftErrorCode union member; BranchTopologyChangedError is exported from the package root; both are covered by .test-d.ts type tests against the built package.
- [ ] `bun run build` post-build guards pass; error documentation references both.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.

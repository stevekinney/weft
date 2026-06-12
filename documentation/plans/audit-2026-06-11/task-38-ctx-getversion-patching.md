# Task 38: ctx.getVersion: in-flight workflow patching

**Severity:** high

> [!IMPORTANT]
> Depends on Task 31 merging first. Do not start until it has landed on main.

## Finding: No in-flight workflow versioning / patch API for running workflows

- **Severity:** high (feature-gap)
- **Files (audit snapshot):** `src/core/versioning.ts`, `src/core/types/workflow-context.ts`

### Evidence

src/core/versioning.ts provides checkVersionCompatibility (line 46) which returns 'compatible' or 'incompatible' — a hard gate that throws VersionMismatchError on any version mismatch. There is no ctx.getVersion(changeId, minSupported, maxSupported) API (Temporal's patching primitive) that lets a workflow branch deterministically based on which code version started it. The engine either accepts a run fully or rejects it — there is no path where in-flight workflows on old code and newly-started workflows on new code coexist and diverge only at the specific changed step.

### Required fix

Add ctx.getVersion(changeId: string, minSupported: number, maxSupported: number): WorkflowOperation<number>. On first execution it checkpoints the current maxSupported version under changeId. On replay it returns the checkpointed version (which may be older). The durable location is solely a named checkpoint-local entry keyed `version:{changeId}` (see the resolved design below). This allows: old workflows to keep following the old branch, new workflows to take the new branch, and a safe deprecation path (remove min-supported branch once no workflows on that version remain). Requires adding a new operation type 'get-version' to ContextOperationRequest and a corresponding handler in operations-activity.ts.

### Verifier note

The severity is correct. The gap is real and matters for Temporal parity. However, the finding's framing should note that the documentation explicitly presents this as an architectural trade-off, not an oversight — the authors are aware of `patched()` and chose to reject it. The claim that checkpointing eliminates the need for a patch API is overstated: it holds only for the trivial append-after-checkpoint case. For the general case (changing logic that in-flight workflows haven't yet executed), users are left with the drain-first pattern (keep old code registered until all in-flight runs complete, then deploy), which is operationally heavier than Temporal's in-binary branching. The proposed fix (`ctx.getVersion(changeId, minSupported, maxSupported)` pinned as a named checkpoint-local entry) is architecturally sound and consistent with how Weft's other durable operations work, but it would require: a new `'get-version'` operation type in `src/core/context/operation-request.ts`, a handler in `src/core/engine/operations-activity.ts`, and exposure on `WorkflowContext` in `src/core/types/workflow-context.ts`. The `src/core/versioning.ts` file itself needs no changes — the gap is in the `WorkflowContext` surface, not the version comparison utilities.

## Resolved durable-location design

The committee resolved the storage ambiguity in the original fix text: the version pin is stored as a NAMED ENTRY IN CHECKPOINT LOCALS keyed by changeId (e.g. `version:{changeId}`) — NOT in accumulatedResults. This keeps it orthogonal to the accumulated-results pruning task. First execution of `ctx.getVersion(changeId, minSupported, maxSupported)` pins maxSupported into locals within that step's checkpoint commit; subsequent executions (including after recovery) return the pinned value; a pinned value below minSupported fails the run with an actionable error. File references in the evidence may be stale — locate the operation-handling seam by symbol. This task DEPENDS ON the checkpoint-prune task landing first so the locals/results boundary is settled.

## Acceptance criteria (all required — completion is binary)

- [ ] ctx.getVersion(changeId, min, max) pins on first execution, returns the pin on later executions and recovery, and errors actionably when the pin is below minSupported — all pinned by tests including a crash-between-pin-and-next-step case.
- [ ] workflow-versioning.md documents the deploy pattern (old branch retained until no runs pinned below N) alongside the existing drain-first guidance.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.

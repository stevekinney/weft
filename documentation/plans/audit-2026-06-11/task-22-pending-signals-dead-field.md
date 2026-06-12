# Task 22: Remove the dead pendingSignals checkpoint field

**Severity:** low

## Finding: pendingSignals checkpoint field is always empty — misleading dead field in schema

- **Severity:** low (dx)
- **Files (audit snapshot):** `src/core/types/checkpoint.ts`, `src/core/checkpoint/lifecycle.ts`

### Evidence

checkpoint.ts:114: pendingSignals: string[] field. lifecycle.ts:28 initializes as [], lifecycle.ts:69 carries forward unchanged. No production code ever writes a non-empty value. The field name implies signals are stored in checkpoints (which would solve the crash-loss problem), but they are not — signals are separate sig: keys. architecture/research.md:16 names pendingSignals as a captured value implying design intent that was never implemented.

### Required fix

Remove the field from fresh checkpoint writes and add a comment at the former definition site explaining that signals are stored as separate `sig:` storage keys, not in checkpoints. (Populating the field for observability and keeping it as a reserved-comment placeholder were both considered and rejected — see the resolved design below. Do not implement either.)

## Resolved design

The committee resolved the either/or: REMOVE the field from fresh checkpoint writes. Decode tolerates persisted checkpoints that still carry it (read normalization, consistent with the versionTuple precedent). Do not populate it; do not keep it as a reserved comment.

## Acceptance criteria (all required — completion is binary)

- [ ] Fresh checkpoints no longer serialize pendingSignals; decoding an old checkpoint containing it still works (pinned by a fixture test).
- [ ] The checkpoint schema docs/types no longer advertise the field.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.

# Task 07: TursoStorage: distinguish SQLITE_BUSY from CAS precondition mismatch

**Severity:** critical

## Finding: TursoStorage.conditionalBatch returns false on SQLITE_BUSY, conflating infrastructure failure with CAS precondition mismatch

- **Severity:** critical (durability)
- **Files (audit snapshot):** `src/storage/turso.ts`

### Evidence

turso.ts:351-373: beginWriteTransaction returns null on SQLITE_BUSY and conditionalBatch returns false in that case. false from conditionalBatch means 'precondition not met' — the engine interprets this as a conflicting run already existing. Under lock contention, the real start is silently swallowed. NeonStorage correctly throws after retry exhaustion; Turso silently conflates contention with semantic CAS failure.

### Required fix

On SQLITE_BUSY, retry with backoff (up to MAX_RETRIES) then throw if retries are exhausted — mirroring the NeonStorage pattern. Never return false for infrastructure failures: false is a semantic result (precondition not satisfied), throw is for infrastructure failures.

## Acceptance criteria (all required — completion is binary)

- [ ] SQLITE_BUSY (and equivalent transient contention) results in bounded retry or a typed retryable infrastructure error — never a `false` CAS result.
- [ ] Regression test injects BUSY and asserts the caller can distinguish contention from a genuine precondition mismatch.
- [ ] NeonStorage’s contention/CAS split is the reference semantics; the Turso adapter’s capabilities() story stays honest.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.

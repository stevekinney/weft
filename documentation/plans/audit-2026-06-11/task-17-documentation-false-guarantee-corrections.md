# Task 17: Correct false guarantees: README exactly-once overclaim, non-compiling temporal-comparison example, migration.md breaking-changes claim

**Severity:** high

## Finding: README overclaims activity exactly-once execution for payment workflows

- **Severity:** high (documentation)
- **Files (audit snapshot):** `README.md`, `documentation/architecture/tier-0-behavioral-contract.md`

### Evidence

README.md line 287: 'the charge runs exactly once.' tier-0-behavioral-contract.md line 5 says 'The goal is not blanket exactly-once execution.' activities.md lines 188-191 says 'Activities are at-least-once side effects. Payment providers... still need their own idempotency keys.' The activity reconciliation record that would close the crash window is explicitly marked not yet implemented at tier-0-behavioral-contract.md line 11.

### Required fix

Change README.md line 287 to qualify the exactly-once claim: clarify that chargeCard may re-execute on crash-before-checkpoint and users must pass an idempotency key to their payment provider. Link to the activities guide's at-least-once callout.

## Finding: temporal-comparison.md shows a non-existent engine.start() API overload that cannot compile

- **Severity:** high (documentation)
- **Files (audit snapshot):** `documentation/architecture/temporal-comparison.md`, `documentation/architecture/checkpoint-versus-replay.md`

### Evidence

temporal-comparison.md lines 75-85 shows engine.start('onboard', async (ctx) => {...}, { name: 'Alice' }) — passing an inline async function as the second argument. This overload does not exist. engine.start() takes (type, input, options). The real API requires workflow({ name }).execute(compileStepWorkflow(fn)) + engine.register() + engine.start(type, input). checkpoint-versus-replay.md lines 62-74 shows a non-existent CheckpointSerializationError class; the actual emission is DevelopmentWarningEvent with a bare message string.

### Required fix

Replace the pseudocode blocks in temporal-comparison.md and checkpoint-versus-replay.md with the actual API pattern. For the error example, show what the engine actually emits: a DevelopmentWarningEvent with message and fieldPaths, and how to listen via engine.addEventListener.

## Finding: migration.md falsely claims no breaking changes have been documented, contradicting CHANGELOG

- **Severity:** high (documentation)
- **Files (audit snapshot):** `documentation/guides/migration.md`, `CHANGELOG.md`

### Evidence

migration.md: 'there are no entries yet because no release so far has required migrating existing call sites or data.' CHANGELOG.md line 89: '### Removed — multi-tenancy (BREAKING)' under 0.3.0. CHANGELOG.md lines 398-450 under 0.1.0: '### Removed (breaking)' removing the entire agent surface (~30 exports) with explicit migration guidance already written in the CHANGELOG. Additional breaking renames and removals at lines 153, 265, 285.

### Required fix

Populate migration.md with a 'Migrating from 0.2.x/0.1.x to 0.3.0' section covering multi-tenancy removal and agent surface removal, using the content already written in CHANGELOG.md. The CHANGELOG has all the content; migration.md needs to surface it as actionable steps.

## Acceptance criteria (all required — completion is binary)

- [ ] README describes the actual contract: activity execution is at-least-once — a crash before checkpoint commit can re-execute the activity — and side effects are made safe only by passing an idempotency key (or equivalent verifier) to the external provider. No "exactly once" execution claim survives anywhere in the README; wording is consistent with the Tier-0 behavioral contract and the activities guide's at-least-once callout.
- [ ] Every code example in temporal-comparison.md compiles against the current public surface (markdown doctests prove it).
- [ ] migration.md surfaces every breaking change recorded in CHANGELOG.md (and cross-checks BREAKING-CHANGES.md at the repository root) as actionable migration steps — at minimum the 0.3.0 multi-tenancy removal and the 0.1.0 agent-surface removal.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.

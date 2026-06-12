# Task 24: Guard RegExp deserialization from checkpoint bytes

**Severity:** medium

## Context

The RegExp extension decoder in `src/core/codec/extension-codec.ts:52-57` calls `new RegExp(source, flags)` where both `source` and `flags` come directly from msgpack-decoded checkpoint bytes with no validation or try/catch.

## Evidence

- `extension-codec.ts:52-57`: `new RegExp(source, flags)` — no try/catch, no length check on source.
- `validateCheckpointShape` runs after codec decode, so it cannot protect against this.
- An invalid `flags` string (e.g., an unrecognized flag letter introduced in a newer JS engine version) throws an uncaught error that propagates out of `deserializeCheckpoint`, crashing the affected workflow's recovery.
- Note: Bun/JavaScriptCore uses a DFA engine, so ReDoS is not a concern. The vulnerability is that invalid flags can crash recovery.

## Impact

A checkpoint written by a newer Bun version that uses a newer RegExp flag can permanently prevent recovery on an older Bun version. Corrupt checkpoint bytes can also trigger this. The crash is isolated to the affected workflow's recovery, not engine-wide.

## Required fix

1. Wrap `new RegExp(source, flags)` in try/catch and rethrow a descriptive error naming the source/flags values so the failure is actionable.
2. Add a maximum-length check on `source` (65535 bytes) before construction.
3. Document in the extension-codec JSDoc that `RegExp` values in checkpoints are version-sensitive and that upgrading Bun may produce checkpoints unreadable by older versions.

## Acceptance criteria (all required — completion is binary)

- [ ] RegExp extension decode validates flags and bounds source length (try/catch around construction) and surfaces a typed decode error naming the extension tag, the source, and the flags — not an uncaught exception that crashes recovery wholesale.
- [ ] Regression test feeds a checkpoint fixture with invalid RegExp flags and asserts recovery survives with the documented failure mode; a second test pins the source-length bound.
- [ ] Extension-codec JSDoc documents the version-sensitivity of persisted RegExp values.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.

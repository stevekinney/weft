# Task 19: Typed Engine event surface

**Severity:** medium

## Finding: Engine extends untyped EventTarget — opening events.md example does not typecheck, guide recommends double-cast

- **Severity:** medium (dx)
- **Files (audit snapshot):** `src/core/engine/index.ts`, `src/core/events/event-map.ts`, `documentation/guides/events.md`

### Evidence

Engine extends EventTarget (index.ts:356) without implementing TypedEventTarget<WeftEventMap>. events.md line 76 shows engine as unknown as TypedEventTarget<WeftEventMap> — the double-cast CLAUDE.md conventions flag as a red flag. The opening events.md example (lines 10-12) accesses event.workflowId and event.duration on a plain Event parameter — does not typecheck.

### Required fix

Have Engine implement TypedEventTarget<WeftEventMap> by declaring typed addEventListener/removeEventListener overloads inline on the class (approx. 10 lines). This eliminates the double-cast, makes the opening events.md example typecheck, and removes the as DevelopmentWarningEvent cast from all JSDoc examples.

## Acceptance criteria (all required — completion is binary)

- [ ] Engine exposes a typed event-listener surface (typed addEventListener overloads or an equivalent typed emitter facade) such that the events.md opening example typechecks with no casts.
- [ ] events.md examples are markdown-doctested; a .test-d.ts pins the typed listener inference.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.

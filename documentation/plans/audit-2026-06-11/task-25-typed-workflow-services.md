# Task 25: Generic typing for ctx.services

**Severity:** low

## Context

`src/core/types/workflow-context.ts:220` declares `readonly services?: unknown`. The JSDoc acknowledges 'A threaded generic is a deliberate follow-on, not part of this surface yet.' Every workflow that uses services must write a type guard or an `as` cast — the pattern the project's own CLAUDE.md conventions mark as suspect.

## Evidence

- `workflow-context.ts:220`: `readonly services?: unknown`
- `documentation/guides/workflows.md:183-186`: shows the recommended `isOrderServices(ctx.services)` type guard — 8-10 lines of boilerplate per workflow.
- The JSDoc explicitly defers the generic parameter as a planned follow-on.

## Required fix

Add a generic type parameter `TServices = unknown` to `WorkflowContext<TServices>` and thread it through:

- `Engine<TServices>` (or resolved from `resolveWorkflowServices` return type)
- `WorkflowHandle<TServices>` (for observable service type at handle level)
- `engine.start()` and `engine.register()` so TypeScript infers the services type

This eliminates the `as` cast, makes the opening workflows.md example typecheck correctly, and allows typed service injection without boilerplate type guards.

## Design boundary

Before implementing, enumerate every public type the generic touches (workflow builder options, WorkflowContext, Engine.create registration, ServeOptions inference, generated clients if any) and add .test-d.ts coverage FIRST; the generic must default to the current behavior (`unknown`) so every existing call site compiles unchanged. If threading the generic forces a breaking change to any candidate-stable surface, stop and report rather than shipping the break.

## Acceptance criteria (all required — completion is binary)

- [ ] Workflows can declare a services type once and ctx.services is typed accordingly with no `as` cast at access sites; default stays unknown; zero existing call sites break (type tests prove all three).
- [ ] .test-d.ts covers inference at definition, context, and Engine.create boundaries before the implementation lands (TDD at the type level).

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.

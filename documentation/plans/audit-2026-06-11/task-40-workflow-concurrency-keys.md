# Task 40: First-class workflow concurrency limits with partition keys

**Severity:** medium

## Finding: No Inngest-style flow control: throttle, debounce, batch-events, concurrency keys per tenant

- **Severity:** medium (feature-gap)
- **Files (audit snapshot):** `src/core/concurrency.ts`, `src/core/types/options.ts`, `src/core/types/workflow-function.ts`

### Evidence

src/core/concurrency.ts provides DurableSemaphore/DurableMutex as primitives, but these are manual building blocks. There is no built-in throttle (max N executions per time window), debounce (delay execution until a signal stops arriving), batch-trigger (accumulate N events then start one workflow), or per-tenant concurrency key as first-class EngineOptions. src/core/types/options.ts has no maxConcurrency, throttlePolicy, or batchTrigger options. Inngest makes these first-class scheduling constraints declared on the function definition.

### Required fix

Add a concurrency field to workflow definition options (workflow({ name: 'x', concurrency: { max: 3, key: (input) => input.tenantId } })). The engine enforces this at start-time using the existing DurableSemaphore + AtomicState mechanism as the backing store, acquiring a lease before start and releasing it on terminal cleanup. Debounce and batch-trigger are harder: debounce requires a scheduled delay that restarts on each signal (achievable with schedule + cancel-running overlap policy). Batch-trigger requires a collector workflow pattern. Document these patterns rather than baking them in for v1.

### Verifier note

The finding is accurate as stated. One clarification: the `concurrency` field that exists on `WorkflowMapOptions` (line 291 of `workflow-function.ts`) should not be confused with the absent per-type start-time enforcement — it controls child-workflow fan-out parallelism inside `ctx.map()`, a different concern entirely. The proposed fix is well-scoped: a `concurrency` field on `WorkflowBuilderOptions` enforced by the engine at `engine.start()` time using the existing `DurableSemaphore`+`AtomicState` mechanism is achievable without architectural changes. Debounce and batch-trigger are correctly identified as pattern-documentation concerns rather than v1 primitives, keeping the fix proportionate. Neither Temporal nor Inngest comparisons are over-stated — Temporal's `maxConcurrentWorkflowTaskExecutors` is a worker-level cap (different layer), while Inngest's `concurrency.key` is the direct analog of what's missing here.

## Terminology requirement

Multi-tenancy was deliberately removed from the Weft core (see CLAUDE.md) — this feature must NOT reintroduce tenant vocabulary. The capability is a generic concurrency limit with an optional user-defined partition key. Use examples like `key: (input) => input.customerId` or a resource id. Naming: `concurrency: { max: number, key?: (input) => string }` on the workflow definition. Per the original verifier note: do not confuse this with the existing per-ctx.map `concurrency` option (child fan-out parallelism), and debounce/batch-trigger remain documented patterns, not primitives — add those pattern docs to the concurrency guide as part of this task.

## Acceptance criteria (all required — completion is binary)

- [ ] A workflow type with concurrency.max=N admits at most N concurrently-running starts (per key value when key is provided); excess starts queue or reject per a documented, tested policy; leases release on every terminal path including crash recovery.
- [ ] No tenant terminology anywhere in code, types, tests, or docs; debounce and batch-trigger documented as patterns in the concurrency guide.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.

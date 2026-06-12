# Task 22: Feature: workflow concurrency keys

**Severity:** medium

## No Inngest-style flow control: throttle, debounce, batch-events, concurrency keys per tenant

- **Severity:** medium (feature-gap)
- **Files:** `src/core/concurrency.ts`, `src/core/types/options.ts`, `src/core/types/workflow-function.ts`

**Evidence:** src/core/concurrency.ts provides DurableSemaphore/DurableMutex as primitives, but these are manual building blocks. There is no built-in throttle (max N executions per time window), debounce (delay execution until a signal stops arriving), batch-trigger (accumulate N events then start one workflow), or per-tenant concurrency key as first-class EngineOptions. src/core/types/options.ts has no maxConcurrency, throttlePolicy, or batchTrigger options. Inngest makes these first-class scheduling constraints declared on the function definition.

**Required fix:** Add a concurrency field to workflow definition options (workflow({ name: 'x', concurrency: { max: 3, key: (input) => input.tenantId } })). The engine enforces this at start-time using the existing DurableSemaphore + AtomicState mechanism as the backing store, acquiring a lease before start and releasing it on terminal cleanup. Debounce and batch-trigger are harder: debounce requires a scheduled delay that restarts on each signal (achievable with schedule + cancel-running overlap policy). Batch-trigger requires a collector workflow pattern. Document these patterns rather than baking them in for v1.

**Verifier note:** The finding is accurate as stated. One clarification: the `concurrency` field that exists on `WorkflowMapOptions` (line 291 of `workflow-function.ts`) should not be confused with the absent per-type start-time enforcement — it controls child-workflow fan-out parallelism inside `ctx.map()`, a different concern entirely. The proposed fix is well-scoped: a `concurrency` field on `WorkflowBuilderOptions` enforced by the engine at `engine.start()` time using the existing `DurableSemaphore`+`AtomicState` mechanism is achievable without architectural changes. Debounce and batch-trigger are correctly identified as pattern-documentation concerns rather than v1 primitives, keeping the fix proportionate. Neither Temporal nor Inngest comparisons are over-stated — Temporal's `maxConcurrentWorkflowTaskExecutors` is a worker-level cap (different layer), while Inngest's `concurrency.key` is the direct analog of what's missing here.

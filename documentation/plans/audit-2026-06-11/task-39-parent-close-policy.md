# Task 39: Parent-close policy for child workflows

**Severity:** high

## Finding: No parent-close policy for child workflows (always awaits child)

- **Severity:** high (feature-gap)
- **Files (audit snapshot):** `src/core/engine/child-workflow.ts`, `src/core/context/child-workflow-pipe.ts`

### Evidence

src/core/engine/child-workflow.ts:180-182: executeChildWorkflow always calls childHandle.result() and awaits it — the parent always blocks on the child result. src/core/context/child-workflow-pipe.ts:133-171: startChild generator always yields the child result. There is no option to abandon a child when the parent terminates/cancels (Temporal's ABANDON policy) or to request the parent cancel the child on its own completion (REQUEST_CANCEL). The child lifecycle is completely tied to the parent's await.

### Required fix

Add a parentClosePolicy field to ChildWorkflowOptions with exactly three policies: 'await' (current default), 'abandon', and 'request-cancel'. Implement 'abandon' by NOT awaiting childHandle.result() and returning a ChildWorkflowHandle reference instead (the child runs independently). Implement 'request-cancel' by registering a cancel handler (via the existing registerCancelHandler mechanism) that cancels the child when the parent cancels. A forcible 'terminate' policy is explicitly out of scope — do not add it; note the deliberate omission in the PR body. The machinery to fire-and-not-await exists in the engine; this is a routing change in executeChildWorkflow and a new StartOptions flag.

### Verifier note

The finding is accurate as stated. One nuance: `ctx.startChild` is the underlying primitive for the composition operators (`ctx.pipe`, `ctx.map`, `ctx.reduce`), which all need to collect results by design. However, `ctx.startChild` is also the directly-exposed user API on `Context` (`src/core/context/index.ts:356`), so users who want fire-and-forget child workflows or any non-await lifecycle policy have no path to it. The severity is correctly high: users who need detached child workflows (e.g., launching a long-running background process from an orchestrator that should not be coupled to the parent's lifetime) cannot express that pattern at all in Weft. The proposed fix is mechanically accurate — `ChildWorkflowOptions` needs a `parentClosePolicy` discriminant and `executeChildWorkflow` needs to branch on it — but implementing 'abandon' correctly requires more than just skipping `childHandle.result()`: the child's `executionStateOwnerId` linkage (set at line 167) must also be severed so the child does not inherit the parent's execution ownership chain, otherwise abandoned children will still be coupled to the parent's recovery lifecycle.

## Required TypeScript contract

The committee requires the exact API shape up front (type-level breaking changes are not acceptable):

- `ctx.startChild(workflow, input, options?)` with `options.parentClosePolicy?: 'await' | 'abandon' | 'request-cancel'` defaulting to `'await'`.
- `'await'` (and omitted) preserves the CURRENT return type and yield semantics exactly — zero existing call sites change.
- `'abandon'` and `'request-cancel'` return a `ChildWorkflowHandle` (id + status accessors) instead of the child result, modeled as overloads discriminated on the options literal type so inference is automatic. Pin all three shapes in .test-d.ts BEFORE implementing.
- `'request-cancel'` registers via the existing cancel-handler mechanism: parent cancellation requests child cancellation; `'abandon'` fully detaches.
- `'abandon'` must sever the child's execution ownership linkage, not merely skip the result await: the field linking the child to the parent's execution context (locate by the `executionStateOwnerId` symbol in the child-workflow start path) must not be set for abandoned children, so the parent's crash recovery, purge, and retention never affect the abandoned child's lifecycle. The verifier-note paragraph above is the specification for this requirement.
- Composition operators (ctx.map/pipe/reduce) remain await-only by design — document that.

## Acceptance criteria (all required — completion is binary)

- [ ] Overloads compile per the contract above; .test-d.ts pins all three policies' return types and that omitting the option is identical to 'await'.
- [ ] Behavioral tests: abandoned child survives parent completion AND parent cancellation; abandoned children carry no parent execution-ownership linkage (executionStateOwnerId or its current equivalent is unset, pinned by test covering parent purge/recovery); request-cancel child receives cancellation when the parent cancels; await semantics byte-identical to today.
- [ ] Child-workflow guide documents the policies and the composition-operator boundary.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.

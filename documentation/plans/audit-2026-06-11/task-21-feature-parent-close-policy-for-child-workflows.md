# Task 21: Feature: parent-close policy for child workflows

**Severity:** high

## No parent-close policy for child workflows (always awaits child)

- **Severity:** high (feature-gap)
- **Files:** `src/core/engine/child-workflow.ts`, `src/core/context/child-workflow-pipe.ts`

**Evidence:** src/core/engine/child-workflow.ts:180-182: executeChildWorkflow always calls childHandle.result() and awaits it — the parent always blocks on the child result. src/core/context/child-workflow-pipe.ts:133-171: startChild generator always yields the child result. There is no option to abandon a child when the parent terminates/cancels (Temporal's ABANDON policy) or to request the parent cancel the child on its own completion (REQUEST_CANCEL). The child lifecycle is completely tied to the parent's await.

**Required fix:** Add a parentClosePolicy field to ChildWorkflowOptions: 'await' (current default), 'abandon', 'request-cancel', 'terminate'. Implement 'abandon' by NOT awaiting childHandle.result() and returning a ChildWorkflowHandle reference instead (the child runs independently). Implement 'request-cancel' by registering a cancel handler (via the existing registerCancelHandler mechanism) that cancels the child when the parent cancels. 'terminate' forcibly terminates. The machinery to fire-and-not-await exists in the engine; this is a routing change in executeChildWorkflow and a new StartOptions flag.

**Verifier note:** The finding is accurate as stated. One nuance: `ctx.startChild` is the underlying primitive for the composition operators (`ctx.pipe`, `ctx.map`, `ctx.reduce`), which all need to collect results by design. However, `ctx.startChild` is also the directly-exposed user API on `Context` (`src/core/context/index.ts:356`), so users who want fire-and-forget child workflows or any non-await lifecycle policy have no path to it. The severity is correctly high: users who need detached child workflows (e.g., launching a long-running background process from an orchestrator that should not be coupled to the parent's lifetime) cannot express that pattern at all in Weft. The proposed fix is mechanically accurate — `ChildWorkflowOptions` needs a `parentClosePolicy` discriminant and `executeChildWorkflow` needs to branch on it — but implementing 'abandon' correctly requires more than just skipping `childHandle.result()`: the child's `executionStateOwnerId` linkage (set at line 167) must also be severed so the child does not inherit the parent's execution ownership chain, otherwise abandoned children will still be coupled to the parent's recovery lifecycle.

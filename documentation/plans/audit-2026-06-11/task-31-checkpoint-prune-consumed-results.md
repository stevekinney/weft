# Task 31: Prune consumed accumulatedResults from checkpoints (fix O(n²) growth)

**Severity:** high

## Finding: Checkpoint serializes full accumulated-results array on every step — O(n²) total I/O across a workflow's lifetime

- **Severity:** high (performance)
- **Files (audit snapshot):** `src/core/types/checkpoint.ts`, `src/core/checkpoint/lifecycle.ts`, `src/core/engine/checkpoint-io.ts`, `src/core/codec/api.ts`

### Evidence

src/core/types/checkpoint.ts:101 — `accumulatedResults: Array<[number, unknown]>` is a flat array of ALL completed step results. src/core/engine/checkpoint-io.ts:149 — `advanceCheckpoint(current, context.checkpointLocals, { accumulatedResults: context.checkpointAccumulatedResults })` passes the entire accumulator into each new checkpoint object. src/core/checkpoint/lifecycle.ts:62–63 — `advanceCheckpoint` spreads `options?.accumulatedResults ?? checkpoint.accumulatedResults` verbatim into the new object. src/core/codec/api.ts:24–27 — `encode()` calls `replaceUndefined()` (a full recursive object walk) then `msgpackEncode()` on the whole checkpoint. Result: at step N the serialized checkpoint contains N step results; a 100-step workflow writes bytes proportional to 1+2+…+100 = O(n²) total across its lifetime. Temporal's 'sticky execution cache' (Temporal docs, 'Workflow Execution') and event-sourcing model replay from a compact event history without carrying all results in every checkpoint; Weft has no equivalent incremental checkpoint or delta compression.

### Required fix

Prune consumed entries from the serialized checkpoint: once the step frontier advances past an entry (its result has been consumed by resume/replay reconstruction), drop it, leaving only entries at or ahead of the frontier — typically the single pending step. This reduces per-step checkpoint size from O(steps) to O(pending). The full design contract is in the resolved required design section below. (The original finding proposed delta chains or a write-once side-table per step result — both were rejected by the committee; see below. Do not implement either.)

### Verifier note

The finding is real but the severity should be downgraded from critical to high. The O(n²) growth applies only to the inline execution path for sequential workflows. The Worker execution path (`workflow-runner.ts:466-478`) has the same flaw (`[...replayState.accumulatedResults]` is spread verbatim into the checkpoint). However, the practical impact is bounded by two mitigations: (1) the `payloadSize.maxBytes` policy rejects oversized activity results before they can accumulate, and (2) `ctx.offload()` provides an explicit large-payload escape hatch that stores data outside the checkpoint. These do not eliminate the O(n²) growth for moderate-sized results below the size cap, but they prevent catastrophic unbounded growth in well-configured deployments. The documentation claim that checkpoints are "constant-size" (`checkpoint-versus-replay.md:82-96`, `guides/workflows.md:219`) is materially false for sequential workflows and represents a correctness gap versus Temporal's documented behavior, even if Temporal has its own O(n) history growth. The proposed fix (pruning entries once stepIndex advances past them) is the right direction: after replay finishes rewinding, all entries at steps below the current frontier are consumed and can be discarded, leaving only the single pending-step entry in the serialized checkpoint.

## Resolved required design

The committee resolved the design ambiguity. REQUIRED: pruning. Once the step frontier advances past an entry (its result has been consumed by resume/replay reconstruction), it is dropped from the serialized checkpoint, leaving only entries at or ahead of the frontier (typically the single pending step). Specify in the implementation: exactly which entries survive serialization, how resume reconstructs generator state from a pruned checkpoint (it must not need the dropped entries — prove it), and decode compatibility for previously persisted unpruned checkpoints (read normalization; fixture test). REJECTED alternatives (do not implement): delta chains across checkpoint history entries; a write-once side-table per step result. Both add schema surface and read paths the pruning design makes unnecessary. Apply the same fix to the worker execution path (workflow-runner's accumulatedResults spread). Then correct the checkpoint-size claims in documentation/architecture/checkpoint-versus-replay.md and documentation/guides/workflows.md to match the now-true behavior.

## Acceptance criteria (all required — completion is binary)

- [ ] Serialized checkpoint size is O(pending step results), not O(all completed steps) — a test serializes a many-step workflow and asserts bounded checkpoint size across steps, on both inline and worker paths.
- [ ] Old unpruned checkpoints decode and resume correctly (fixture test).
- [ ] checkpoint-versus-replay.md and workflows.md size claims match the implementation.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.

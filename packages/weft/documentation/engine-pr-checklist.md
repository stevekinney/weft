# Engine PR checklist

> **Optional** — paste this checklist into your PR description only when the PR touches `src/core/engine/`.

## Replay determinism

- [ ] No state moved off `Engine`/`EngineInternals`. Every formerly-private field still lives in one place.
- [ ] No `Promise.all` introduced where a sequence existed.
- [ ] No `await` boundaries reordered within an extracted method.
- [ ] No event emission moved across an `await` point.
- [ ] No generator boundary changed (`replayWorkflowFeed`, `streamWorkflowStates`, `WorkflowHandle[Symbol.asyncIterator]`).
- [ ] Storage commit and event broadcast ordering preserved (`persistCheckpoint` writes-before-broadcast, `completeWorkflow` broadcasts-after-storage-settles).

## Methods extracted

<!-- List the methods extracted from `Engine` to a sibling module, e.g.:
- `#startWorkflow` → `engine/lifecycle.ts:startWorkflow`
- `#resumeWorkflowFromStorage` → `engine/lifecycle.ts:resumeWorkflowFromStorage`
-->

## Verification

- [ ] `bun run validate` clean
- [ ] `bun run build` clean; public-API snapshot reviewed
- [ ] `tests/replay-fixtures/` and `tests/checkpoint-compat/` green
- [ ] `bun run scripts/check-engine-internals-field-access.ts` clean

## Revertability

- [ ] This PR is **immediately revertable** — its first dependent PR has not yet merged at the time this lands.
- [ ] Per-PR log file added at `documentation/engine-split-log/PR-NN.md` naming methods extracted, `EngineInternals` fields touched, and any test fixtures regenerated.

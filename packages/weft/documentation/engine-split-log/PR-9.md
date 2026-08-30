# PR 9 — Engine errors and handles

## Scope

Extracts engine error classes, workflow/schedule handle classes, and
speculative execution bookkeeping from `src/core/engine/index.ts` into sibling
modules under `src/core/engine/`.

The public engine barrel remains unchanged for the public classes:
`WorkflowAlreadyExistsError`, `BulkDeleteRequiresTerminalWorkflowsError`,
`WorkflowHandle`, and `ScheduleHandle` still resolve from
`src/core/engine/index.ts`.

## Files added/changed

- `src/core/engine/errors.ts` — owns the workflow conflict, bulk-delete, and
  workflow-not-found error classes.
- `src/core/engine/handles.ts` — owns `WorkflowHandle`, `ScheduleHandle`, the
  handle iterator helper types/functions, and `HANDLE_RESULT_PROMISE`.
- `src/core/engine/speculative-execution-state.ts` — owns
  `SpeculativeExecutionState`.
- `src/core/engine/index.ts` — imports the moved internals and re-exports the
  public error and handle classes.
- `documentation/oxlint-disable-inventory.md` — updates the moved complexity
  disable entry for the workflow handle iterator.

## Classes extracted

- `WorkflowAlreadyExistsError`
- `BulkDeleteRequiresTerminalWorkflowsError`
- `WorkflowNotFoundError`
- `WorkflowHandle`
- `ScheduleHandle`
- `SpeculativeExecutionState`

## Replay-determinism rules respected

- Extracted errors are pure `Error` subclasses with no storage or scheduler
  side effects.
- `WorkflowHandle` and `ScheduleHandle` remain lightweight references to the
  public `Engine` surface. They use a type-only `Engine` import and do not read
  `EngineInternals`.
- `SpeculativeExecutionState` remains isolated bookkeeping for verification and
  compensation promises.
- No imports from `./internals.ts` or `../engine/internals.ts` were added to the
  new files.
- No method bodies, await boundaries, generator boundaries, event emission
  positions, or storage commit ordering were changed.

## Verification

- `bun run typecheck`
- `bun test src/core/`
- `bun run lint`

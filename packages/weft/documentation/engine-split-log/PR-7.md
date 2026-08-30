# PR 7: Context internals split

`src/core/context.ts` is now a thin barrel over `src/core/context/index.ts`.
The `Context` public surface stays on the class, while mutable execution state
now lives in `ContextInternals` behind a WeakMap.

## Moved modules

- `src/core/context/internals.ts`: `ContextInternals`, WeakMap storage, and initialization.
- `src/core/context/session-state.ts`: session-state store helpers and sticky run option merging.
- `src/core/context/attributes.ts`: search attribute validation and synchronous attribute accessors.
- `src/core/context/budget.ts`: budget tracker accessors.
- `src/core/context/updates.ts`: update handler and exposed accessor registration.
- `src/core/context/child-workflow-pipe.ts`: child workflow target resolution, composition tokens, and pipe/map/reduce execution.
- `src/core/context/validation.ts`: caller stack capture and trimming.
- `src/core/context/durable-operations.ts`: run, sleep, wait, review, offload, stream, load, and archive operations.
- `src/core/context/parallel-operations.ts`: all, race, memo, and runAll operations.
- `src/core/context/ai-operations.ts`: agent, speculate, handoff, debate, and supervise operations.
- `src/core/context/saga.ts`: saga execution and compensation flow.
- `src/core/context/types.ts` and `src/core/context/operation-request.ts`: context-facing public types.

## Compatibility notes

- Existing imports from `src/core/context.ts` continue to work through the barrel.
- `Context` still owns the public readonly fields: `workflowId`, `workflowType`, `startedAt`, and `signal`.
- Speculative child creation and commit now copy state through `getInternals(child)` instead of private cross-instance field access.

## Removed suppressions

- `core-context-file-length`

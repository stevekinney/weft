# PR 32b - Engine tenant and final extraction

## Scope

Extracts the remaining private Engine helpers that kept
`src/core/engine/index.ts` over the file-length limit. The Engine class now
stays as the public API hub: constructor initialization, public method
delegation, disposal, and re-exports live in `index.ts`; extracted behavior
lives in sibling modules that share `EngineInternals`.

## Files added/changed

- `src/core/engine/sub-operation.ts` - sub-operation execution and
  wait-review routing.
- `src/core/engine/handle-result.ts` - workflow handle caching, result waiter
  creation, and durable result bootstrap.
- `src/core/engine/pending-updates.ts` - inline update-handler invocation and
  pending update draining.
- `src/core/engine/callback-creators.ts` - callback bundle factories used by
  extracted sibling modules.
- `src/core/engine/strategy-helpers.ts` - operation-result feeding, promise
  rejection swallowing, and composed interceptor caching.
- `src/core/engine/checkpoint-io.ts` - timeline batch operation creation for
  checkpoint persistence.
- `src/core/engine/schedules.ts` - schedule summary conversion.
- `src/core/engine/engine-internal-types.ts` - internal Engine type contracts
  consumed by `internals.ts` and extracted helpers.
- `src/core/engine/index.ts` - reduced to constructor, public delegations,
  short private callback shims, disposal, and re-exports.

## Methods extracted

- `#executeSubOperation`
- `#processWaitReviewOperation`
- `#createWorkflowHandleWithResultPromise`
- `#createWorkflowResultWaiter`
- `#getWorkflowResultPromise`
- `#bootstrapWorkflowResultResolver`
- `#cacheHandle`
- `#processPendingUpdatesForHandlers`
- `#invokeUpdateHandler`
- `#appendTimelineBatchOperations`
- `#feedOperationResult`
- `#swallowPromiseRejection`
- All `#create*Callbacks()` bundle factories

## Replay-determinism rules respected

- Sub-operation execution keeps abort checks, nested `Promise.all`,
  `Promise.race`, dynamic agent imports, and budget recording in the original
  order.
- Result promise bootstrapping keeps the durable state load before result load
  and preserves the existing resolver handoff behavior.
- Pending update draining keeps FIFO update iteration, handler invocation,
  response persistence, event dispatch, and broadcast ordering unchanged.
- Schedule and checkpoint helper moves keep the same callback boundaries rather
  than introducing new orchestration layers.

## Verification

- `bun run lint`
- `bun run typecheck`
- `bun test src/core/`
- `bun test tests/replay-fixtures/ tests/checkpoint-compat/`
- `bun run build`
- `bun run scripts/snapshot-public-api.ts`
- `wc -l src/core/engine/index.ts`

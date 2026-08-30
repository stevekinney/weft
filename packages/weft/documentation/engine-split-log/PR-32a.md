# PR 32a - Engine registration and inline execution extraction

## Scope

Extracts registration, broadcast, terminal guard, constraint evaluation, and
inline parking strategy-message helpers from `src/core/engine/index.ts` into
focused sibling modules.

This continues the `EngineInternals` sibling-module pattern: extracted helpers
take `EngineInternals` first, receive typed parameters, and call back into
engine-only behavior through module-specific callback surfaces.

## Files added/changed

- `src/core/engine/registration.ts` - registration overload implementation and
  workflow-type target resolution.
- `src/core/engine/broadcast.ts` - broadcast channel dispatch, handle event
  forwarding, and pending update-received dispatch.
- `src/core/engine/guards.ts` - terminal workflow guards and shared terminal
  status set.
- `src/core/engine/constraints.ts` - workflow constraint evaluation and
  violation reactions.
- `src/core/engine/inline-parking.ts` - inline wait-signal parking, parked
  workflow resume handling, parked resume disposition, and strategy message
  handling.
- `src/core/engine/index.ts` - Engine methods now delegate into the new sibling
  modules through typed callback creators.
- `documentation/engine-split-log/PR-32a.md` - this split log.

## Methods extracted

- `register`
- `#resolveWorkflowTypeTarget`
- `#broadcast`
- `#forwardEventToHandle`
- `#dispatchPendingUpdateReceived`
- `#guardTerminalWorkflow`
- `#guardTerminalWorkflowAfterCoordinatedRequest`
- `#evaluateConstraints`
- `#parkInlineWorkflowAfterCheckpoint`
- `#resumeParkedInlineWorkflow`
- `#getParkedWorkflowResumeDisposition`
- `#handleStrategyMessage`

## Callback surfaces

`RegistrationCallbacks` covers engine-only registration behavior:

- `ensureRetentionSweepInterval`
- `isAgentDefinition`

`BroadcastCallbacks` covers event dispatch used by update-received forwarding:

- `dispatchEvent`

`GuardCallbacks` covers coordinated update request cleanup after terminal races:

- `deleteCoordinatedUpdateRequest`

`ConstraintCallbacks` covers constraint violation reactions:

- `cancelWorkflowInStrategy`
- `dispatchEvent`
- `failWorkflow`
- `feedOperationResult`

`InlineParkingCallbacks` covers lifecycle, termination, storage, checkpoint, and
operation-routing behavior that remains owned by `Engine`:

- `createLifecycleCallbacks`
- `createTerminationCallbacks`
- `evaluateConstraints`
- `hasBufferedSignal`
- `loadWorkflowState`
- `persistCheckpoint`
- `processOperation`
- `readCheckpointBytes`
- `runSerializedWorkflowStateWrite`
- `translateOperationRequest`
- `validateDevelopmentCheckpoint`

## Replay-determinism rules respected

- Registration keeps synchronous side effects and synchronous throw behavior so
  the public `register()` API is unchanged.
- Inline checkpoint handling keeps checkpoint persistence, development
  validation, constraint evaluation, inline parking, and operation processing in
  the original order.
- Inline parking keeps the pre-park signal scan, serialized parked-marker write,
  and post-marker signal scan in the original order.
- Constraint evaluation keeps per-constraint await boundaries and stops at the
  first actionable violation.
- Broadcast and update-received dispatch preserve event-emission order.
- No await boundaries were merged or reordered.

## Verification

- `bun run lint` clean.
- `bun run typecheck` clean.
- `bun test src/core/` - 1537 pass, 0 fail.
- `bun test tests/replay-fixtures/ tests/checkpoint-compat/` - 22 pass, 0 fail.
- `bun run build` clean.
- `bun run scripts/snapshot-public-api.ts` - API surface unchanged.

## Implementation notes

`register()` remains a synchronous extracted helper rather than an async
function because changing synchronous validation failures into rejected promises
would change the public API.

`TERMINAL_STATUSES` moved to `guards.ts` as a module-level exported constant so
the extracted guard helpers do not depend on a private static field.

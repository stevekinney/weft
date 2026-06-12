# Task 13: DX hardening batch

**Severity:** medium

## RegExp deserialized from checkpoint bytes has no guard against invalid flags — can crash workflow recovery

## Context

The RegExp extension decoder in `src/core/codec/extension-codec.ts:52-57` calls `new RegExp(source, flags)` where both `source` and `flags` come directly from msgpack-decoded checkpoint bytes with no validation or try/catch.

## Evidence

- `extension-codec.ts:52-57`: `new RegExp(source, flags)` — no try/catch, no length check on source.
- `validateCheckpointShape` runs after codec decode, so it cannot protect against this.
- An invalid `flags` string (e.g., an unrecognized flag letter introduced in a newer JS engine version) throws an uncaught error that propagates out of `deserializeCheckpoint`, crashing the affected workflow's recovery.
- Note: Bun/JavaScriptCore uses a DFA engine, so ReDoS is not a concern. The vulnerability is invalid-flags crashes crashing recovery.

## Impact

A checkpoint written by a newer Bun version that uses a newer RegExp flag can permanently prevent recovery on an older Bun version. Corrupt checkpoint bytes can also trigger this. The crash is isolated to the affected workflow's recovery, not engine-wide.

## Proposed Design

1. Wrap `new RegExp(source, flags)` in try/catch and rethrow a descriptive error naming the source/flags values so the failure is actionable.
2. Add a maximum-length check on `source` (e.g., 65535 bytes) before construction.
3. Document in the extension-codec JSDoc that `RegExp` values in checkpoints are version-sensitive and that upgrading Bun may produce checkpoints unreadable by older versions.

## Acceptance Criteria

- An invalid flags string in a checkpoint byte sequence produces a descriptive error naming the tag, source, and flags — not an uncaught exception.
- A length-bounded source check prevents pathologically long source strings from being constructed.

## ctx.services is typed unknown with no generic parameter, forcing type assertions at every call site

## Context

`src/core/types/workflow-context.ts:220` declares `readonly services?: unknown`. The JSDoc acknowledges 'A threaded generic is a deliberate follow-on, not part of this surface yet.' Every workflow that uses services must write a type guard or an `as` cast — the pattern the project's own CLAUDE.md conventions mark as suspect.

## Evidence

- `workflow-context.ts:220`: `readonly services?: unknown`
- `documentation/guides/workflows.md:183-186`: shows the recommended `isOrderServices(ctx.services)` type guard — 8-10 lines of boilerplate per workflow.
- The JSDoc explicitly defers the generic parameter as a planned follow-on.

## Proposed Design

Add a generic type parameter `TServices = unknown` to `WorkflowContext<TServices>` and thread it through:
- `Engine<TServices>` (or resolved from `resolveWorkflowServices` return type)
- `WorkflowHandle<TServices>` (for observable service type at handle level)
- `engine.start()` and `engine.register()` so TypeScript infers the services type

This eliminates the `as` cast, makes the opening workflows.md example typecheck correctly, and allows typed service injection without boilerplate type guards.

## Acceptance Criteria

- `ctx.services` is typed as `TServices` when a workflow is defined with a typed resolver.
- No `as` cast is required to access known service properties.
- Existing untyped workflows (no resolver or `resolveWorkflowServices: () => unknown`) continue to work unchanged.

## ctx.state.session() throws at runtime in worker execution mode with no static or early-startup guard

## Context

`src/workers/workflow-runner.ts:90-96` stubs `ctx.state.session()` to throw at first call inside the generator. There is no construction-time or registration-time check. The failure surfaces deep in workflow execution after side-effecting steps may have already committed.

## Evidence

- `workflow-runner.ts:91-96`: `createWorkerStateNamespace` stubs `session` as `() => { throw new Error('ctx.state.session() is not supported in worker execution mode...') }`
- `documentation/reference/api-context.md:527-555`: documents `ctx.state.session()` with examples but no warning that it throws in worker mode.
- `api-context.md` step-form section (line 594) does carry a worker-mode incompatibility warning — the pattern is established but not applied to `ctx.state.session()`.

## Proposed Design

1. Add a worker-mode incompatibility callout to `api-context.md` in the `ctx.state.session()` section, matching the pattern already established for step-form and `ctx.services` worker-mode differences.
2. Optionally add a registration-time or startup-time check that warns when a workflow registered in worker-execution mode uses `session` — this requires static analysis or a heuristic scan, which may not be feasible.
3. At minimum, ensure the throw message (which is already clear) is tested and documented in the reference.

## Acceptance Criteria

- `api-context.md` contains a `[!WARNING]` callout in the `ctx.state.session()` section stating it throws in worker execution mode.
- The callout points to the list of workflow context features unavailable in worker mode.

## Per-workflow MCP tools await handle.result() with no timeout — suspended workflows hang MCP tool calls indefinitely

## Context

`src/mcp/tools.ts:156-163` auto-generated per-workflow tools call `await handle.result()` with no timeout. If the workflow is suspended or waiting for a signal indefinitely, the tool call's HTTP response handler remains open until the MCP host's own connection timeout.

## Evidence

- `mcp/tools.ts:156-163`: `const result = await handle.result()` — no AbortSignal threading from the MCP request cancellation path through to the result await.
- `dispatcher.ts:91-96`: handles `notifications/cancelled` but only checks cancellation before start (line 153) and after start (line 159) — not during the result await.
- Suspended workflows (documented public API: `engine.suspend()`) have a `handle.result()` that is permanently pending until resumed.

## Proposed Design

1. Add an optional `timeoutMs` parameter to per-workflow MCP tools (default: 30,000ms).
2. If `handle.result()` does not resolve within the timeout, return a tool result with `isError: false` indicating the workflow is running but not yet complete, including the `workflowId` so the agent can call `get_workflow_state` to poll.
3. Properly thread the `notifications/cancelled` signal into the `handle.result()` promise via `AbortSignal`, so MCP host cancellation also unblocks the await.

## Acceptance Criteria

- A suspended workflow does not cause its MCP tool call to hang past the configured timeout.
- When the timeout fires, the tool returns a structured partial result with `workflowId` for subsequent polling.
- MCP `notifications/cancelled` aborts the `handle.result()` await.

## Storage adapter conformance test suite exists internally but is not exported — third-party adapter authors cannot run it

## Context

`src/storage/storage-adapter.test-support.ts` exports `runStorageCapabilityConformance`, `runBasicStorageContract`, and `runBinaryAndLargeScanStorageConformance`, but line 9 explicitly states they are 'intentionally not re-exported from any package entry point.' No `@lostgradient/weft/storage/testing` subpath exists.

## Evidence

- `src/storage/storage-adapter.test-support.ts:9`: explicit exclusion comment.
- `package.json` exports: the `./testing` subpath exists but its `src/testing/index.ts` exports only TestEngine, chaos helpers, etc. — none of the storage conformance functions.
- `documentation/guides/storage.md`: no 'Implementing a custom adapter' section, no mention of the conformance helpers.
- `documentation/roadmap-to-1.0.md`: notes that Turso needs a conformance proof, which underscores the need for a public-facing conformance suite.

## Proposed Design

1. Add a `@lostgradient/weft/storage/testing` subpath (or extend the existing `./testing` subpath) that exports the three conformance helper functions.
2. Since these functions import `bun:test`, ensure the subpath is excluded from the main bundle (already handled by the build-exclusion mechanism for test-support files).
3. Add a 'Implementing a custom adapter' section to `documentation/guides/storage.md` that links to this suite and shows a minimal usage example.
4. Extend `weft conformance` to optionally cover the storage adapter protocol (analogous to how it covers the RemoteWorker protocol).

## Acceptance Criteria

- A third-party storage adapter author can run the conformance suite by importing from `@lostgradient/weft/storage/testing` without a deep internal import.
- `storage.md` contains a 'Implementing a custom adapter' section that links to the conformance suite.

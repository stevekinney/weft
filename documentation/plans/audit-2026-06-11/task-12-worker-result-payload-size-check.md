# Task 12: Enforce payload-size policy on RemoteWorker task results

**Severity:** high

## Finding: RemoteWorker taskResult value persisted to storage without payload-size check

- **Severity:** high (security)
- **Files (audit snapshot):** `src/server/runtime/websocket-worker.ts`, `src/server/task-state.ts`

### Evidence

onTaskResultMessage (websocket-worker.ts:247-265) accepts CompletedTaskResultMessage whose value is any RemoteWorkerJsonValue, structurally validated but NOT size-bounded. It calls transitionInflightToResolved which persists to storage. Every other completion path calls assertPayloadWithinLimit: completeAsyncActivity (async-activity-completion.ts:336), inline activity path (operations-activity.ts:408), reconciliation (activity-reconciliation.ts:156). The WebSocket path is the sole exception. No Bun-level websocket.maxPayload is set.

### Required fix

Add assertPayloadWithinLimit(message.value, ...) in onTaskResultMessage (and for the error string in failed/cancelled variants) before calling transitionInflightToResolved. Thread the engine's payloadSizePolicy.maxBytes through ServeOptions or ServerContext so the WebSocket handler can access it.

## Acceptance criteria (all required — completion is binary)

- [ ] Worker-delivered task results pass the same payloadSize.maxBytes rejection as inline activity results, before any durable write, on both WebSocket and HTTP delivery paths.
- [ ] Oversized result produces the documented payload fault delivered to the worker (and the activity fails with a classified application error), with regression tests for both transports.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.

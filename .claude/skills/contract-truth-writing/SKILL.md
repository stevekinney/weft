---
name: contract-truth-writing
description: >-
  Use this skill when writing or reviewing Weft comments, JSDoc, documentation,
  README examples, test prose, or operation descriptions that describe wire
  responses, server diagnostics, masked errors, public APIs, or runtime recovery.
---

> Monorepo note: all repository paths and commands in this skill are relative to `packages/weft/` unless a path explicitly starts with `packages/`.

# Contract Truth Writing

## When to use

- Documenting server operations, REST bindings, JSON-RPC behavior, MCP discovery, registry snapshots, recovery, or worker protocols.
- Documenting operator diagnostics, task metrics, worker fleet visibility, drain operations, or external dashboard mounting behavior.
- Writing test headers or comments that describe what a response, error, or log contains.
- Updating JSDoc for public exports or examples checked by documentation verification.
- Explaining diagnostics where wire responses intentionally mask internal details.

## Do not use

- Private inline comments that only explain a local algorithm and make no external promise.
- Copy edits that do not affect contract meaning.
- Marketing or positioning prose outside the technical contract surface.

## Workflow

1. Separate the wire contract, server-side diagnostics, logs or telemetry, and implementation details.
2. Verify the code path before promising that a response includes a name, message, stack, status, or actionable diagnostic.
3. Keep masked-error behavior explicit: say what clients see and where operators can inspect richer context.
4. Keep metric documentation low-cardinality. Put workflow IDs, operation IDs, worker IDs, queue names, and bounded evidence in diagnostic endpoint docs, not metric label guidance.
5. Treat test prose as executable contract documentation; update it when assertions prove a narrower behavior.
6. Use public examples that match the current API and recovery model, not a friendlier shorthand that changes semantics.
7. For workflow visibility, keep list filters, aggregate groupings, failure-category projection, operator counts, and backfill/watermark claims aligned with implementation and tests.
8. For MCP discovery, distinguish public discovery documents from live `tools/list` behavior, and mention `publicOrigin` or `trustedHosts` whenever absolute URLs are emitted.
9. For schedule operations, document REST and JSON-RPC authentication/scope behavior together; do not describe tenant-claim access checks unless a new implementation reintroduces them.
10. For task queue docs, distinguish HTTP long-poll request aborts from server shutdown disposal; one preserves queued work for another caller, the other drops in-memory queue state during teardown.
11. For storage operations, distinguish correctness gates from operational hints: `conditionalBatch` is runtime-gated, `boundedRangeDelete` is not, and `deleteRange` must be described as bounded-only with `deletePrefix` reserved for whole-prefix deletion.
12. For async activity completion, state that `completeAsync()` tokens are deterministic identifiers, not secrets; the token belongs in the request body; completion payloads are hostile input; and oversized payloads fail before the token is consumed.
13. For `durableActivity()`, state that it is a package-root async helper for inline `ctx.memo()` callbacks, not a `WorkflowOperation`; keyed helper activity results use immediate fenced reconciliation, unkeyed results stay at-least-once across a crash, and `ActivityContext.completeAsync()` is unsupported from helper-launched activities.
14. For MCP built-in workflow-control tools, keep tool names and input field names distinct: `signal_workflow`, `update_workflow`, and `query_workflow` keep their tool names, but their arguments are `signalName`, `updateName`, and `queryName`.
15. For `ctx.log` and `EngineOptions.onLog`, say that inline sinks replace console routing for non-replayed records, throwing sinks fall back to console without failing the workflow, `ctx.speculate()` uses the same sink path, and worker-mode records still stay in the worker console until issue #529 changes that.
16. For MCP Streamable HTTP sessions, distinguish the public session id from the anonymous continuation token: `initialize` returns both headers, later anonymous POST/GET/DELETE requests require both, and authenticated sessions rely on the re-presented credential plus bound principal.
17. For timeout docs, distinguish deadline timeouts from history circuit-breaker termination: `WorkflowTimeoutError.terminationReason` is `'history-circuit-breaker'` only for breaker trips and `undefined` for execution or run deadline timeouts.
18. For cleanup wording in tests and comments, describe the current contract directly. Use "retired" or "persisted-state fields" when code tolerates old shapes; avoid "legacy", "migration", or "compatibility" framing unless the file is an actual migration guide or compatibility policy.
19. For Tier-0 or persisted-format prose, use rolling-upgrade contract language when that is the actual guarantee. Do not describe pre-release current behavior as "legacy" behavior, and do not call shape tests "migration tests" unless they test an implemented migration path.
20. For fixture names, reserve `historical-*` for old persisted records or protocol shapes. When a test only compares current behavior, use direct names such as `retiredField`, `old`, or `current` instead of `legacy`.
21. For implementation-file-size exceptions, update `documentation/contributing/development-setup.md` and `scripts/check-implementation-file-sizes.ts` together. The rationale should name the current responsibility boundary, not preservation of old import paths, compatibility barrels, or shim layers.
22. For REST fault documentation, describe the current flat `{ error, weftCode?, data? }` body, keep `EngineFailure` masked, and place recover-all conflict details under `data`; do not document the retired nested envelope. For embedded `handleRequest()` hosts, document that injected `WorkerRegistry` and `TaskQueue` instances supply the live state used by worker, queue, and task-diagnostics operations.

## Verification

- Run `bun run verify:documentation` when documentation, JSDoc, anchors, or examples change.
- Run the focused tests for the operation or example being described.
- Inspect the rendered or asserted response shape before finalizing prose.

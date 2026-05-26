---
name: contract-truth-writing
description: >-
  Use this skill when writing or reviewing Weft comments, JSDoc, documentation,
  README examples, test prose, or operation descriptions that describe wire
  responses, server diagnostics, masked errors, public APIs, or runtime recovery.
---

# Contract Truth Writing

## When to use

- Documenting server operations, REST bindings, JSON-RPC behavior, MCP discovery, registry snapshots, recovery, or worker protocols.
- Documenting operator diagnostics, task metrics, worker fleet visibility, drain operations, or dashboard API client behavior.
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
7. For workflow visibility, keep list filters, aggregate groupings, failure-category projection, dashboard counts, and backfill/watermark claims aligned with implementation and tests.
8. For MCP discovery, distinguish public discovery documents from live `tools/list` behavior, and mention `publicOrigin` or `trustedHosts` whenever absolute URLs are emitted.
9. For schedule operations, document REST and JSON-RPC tenant behavior together: missing JWT tenant claims are forbidden, cross-tenant schedule IDs are not found, and non-JWT principals keep the engine default policy.
10. For task queue docs, distinguish HTTP long-poll request aborts from server shutdown disposal; one preserves queued work for another caller, the other drops in-memory queue state during teardown.

## Verification

- Run `bun run verify:documentation` when documentation, JSDoc, anchors, or examples change.
- Run the focused tests for the operation or example being described.
- Inspect the rendered or asserted response shape before finalizing prose.

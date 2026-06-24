---
name: semantic-compatibility
description: >-
  Use this skill when a Weft change renames, reshapes, normalizes, hashes,
  serializes, or replays persisted data such as effect-log records, checkpoints,
  tool calls, tool results, JSONValue content, storage payloads, or compatibility
  fixtures.
---

# Semantic Compatibility

## When to use

- Renaming fields in persisted or replayed shapes, such as `input` to `arguments`.
- Changing semantic hash inputs, canonicalization, serialization, or codec behavior.
- Updating `JSONValue`, tool-call, tool-result, checkpoint, storage, or effect-log data.
- Adding storage primitives that can delete persisted ranges, especially `deleteRange` bounds, prefix intersection, event-log compaction watermarks, or watermark truncation semantics.
- Changing history policy, payload-size admission, archive export, Worker replay signatures, checkpoint failure metadata, or event-log verification.
- Adding compatibility with another package while Weft still owns the runtime contract.
- Generating or validating cross-process declarations from registry snapshots, or wrapping byte-oriented storage for string-oriented consumers.
- Refactoring registry-driven generated clients, especially when JSON Schema shapes become shared aliases instead of inline object types.
- Changing storage capability reports, reserved key prefixes, string KV import helpers, or application-facing wrappers that share a storage backend with the engine.
- Adding or changing SQL-backed storage adapters such as `NeonStorage`, especially `TEXT COLLATE "C"` key ordering, opaque `BYTEA` value mapping, read-only query passthrough, and `SERIALIZABLE` compare-and-swap retries.
- Adding or deleting reserved workflow metadata markers such as `wf-has-services:`; marker writes, reads, scheduled-occurrence starts, cleanup, purge, and retention must stay aligned.
- Changing failure-category values, workflow visibility index keys, or framed compressed-storage payloads.
- Changing idempotent start storage (`start-idem:`), signal id derivation, `startOrSignal` convergence or terminal-restart semantics, serializer registry tags, recovered launch/snapshot public shapes, or durable task in-flight records such as `attemptToken`.
- Changing buffered signal storage keys, including encoded signal names, `KEYS.startSignal` sort-class behavior, and the class-independent `sigres:` accepted-response dedup record.
- Changing anonymous signal sequence derivation or explicit `signalId` validation. Caller-supplied `signalId` values are opaque after validation, so strings containing `anonymous:` or separators must never be parsed as generated anonymous identifiers.
- Changing workflow version metadata on persisted `WorkflowState`; the current canonical state shape is `versionTuple`, while old flat version fields are read-normalized only.
- Changing the persisted `WorkflowState` decoder field allowlist or unknown-field behavior. Current decode tolerates extra keys but strips every field outside the current state shape before recovery continues.
- Removing or changing workflow version recovery behavior. Current recovery has no checkpoint migration hook: stored and registered versions plus `versionTuple` metadata are strict recovery guards that fail with `VersionMismatchError` on drift.

## Do not use

- Purely local helper refactors with no stored, hashed, replayed, or exported shape.
- New internal types that never cross a persistence, public API, or interoperability boundary.
- Documentation-only edits unless the documentation promises persisted compatibility.

## Workflow

1. Identify every boundary that observes the shape: fresh execution, commit, replay, decode, event snapshots, public types, and compatibility fixtures.
2. Preserve semantic keys used for idempotency unless the migration explicitly changes them and includes old-record handling.
3. Add old-vs-new fixtures before changing implementation behavior when existing stored records may exist.
4. Normalize replayed values through the same path as fresh values, especially JSON-safe outputs and lossy codec values.
5. For registry codegen, pin deterministic output and make unsupported JSON Schema keywords degrade to `unknown` rather than emitting an unsound type.
6. When hoisting repeated registry shapes into aliases, derive the deduplication key and emitted TypeScript from the same normalized representation so two shapes alias only when they render identically. Keep alias names deterministic and collision-checked.
7. For failure-category changes, keep the current public taxonomy limited to `application`, `timeout`, `cancellation`, `resource`, and `system`. Do not reintroduce alias normalization or search expansion for older category names unless a task explicitly restores that compatibility and includes old-record fixtures.
8. For compression changes, keep the two-byte framing contract pinned so gzip, brotli, and uncompressed values remain distinguishable without storage-side metadata.
9. Keep external compatibility structural and dev/test-only; do not import sibling package runtime types into Weft runtime source.
10. For bounded storage deletion, prove the operation cannot become an unbounded wipe through malformed options, negative limits, reverse iteration, or scoped-storage prefix smuggling.
11. For event-log compaction, prove the watermark and checkpoint commit are atomic, verification seeds from the watermark, the surviving tail still matches the head, and `history.maxEvents` continues to count lifetime sequence.
12. For `payloadSize.maxBytes`, prove oversize workflow inputs, signal payloads, and activity results fail before durable writes while already-persisted data remains replayable under the current policy.
13. For application storage wrappers, keep `disposeUnderlyingStorage: false` available and covered when the wrapper shares an engine-owned backend, and forward `conditionalBatch()` through text and typed codecs without changing compare bytes unexpectedly.
14. For string KV imports, prove source and target paths cannot be identical, source table names are validated, reserved Weft prefixes are rejected, and existing target keys are never overwritten.
15. For services markers, prove the marker is presence-only, is written atomically with start records and scheduled occurrences, gates resolver calls on recovery, and is deleted by terminal cleanup, purge, and retention.
16. For idempotent starts, keep key mappings permanent across terminal cleanup, purge, and retention; a key that maps to a missing workflow record is spent and must not create a replacement run.
17. For signal-with-start storage, keep start-signal payload keys sorting before normal signal keys while preserving deduplication by `(workflowId, signalName, signalId)` through `sigres:`. Encode signal names consistently in payload keys, scan prefixes, and accepted-response keys so separator characters cannot alias another signal name. For `onTerminalConflict: 'start-new'`, prove explicit `id` and `signalId` are required, `idempotencyKey` is rejected, non-terminal targets are signalled rather than replaced, and terminal replacements purge through the shared terminal-conflict path.
18. For serializer registration, treat `options.tag` as persisted data. Decode must resolve by tag regardless of registration order, reject missing or non-string tags, and fail clearly when a process has not registered the tag needed by an old checkpoint.
19. For Neon/Postgres storage, treat key collation and byte mapping as semantic compatibility: `kv.key` must use `COLLATE "C"`, values must remain opaque `BYTEA`, schema/table identifiers must be validated before SQL construction, collapsed batch net effects must match sequential execution, and retryable `40001`/`40P01` transaction aborts must retry the whole CAS transaction before throwing on cap exhaustion.
20. For task attempt tokens, preserve additive wire compatibility: missing tokens keep worker-id fallback for older workers and token-less records, while present-but-wrong or malformed tokens reject without completing the task.
21. For persisted workflow version metadata, write only `versionTuple` on fresh state, lift old flat `version` / `agentVersion` / `toolVersions` records through `decodeWorkflowState()`, route diagnostics through the decoder, and regenerate replay/checkpoint fixtures only after verifying the diff is shape-only.
22. For versioning changes, keep `checkVersionCompatibility()` to compatible/incompatible outcomes, keep `weft version:check` to safe/unsafe reporting, and do not reintroduce `migrate`, `migrateCheckpoint`, or `needs-migration` surfaces unless the task explicitly restores them with storage fixtures.
23. When persisted data or checkpoint wording is touched, frame exact-schema rejection as the current contract: Weft does not upgrade older database records in place unless the task explicitly adds and tests that upgrade path.
24. For unknown persisted workflow-state fields, add neutral extra-field fixtures that prove decode drops the field and resumes with only current `WorkflowState` keys. Do not reintroduce tenant-specific or legacy alias normalization when the current contract is tolerate-and-strip.
25. For JSON value validation or typed storage codecs, reject values whose JSON encoding would erase information. `-0` must stay invalid because `JSON.stringify(-0)` emits `0`; add regression coverage in both `src/core/json.test.ts` and `src/storage/typed-storage.test.ts` when this boundary moves.

## Verification

- Add regression tests that prove old committed records still deduplicate and replay without re-executing effects.
- Test fresh execution and replay produce the same normalized content shape.
- For registry codegen aliasing, run generator determinism, catalog drift, and type-level assignability tests against representative generated operation inputs.
- For storage wrapper or importer changes, run the focused text-value, typed-storage, conditional-batch, and importer tests plus documentation verification when public guidance changes.
- For services marker changes, run the recovered-services, workflow-services, delayed-start, schedule, purge, and retention tests that prove marker lifecycle across storage paths.
- For idempotent start and signal-with-start changes, run the start workflow, start-or-signal, generated operation-client drift, and storage capability tests that prove convergence and conflict behavior.
- For buffered signal key changes, run focused signal and start-or-signal tests that prove same-tick start-signal-first ordering, duplicate `signalId` dedup across start/live paths, and separator-containing signal names do not prefix-match other names.
- For anonymous signal sequence changes, include explicit `signalId` values containing `anonymous:` plus overflow cases near `Number.MAX_SAFE_INTEGER`.
- For serializer registry changes, run focused codec tests for custom serializer round trips, corrupt extension payloads, duplicate constructor/tag rejection, and `Error` subclass field preservation.
- For Neon/Postgres storage, run PGlite-backed storage contract tests, retry fault-injection tests, schema/table query-shape tests, net-effect resolver tests, and any env-gated live Neon tests when `NEON_DATABASE_URL` is available.
- For task attempt-token changes, run protocol parser tests, WebSocket stale-attempt regressions, long-poll completion authorization tests, conformance fixtures, and server restart restoration tests.
- For workflow-state version-shape changes, run decode-lift tests, recovery/version-drift tests, diagnostics scans, and fixture regeneration review that proves no unrelated replay data changed.
- For unknown workflow-state field cleanup, run `bun test src/core/engine/validation.test.ts src/core/engine.test.ts src/core/crash-recovery.test.ts tests/replay-fixtures/replay-fixtures.test.ts`.
- For failure-category compatibility changes, run `bun test src/core/failure-category.test.ts src/core/list-filter-validation.test.ts src/core/engine/validation.test.ts src/core/engine/list-candidate-resolution.test.ts src/server/operations/list-workflows.test.ts src/server/json-rpc-http-integration.test.ts`.
- For versioning-surface removals or recovery-guard changes, run `bun test src/core/versioning.test.ts src/diagnostics/version-check.test.ts src/diagnostics/format.test.ts src/core/engine.test.ts` plus `bun run verify:documentation`.
- Run the relevant focused test, then `bun run typecheck` and `bun run validate` before shipping.

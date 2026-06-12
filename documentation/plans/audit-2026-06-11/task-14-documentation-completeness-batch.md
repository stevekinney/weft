# Task 14: Documentation completeness batch

**Severity:** medium

## No dedicated error-codes reference page for WeftErrorCode union and FaultCode union

## Context

`WeftErrorCode` (30 values, `src/core/weft-error.ts:25-55`) and `FaultCode` (12 values, `src/core/fault-code.ts:39-51`) are both exported public surfaces classified as candidate-stable in `documentation/contributing/breaking-changes.md`. Neither is documented in a dedicated reference page.

## Evidence

- Grep across all `documentation/reference/` files: no page documents `FaultCode` values.
- Helper functions `isWeftError`, `isWeftErrorCode`, `isWeftErrorLike` are absent from all documentation.
- `api-server.md:616-623` has a bare HTTP status table mapping integers to plain English — never names `FaultCode` string values.
- Error class names are scattered across `api-engine.md`, `api-workflow-handle.md`, `recovery-and-deploys.md` with no unifying reference.

## Proposed Design

Create `documentation/reference/api-errors.md` with:
1. **WeftErrorCode table**: each code, the class that throws it, the triggering scenario, and whether it is catchable vs. fatal.
2. **FaultCode table**: each server fault code, the HTTP status it maps to, and the JSON-RPC error shape.
3. **Error helpers section**: `WeftError`, `isWeftError`, `isWeftErrorCode`, `isWeftErrorLike` — signatures, when to prefer each, and an example of error-routing using the guard pattern.

Cross-link from `api-engine.md`, `api-server.md`, and JSDoc on the exported error helpers.

## Acceptance Criteria

- A developer can find any WeftErrorCode value and its triggering scenario from a single reference page.
- FaultCode values are fully documented with HTTP status mappings.
- The isWeftError/isWeftErrorCode/isWeftErrorLike helpers have documented usage examples.

## HTTP long-poll transport is entirely undocumented at the protocol level — wrong endpoints in the remote-workers guide

## Context

`documentation/reference/remote-worker-protocol.md` documents only the WebSocket path. The HTTP long-poll transport (`LongPollWorker`) has no protocol-level specification, and the `remote-workers.md` guide actively misinforms — describing poll as `/poll` and result as `/complete` when the real endpoints are `GET /api/v1/tasks/:queue` and `POST /api/v1/tasks/:queue/result`.

## Evidence

- `documentation/reference/remote-worker-protocol.md`: zero mentions of `LongPollWorker`, `/api/v1/tasks/:queue`, `attemptToken` semantics on the HTTP path, or task-retention on aborted long-polls.
- `src/worker/long-poll.ts:135,141`: actual endpoints are `GET /api/v1/tasks/:queue` and `POST /api/v1/tasks/:queue/result`.
- `src/server/runtime/task-polling.ts:200-245`: separate polling contract with `createLongPollInflightRecord` and synthetic `longpoll-<uuid>` workerIds.
- `documentation/guides/remote-workers.md` long-poll section: describes `/poll` and `/complete` (both wrong).

## Proposed Design

1. Add an 'HTTP long-poll transport' section to `remote-worker-protocol.md` documenting: the poll endpoint (`GET /api/v1/tasks/:queue`), the result endpoint, `workerId`+`attemptToken` fields, claim expiry/visibility timeout semantics, at-least-once requeue on abort/timeout.
2. Fix the incorrect endpoint documentation in `remote-workers.md`.
3. Extend `weft conformance` to cover the HTTP long-poll path.

## Acceptance Criteria

- A non-TypeScript developer can implement a correct HTTP long-poll worker using only the protocol documentation.
- `remote-workers.md` shows the correct endpoint paths.
- `weft conformance` can validate an HTTP-only worker implementation.

## TursoStorage capabilities() reports readAfterWrite: 'session' — silently fails assertDurableStorageForRecovery with no docs warning

## Context

`TursoStorage` reports `readAfterWrite: 'session'` for all URL forms including remote `libsql://` URLs. `assertDurableStorageForRecovery()` requires `readAfterWrite: 'linearizable'` and throws for anything else.

## Evidence

- `src/storage/turso.ts:185-198`: `capabilities()` returns `readAfterWrite: 'session'` unconditionally.
- `src/storage/capabilities.ts:220-221`: `assertDurableStorageForRecovery` throws for non-linearizable read-after-write.
- `documentation/guides/storage.md:288-303` (TursoStorage section): mentions session consistency but no cross-reference warning that TursoStorage will always fail `assertDurableStorageForRecovery`.

## Impact

Users who configure TursoStorage for a production durable deployment and call `assertDurableStorageForRecovery` get a hard failure with no guidance. Users who do not call the assertion run a 'durable' engine on session-level read-after-write, which may silently miss checkpoints across replica routing events.

## Proposed Design

Add a prominent `[!WARNING]` callout to the TursoStorage section in `storage.md` explaining: (1) TursoStorage will always fail `assertDurableStorageForRecovery`; (2) TursoStorage is suitable for development, testing, or deployments that pin to a single libSQL connection; (3) for durable production recovery, use NeonStorage, BunSQLiteStorage, or LMDBStorage. Also update the `capabilities()` JSDoc comment in `turso.ts` to explain that session-level read-after-write applies to all URL forms.

## weft version:check command is experimental by README policy but promoted as a solved deployment-safety tool in temporal-comparison.md

## Context

`temporal-comparison.md` promotes `weft version:check` as a solved deployment safety tool. The README stability table (lines 48-55) lists candidate-stable CLI commands as 'serve, doctor, version, --version, and -v'. `version:check` is absent from that list, making it experimental by the README's own stated policy.

## Evidence

- `README.md:48-55`: stability table explicitly lists stable CLI commands; `version:check` not included.
- `documentation/roadmap-to-1.0.md:23-27`: same stable CLI list, same omission.
- `documentation/architecture/temporal-comparison.md:65`: 'Weft's CLI also provides weft version:check, which analyzes registered workflows against the existing database and reports compatibility before deployment' — stated as a solved, stable tool.
- `documentation/reference/cli.md`: documents `version:check` without any stability caveat.

## Proposed Resolution

Option A: Add `version:check` to the candidate-stable CLI list in README.md and roadmap-to-1.0.md (appropriate if the command's contract is considered stable).

Option B: Add an `[!NOTE] Experimental` callout to `cli.md`'s `version:check` section and soften the `temporal-comparison.md` language to 'Weft provides an experimental `weft version:check` command...'

Option A is preferred if the output contract and flag interface are stable enough to commit to.

## CHANGELOG.md is missing all 0.2.x release entries despite v0.2.1 tag existing

## Context

`CHANGELOG.md` has sections for `[Unreleased]`, `[0.3.0]`, and `[0.1.0]` but nothing between them. The `v0.2.1` tag exists in git (`git tag` output), corresponding to the 'Release v0.2.1 (#416)' commit.

## Evidence

- `CHANGELOG.md`: no `## [0.2.1]` or `## [0.2.0]` section.
- `documentation/contributing/breaking-changes.md:23`: 'Breaking changes to stable surfaces are always announced in CHANGELOG.md with a migration path.'
- The `v0.2.1` tag corresponds to 'Weft DX improvements from the first integrator (agent-bureau) (#415)', followed by 'Release v0.2.1 (#416)'.

## Proposed Resolution

Add a `## [0.2.1] - <date>` section to CHANGELOG.md capturing what changed between 0.1.0 and 0.2.1. If no breaking changes occurred (the commits appear to be DX improvements and pipeline hardening), the section can note 'No breaking changes' and list the notable improvements. This satisfies the project's own changelog policy and gives operators a complete release history.

## Acceptance Criteria

- CHANGELOG.md has a `## [0.2.1]` section with an accurate date.
- The section either documents breaking changes with migration paths, or explicitly states no breaking changes occurred in this release.

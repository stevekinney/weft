# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Ground Rules

**Fix problems. Do not report them.** If you encounter pre-existing warnings, lint errors, type errors, failing tests, or any other issue in the codebase — fix it. Do not ask whether to fix it. Do not explain that it's pre-existing. Do not suggest workarounds like skipping hooks. Just fix it and move on.

## Essential Commands

### Development

```bash
bun run dev               # Start development with watch mode
bun run build             # Build for production (outputs to dist/)
# Run production build
bun ./dist/index.js       # After build, run with Bun
```

### Testing

```bash
bun test                  # Run all tests
bun test src/utils        # Run tests in specific directory
bun test logger          # Run tests matching pattern
bun test --watch         # Watch mode
bun run test:coverage    # Generate coverage report (sets WEFT_COVERAGE_MODE=1, applies project timeout)
```

### Code Quality

```bash
bun run lint             # Check linting errors
bun run lint:fix         # Auto-fix linting errors
bun run typecheck        # TypeScript type checking
bun run format           # Format all files with Prettier
bun run format:check     # Check formatting without changes
bun scripts/check-lint-disables.ts
```

### Lint suppression policy

The repository allows **at most 5** `oxlint-disable` directives in production source code under `src/` (not `scripts/`, `tests/`, or any other top-level directory). The included extensions are `*.{ts,tsx,mts,cts}`; the excluded patterns are `*.test.{ts,tsx,mts,cts}`, `*.spec.{ts,tsx,mts,cts}`, `/test/`, and `/__tests__/`. The exact scope is defined in `scripts/check-lint-disables.ts` by the exported constants `SOURCE_FILE_GLOB` (inclusion) and `TEST_FILE_EXCLUSION_GLOBS` (exclusion); update both this paragraph and those constants together if the scope ever changes.

Every directive must carry an inline rationale after `--`, at least 40 characters long. The conventional format is `-- <one-sentence reason why this rule cannot apply>; rejected: <alternative that was considered>`. This is enforced in PR review, not by the script — but the 40-character floor exists so the script catches drive-by suppressions.

Adding a new suppression requires explicit justification in the PR description and reviewer sign-off. The ceiling is enforced by `scripts/check-lint-disables.ts`, which runs as part of `bun run lint` (CI) and is also invoked from the pre-commit hook so local commits are gated by the same check.

### Utilities

```bash
bun run clean            # Clean build artifacts (dist/, coverage/, caches)
bun run verify:documentation
bun run verify:markdown-doctests
bun run verify:jsdoc:doctests
bun run verify:jsdoc:full
bun run scripts/check-coverage.ts
weft conformance -- <worker-command>
weft codegen --server http://localhost:7233 --out ./src/weft.generated.d.ts
```

`verify:documentation` is the minimum gate for public Markdown, generated reference links, and documentation anchors. Run `verify:markdown-doctests` when Markdown examples change, `verify:jsdoc:doctests` when JSDoc examples change, and `verify:jsdoc:full` before shipping changes that alter exported declarations.

Use `bun run scripts/check-coverage.ts` for the deterministic adjusted-coverage gate. It deletes stale `coverage/` output, runs one Bun coverage pass, parses `coverage/lcov.info`, applies the repository's explicit allowances, and fails when the coverage process exits non-zero or adjusted line or function coverage is below 100 percent. This is a coverage gate only, so it does not replace a passing `bun test` or `bun run validate`.

Use `bun run prepack` before release or package-surface changes. It runs the build, export and portability checks, Markdown and JSDoc doctests, package-content validation, and packed-consumer checks. The GitHub release workflow publishes `@lostgradient/weft` with `npm publish --ignore-scripts`, so local publish dry runs should use `npm publish --dry-run --ignore-scripts` after `prepack`. Release changes must also keep the tag, `package.json.version`, and exported `VERSION` constant aligned through `bun run scripts/verify-release-version.ts --tag=<tag>`.

Release version changes must keep `package.json`, `src/version.ts`, and server discovery defaults aligned. Run `bun run verify:release-version` before release pull requests, and include OpenAPI, OpenRPC, AsyncAPI, and MCP discovery tests when the default version string changes.

Use `weft conformance` when a change touches the `RemoteWorker` protocol or worker SDK compatibility. Use `weft codegen` when validating cross-process type-generation docs or client fixtures; the command reads `/v1/registry` from a live server or `--from` a vendored registry JSON file and writes a deterministic `.d.ts`.

## Architecture Overview

### Core Design Principles

1. **Options-First Configuration**: The library API is options-first. Environment variables (`WEFT_*`) are limited to explicit runtime, CLI, and test toggles, and each read stays close to the code path that consumes it. Document user-facing runtime, CLI, and conformance variables in [`documentation/reference/configuration.md`](documentation/reference/configuration.md#environment-variables); internal benchmark, coverage, and smoke-test toggles stay documented beside the tests and scripts that consume them.

2. **Lean Surface Area**: This template intentionally avoids framework-specific scaffolding (custom error classes, logger wrappers, etc.). Add only what you need for your project.

### Key Notes

- **ESM + TypeScript**: Source files are TypeScript modules; build output targets Bun.
- **Import paths**: Use standard TS/ESM imports; no special runtime helpers are required.

### Git Hooks Architecture

Hooks live as Bun TypeScript files under `scripts/husky/` and are invoked by tiny sh wrappers in `.husky/`:

- `pre-commit`: runs lint-staged, the lint-disable ceiling check, basic dependency checks, and the diagnosable Bun test runner in `scripts/husky/run-tests.ts`
- `post-checkout`: installs deps when `package.json`+`bun.lock` change; surfaces config changes
- `post-merge`: installs/cleans when dependencies or config changed; shows merge stats

They use `chalk` for color, `change-case` for headings, and Bun’s `$` and `Bun.write` for shell/IO.

### Types

There is no shared `src/types.ts` in this template. Add shared or domain-specific types near their modules as needed.

## TypeScript Conventions

### `any` Is Forbidden Outside Test Files

Do not use `any` in production code. Use proper types, generics, `unknown` with type narrowing, or Zod schemas. Test files (`.test.ts`, `.spec.ts`) are exempt — Oxlint relaxes this rule there.

### Type Assertions (`as`) Are Suspect

Treat every `as` cast with suspicion. The pattern `as unknown as SomeType` is a red flag that almost always means a type design problem — do not use it unless you can explain exactly why there is no better alternative.

**Prefer type guards over assertions:**

```typescript
// Preferred: Zod schema validation
const parsed = MySchema.parse(untrustedInput);

// Preferred: type guard function
function isWorkflowState(value: unknown): value is WorkflowState {
  return typeof value === 'object' && value !== null && 'status' in value;
}

// Preferred: narrowing with typeof / in / instanceof
if (typeof value === 'string') {
  /* value is string here */
}

// Acceptable when justified: simple assertion on trusted data
const state = decode(bytes) as WorkflowState; // bytes came from our own storage
```

If an `as` cast is genuinely necessary (e.g., deserializing from storage where the type is known by construction), add a brief comment explaining why. If it cannot be justified, refactor the types instead.

## Development Patterns

### Adding New Features

1. **Environment variables**: Place the read close to the code path that consumes it. Document a new user-facing runtime, CLI, or conformance `WEFT_*` variable in [`documentation/reference/configuration.md`](documentation/reference/configuration.md#environment-variables); document internal benchmark, coverage, and smoke-test toggles beside the tests or scripts that consume them.
2. **Types**: Shared/reusable types go in `src/types.ts`; domain-specific types live near their modules.

### Server and API Surfaces

- New REST or JSON-RPC operations must declare their access scope, operation name, transport availability, input source mapping, and fault shaping explicitly.
- Operator diagnostics should keep metrics low-cardinality. Use bounded diagnostic endpoints for workflow IDs, operation IDs, worker IDs, queue names, and other high-cardinality evidence.
- Weft no longer ships an in-repository dashboard. If a server operation is meant for operator UIs, document the REST/JSON-RPC contract and keep `serve({ dashboard })` framed as an externally supplied shell mounted on the supported page routes.
- Workflow visibility changes must keep `engine.list`, `engine.aggregate`, REST query parsing, JSON-RPC inputs, operator UI filters, and bulk-action preview filters aligned. Pin failure-category filters, id-prefix filters, date ranges, aggregate grouping, and default ordering in tests.
- Existing Bun SQLite deployments need the workflow visibility backfill before older workflows can rely on indexed queries. Document the maintenance-window requirement, `--drop` rollback path, exit codes, and watermark behavior with any visibility-index change.
- Failure categories are the execution taxonomy `application`, `timeout`, `cancellation`, `resource`, and `system`. Do not reintroduce alias normalization or search expansion for older category names; decode drops unknown persisted categories and list/aggregate filters use only the current taxonomy.
- MCP discovery is public metadata that emits absolute URLs. Changes to `/.well-known/mcp.json`, `/openrpc.json` MCP metadata, or `/mcp` must cover `publicOrigin`/`trustedHosts`, authentication/session binding, and anonymous-session continuation tokens (`Mcp-Session-Token` on initialize, required with `Mcp-Session-Id` on later POST/GET/DELETE requests when auth is disabled).
- Preserve current REST response contracts during cleanup refactors. Shared helpers are fine, but tests must pin any intentionally raw or masked error shape.
- REST `EngineFailure` responses are masked by the canonical `shapeRestFault` path as `{ error: "Internal server error" }` with status `500`; JSON-RPC still receives the operation fault object. Preserve that split when refactoring operation helpers.
- Schedule operations use their operation-catalog access policies across REST and JSON-RPC. Do not reintroduce tenant-claim access checks; multi-tenancy has been removed from the core, and legacy tenant fields are tolerated only as persisted-data cleanup.
- Async activity completion operations (`weft.activities.complete` / `weft.activities.fail`) are public mutators over REST and JSON-RPC. Keep tokens in the request body, treat tokens as deterministic identifiers rather than secrets, validate completion payloads as hostile input, and reject oversized completion/failure payloads before consuming the single-use token.
- Storage adapters must report `capabilities()` honestly. Gate only `conditionalBatch` with `requireStorageCapability`; treat `boundedRangeDelete` as an operational hint and route bounded deletes through `storageDeleteRange()` so unbounded range deletion is impossible.
- NeonStorage changes must preserve configurable `schema`/`table` validation, `TEXT COLLATE "C"` key ordering, opaque `BYTEA` values, read-only `query()` enforcement, and collapsed `batch()`/`conditionalBatch()` semantics where the net effect is resolved once before the SERIALIZABLE retry loop. Live Neon verification is required for driver-specific array binding or transaction changes when `NEON_DATABASE_URL` is available.
- Storage integrations that claim durable recovery readiness must satisfy `assertDurableStorageForRecovery()`: `persistence: 'local'` or `'remote'` (a durable remote store such as `NeonStorage`; only `ephemeral` is rejected on the persistence axis), linearizable read-after-write, snapshot scans, atomic batches, and `conditionalBatch`. Keep `WEFT_RESERVED_KEY_PREFIXES`, `scopedStorage`, `textValueStore`, `withCodec`, and the string-KV importer aligned when changing storage keyspace or wrapper behavior.
- `Engine.create()` recovers by default after workflow registration. Use `recover: false` only for tests, isolated `ScopedStorage` engines, or pre-recovery inspection, and do not reintroduce `requireConcurrentResumeSafety`; current Weft supports one engine process per durable store until `MultiEngine` fenced ownership exists. Preserve the type-level invariant that `Engine.create({ workflows: {} })` is equivalent to omitting `workflows` and returns the default-registry engine accepted by `ServeOptions`. Keep scheduler ownership orthogonal: `startScheduler` controls whether durable timers fire, defaults to `recover !== false`, and `schedulerPollIntervalMs` must stay a validated positive safe integer test seam rather than an environment variable.
- Per-run workflow `services` are inline-only host capabilities, not durable state. Starting with `services` must persist only the presence marker, reject Worker execution mode, re-provide services through `resolveWorkflowServices` on running recovery, delayed-start recovery, and scheduled occurrences, fail only the affected run when unavailable, and sweep the marker on terminal cleanup, purge, and retention.
- Query handlers registered with `ctx.onQuery()` must remain callable while an inline workflow is parked on `waitForSignal()`, must switch to the fresh context after signal resume, and must be torn down on suspend or terminal cleanup.
- `ctx.waitUntil(predicate, timeout?)` is an inline-only durable condition gate. It re-evaluates pure predicates only when `ctx.onUpdate()` drives workflow-local state or when its deterministic timeout fires; signals do not re-drive it, and it must remain rejected inside `ctx.race()`, `ctx.all()`, and `ctx.speculate()`.
- `ctx.race()` / `ctx.all()` branch changes must preserve sleep and wait-signal support, nested coordinator propagation, duplicate signal-name rejection across the coordination tree, non-destructive signal losers, and deferred signal consumption before checkpointing. Losing `ctx.run()` branches inside `ctx.race()` receive the coordinator `AbortSignal` on `ActivityContext.signal`, so superseded activities can stop cooperatively. Pin `ctx.speculate` separately because it drives nested coordinators through a different top-level path.
- Idempotent starts and `engine.startOrSignal()` require storage `conditionalBatch`. Preserve permanent `start-idem:` key semantics: mappings survive terminal cleanup, purge, and retention; a spent key whose workflow record is gone must surface a conflict rather than start a replacement. For `startOrSignal`, keep REST, JSON-RPC, generated clients, `StartOrSignalSignal` typing, and the per-call `StartOrSignalResult.outcome` aligned around exactly one of `signalId` or `idempotencyKey`, preserve same-tick start-signal-first delivery, and preserve the documented terminal-transition race behavior.
- `engine.start(..., { id, onTerminalConflict: 'start-new' })` is in-process `engine.start` only. It requires an explicit `id`, rejects `idempotencyKey`, never displaces non-terminal runs, purges terminal runs through the shared purge path before replacement, and must remain absent from REST/JSON-RPC, `engine.startOrSignal()`, and `ctx.startChild()`.
- `WorkflowHandle.getLaunchMetadata()` and `WorkflowHandle.snapshot()` are recovered-handle observability surfaces. Keep them asynchronous storage reads that return `null` after purge/retention, exclude non-recoverable launch options from metadata, and report the same status semantics as `engine.get(id)`.
- History policy changes must keep `history.maxEvents` as a lifetime circuit breaker and `history.retentionWindow` as storage reclamation only. Event-log compaction writes the watermark atomically with checkpoint commits; archival is best-effort after deletion and must not be described as a durability guarantee.
- Persisted workflow-state version metadata is `WorkflowState.versionTuple`, not flat `version` / `agentVersion` / `toolVersions` fields. Fresh writes must use the tuple; decode can tolerate old flat records only as read normalization, and docs/tests should keep `WorkflowSummary.version` framed as the list-result shortcut for `versionTuple.workflowVersion`.
- `decodeWorkflowState()` strips unknown persisted fields instead of preserving retired or foreign keys. Fresh state writes must stay on the current `WorkflowState` allowlist; cleanup fixtures should prove tolerated extras are dropped without reintroducing alias, tenant, or migration wording.
- Payload-size policy changes must reject oversized workflow inputs, signal payloads, and activity results before durable writes. Keep `payloadSize.maxBytes` separate from storage compression and Worker `maxProtocolMessageBytes`.
- Custom serializer changes must preserve `registerSerializer()` as process-global and one-shot per constructor/tag. Checkpoints decode by the durable `tag`, not registration order; never document or implement `constructor.name` as a safe tag source for minified builds.
- Worker execution changes must preserve explicit trust posture: `workflowExecutionMode: 'worker'` is the hardened untrusted path with turn timeouts and bounded protocol messages; `workflowExecutionMode: 'inline'` rejects `workerExecution`.
- Durable workflow finalizers run on the engine host, not through the RemoteWorker activity table. Worker-mode engines may register workflows with `finalizer`, but worker generator contexts cannot stage finalizer state with `ctx.setFinalizerState()`; tests must cover host-side teardown, crash recovery, and the no-recorded-state case.
- `ctx.log` changes must preserve checkpoint-aware suppression without consuming a durable step: envelope fields stay engine-owned, attributes stay nested, and logs at uncached live frontiers may re-emit after recovery. A host `EngineOptions.onLog` sink receives records from both execution modes — inline directly and worker-mode forwarded back to the host via a non-terminal `log` protocol message; worker mode logs to the worker console only when no host sink is installed. Throwing `EngineOptions.onLog` sinks fall back to console without failing the workflow, and `ctx.speculate()` branches use the same sink behavior — including the worker-forwarded path, which falls a throwing host sink back to the HOST console (the forwarded-log delivery and its `logRecordToConsole` fallback run on the engine host, not in the worker). A forwarded `log` is lenient observability that carries no turn-protocol state: it never reaches the strict accept-or-discard gate and never settles or clears the worker turn. The host delivers it to the sink only when the sending worker owns the workflow (active or parked) AND the record's `workflowId` matches the envelope AND the record is a structurally valid `WorkflowLogRecord` within the size cap; otherwise it is dropped. A _single_ wrong-owner, malformed, oversize, or out-of-turn `log` never discards the worker, but _repeated_ forwarded-log abuse does (#545): a per-worker counter (keyed by the `Worker` reference, driven by the injected engine clock) discards the worker when forwarded-log arrivals exceed a generous fixed-window flood budget (internal, not a public option — default 5000 per 60s, AGGREGATE per pooled worker across every workflow it owns, NOT per workflow; every `type:'log'` arrival counts, including wrong-owner ones, BEFORE the ownership gate, because the host already paid the structured-clone cost on receipt) OR when cumulative anomalous (oversize OR structurally invalid) records reach a small non-resettable lifetime strike threshold (constant 5). Because the budget is per-worker, discarding an abusive worker fails ALL the workflows it currently owns (its siblings on a pooled worker), so the defaults bias hard against false discard; honest high-log workflows stay well under them. Wrong-owner logs count toward the flood budget only, never as strikes (a between-turns self-log for a just-terminated workflow is benign mistiming). A between-turns self-log (a fire-and-forget log resolving while the worker is parked) IS delivered, because the worker still owns its parked workflow. `maxProtocolMessageBytes` is by design a post-receive guard — the runtime structured-clones the message before any handler runs, so the size cap cannot be enforced earlier; repeat-oversize is what the strike bucket escalates. The forwarded-log lane needs no double-emit guard against a discard interleaving a suspended strict turn: the engine's terminal transitions are status-gated and serialized (first-wins), so a spurious `failed` after a `completed` is absorbed at the durable layer.
- Schedule event changes must preserve `schedule:fired` as a process-local, best-effort-after-durable-start event emitted only when a scheduled occurrence actually launches a run. Keep skipped ticks silent, queued-drain runs at `occurrence: undefined`, and unavailable-services failures ordered as `schedule:fired` before `workflow:failed`.
- Client ergonomics changes must keep `WeftClient.getHandle(id)` transport-uniform (`null` for missing, terminal `result()` from persisted state), preserve non-generic overloads before generic overloads on `WeftClient`, `LocalClient`, and `HttpClient`, and keep `isWeftFault(error, code)` matching both same-process Weft errors and HTTP-wrapped `weftCode` values. `StartOrSignalOutcome` is public from both the package root and `/client`, and `LocalClient` must accept branded engines returned by `Engine.create({ workflows })` without call-site casts.
- RemoteWorker SDK changes must preserve the required `workflows` map, qualified `${workflowType}.${activityName}` advertisement, key/name validation, and per-dispatch `attemptToken` echoing. Do not reintroduce the removed flat `activities` alias; `LongPollWorker.activities` and the wire `register.activities` array are separate contracts.
- Long-poll completion authorization is strict when the stored in-flight record has an `attemptToken`: missing or mismatched echoes reject. WebSocket `taskResult` authorization is additive for compatibility: missing echoes still fall back to the worker ownership guard, while present-but-wrong echoes reject.
- Task polling and shutdown changes must cover already-aborted request signals, disconnects during parked long-polls, task retention for dead pollers, and `server.stop()` disposal of queued timers/waiters.
- Inline launch scheduling changes must cover `defer: false`, queued launch draining during disposal, and the MessageChannel-unavailable timeout-flush fallback without leaving result waiters pending.
- Client event-streaming changes must preserve the `client.tail(id)` / `handle.tail()` contract across `LocalClient` and `HttpClient`: `whenConnected()` resolves after catch-up, tails are single-consumer, `HttpClient` can use `/v1/workflows/:id/watch` or fetch-based `/v1/workflows/:id/events/sse`, reconnect catch-up must not duplicate or skip buffered frames, SSE replay-complete pings must unblock readiness, callback-only listeners must not accumulate an unbounded iterator buffer, and runtimes without usable WebSocket header support must either fall back to SSE under `eventTransport: 'auto'` or get an actionable `webSocketFactory` diagnostic when WebSocket is required. Server subscription changes must keep raw `/watch` scoped to `events:read`, raw token `/stream` scoped to `streams:read`, REST workflow and fleet SSE streams scoped through the operation catalog, JSON-RPC `weft.workflows.subscribe` and `weft.events.subscribe` out of request/response dispatch, replay capped and cursor-ordered, fleet events purge-safe, and worker connect/disconnect events included in the operator feed.
- Public root exports and build rewriter changes must run `bun run build`; the post-build guard fails if `dist/` contains a dangling relative `.js` specifier, including directory re-export mistakes such as emitting `./diagnostics.js` when only `./diagnostics/index.js` exists.
- Server subpath export changes must keep `@lostgradient/weft/server` self-sufficient for naming `ServeOptions`, `WeftServer`, `TaskDispatch`, `DiscoveryInfo`, `TaskQueue`, routing/scheduling/retry policies, `PrometheusExporter`, and `WorkerRegistry`, while `Engine` remains rooted at `@lostgradient/weft`. Pin the built package subpath with `.test-d.ts` coverage.
- Generated operation-client changes must update `scripts/generate-operation-client.ts`, regenerate `src/cli/generated/operation-client.generated.ts`, and prove determinism with `bun run scripts/generate-operation-client.ts && bun run scripts/check-catalog-drift.ts`. When reducing generated duplication, keep aliases structurally transparent, preserve call-site inference with type-level tests, and run `jscpd` against the generated file.
- Duplicate-audit cleanup must classify generated artifacts, reference-documentation mirrors, and intentional script cross-checks before refactoring. Use `documentation/contributing/duplicate-audits.md` and run `jscpd src scripts documentation tests --min-lines 18 --min-tokens 120 --exit-code 0`; do not quiet the audit by adding broad `src/` or `documentation/` ignores. Coverage allowance changes must reject duplicate keys, cross-layer-shadowed keys, and keys matching a `coveragePathIgnorePatterns` entry in `scripts/check-coverage.ts` tests.
- CLI version-surface changes must preserve leading-token semantics: `weft --version`, `weft -v`, and `weft version` print the bare `VERSION` string and exit 0, while subcommand-local flags such as `weft serve --version` remain owned by that subcommand and reject unknown options.
- CLI command-suggestion refactors must preserve user-visible wording and thresholds: top-level subcommands use distance `2`, `weft api` operation suggestions use distance `6`, and tie breaks keep the first candidate. Pin those invariants in `src/cli/command-suggestions.test.ts` and parser integration tests.

### Testing Approach

- Tests use Bun's built-in test runner with `describe`, `it`, `expect`.
- Test files are typically colocated with sources using the `.test.ts` suffix.
- Test-only support modules under `src/` must use `.test-support.ts` or another build-excluded test-only pattern. After renaming or adding support modules, run `bun run build` so the post-build guard catches forbidden `bun:test`, `fake-indexeddb`, or `jsdom` imports in `dist/`.
- Shared browser-storage tests rely on the Bun `[test].preload` in `tests/test-preload.ts` for `fake-indexeddb`. Do not reintroduce per-file IndexedDB shim imports unless the file is a helper that can run outside the test preload.
- Avoid fixed wall-clock sleeps before assertions. For load-sensitive test handling, follow the `LOAD_SENSITIVE_TEST_PATHS` policy in [`documentation/contributing/development-setup.md`](documentation/contributing/development-setup.md#testing-conventions).
- Coverage fixes for callback creator bundles should exercise every wrapper path, including cleanup-error callbacks for stream and time operations, rather than adding allowances for reachable one-line delegators.
- Tests that use fake timers should restore real timers locally, even though `tests/test-preload.ts` runs a global `afterEach(restoreRealTimers)` safety net. A leaked fake clock can trap `Bun.sleep(...)` in the next sequential test file, so isolation tests should prove the preload cleanup remains active rather than relying on test order.
- Coverage-restoration pull requests for retry or checkpoint machinery should cover invalid persisted retry attempts, missing retry policy replay, non-`Error` retry classification, and retry-to-sleep-to-success paths before shrinking allowances.
- Oxlint rules are relaxed for test files (`*.test.ts`, `*.spec.ts`, `test/**`, `__tests__/**`). You can use `any`, non-null assertions, unused variables, and other patterns that would normally be flagged.
- A separate `tsconfig.test.json` is available with relaxed TypeScript settings for tests.

### Import Organization

Prettier plus import sorting keeps imports consistent. A common order is:

1. Bun built-ins (e.g., `import { file, write } from 'bun'`)
2. Node built-ins (e.g., `import { readFile } from 'node:fs'`)
3. External packages (e.g., `import { z } from 'zod'`)
4. Internal absolute imports (e.g., `@/configuration/environment`)
5. Relative imports (e.g., `./local-module`)

## Bun-Specific Considerations

- Always use `bun` commands, not `npm` or `yarn`.
- The lockfile in this repo is `bun.lock`.
- Bun provides native TypeScript execution without precompilation.
- Use `bunx` for one-off package execution (like `npx`).

### Prefer Bun Built-ins Over Node

When possible, use Bun's native APIs instead of Node.js equivalents. Bun's APIs are optimized for performance and often have a simpler interface.

| Task          | Use (Bun)                                | Avoid (Node)                     |
| ------------- | ---------------------------------------- | -------------------------------- |
| Read file     | `Bun.file(path).text()`                  | `fs.readFileSync(path, 'utf-8')` |
| Write file    | `Bun.write(path, data)`                  | `fs.writeFileSync(path, data)`   |
| HTTP server   | `Bun.serve()`                            | `http.createServer()` or Express |
| Hashing       | `Bun.hash()` or `new Bun.CryptoHasher()` | `crypto.createHash()`            |
| Spawn process | `Bun.spawn()` or `Bun.$`                 | `child_process.spawn()`          |
| Sleep         | `Bun.sleep(ms)`                          | `setTimeout` with promisify      |
| Environment   | `Bun.env.VAR`                            | `process.env.VAR`                |
| Glob          | `Bun.Glob`                               | `glob` package                   |

When a Bun equivalent doesn't exist or Node's API is more appropriate for the use case, use the `node:` prefix for clarity (e.g., `import { join } from 'node:path'`).

### Configuration Notes

- **bunfig.toml**: Build targets Bun with sourcemaps and minification.
- **TypeScript**: Uses Bun types; Node type libs are not included by default.
- **Oxlint**: Rust-based linter with built-in TypeScript, promise, unicorn, and import plugins. Type-aware rules enabled via `--type-aware --tsconfig ./tsconfig.json`. Import sorting and unused import removal handled by Prettier via `prettier-plugin-organize-imports`. Test files have relaxed rules.
- **Testing**: You can run tests in parallel via `bun test --parallel`.

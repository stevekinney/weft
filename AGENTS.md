# AGENTS.md

This file provides guidance to coding agents working with code in this repository.

## Ground Rules

**Fix problems. Do not report them.** If you encounter pre-existing warnings, lint errors, type errors, failing tests, or any other issue in the codebase — fix it. Do not ask whether to fix it. Do not explain that it's pre-existing. Do not suggest workarounds like skipping hooks. Just fix it and move on.

## Pull Request Titles

Pull request titles must use this format:

- Optional Linear prefix when applicable: `ABC-123: `
- Then a concise sentence-case action title
- No branch slug prefix
- No Markdown or inline code formatting
- No conventional-commit prefixes like `feat:` or `fix:`
- No multi-sentence acceptance-criteria dump

Before opening a PR, compute and validate the final title:

```bash
draft_title="<descriptive title>"
normalized_title=$(bun run scripts/pr-title.ts normalize --title "$draft_title" | jq -r '.normalizedTitle // empty')
pr_title="${normalized_title:-$draft_title}"
bun run scripts/pr-title.ts validate --title "$pr_title"
```

After creating the PR, read the title back from GitHub and fail immediately if it does not match:

```bash
gh pr create --title "$pr_title" --body-file /tmp/pr-body.md
created_title=$(gh pr view --json title --jq '.title')
test "$created_title" = "$pr_title"
```

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
bun run scripts/check-implementation-file-sizes.ts
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

For documentation refreshes driven by recent pull requests, use the mirrored `documentation-refresh` skill. Gather merged pull request evidence before editing, avoid re-documenting behavior already covered by the latest documentation refresh, and mirror workflow guidance across `AGENTS.md`, `CLAUDE.md`, `.agents/skills`, and `.claude/skills`. If the window contains only a documentation-refresh pull request, treat it as the lower bound, state that no post-refresh runtime/API/workflow behavior landed, and leave `README.md` plus `documentation/**` unchanged unless a specific stale claim remains.

Use `bun run scripts/check-coverage.ts` for the deterministic adjusted-coverage gate. It deletes stale `coverage/` output, runs one Bun coverage pass, parses `coverage/lcov.info`, applies the repository's explicit allowances, and fails when the coverage process exits non-zero or adjusted line or function coverage is below 100 percent. This is a coverage gate only, so it does not replace a passing `bun test` or `bun run validate`.

Use `bun run prepack` before release or package-surface changes. It runs the build, export and portability checks, Markdown and JSDoc doctests, package-content validation, and packed-consumer checks. The GitHub release workflow publishes `@lostgradient/weft` with `npm publish --ignore-scripts`, so local publish dry runs should use `npm publish --dry-run --ignore-scripts` after `prepack`. Release changes must also keep the tag, `package.json.version`, and exported `VERSION` constant aligned through `bun run scripts/verify-release-version.ts --tag=<tag>`.

Release version changes must keep `package.json`, `src/version.ts`, and server discovery defaults aligned. Run `bun run verify:release-version` before release pull requests, and include OpenAPI, OpenRPC, AsyncAPI, and MCP discovery tests when the default version string changes.

The release workflow now opens downstream bump issues after npm publish. Keep `downstream-release-repositories.toml` as the editable repository list, keep `DOWNSTREAM_ISSUE_TOKEN` as the cross-repository issue credential, and preserve duplicate-title detection before creating new downstream issues.

Use `weft conformance` when a change touches the `RemoteWorker` protocol or worker SDK compatibility. Use `weft codegen` when validating cross-process type-generation docs or client fixtures; the command reads `/v1/registry` from a live server or `--from` a vendored registry JSON file and writes a deterministic `.d.ts`.

## Architecture Overview

### Core Design Principles

1. **Options-First Configuration**: The library API is options-first. Environment variables (`WEFT_*`) are limited to explicit runtime, CLI, and test toggles, and each read stays close to the code path that consumes it. Document user-facing runtime, CLI, and conformance variables in [`documentation/reference/configuration.md`](documentation/reference/configuration.md#environment-variables); internal benchmark, coverage, and smoke-test toggles stay documented beside the tests and scripts that consume them.

2. **Lean Surface Area**: Keep Weft's public surface deliberate. Add framework-specific scaffolding only when the runtime needs it or the surrounding package already owns that abstraction.

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

Shared public type surfaces live under `src/core/types/`. Add domain-specific types near their owning modules unless they are part of that shared core surface.

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
2. **Types**: Shared core types go under `src/core/types/`; domain-specific types live near their owning modules.

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
- Schedule operations use their operation-catalog access policies across REST and JSON-RPC. Do not reintroduce tenant-claim access checks; multi-tenancy has been removed from the core, and legacy tenant fields are tolerated only as persisted-data cleanup. Preserve `description` as optional operator metadata on schedule definitions, persisted state, summaries, REST inputs, JSON-RPC inputs, and generated clients.
- Async activity completion operations (`weft.activities.complete` / `weft.activities.fail`) are public mutators over REST and JSON-RPC. Keep tokens in the request body, treat tokens as deterministic identifiers rather than secrets, validate completion payloads as hostile input, and reject oversized completion/failure payloads before consuming the single-use token.
- `durableActivity()` is a package-root helper only for plain async helpers running inside an inline `ctx.memo()` callback. Preserve memo-scoped sub-operation identities for retry, heartbeat, reconciliation, diagnostics, and timeline labels; keyed helper activities commit completed reconciliation records through immediate lease-fenced writes, while unkeyed helper activities keep at-least-once crash behavior. Reject use outside the active memo scope, reject unawaited pending helper promises on memo return, and keep `ActivityContext.completeAsync()` unsupported from helper-launched activities.
- Durable execution-token changes must preserve the split between `workflowExecutionToken` and per-attempt activity/finalizer tokens. `workflowExecutionToken` is minted for each run, persisted on `WorkflowState`, exposed on `WorkflowContext`, stable across recovery, and rotated for `start-new` or forked runs. Activity and finalizer attempt tokens must change per retry/attempt, flow through inline activities, worker execution, WebSocket tasks, long-poll claims, and finalizers, and be documented as external write fences rather than secrets.
- Storage adapters must report `capabilities()` honestly. Gate only `conditionalBatch` with `requireStorageCapability`; treat `boundedRangeDelete` as an operational hint and route bounded deletes through `storageDeleteRange()` so unbounded range deletion is impossible.
- `resolveDefaultStorage()` must stay durable-only across Bun, Node, WebExtension, and IndexedDB runtimes and must remain browser-bundleable without static Node built-in imports. Keep its behavior distinct from `resolveStorage({ type: 'auto' })`, which may fall back to `MemoryStorage`.
- Lease-owned engine writes must stay under `commitFencedEngineWrite`: checkpoints, timers, schedule state, purge commits, bulk retry reactivation, activity reconciliation, async-activity token/registration writes, completed-review persistence, and staged checkpoint side effects must all lose their compare-and-swap after deposition. Do not route one of those paths back through bare `storage.batch()` or standalone deletes.
- `isJSONValue()` and `jsonCodec()` reject `-0` because JSON serialization erases its sign. Keep negative-zero regression coverage when changing JSON validation, typed storage codecs, effect-log JSON handling, or storage wrappers.
- NeonStorage changes must preserve configurable `schema`/`table` validation, `TEXT COLLATE "C"` key ordering, opaque `BYTEA` values, read-only `query()` enforcement, and collapsed `batch()`/`conditionalBatch()` semantics where the net effect is resolved once before the SERIALIZABLE retry loop. Live Neon verification is required for driver-specific array binding or transaction changes when `NEON_DATABASE_URL` is available.
- Storage integrations that claim durable recovery readiness must satisfy `assertDurableStorageForRecovery()`: `persistence: 'local'` or `'remote'` (a durable remote store such as `NeonStorage`; only `ephemeral` is rejected on the persistence axis), linearizable read-after-write, snapshot scans, atomic batches, and `conditionalBatch`. Keep `WEFT_RESERVED_KEY_PREFIXES`, `scopedStorage`, `textValueStore`, `withCodec`, and the string-KV importer aligned when changing storage keyspace or wrapper behavior.
- `Engine.create()` recovers by default after workflow registration. Use `recover: false` only for tests, isolated `ScopedStorage` engines, pre-recovery inspection, or hosts that must install `recoverAll({ onRecoveredWorkflow })` hooks before recovery advances; do not reintroduce `requireConcurrentResumeSafety`; current Weft supports one engine process per durable store until `MultiEngine` fenced ownership exists. Preserve the type-level invariant that `Engine.create({ workflows: {} })` is equivalent to omitting `workflows` and returns the default-registry engine accepted by `ServeOptions`. Keep scheduler ownership orthogonal: `startScheduler` controls whether durable timers fire, defaults to `recover !== false`, and `schedulerPollIntervalMs` must stay a validated positive safe integer test seam rather than an environment variable. `backgroundTasks: 'manual'` is the externally driven maintenance mode: it must start no scheduler, cleanup, retention, or alert intervals; `await engine.runMaintenance()` must drive those paths once per awaited host tick; and construction must keep rejecting `ownership: 'lease'`, `detectSecondInstance: true`, and `startScheduler: true`.
- `ctx.sleep()` timer identity must stay replay-stable: the durable sleep operation id is `${workflowId}:${step}` so crash recovery re-arms the same timer key. Because `start-new` can reuse the workflow id and step, sleep settlement must remain deadline-aware (`fireAt`) and must not use a missing `timer-idx:sleep:` index as proof that the current run's timer fired; stale earlier-run timers can delete that shared index.
- Per-run workflow `services` are inline-only host capabilities, not durable state. Starting with `services` must persist only the presence marker, reject Worker execution mode, re-provide services through `resolveWorkflowServices` on running recovery, delayed-start recovery, and scheduled occurrences, pass recovered `launchOptions` and durable `schedule-run` metadata into the resolver when available, fail only the affected run when unavailable, and sweep the marker plus schedule-run metadata on terminal cleanup, purge, and retention. Keep `WorkflowServicesResolverLaunchOptions`, `WorkflowServicesResolverScheduleInfo`, and recovered-workflow hook types root-exported while `WorkflowServicesResolverInfo` exposes those fields. `recoverAll({ onRecoveredWorkflow })` runs after services are resolved and before the recovered generator advances; hook failures must fail only that run with a `system` category while sibling recovery continues.
- Query handlers registered with `ctx.onQuery()` must remain callable while an inline workflow is parked on `waitForSignal()`, must switch to the fresh context after signal resume, and must be torn down on suspend or terminal cleanup.
- `ctx.waitUntil(predicate, timeout?)` is an inline-only durable condition gate. It re-evaluates pure predicates only when `ctx.onUpdate()` drives workflow-local state or when its deterministic timeout fires; signals do not re-drive it, and it must remain rejected inside `ctx.race()`, `ctx.all()`, and `ctx.speculate()`.
- `ctx.race()` / `ctx.raceKeyed()` / `ctx.all()` branch changes must preserve sleep and wait-signal support, nested coordinator propagation, duplicate signal-name rejection across the coordination tree, non-destructive signal losers, and deferred signal consumption before checkpointing. Losing inline `ctx.run()` branches inside a race receive the coordinator `AbortSignal` on `ActivityContext.signal`, so superseded inline activities can stop cooperatively; worker-pooled activities do not receive that race-loss abort. `ctx.raceKeyed()` must persist and replay branch-name topology, reject empty or symbol-keyed maps before consuming a durable step, stringify numeric keys in the public result, and fail recovery on positional/keyed topology changes or branch-name reorderings. A direct two-branch race between `ctx.waitForSignal(name)` and literal `ctx.sleep(0)` must check the durable signal buffer before the zero sleep can win, while positive-duration sleeps keep ordinary race behavior. Pin `ctx.speculate` separately because it drives nested coordinators through a different top-level path.
- Idempotent starts and `engine.startOrSignal()` require storage `conditionalBatch`. Preserve permanent `start-idem:` key semantics: mappings survive terminal cleanup, purge, and retention; a spent key whose workflow record is gone must surface a conflict rather than start a replacement. For `startOrSignal`, keep REST, JSON-RPC, generated clients, `StartOrSignalSignal` typing, restart-capable `onTerminalConflict: 'start-new'`, and the per-call `StartOrSignalResult.outcome` aligned around exactly one of `signalId` or `idempotencyKey`, preserve same-tick start-signal-first delivery, and preserve the documented terminal-transition race behavior.
- Signal-id changes must keep caller-provided `signalId` values opaque and character-agnostic before storage-key encoding. Explicit values containing `anonymous:` or separator characters must not be parsed as Weft-generated anonymous signal identifiers, and anonymous sequence overflow must be rejected before persistence.
- `engine.start(..., { id, onTerminalConflict: 'start-new' })` and `engine.startOrSignal(..., { id, onTerminalConflict: 'start-new' })` both require an explicit `id`, reject `idempotencyKey`, never displace non-terminal runs, and purge terminal runs through the shared purge path before replacement. `startOrSignal` additionally requires a deterministic `signal.signalId` and is exposed through REST/JSON-RPC as a destructive operation; `ctx.startChild()` must still reject terminal-restart options for replay determinism.
- `WorkflowHandle.getLaunchMetadata()` and `WorkflowHandle.snapshot()` are recovered-handle observability surfaces. Keep them asynchronous storage reads that return `null` after purge/retention, exclude non-recoverable launch options from metadata, and report the same status semantics as `engine.get(id)`.
- History policy changes must keep `history.maxEvents` as a lifetime circuit breaker and `history.retentionWindow` as storage reclamation only. Event-log compaction writes the watermark atomically with checkpoint commits; archival is best-effort after deletion and must not be described as a durability guarantee.
- Persisted workflow-state version metadata is `WorkflowState.versionTuple`, not flat `version` / `agentVersion` / `toolVersions` fields. Fresh writes must use the tuple; decode can tolerate old flat records only as read normalization, and docs/tests should keep `WorkflowSummary.version` framed as the list-result shortcut for `versionTuple.workflowVersion`.
- `decodeWorkflowState()` strips unknown persisted fields instead of preserving retired or foreign keys. Fresh state writes must stay on the current `WorkflowState` allowlist; cleanup fixtures should prove tolerated extras are dropped without reintroducing alias, tenant, or migration wording.
- Payload-size policy changes must reject oversized workflow inputs, signal payloads, and activity results before durable writes. Keep `payloadSize.maxBytes` separate from storage compression, Worker `maxProtocolMessageBytes`, and the server WebSocket transport's fixed 4 MiB raw-frame ceiling.
- Custom serializer changes must preserve `registerSerializer()` as process-global and one-shot per constructor/tag. Checkpoints decode by the durable `tag`, not registration order; never document or implement `constructor.name` as a safe tag source for minified builds.
- Worker execution changes must preserve explicit trust posture: `workflowExecutionMode: 'worker'` is the hardened untrusted path with turn timeouts and bounded protocol messages; `workflowExecutionMode: 'inline'` rejects `workerExecution`.
- Durable workflow finalizers run on the engine host, not through the RemoteWorker activity table. Worker-mode engines may register workflows with `finalizer`, but worker generator contexts cannot stage finalizer state with `ctx.setFinalizerState()`; tests must cover host-side teardown, crash recovery, and the no-recorded-state case.
- `ctx.log` changes must preserve checkpoint-aware suppression without consuming a durable step: envelope fields stay engine-owned, attributes stay nested, worker mode logs to the worker console, throwing `EngineOptions.onLog` sinks fall back to console without failing the workflow, `ctx.speculate()` branches use the same sink behavior, and logs at uncached live frontiers may re-emit after recovery.
- Schedule event changes must preserve `schedule:fired` as a process-local, best-effort-after-durable-start event emitted only when a scheduled occurrence actually launches a run. Keep skipped ticks silent, queued-drain runs at `occurrence: undefined`, and unavailable-services failures ordered as `schedule:fired` before `workflow:failed`.
- Client ergonomics changes must keep `WeftClient.getHandle(id)` transport-uniform (`null` for missing, terminal `result()` from persisted state), preserve non-generic overloads before generic overloads on `WeftClient`, `LocalClient`, and `HttpClient`, and keep `isWeftFault(error, code)` matching both same-process Weft errors and HTTP-wrapped `weftCode` values. `StartOrSignalOutcome` is public from both the package root and `/client`, and `LocalClient` must accept branded engines returned by `Engine.create({ workflows })` without call-site casts.
- RemoteWorker SDK changes must preserve the required `workflows` map, qualified `${workflowType}.${activityName}` advertisement, key/name validation, duplicate-live-`workerId` rejection with grace-period reconnect allowed, and per-dispatch `attemptToken` echoing. Do not reintroduce the removed flat `activities` alias; `LongPollWorker.activities` and the wire `register.activities` array are separate contracts.
- Long-poll completion authorization is strict when the stored in-flight record has an `attemptToken`: missing or mismatched echoes reject. WebSocket `taskResult` authorization is additive for compatibility: missing echoes still fall back to the worker ownership guard, while present-but-wrong echoes reject.
- Task polling and shutdown changes must cover already-aborted request signals, disconnects during parked long-polls, task retention for dead pollers, and `server.stop()` disposal of queued timers/waiters.
- Inline cancellation changes must preserve prompt abort ordering: `engine.cancel()` aborts `ctx.signal` for already-running inline work before `ctx.onCancel()` handlers run, while `ctx.onCancel()` runs after the cancelled state is durably committed and before `cancel()` settles.
- Inline launch scheduling changes must cover `defer: false`, queued launch draining during disposal, and the MessageChannel-unavailable timeout-flush fallback without leaving result waiters pending.
- Client event-streaming changes must preserve the `client.tail(id)` / `handle.tail()` contract across `LocalClient` and `HttpClient`: `whenConnected()` resolves after catch-up, tails are single-consumer, `HttpClient` can use `/v1/workflows/:id/watch` or fetch-based `/v1/workflows/:id/events/sse`, reconnect catch-up must not duplicate or skip buffered frames, SSE replay-complete pings must unblock readiness, callback-only listeners must not accumulate an unbounded iterator buffer, and runtimes without usable WebSocket header support must either fall back to SSE under `eventTransport: 'auto'` or get an actionable `webSocketFactory` diagnostic when WebSocket is required. Server subscription changes must keep raw `/watch` scoped to `events:read`, raw token `/stream` scoped to `streams:read`, REST workflow and fleet SSE streams scoped through the operation catalog, JSON-RPC `weft.workflows.subscribe` and `weft.events.subscribe` out of request/response dispatch, replay capped and cursor-ordered, fleet events purge-safe, and worker connect/disconnect events included in the operator feed.
- Public root exports and build rewriter changes must run `bun run build`; the post-build guard fails if `dist/` contains a dangling relative `.js` specifier, including directory re-export mistakes such as emitting `./diagnostics.js` when only `./diagnostics/index.js` exists.
- Server subpath export changes must keep `@lostgradient/weft/server` self-sufficient for naming `ServeOptions`, `WeftServer`, `TaskDispatch`, `DiscoveryInfo`, `TaskQueue`, routing/scheduling/retry policies, `PrometheusExporter`, and `WorkerRegistry`, while `Engine` remains rooted at `@lostgradient/weft`. Pin the built package subpath with `.test-d.ts` coverage.
- Generated operation-client changes must update `scripts/generate-operation-client.ts`, regenerate `src/cli/generated/operation-client.generated.ts`, and prove determinism with `bun run scripts/generate-operation-client.ts && bun run scripts/check-catalog-drift.ts`. When reducing generated duplication, keep aliases structurally transparent, preserve call-site inference with type-level tests, and run `jscpd` against the generated file.
- Duplicate-audit cleanup must classify generated artifacts, reference-documentation mirrors, and intentional script cross-checks before refactoring. Use `documentation/contributing/duplicate-audits.md` and run `jscpd src scripts documentation tests --min-lines 18 --min-tokens 120 --exit-code 0`; do not quiet the audit by adding broad `src/` or `documentation/` ignores. When hand-authored test duplicates share fixture setup, extract only the repeated harness, such as lease-renewal failure setup, sleep-timer resolver choreography, or historical `review-decision:*` record construction, while keeping the scenario-specific timing inputs and assertions in each test. When test fixtures intentionally cover older persisted records or protocol shapes, name them `historical-*` or by the exact current scenario instead of leaving generic `legacy` identifiers. Coverage allowance changes must reject duplicate keys, cross-layer-shadowed keys, and keys matching a `coveragePathIgnorePatterns` entry in `scripts/check-coverage.ts` tests. Implementation-file-size exception wording must stay synchronized between `documentation/contributing/development-setup.md` and `scripts/check-implementation-file-sizes.ts`, and should describe the current responsibility boundary instead of old-path shims or compatibility barrels.
- CLI version-surface changes must preserve leading-token semantics: `weft --version`, `weft -v`, and `weft version` print the bare `VERSION` string and exit 0, while subcommand-local flags such as `weft serve --version` remain owned by that subcommand and reject unknown options.
- CLI command-suggestion refactors must preserve user-visible wording and thresholds: top-level subcommands use distance `2`, `weft api` operation suggestions use distance `6`, and tie breaks keep the first candidate. Pin those invariants in `src/cli/command-suggestions.test.ts` and parser integration tests.

### Testing Approach

- Tests use Bun's built-in test runner with `describe`, `it`, `expect`.
- Test files are typically colocated with sources using the `.test.ts` suffix.
- Test-only support modules under `src/` must use `.test-support.ts` or another build-excluded test-only pattern. After renaming or adding support modules, run `bun run build` so the post-build guard catches forbidden `bun:test`, `fake-indexeddb`, or `jsdom` imports in `dist/`.
- Shared browser-storage tests rely on the Bun `[test].preload` in `tests/test-preload.ts` for `fake-indexeddb`. Do not reintroduce per-file IndexedDB shim imports unless the file is a helper that can run outside the test preload.
- Avoid fixed wall-clock sleeps before assertions. For load-sensitive test handling, follow the `LOAD_SENSITIVE_TEST_PATHS` policy in [`documentation/contributing/development-setup.md`](documentation/contributing/development-setup.md#testing-conventions).
- Coverage fixes for callback creator bundles should exercise every wrapper path, including cleanup-error callbacks for stream and time operations, rather than adding allowances for reachable one-line delegators.
- Coverage fixes for server runtime worker paths should cover reachable lifecycle behavior before adjusting allowances. For stale worker socket closes, assert the warning, no requeue, and preserved fresh socket mapping; for `taskResult` resolution storage failures, assert the operator-facing `console.error` about a possible in-flight leak. Allowlist only residual branches proven unreachable by fresh LCOV, such as exhaustiveness defaults.
- Coverage fixes for engine lifecycle leak-warning helpers should stay in `src/core/engine-lifecycle-ergonomics.test.ts`: use the existing finalizer leak-warning harness and assert `getEngineLeakCollectionCountForTesting()` through the disabled warning gate before considering an allowance.
- Tests that use fake timers should restore real timers locally, even though `tests/test-preload.ts` runs a global `afterEach(restoreRealTimers)` safety net. A leaked fake clock can trap `Bun.sleep(...)` in the next sequential test file, so isolation tests should prove the preload cleanup remains active rather than relying on test order.
- Coverage-restoration pull requests for retry or checkpoint machinery should cover invalid persisted retry attempts, missing retry policy replay, non-`Error` retry classification, and retry-to-sleep-to-success paths before shrinking allowances.
- Coverage-restoration work for parallel caches, activity reconciliation, and checkpoint persistence should prove `ctx.runAll()` cached replay reconstruction, malformed reconciliation-record rejection, fenced-write conflict surfacing, callback checkpoint persistence through a live engine, and `history.maxEvents` circuit-breaker termination before editing `scripts/check-coverage.ts`. Remove duplicate allowance refresh entries after fresh LCOV proves they are stale.
- Coverage-restoration work for async activity completion should prove acknowledgement durability before moving allowances: same-epoch lease precondition loss must reject without consuming the token record, and malformed persisted resolution outcomes must be ignored during recovery without entering pending async activity resolutions.
- Coverage-restoration work for durable operation helpers should include cached replay mismatch and explain-mode logging paths for `getVersion()`, `sleep()`, and `review()` before relying on the adjusted coverage gate.
- Coverage-restoration work for schedule and worker seams should cover schedule spec/options validation, malformed schedule-record decoding, create-schedule `jitter` validation, worker `getVersion()` replay edges, interceptor context omission, and task-result persistence-failure logging before moving line-keyed allowances.
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

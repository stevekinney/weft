# Development Setup

Weft is a Bun-native project. Everything—from the runtime to the test runner to the build tool—is Bun. If you're coming from a Node.js background, most things will feel familiar, but a few conventions are different enough to be worth calling out up front.

## Prerequisites

You need [Bun](https://bun.sh) installed. The minimum version is 1.3.13, but I'd recommend the latest stable release. If you don't have it yet:

```bash
curl -fsSL https://bun.sh/install | bash
```

Verify with `bun --version`. That's the only prerequisite—no Docker, no separate database, no global CLI tools.

## Getting started

Clone the repository and install dependencies:

```bash
git clone https://github.com/stevekinney/weft.git
cd weft
bun install
```

The lockfile is `bun.lock`. Always use `bun` commands, never `npm` or `yarn`. Use `bunx` in place of `npx` for one-off package execution.

## Development commands

Start the development server with file watching:

```bash
bun run dev
```

This runs `src/index.ts` with Bun's `--watch` flag, so changes are picked up automatically.

For a production build:

```bash
bun run build
```

Output lands in `dist/`. You can run the compiled artifact directly:

```bash
bun ./dist/index.js
```

## Testing

Bun's built-in test runner handles everything. Tests use `describe`, `it`, and `expect`—same ergonomics as Jest, no extra dependencies.

```bash
bun test                  # Run all tests
bun test src/utils        # Run tests in a specific directory
bun test logger           # Run tests matching a pattern
bun test --watch          # Watch mode
bun test --coverage       # Generate a coverage report
bun test --parallel       # Parallel execution across files
```

> [!NOTE]
> The project's `bun run test` script wraps `bun test --timeout 15000`. Use `bun run test:coverage` (which sets `WEFT_COVERAGE_MODE=1`) for coverage with the project's configured timeout and environment.

> [!NOTE]
> Performance benchmarks live in `src/benchmarks/` and run separately via `bun run test:benchmarks`—serial, to keep timing honest. They're excluded from `bun run test`, `bun run validate`, and the publish gate; run them when you touch a performance-sensitive path. The coverage gate still exercises them.

For the repository coverage gate, use the deterministic verifier:

```bash
bun run scripts/check-coverage.ts
```

The verifier removes stale `coverage/` output, runs Bun coverage once with LCOV output, parses `coverage/lcov.info`, applies the repository's narrow coverage allowances, and exits non-zero when the coverage process fails or adjusted line or function coverage is below 100 percent. It is a coverage gate only, so keep `bun test` or `bun run validate` as the passing-suite gate. Use it when changing coverage-sensitive code, generated clients, CLI paths, or the allowance table itself.

When restoring coverage around server runtime paths, prefer characterization tests for reachable lifecycle behavior before editing allowances. Recent examples cover stale worker socket closes by asserting the warning, no requeue, and preserved fresh socket mapping, and cover `taskResult` resolution storage failures by asserting the operator-facing `console.error` that an in-flight record may leak. Only keep an allowance after fresh LCOV output proves the remaining branch is unreachable, such as a type-level exhaustiveness default arm.

When restoring coverage around schedules or worker replay, drive the public validation and replay contracts before shifting allowance lines. Recent focused examples cover malformed schedule records, invalid create-schedule `jitter` input, worker `getVersion()` replay edges, interceptor context omission, and retryable string failures that sleep before retrying.

When restoring coverage around retry, checkpoint, or reconciliation paths, drive the durable behavior before changing `scripts/check-coverage.ts`. Recent focused tests cover corrupt retry-state locals, `ctx.runAll()` cached replay reconstruction, malformed activity reconciliation records, fenced-write conflicts, callback checkpoint persistence through a live engine, and `history.maxEvents` circuit-breaker termination. Remove duplicate or stale allowance refresh entries after fresh LCOV proves the remaining miss is instrumentation drift rather than reachable behavior.

When restoring coverage around async activity completion, prove the acknowledgement durability contract directly before moving allowances. Recent focused tests cover same-epoch acknowledgement precondition loss under `ownership: 'lease'` by asserting the token record remains present and unconsumed, and recovery from malformed persisted resolution outcomes by asserting nothing is queued into pending async activity resolutions.

### Testing conventions

Test files live next to the source they test, using the `.test.ts` suffix. A separate `tsconfig.test.json` provides relaxed TypeScript settings for test code. Oxlint rules are also relaxed for test files (`*.test.ts`, `*.spec.ts`, `test/**`, `__tests__/**`)—you can freely use `any`, non-null assertions, unused variables, and other patterns that would normally be flagged in production code.

Prefer condition-based synchronization over fixed wall-clock sleeps. The `verify:no-test-sleeps` gate rejects direct `Bun.sleep(...)` calls in tests and literal `waitForRealTimersForTesting(<number>)` barriers immediately before assertions. If a real integration case cannot await an observable condition, mark the delay with one of the structured categories enforced by the verifier: `negative assertion`, `pre-dispatch settle`, or `hang guard`.

Tests that install Bun/Jest fake timers must restore real timers in their own teardown when possible. The shared `tests/test-preload.ts` also runs a global `afterEach(restoreRealTimers)` safety net so a failing local teardown cannot leak fake timers into the next file and strand later `Bun.sleep(...)` calls. Treat that preload hook as isolation cleanup, not as permission to leave fake timers installed intentionally.

The pre-commit hook excludes a small, reviewed `LOAD_SENSITIVE_TEST_PATHS` list from its parallel full-suite pass. Add to that list only after proving the case cannot be made load-insensitive, splitting it into its own file, and keeping the ceiling assertion in `scripts/husky/run-tests.test.ts` honest. CI still runs those tests in the normal full suite; the exclusion is local-hook load control, not a correctness skip.

## Code quality

Three tools keep the codebase consistent:

```bash
bun run lint              # Check for linting errors (Oxlint)
bun run lint:fix          # Auto-fix linting errors
bun run typecheck         # TypeScript type checking (tsc --noEmit)
bun run format            # Format all files with Prettier
bun run format:check      # Check formatting without writing changes
```

**Oxlint** is a Rust-based linter with built-in TypeScript, promise, unicorn, and import plugins. It runs type-aware rules via `--type-aware --tsconfig ./tsconfig.json`. Import sorting and unused import removal are handled by Prettier via `prettier-plugin-organize-imports`.

`.oxlintrc.json` keeps the default cyclomatic complexity ceiling at 10. A small
override block allows `max: 22` for files where the branch count is dominated by
wire contracts, state-machine transitions, or catalog-shaped request parsing. Do
not add a file to that override without adding a per-file rationale here:

| File                                              | Rationale                                                                                                                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/checkpoint/lifecycle.ts`                | Checkpoint restoration validates serialized lifecycle variants in one boundary so malformed durable state fails before replay advances.                        |
| `src/core/engine/checkpoint-replay.ts`            | Replay compaction keeps accumulated results, worker signatures, and worker failures aligned through one watermark algorithm.                                   |
| `src/core/engine/bulk-operations.ts`              | Bulk mutators share confirmation, filtering, per-workflow outcome shaping, and audit persistence across the public bulk API surface.                           |
| `src/core/engine/lifecycle/recovered-services.ts` | Service rehydration must distinguish available, unavailable, missing-resolver, and throwing-resolver recovery paths before generator execution resumes.        |
| `src/core/engine/lifecycle/start-commit.ts`       | Start commits coordinate idempotency keys, delayed starts, scheduling timers, indexes, and execution ownership in one atomic write boundary.                   |
| `src/core/engine/termination/complete.ts`         | Terminal transitions fan out to result resolution, timers, indexes, concurrency release, cleanup markers, and event emission from one status gate.             |
| `src/server/operations/create-schedule.ts`        | Schedule creation normalizes REST and JSON-RPC input variants while preserving one operation contract for cron, jitter, overlap, and backfill options.         |
| `src/server/operations/get-task-diagnostics.ts`   | Diagnostics intentionally classify queued, inflight, resolved, and dead-letter records into a bounded operator response without splitting the schema contract. |
| `src/server/runtime/authentication-bridge.ts`     | Authentication bridge behavior is a transport boundary that must preserve request cloning, body forwarding, and principal shaping decisions together.          |
| `src/server/runtime/task-polling.ts`              | Polling owns long-poll lifecycle, timeout disposal, task dispatch, payload rejection, and HTTP result submission from one request boundary.                    |
| `src/server/runtime/task-reconciliation.ts`       | Reconciliation classifies queued and inflight task records against worker liveness and retry state in one bounded diagnostic pass.                             |
| `src/server/runtime/task-result-resolution.ts`    | Result resolution coordinates payload-size checks, in-flight ownership, dead letters, retries, and resolved markers under one authorization boundary.          |

The repository prefers implementation files at or below 500 physical lines, but not every larger file should be split. Run the file-size audit before opening a pull request:

```bash
bun run scripts/check-implementation-file-sizes.ts
```

The audit scans `src/`, `scripts/`, and `tests/` TypeScript/Svelte implementation files, excluding generated files plus test/spec suffixes such as `.test.ts`, `.spec.svelte`, and `.test-d.ts`. Any file above 500 lines must be either split along an existing responsibility boundary or classified here with a durable rationale. Do not split public type surfaces, root export manifests, or operation-boundary modules into compatibility barrels or shallow old-path re-export layers.

| File                                            | Classification      | Rationale                                                                                                                                  |
| ----------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/check-coverage.ts`                     | Justified exception | Coverage allowances, LCOV parsing, and adjusted-total reporting stay together so the coverage gate has one auditable policy owner.         |
| `src/core/engine/index.ts`                      | Tracked separately  | The Engine declaration surface is tracked by local task 3765ffa6-1430-4be5-970c-c0f984ff34df; this issue excludes that refactor.           |
| `src/core/engine/bulk-operations.ts`            | Justified exception | Bulk cancel, delete, retry, signal, tag, and purge operations share one confirmation, filtering, outcome, and audit contract.              |
| `src/storage/interface.ts`                      | Justified exception | The storage interface is a public type and helper surface where splitting would scatter one import contract across multiple subpaths.      |
| `src/client/client-contract.test-support.ts`    | Justified exception | The shared client contract harness intentionally keeps cross-transport behavior assertions in one reusable test-support module.            |
| `src/core/engine/state-utilities.ts`            | Justified exception | Workflow state decoding, summaries, filters, and debug sanitization are coupled around the persisted workflow-state boundary.              |
| `scripts/snapshot-public-api.ts`                | Justified exception | Public API snapshotting keeps export traversal, declaration capture, and snapshot comparison together as one release-surface audit.        |
| `src/client/interface.ts`                       | Justified exception | The public client interface keeps transport-uniform overloads, handles, schedules, reviews, and stream contracts in one type surface.      |
| `src/core/engine/termination/complete.ts`       | Justified exception | Terminal completion coordinates status transitions, timers, indexes, waiters, events, and cleanup from one status gate.                    |
| `src/worker/index.ts`                           | Justified exception | The worker entrypoint keeps registration, protocol negotiation, dispatch, completion, heartbeat, and shutdown behavior together.           |
| `src/server/operations/get-task-diagnostics.ts` | Justified exception | Task diagnostics classify queued, inflight, resolved, and dead-letter records into one bounded operator response.                          |
| `scripts/verify-tree-shaking.ts`                | Justified exception | Tree-shaking verification keeps build setup, bundle inspection, source-map checks, and package export assertions in one audit.             |
| `src/index.ts`                                  | Justified exception | The package root is the intentional public export manifest; splitting it would add indirection without reducing implementation complexity. |
| `src/core/types/workflow-builder.ts`            | Justified exception | Workflow-builder types form one fluent type-state contract where splitting would obscure the compile-time state transitions.               |
| `src/server/task-state.ts`                      | Justified exception | Task-state storage owns queued, inflight, resolved, dead-letter, and worker-index records under one persistence contract.                  |
| `src/client/http-client.ts`                     | Justified exception | The HTTP client class centralizes the transport implementation behind the public client interface without adding old-path shims.           |
| `src/workers/workflow-runner.ts`                | Justified exception | Worker-runner message handling, replay, context wiring, and result reporting stay together as the worker isolate boundary.                 |
| `src/core/engine/checkpoint-io.ts`              | Justified exception | Checkpoint I/O owns decode, encode, chunk, archive, and retention behavior around one durable checkpoint boundary.                         |
| `scripts/husky/run-tests.ts`                    | Justified exception | The hook test runner keeps staged-file routing, load-sensitive exclusions, and diagnosable output in one local hook command.               |
| `src/core/context/index.ts`                     | Justified exception | Workflow context exposes the generator-facing API surface; splitting it would make one context contract harder to inspect.                 |
| `scripts/regenerate-trace-fixtures.ts`          | Justified exception | Trace-fixture regeneration keeps scenario discovery, execution, serialization, and drift output in one fixture owner.                      |
| `src/core/types/workflow-context.ts`            | Justified exception | Workflow-context types define one public generator API contract whose overloads and helper result types need local adjacency.              |
| `src/server/operations/bulk-filter-helpers.ts`  | Justified exception | Bulk filter helpers keep REST, JSON-RPC, preview, and commit parsing aligned for the shared bulk-operation contract.                       |
| `src/server/index.ts`                           | Justified exception | The server entrypoint owns the public serve surface and exported server types; further splitting would create shallow re-export files.     |
| `src/storage/indexeddb.ts`                      | Justified exception | IndexedDB storage keeps browser schema setup, transactions, scans, batching, and capability reporting in one adapter boundary.             |
| `src/core/worker-protocol.ts`                   | Justified exception | Worker protocol types and validators stay together so wire messages, limits, and validation errors remain one auditable contract.          |
| `src/mcp/tools.ts`                              | Justified exception | MCP tool schemas and handlers are intentionally adjacent so tool metadata and operation dispatch cannot drift.                             |
| `src/storage/web-extension.ts`                  | Justified exception | WebExtension storage keeps namespace detection, callback/promise bridging, quota handling, and scans in one adapter boundary.              |
| `src/core/engine/operations-coordination.ts`    | Justified exception | Coordination operations keep race, all, nested signal, and branch-dispatch semantics together around one coordinator boundary.             |
| `src/server/operations/storage.ts`              | Justified exception | Storage operations keep REST-only bindings, binary body handling, batch validation, and fault shaping in one route contract.               |
| `src/core/engine/operations-activity.ts`        | Justified exception | Activity operations coordinate interceptors, retries, reconciliation, async completion, verification, and result feeding together.         |
| `src/core/engine/signals.ts`                    | Justified exception | Signal buffering, waiter tracking, payload validation, and atomic consumption share one durable signal-delivery contract.                  |
| `src/client/http-client-requests.ts`            | Justified exception | HTTP request helpers are grouped by one client transport and mostly sit just above the threshold; splitting would add routing noise.       |
| `scripts/generate-operation-client.ts`          | Justified exception | The operation-client generator keeps schema normalization, alias selection, rendering, formatting, and drift output together.              |

To clean build artifacts, coverage output, and caches:

```bash
bun run clean
```

### Verification scripts

Run `bun run validate` before opening a pull request. It is the one-shot gate that composes `bun run lint`, `bun run typecheck`, `bun run typecheck:tests`, `bun run verify:documentation`, `bun run verify:no-test-sleeps`, `bun run verify:public-api-jsdoc`, and `bun run test`.

```bash
bun run validate
```

When iterating on a single area, you can run the individual scripts that `validate` composes:

```bash
bun run verify:exports          # Check all public exports resolve correctly
bun run verify:documentation    # Check documentation links, anchors, and version claims
bun run verify:portability      # Check that code avoids Bun-only APIs in portable modules
bun run verify:jsdoc            # Validate JSDoc coverage on public API
bun run verify:markdown-doctests # Check TypeScript code blocks in documentation
bun run scripts/verify-release-version.ts --tag=vX.Y.Z  # Confirm package.json, VERSION, and tag consistency before a release
```

### Release package checks

The npm package is published as `@lostgradient/weft` through trusted publishing. The GitHub Actions release workflow uses npm OIDC provenance and must not use `NODE_AUTH_TOKEN` or `NPM_TOKEN`; configure the npm trusted publisher for `.github/workflows/release.yaml` before the first publish.

Run the package gates against the built artifact before cutting a tag:

```bash
bun run prepack
npm publish --dry-run --ignore-scripts
```

`prepack` already runs the build, export and portability checks, Markdown and JSDoc doctests, package-content validation, and packed-consumer checks. The publish dry run uses `--ignore-scripts` to match the release workflow, where `prepack` has already run explicitly before publish. The release workflow also runs `bun run validate` before publishing, and `verify-release-version` fails unless the pushed tag, `package.json.version`, and the exported `VERSION` constant all agree.

## Git hooks

Husky manages Git hooks. The shell wrappers live in `.husky/` and delegate to TypeScript scripts under `scripts/husky/`. Those scripts use `chalk` for color, `change-case` for headings, and Bun's `$` shell and `Bun.write` for I/O.

Three hooks are active:

- **pre-commit** runs lint-staged, which auto-fixes linting and formatting on staged files. It also runs basic dependency checks.
- **post-checkout** installs dependencies when `package.json` or `bun.lock` changed between branches and surfaces relevant config changes.
- **post-merge** installs or cleans dependencies when they changed during the merge and shows merge stats.

You don't need to configure any of this—`bun install` sets up Husky automatically via the `prepare` script.

## Import organization

Prettier with `prettier-plugin-organize-imports` sorts imports automatically. The expected order is:

1. Bun built-ins (e.g., `import { file, write } from 'bun'`)
2. Node built-ins (e.g., `import { join } from 'node:path'`)
3. External packages (e.g., `import { z } from 'zod'`)
4. Internal absolute imports (e.g., `@/configuration/environment`)
5. Relative imports (e.g., `./local-module`)

Running `bun run format` enforces this, so you don't need to think about it manually.

## Prefer Bun APIs over Node equivalents

When possible, reach for Bun's native APIs. They're optimized for performance and typically have a simpler interface. Here's a quick reference:

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

When a Bun equivalent doesn't exist or Node's API is more appropriate, use the `node:` prefix for clarity (e.g., `import { join } from 'node:path'`).

## Configuration notes

A few things worth knowing about the tooling setup:

- **bunfig.toml** targets Bun for builds with sourcemaps and minification enabled.
- **TypeScript** uses Bun types. Node type libraries are not included by default.
- **ESM + TypeScript** is the module format. Source files are TypeScript modules; the build output targets Bun. Use standard TS/ESM imports—no special runtime helpers needed.
- **Environment variables** are limited to explicit runtime, CLI, and test toggles. The library API is options-first; keep each read close to the code path that consumes it. Document a new user-facing runtime, CLI, or conformance `WEFT_*` variable in [`configuration.md`](../reference/configuration.md#environment-variables); keep internal benchmark, coverage, and smoke-test toggles documented beside the tests or scripts that consume them.

That covers the day-to-day workflow. If the tests pass, the linter is happy, and the types check out, you're good to open a pull request.

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

Use `bun run scripts/check-coverage.ts` for the deterministic adjusted-coverage gate. It deletes stale `coverage/` output, runs non-dashboard coverage in parallel, runs dashboard coverage serially, merges LCOV, applies the repository's explicit allowances, and fails when adjusted line or function coverage is below 100 percent. This is a coverage gate only: it can still evaluate LCOV after a shard exits non-zero, so it does not replace a passing `bun test` or `bun run validate`.

Use `bun run prepack` before release or package-surface changes. It runs the build, export and portability checks, Markdown and JSDoc doctests, package-content validation, and packed-consumer checks. The GitHub release workflow publishes `@lostgradient/weft` with `npm publish --ignore-scripts`, so local publish dry runs should use `npm publish --dry-run --ignore-scripts` after `prepack`.

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

### Server and Dashboard Surfaces

- New REST or JSON-RPC operations must declare their access scope, operation name, transport availability, input source mapping, and fault shaping explicitly.
- Operator diagnostics should keep metrics low-cardinality. Use bounded diagnostic endpoints for workflow IDs, operation IDs, worker IDs, queue names, and other high-cardinality evidence.
- If a server operation is surfaced in the dashboard, update the dashboard API client types and tests together with the route or operation.
- Workflow visibility changes must keep `engine.list`, `engine.aggregate`, REST query parsing, JSON-RPC inputs, dashboard filters, and bulk-action preview filters aligned. Pin failure-category filters, id-prefix filters, date ranges, aggregate grouping, and default ordering in tests.
- Existing Bun SQLite deployments need the workflow visibility backfill before older workflows can rely on indexed queries. Document the maintenance-window requirement, `--drop` rollback path, exit codes, and watermark behavior with any visibility-index change.
- Failure categories are the execution taxonomy `application`, `timeout`, `cancellation`, `resource`, and `system`. Preserve read/query normalization for legacy persisted values, but do not reintroduce legacy values as accepted public filter input.
- MCP discovery is public metadata that emits absolute URLs. Changes to `/.well-known/mcp.json`, `/openrpc.json` MCP metadata, or `/mcp` must cover `publicOrigin`/`trustedHosts`, and authentication/session binding.
- Preserve legacy REST response contracts during cleanup refactors. Shared helpers are fine, but tests must pin any intentionally raw or masked error shape.
- REST `EngineFailure` responses are masked by the canonical `shapeRestFault` path as `{ error: "Internal server error" }` with status `500`; JSON-RPC still receives the operation fault object. Preserve that split when refactoring operation helpers.
- Schedule operations use their operation-catalog access policies across REST and JSON-RPC. Do not reintroduce tenant-claim access checks; multi-tenancy has been removed from the core, and legacy tenant fields are tolerated only as persisted-data cleanup.
- Storage adapters must report `capabilities()` honestly. Gate only `conditionalBatch` with `requireStorageCapability`; treat `boundedRangeDelete` as an operational hint and route bounded deletes through `storageDeleteRange()` so unbounded range deletion is impossible.
- Storage integrations that claim durable recovery readiness must satisfy `assertDurableStorageForRecovery()`: `persistence: 'local'`, linearizable read-after-write, snapshot scans, atomic batches, and `conditionalBatch`. Keep `WEFT_RESERVED_KEY_PREFIXES`, `scopedStorage`, `textValueStore`, `withCodec`, and the string-KV importer aligned when changing storage keyspace or wrapper behavior.
- `Engine.create()` recovers by default after workflow registration. Use `recover: false` only for tests, isolated `ScopedStorage` engines, or pre-migration inspection, and do not reintroduce `requireConcurrentResumeSafety`; current Weft supports one engine process per durable store until `MultiEngine` fenced ownership exists.
- History policy changes must keep `history.maxEvents` as a lifetime circuit breaker and `history.retentionWindow` as storage reclamation only. Event-log compaction writes the watermark atomically with checkpoint commits; archival is best-effort after deletion and must not be described as a durability guarantee.
- Payload-size policy changes must reject oversized workflow inputs, signal payloads, and activity results before durable writes. Keep `payloadSize.maxBytes` separate from storage compression and Worker `maxProtocolMessageBytes`.
- Worker execution changes must preserve explicit trust posture: `workflowExecutionMode: 'worker'` is the hardened untrusted path with turn timeouts and bounded protocol messages; `workflowExecutionMode: 'inline'` rejects `workerExecution`.
- Task polling and shutdown changes must cover already-aborted request signals, disconnects during parked long-polls, task retention for dead pollers, and `server.stop()` disposal of queued timers/waiters.
- Client event-streaming changes must preserve the `client.tail(id)` / `handle.tail()` contract across `LocalClient` and `HttpClient`: `whenConnected()` resolves after catch-up, tails are single-consumer, `HttpClient` uses `/v1/workflows/:id/watch`, reconnect catch-up must not duplicate or skip buffered frames, callback-only listeners must not accumulate an unbounded iterator buffer, and runtimes without usable WebSocket header support must get an actionable `webSocketFactory` diagnostic.
- Public root exports and build rewriter changes must run `bun run build`; the post-build guard fails if `dist/` contains a dangling relative `.js` specifier, including directory re-export mistakes such as emitting `./diagnostics.js` when only `./diagnostics/index.js` exists.
- Generated operation-client changes must update `scripts/generate-operation-client.ts`, regenerate `src/cli/generated/operation-client.generated.ts`, and prove determinism with `bun run scripts/generate-operation-client.ts && bun run scripts/check-catalog-drift.ts`. When reducing generated duplication, keep aliases structurally transparent, preserve call-site inference with type-level tests, and run `jscpd` against the generated file.
- CLI command-suggestion refactors must preserve user-visible wording and thresholds: top-level subcommands use distance `2`, `weft api` operation suggestions use distance `6`, and tie breaks keep the first candidate. Pin those invariants in `src/cli/command-suggestions.test.ts` and parser integration tests.

### Testing Approach

- Tests use Bun's built-in test runner with `describe`, `it`, `expect`.
- Test files are typically colocated with sources using the `.test.ts` suffix.
- Test-only support modules under `src/` must use `.test-support.ts` or another build-excluded test-only pattern. After renaming or adding support modules, run `bun run build` so the post-build guard catches forbidden `bun:test`, `fake-indexeddb`, or `jsdom` imports in `dist/`.
- Shared browser-storage tests rely on the Bun `[test].preload` in `tests/test-preload.ts` for `fake-indexeddb`. Do not reintroduce per-file IndexedDB shim imports unless the file is a helper that can run outside the test preload.
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

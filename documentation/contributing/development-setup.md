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

For the repository coverage gate, use the deterministic verifier:

```bash
bun run scripts/check-coverage.ts
```

The verifier removes stale `coverage/` output, runs Bun coverage once with LCOV output, applies the repository's narrow coverage allowances, and exits non-zero when adjusted line or function coverage is below 100 percent. It is a coverage gate only: it can still evaluate LCOV after `bun test` exits non-zero, so keep `bun test` or `bun run validate` as the passing-suite gate. Use it when changing coverage-sensitive code, generated clients, CLI paths, or the allowance table itself.

### Testing conventions

Test files live next to the source they test, using the `.test.ts` suffix. A separate `tsconfig.test.json` provides relaxed TypeScript settings for test code. Oxlint rules are also relaxed for test files (`*.test.ts`, `*.spec.ts`, `test/**`, `__tests__/**`)—you can freely use `any`, non-null assertions, unused variables, and other patterns that would normally be flagged in production code.

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
bun run verify:release-version  # Confirm version consistency before a release
```

### Release package checks

The npm package is published as `@lostgradient/weft` through trusted publishing. The GitHub Actions release workflow uses npm OIDC provenance and must not use `NODE_AUTH_TOKEN` or `NPM_TOKEN`; configure the npm trusted publisher for `.github/workflows/release.yaml` before the first publish.

Run the package gates against the built artifact before cutting a tag:

```bash
bun run prepack
npm publish --dry-run --ignore-scripts
```

`prepack` already runs the build, export and portability checks, Markdown and JSDoc doctests, package-content validation, and packed-consumer checks. The publish dry run uses `--ignore-scripts` to match the release workflow, where `prepack` has already run explicitly before publish.

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

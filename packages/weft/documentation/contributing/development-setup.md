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

> [!NOTE] This repository is a publication mirror
> `stevekinney/weft` is synced from the private corvidae workspace, which is the source of truth. Lint, tests, coverage, documentation audits and benchmarks run there before a sync reaches this repository; the retired commands below are corvidae's. Here, `mirror-verify.yaml` builds, typechecks, packs and lints the published package on every pull request, and `release.yaml` publishes it on a tag.

The test files ship here as source, but no script runs them: `bun test`, `test:coverage` and `test:benchmarks` were retired with the repository's own CI. Run them in corvidae.

## Code quality

```bash
bun run typecheck         # TypeScript type checking
bun run format            # Format with Prettier
bun run format:check      # Check formatting without changes
```

Lint, the lint-suppression ceiling, the implementation file-size registry, the revision-keyed lookup guard, the coverage gate and the documentation and JSDoc audits run in corvidae; their scripts were retired from this repository (corvidae COR-1286).

### Release package checks

```bash
bun run prepack
```

`prepack` runs the build, the export and portability checks and the package-consumer validation — the same checks `release.yaml` runs before `npm publish`. Run `bun run verify:release-version` before tagging so `package.json`, `src/version.ts` and the tag agree.

## Git hooks

There are none. The husky hooks were retired with the repository's own CI when it became a mirror.

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

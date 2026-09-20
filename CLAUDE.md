# CLAUDE.md

This repository is a Turborepo-powered monorepo using Bun workspaces.

## Layout

- `packages/weft`: the `@lostgradient/weft` durable execution engine, published to npm. Its own `CLAUDE.md` carries the package's full conventions—read it before working on anything under `packages/weft`.

## Working in this repository

- Run `bun install` at the repository root; there is one root `bun.lock` for the whole workspace.
- Root scripts fan out through Turborepo: `bun run build`, `bun run lint`, `bun run typecheck`, `bun run test` each run `turbo run <task>` across packages. Use `bunx turbo run <task> --filter=<package>` or `cd` into a package to scope to one package.
- Git hooks live at the repository root (`.husky/`) and delegate into each package's `scripts/husky/` hooks with the package directory as the working directory.
- CI uses the Turborepo remote cache for the deterministic jobs only, and `release.yaml` gates never use it.
- Each package keeps its own lint, formatting, TypeScript, and test configuration. Do not hoist package configuration to the root.
- The `v*.*.*` release tags publish `@lostgradient/weft` only. The operator console (`@lostgradient/weft-ui`) is developed and built from its own repository, and is not yet published to npm.

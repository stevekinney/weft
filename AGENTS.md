# AGENTS.md

This file provides guidance to coding agents working with code in this repository. This repository is a Turborepo-powered monorepo using Bun workspaces.

## Layout

- `packages/weft`: the `@lostgradient/weft` durable execution engine, published to npm. Its own `CLAUDE.md` carries the package's full conventions—read it before working on anything under `packages/weft`.

## Working in this repository

- Run `bun install` at the repository root; there is one root `bun.lock` for the whole workspace.
- Root scripts fan out through Turborepo: `bun run build` and `bun run typecheck` each run `turbo run <task>` across packages. Use `bunx turbo run <task> --filter=<package>` or `cd` into a package to scope to one package. There are no lint, test or coverage scripts here: This repository is a **publication mirror** of the private corvidae workspace, which is the source of truth for `@lostgradient/weft`. Lint, tests, coverage, documentation audits and benchmarks run there before a sync reaches this repository; here, the transform-emitted `mirror-verify.yaml` builds, typechecks, packs and lints the published package on every pull request, and `release.yaml` publishes it on a tag. Pull requests are welcome, but they cannot be merged as submitted: a change is ported into corvidae by hand and arrives back through a sync.
- There are no Git hooks. The repository's own CI, hooks and gate scripts were retired when it became a mirror (corvidae COR-1286).
- CI is `.github/workflows/mirror-verify.yaml`, emitted by the corvidae mirror transform from the same steps its sync runs, plus `pr-title.yaml` and `release.yaml`. Do not edit `mirror-verify.yaml` by hand; a sync overwrites it.
- Each package keeps its own lint, formatting, TypeScript, and test configuration. Do not hoist package configuration to the root.
- The `v*.*.*` release tags publish `@lostgradient/weft` only. The operator console (`@lostgradient/weft-ui`) is developed and built from its own repository, and is not yet published to npm.

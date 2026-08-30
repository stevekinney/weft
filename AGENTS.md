# AGENTS.md

This file provides guidance to coding agents working with code in this repository. This repository is a Turborepo-powered monorepo using Bun workspaces.

## Layout

- `packages/weft`: the `@lostgradient/weft` durable execution engine, published to npm. Its own `CLAUDE.md` carries the package's full conventions—read it before working on anything under `packages/weft`.
- `packages/weft-ui`: the `@lostgradient/weft-ui` operator console (Svelte 5 + Vite), formerly the standalone weft-console repository.

## Working in this repository

- Run `bun install` at the repository root; there is one root `bun.lock` for the whole workspace.
- Root scripts fan out through Turborepo: `bun run build`, `bun run lint`, `bun run typecheck`, `bun run test` each run `turbo run <task>` across packages. Use `bunx turbo run <task> --filter=<package>` or `cd` into a package to scope to one package.
- Git hooks live at the repository root (`.husky/`) and delegate into each package's `scripts/husky/` hooks with the package directory as the working directory.
- GitHub workflows live at the repository root and run package jobs with `working-directory` set to the package.
- Each package keeps its own lint, formatting, TypeScript, and test configuration. Do not hoist package configuration to the root.
- The `v*.*.*` release tags publish `@lostgradient/weft` only. `@lostgradient/weft-ui` is not yet published.

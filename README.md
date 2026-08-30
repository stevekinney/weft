# Weft

A Bun-native durable execution engine with pluggable key-value storage, plus its operator console. This repository is a Turborepo-powered monorepo using Bun workspaces.

## Packages

- [`packages/weft`](packages/weft/README.md): the `@lostgradient/weft` durable execution engine, server, client, CLI, and storage adapters. Published to npm.
- [`packages/weft-ui`](packages/weft-ui/README.md): the `@lostgradient/weft-ui` operator console for the Weft engine (formerly the standalone [weft-console](https://github.com/stevekinney/weft-console) repository).

## Getting started

```bash
bun install
bun run build       # turbo run build across all packages
bun run test        # turbo run test across all packages
bun run lint        # turbo run lint across all packages
bun run typecheck   # turbo run typecheck across all packages
```

Run a single package's scripts either through Turborepo filters or directly in the package directory:

```bash
bunx turbo run test --filter=@lostgradient/weft
cd packages/weft && bun run test
```

## Repository layout

Each package keeps its own configuration (`tsconfig.json`, `bunfig.toml`, lint and formatting settings), scripts, tests, and documentation. Repository-level concerns—GitHub workflows, git hooks, and this README—live at the root. Package documentation lives in [`packages/weft/documentation`](packages/weft/documentation) and [`packages/weft-ui/docs`](packages/weft-ui/docs).

## History

Before August 2026, `packages/weft` was the root of this repository and the console lived in the archived [stevekinney/weft-console](https://github.com/stevekinney/weft-console) repository. If you maintain a fork from before the monorepo conversion, the package move was a pure `git mv` commit, so `git log --follow` and merge rename detection carry history across the move.

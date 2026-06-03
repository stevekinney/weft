---
name: feature
description: >-
  Implement a new feature for the weft durable execution engine following
  a structured workflow. Use when the user asks to "implement", "add",
  "build", or "create" a feature, capability, or acceptance criterion.
  Trigger on: "implement X", "add support for X", "build the X feature",
  "work on X from the architecture doc".
argument-hint: <description of the feature to implement>
---

Implement the following feature for the weft durable execution engine: $ARGUMENTS

Follow this workflow:

## 0. Get Context

**DO THIS FIRST**: Read and review `reference/architecture.md`.

## 1. Understand

- Read the relevant source files to understand the affected modules.
- Check `src/index.ts` to see if the public API surface will change. Any new exports are a public API decision — be deliberate.
- Identify which subsystems are involved: core engine (`src/core/`), storage (`src/storage/`), server (`src/server/`), server runtime (`src/server/runtime/`), client (`src/client/`), externally supplied dashboard mounting (`serve({ dashboard })`), testing (`src/testing/`), observability (`src/observability/`), remote workers (`src/worker/`), in-process workers (`src/workers/`), browser runtime (`src/service-worker/`), or alerting (`src/alerting/`).
- Check if this feature needs to work across storage backends (MemoryStorage, BunSQLiteStorage, IndexedDB).
- Check if this feature needs browser compatibility (no Bun-specific APIs in browser-targeted code).

## 2. Plan

- Outline the approach before writing code.
- Identify existing utilities and patterns to reuse — do not reinvent.
- If the change touches the public API, list exactly which exports are added or modified.
- If the change adds a server operation, list the REST path, JSON-RPC name, access scope, transport exposure, operator UI or external-dashboard impact, and documentation page to update.
- Consider whether new types belong near their module or in `src/core/types.ts`.

## 3. Implement

- Follow existing patterns: web-native APIs (fetch, WebSocket, crypto.randomUUID, structuredClone), Bun-native on server (Bun.serve, Bun.SQL).
- Use standard TypeScript/ESM imports. Use `node:` prefix for Node built-ins.
- Prefer Bun built-ins over Node equivalents (see CLAUDE.md table).
- No `any` types at trust boundaries. Use Zod for input validation at API edges.

## 4. Test

- Write tests using `bun:test` with `describe`/`it`/`expect`.
- Colocate test files as `.test.ts` next to the source.
- Use `TestEngine` for workflow behavior tests (provides MemoryStorage + virtual time).
- Use `TimeControl` via `testEngine.advanceTime('5s')` for time-dependent flows.
- Use `testEngine.mock(activity, implementation)` for activity isolation.
- Use `testEngine.recover()` to test engine restart / checkpoint replay.
- Run `bun test <path>` to verify your tests pass.

## 5. Verify

- Run `bun run validate` (lint + typecheck + test).
- Run `bun run build` to confirm the build succeeds.
- Review the diff: check for leftover debug code, unintended changes, and unintended export modifications in `src/index.ts`.

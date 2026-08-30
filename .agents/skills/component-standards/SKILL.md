---
name: component-standards
description: Preserve Weft external-dashboard mount contracts and avoid reintroducing the removed bundled dashboard.
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Grep
  - Glob
---

> Monorepo note: all repository paths and commands in this skill are relative to `packages/weft/` unless a path explicitly starts with `packages/`.

# Component Standards

## When to use

- Changing `serve({ dashboard })`, `DASHBOARD_PAGE_ROUTES`, route targets, or external dashboard mounting behavior.
- Reviewing a change that proposes restoring `src/dashboard/**`, Svelte build tooling, jsdom dashboard tests, or bundled-dashboard package content.
- Documenting how an externally supplied operator UI should call the Weft API.

## Do not use

- Pure core engine workflows (`src/core/**`) and unrelated server behavior outside the external-dashboard mount contract
- Storage adapters (`src/storage/**`)
- Service worker code (`src/service-worker/**`)
- Building an in-repository dashboard; Weft no longer ships one.

## Constraints

- Keep Weft headless by default. `weft serve` starts the API and health endpoints; no bundled UI assets should be loaded or emitted.
- Preserve the external shell contract: `serve({ dashboard })` may mount caller-supplied content on `DASHBOARD_PAGE_ROUTES`, while `/api/...`, discovery, health, REST, JSON-RPC, WebSocket, worker, and MCP routes remain server-owned.
- Do not add Svelte, jsdom, dashboard-specific build steps, or package payload entries unless a new task explicitly reintroduces a maintained dashboard product.
- Authentication protects API calls made by a mounted shell; it does not authenticate the shell route itself because Bun route entries are served before Weft's fetch handler.

## Operation modes

### External Shell Contract

- Pin the supported page route list in tests when it changes.
- Keep API paths rooted under `/api/...` so external shells cannot shadow server operations.
- Document production access control as reverse-proxy or operator-network responsibility when the shell itself must be private.

### Operator API Alignment

- When server operations support operator UIs, update public REST/JSON-RPC documentation and typed clients instead of adding dashboard-only helpers.
- Workflow visibility docs and tests must keep list filters, aggregate counts, and bulk-action preview filters aligned.
- For async activity completion, document that operator UIs must treat completion payloads as untrusted and call the authenticated API routes when exposed outside a trusted boundary.

## Workflow

1. Inspect `src/server/index.ts`, `src/server/route-model.ts`, and the server guide before changing mount behavior.
2. Apply the smallest change that preserves headless default behavior and route ownership.
3. Update documentation and route tests together.
4. Review the package-content guard if any UI asset path is added.

## Verification

- `bun run build` passes and emits no `dist/dashboard` payload.
- `bun run typecheck` passes.
- `bun run lint` passes.
- `bun run verify:documentation` passes when docs changed.

# Task 14: MCP origin validation: no Host-header fallback for absolute URLs

**Severity:** medium

## Finding: MCP origin validation falls back to Host-header-derived origin when publicOrigin and trustedHosts are absent

- **Severity:** medium (security)
- **Files (audit snapshot):** `src/mcp/http.ts`, `src/server/handler/route-dispatch.ts`

### Evidence

mcp/http.ts:374: third branch of validateOrigin is originUrl.host === new URL(request.url).host. Bun's request.url is derived from the Host header. When neither publicOrigin nor trustedHosts is configured, an attacker who controls both Host: and Origin: headers can make this evaluate to true for any origin, bypassing the MCP CORS check. resolveDiscoveryOrigin in route-dispatch.ts already returns 503 in this case — the /mcp endpoint bypasses that guard.

### Required fix

When neither publicOrigin nor trustedHosts is set, reject all cross-origin MCP requests outright (return 403) rather than falling back to Host-derived comparison. Add a startup warning alongside the existing auth posture warning when MCP is enabled without publicOrigin or trustedHosts configured.

## Acceptance criteria (all required — completion is binary)

- [ ] MCP discovery surfaces (/.well-known/mcp.json, /openrpc.json metadata, /mcp) never emit absolute URLs derived from an unvalidated Host header; without publicOrigin/trustedHosts the server either binds to the listen address origin or fails loudly at startup for non-loopback binds — pick per existing publicOrigin docs and pin in tests.
- [ ] Host-header-injection regression test covers all three discovery surfaces.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.

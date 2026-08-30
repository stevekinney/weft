# Task 03: Bounded REST body reads on every operation input path

**Severity:** critical

## Finding: Unbounded REST body reads enable memory exhaustion / OOM DoS

- **Severity:** critical (security)
- **Files (audit snapshot):** `src/server/operations/start-workflow-rest-input.ts`, `src/server/operations/bulk-filter-helpers.ts`, `src/server/operations/storage.ts`

### Evidence

JSON-RPC HTTP and MCP paths call readBodyBounded() with 1 MB cap. REST operation paths do not: start-workflow-rest-input.ts:24 calls bare request.json(), bulk-filter-helpers.ts:102 calls request.text(), storage.ts:430 calls request.arrayBuffer() — all with no size limit. Bun buffers the entire body before resolving, so a multi-GB POST to any unauthenticated REST endpoint exhausts server memory before auth or payload-size policy fires.

### Required fix

Extract a readRestBodyBounded(request, maxBytes) helper mirroring readBodyBounded in the JSON-RPC path (check Content-Length pre-flight, cap stream at configurable ceiling, default 1 MB). Call it from every REST extractInput function that currently calls request.json(), request.text(), or request.arrayBuffer().

## Acceptance criteria (all required — completion is binary)

- [ ] No REST input path calls bare `request.json()`, `request.text()`, or `request.arrayBuffer()` — all go through a shared bounded reader mirroring the JSON-RPC `readBodyBounded` semantics (Content-Length pre-flight, configurable cap, 1 MB default).
- [ ] Oversized requests are rejected with the documented payload-too-large fault shape before the body is buffered; regression tests cover at least the start-workflow, bulk-filter, and storage REST paths.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.

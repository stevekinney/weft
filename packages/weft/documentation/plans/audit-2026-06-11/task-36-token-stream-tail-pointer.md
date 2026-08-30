# Task 36: Durable tail pointer for token-stream reconnects

**Severity:** low

## Finding: Event-log token-stream tail uses O(n) full prefix scan to find max sequence — reconnects are expensive

- **Severity:** low (performance)
- **Files (audit snapshot):** `src/core/engine/workflow-feed.ts`, `src/core/engine/stream-chunk-loading.ts`

### Evidence

src/core/engine/workflow-feed.ts:106–115 — `snapshotWorkflowFeedTail` for the `tokens` selector calls `loadStoredStreamChunks(internals.storage, workflowId, TOKENS_STREAM_KEY)` (a full prefix scan of stored chunks) then iterates all results to find the max sequence number, with no head pointer. The comment at line 108 acknowledges this: 'scan is O(n) in stored chunks. The token feed persists each chunk under the `tokens` prefix and keeps no separate tail record'. A client that reconnects issues a full scan of all stored token chunks to find its resume point. Temporal's sticky-queue model avoids this by routing reconnecting clients to a worker that already holds the history in memory.

### Required fix

Maintain a durable tail pointer (e.g., `stream-tail:{workflowId}:tokens`) updated atomically with each chunk write. This reduces tail-snapshot from O(chunks) to O(1). The comment already flags this as a deliberate tradeoff for short-lived streams — reclassify it as technical debt and fix it for workflows that use ctx.stream extensively.

### Verifier note

The behavior is real and the code comment confirms it is acknowledged debt. However, severity should be low, not medium. The O(n) scan fires once per subscription setup (not per event), only for the `tokens` selector (the `events` selector uses an in-memory head cache for O(1)), and only affects workflows that use `ctx.stream` extensively. The "reconnects are expensive" framing overstates impact: chunk count for typical short-lived token streams is small, and the cost amortizes over the entire subscription lifetime. The Temporal comparison is inapt — Temporal reconnects also trigger full history fetches; sticky queues improve execution locality, not tail-sequence lookup. The proposed tail-pointer fix is valid technical debt to track but carries its own cost (one extra storage write per chunk commit). This belongs on a deferred optimization track, not flagged as a meaningful gap for Temporal feature/performance parity.

## Acceptance criteria (all required — completion is binary)

- [ ] Tokens-selector subscription setup reads a tail record (O(1)) instead of scanning all chunks; the tail is written atomically with chunk writes; missing-tail (old data) falls back to the scan (read normalization).
- [ ] Reconnect catch-up neither duplicates nor skips frames (existing tail contract tests extended to the new path).

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.

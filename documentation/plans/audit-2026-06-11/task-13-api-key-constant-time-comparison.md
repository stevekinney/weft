# Task 13: Constant-time API key comparison

**Severity:** medium

## Finding: Non-constant-time API key comparison via Set.has() enables timing side-channel

- **Severity:** medium (security)
- **Files (audit snapshot):** `src/server/authentication/api-key.ts`, `src/server/authentication/index.ts`

### Evidence

api-key.ts:120: if (apiKeySet?.has(presentedKey)). JavaScript Set.has() is not constant-time. The rotating-api-key-store.ts path also uses Map.get() for the same comparison. An attacker making repeated requests can use response-time variance to shrink the brute-force search space.

### Required fix

Replace Set.has(presentedKey) with a constant-time comparison loop using node:crypto timingSafeEqual over the key bytes, iterating all known keys and XOR-accumulating the result so early-exit is impossible. Apply the same fix to the rotating-api-key-store.ts Map.get() path.

## Acceptance criteria (all required — completion is binary)

- [ ] API key verification uses a constant-time comparison (timingSafeEqual over fixed-length digests of candidate and stored keys) instead of Set.has().
- [ ] Regression test pins that verification still accepts valid keys / rejects invalid ones; implementation notes explain the digest-then-compare pattern.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.

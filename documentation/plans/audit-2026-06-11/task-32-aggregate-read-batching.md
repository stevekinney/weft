# Task 32: Batch storage reads in engine.aggregate()

**Severity:** high

## Finding: N+1 storage reads in aggregate() for attribute-grouped queries

- **Severity:** high (performance)
- **Files (audit snapshot):** `src/core/engine/aggregate.ts`, `src/core/engine/listing.ts`

### Evidence

src/core/engine/aggregate.ts:67–83 — `resolveDimensionKey` is called for every workflow in the candidate set. When `groupBy` is `{ attribute }` it calls `await internals.storage.get(KEYS.attribute(state.id))` serially (line 80), one round-trip per workflow. The outer loop in `accumulateFromConstrainedIds` (lines 202–210) awaits `accumulateAggregateState` which awaits `resolveDimensionKey` — one await chain per workflow with no batching. A query over 10 000 workflows with an attribute groupBy issues 10 000 serial `storage.get` calls. The constrained-ids path in `listing.ts` (lines 85–101) batches a chunk of 64 `storage.get` calls with `Promise.all`, but `aggregate.ts` does NOT use this chunked pattern — each state's attribute is fetched one at a time.

### Required fix

Apply the same CONSTRAINED_ID_CHUNK_SIZE=64 batching pattern from listing.ts:85–101 to aggregate.ts. Collect all candidate states first, then fan out attribute reads in chunks of 64 with Promise.all before grouping. For very large attribute-grouped aggregates, consider maintaining a dedicated attribute-value index (similar to the existing status/type visibility indexes) so no per-workflow reads are needed at query time.

### Verifier note

The finding is accurate as written. One precision note: the serial state reads at line 203 affect ALL groupBy types (status, type, failureCategory, and attribute), not just `{ attribute }` groupBy — only the second serial read (attribute bytes at line 80) is gated on the `{ attribute }` groupBy branch. The title "N+1 storage reads" is slightly imprecise (it is unbatched serial reads, not a classic N+1 relational pattern), but the substance is correct. The proposed fix is sound — the same `Promise.all` + 64-chunk pattern from listing.ts should be applied to both the state-fetch loop and the attribute-fetch step in the aggregate constrained-ids path.

## Acceptance criteria (all required — completion is binary)

- [ ] aggregate() constrained-id state reads and attribute-groupBy reads are chunked (reusing the listing.ts CONSTRAINED_ID_CHUNK_SIZE pattern) — no per-workflow serial awaits.
- [ ] Behavioral results are unchanged (existing aggregate tests stay green); a test exercises an attribute-grouped aggregate over enough workflows to cross chunk boundaries.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.

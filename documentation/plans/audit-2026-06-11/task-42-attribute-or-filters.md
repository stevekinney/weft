# Task 42: Multi-value OR for attribute filters (and post-filter parity)

**Severity:** medium

## Finding: Search attribute filtering is equality/range only; no full-text, boolean expression, or SQL-like query language

- **Severity:** medium (feature-gap)
- **Files (audit snapshot):** `src/core/types/list-options.ts`, `src/core/engine/workflow-visibility-queries.ts`, `src/core/engine/listing.ts`

### Evidence

src/core/types/list-options.ts AttributeFilter (lines 119-145) supports equality (value) and range (gt/gte/lt/lte) per attribute, composed as AND across attributes. src/core/engine/workflow-visibility-queries.ts implements queryWorkflowStatusIndex, queryWorkflowTypeIndex, queryWorkflowTimeRangeIndex, and queryWorkflowIdPrefixCandidates. There is no OR across attribute values, no NOT filter, no nested boolean expression, no LIKE/contains operator, and no Temporal-style SQL-like visibility query string. Advanced visibility queries in Temporal (e.g. 'Status="Running" AND CustomAttr > 5 OR WorkflowType="foo"') are not expressible.

### Required fix

Extend AttributeFilter to support OR within a single attribute (value: string[] for 'any of these values') as a low-cost immediate improvement. For a full expression language, add a FilterExpression type: { and: FilterExpression[] } | { or: FilterExpression[] } | { not: FilterExpression } | AttributeFilter. The index-based query helpers already return Set<string> that can be intersected/unioned; a recursive resolver over FilterExpression would compose these sets.

### Verifier note

The finding is accurate as stated, with one nuance to add: OR filtering IS already supported for the built-in `status` and `failureCategory` fields (both accept arrays), so the gap is specifically confined to the custom `attributes` array in `ListFilter`. A single `AttributeFilter` entry can only match one equality value or a range — multi-value OR like `attribute X in [v1, v2]` is not expressible. Additionally, the finding does not mention that `matchesListFilter` in `src/core/engine/state-utilities.ts` (lines 313-326) never applies `filter.attributes` at the post-filter stage; attribute filtering exists only in the index-query/constrained-ID path. This means on a stale visibility watermark that falls back to a full `wf:` scan, custom attribute filters are silently skipped — a related gap worth noting alongside the OR/boolean-expression gap.

## Scope boundary

In scope: (1) `value: string[]` any-of support on AttributeFilter (the index helpers already return Sets — union them); (2) the verifier-confirmed parity bug: `matchesListFilter` never applies `filter.attributes` post-filter, so stale-watermark scans silently ignore attribute filters — fix and pin. OUT of scope: a full boolean expression language (and/or/not nesting) — note as deliberately deferred in the PR body.

## Acceptance criteria (all required — completion is binary)

- [ ] AttributeFilter accepts a value array with documented any-of semantics across REST query parsing, JSON-RPC inputs, and engine.list — pinned per the workflow-visibility alignment rule in CLAUDE.md (filters, aggregate grouping, bulk-preview parity).
- [ ] matchesListFilter applies attribute filters on the post-filter path; a stale-watermark regression test proves indexed and scan paths return identical results.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.

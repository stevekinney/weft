# PR 8 — Engine substrate (EngineInternals + WeakMap)

## Scope

Establishes the `EngineInternals` WeakMap pattern for `src/core/engine.ts`.
Mirrors the substrate PR 7 introduced for `src/core/context.ts`.

**No methods extracted.** This PR is purely the access-strategy substrate.
Subsequent engine-split PRs will move methods into sibling modules; they will
all use `getInternals(engine)` to read/write kernel state without changing
behavior.

## Files added/changed

- `src/core/engine.ts` — replaced with a 5-line barrel (`export * from './engine/index.ts';`).
  All 73 internal `from './engine.ts'` import sites continue to resolve unchanged.
- `src/core/engine/index.ts` — the Engine class and friends (formerly the bulk of
  `engine.ts`). Field declarations removed; `this.#fieldName` accesses replaced
  with `getInternals(this).fieldName`. Methods stay as `#private`. Carries an
  inline-ID `oxlint-disable max-lines` directive (`core-engine-file-length`) for
  now — removed in PRs 9–32 as methods are extracted.
- `src/core/engine/internals.ts` — exports `EngineInternals`, `WeakMap<Engine, EngineInternals>`,
  `initializeInternals(engine)`, and `getInternals(engine)`. NOT re-exported from
  `src/core/engine/index.ts` or `src/index.ts`. Boundary enforced by
  `scripts/check-internal-imports.ts` (allowlist entry added).
- `documentation/engine-field-init-order.md` — frozen list of the 59 instance
  fields in original declaration order. The constructor body assigns each in
  this order via `getInternals(this).fieldName = expr`.
- `scripts/check-engine-internals-field-access.ts` — verifies no
  `this.#fieldName` reference remains under `src/core/engine/` for any of the 59
  EngineInternals fields. Wired into `bun run lint`.
- `documentation/internal-imports-allowlist.json` — adds entry for engine
  internals (allowed only from `src/core/engine/**`).

## Methods extracted

None. PR 8 is substrate-only. Method extraction happens in PRs 9–32.

## EngineInternals fields

59 instance fields migrated. See `documentation/engine-field-init-order.md` for
the full list and ordering. The static field `Engine.#TERMINAL_STATUSES` is
left as a static class member (not part of the WeakMap).

## Replay-determinism rules respected

- All formerly-private fields live on `EngineInternals`. No module owns its own
  copy.
- Field initialization order preserved exactly — the constructor body assigns
  fields in the same order they were declared in the pre-PR-8 source.
- The 4 inline class-field initializers (`agentWorkflowIds`, `eventLogHeads`,
  `workflowFeedListeners`, `workflowVersionTuples`) — which previously ran
  automatically before the constructor body — are now explicitly initialized in
  the constructor near the other field assignments.
- No `Promise.all` introduced where a sequence existed.
- No `await` boundaries reordered within methods.
- Generator boundaries unchanged.
- Event emission positions relative to awaits unchanged.
- Storage commit and event broadcast ordering unchanged.

## Verification

- `bun run lint` clean (includes `check-engine-internals-field-access.ts`).
- `bun run typecheck` clean.
- `bun test src/core/` — 1537 pass, 0 fail.
- `bun test tests/replay-fixtures/ tests/checkpoint-compat/` — 22 pass, 0 fail
  (the critical replay-parity gate).

## Implementation notes

A handful of locations needed `!` non-null assertions added because TypeScript
no longer narrows across two separate `getInternals(this).field` accesses (each
is a fresh expression). Pre-PR-8 code like
`if (this.#field) this.#field.method()` worked through narrowing; post-PR-8
`if (getInternals(this).field) getInternals(this).field!.method()` requires the
explicit assertion. Affected fields: `inlineStrategy`, `budgetPolicyEnforcer`,
`broadcastChannel`, `storage.deletePrefix`. These are runtime-safe — the
surrounding null check still proves the assertion correct.

## Dependent PRs

PRs 9–32 build on this substrate. They will:

- Extract methods one at a time into sibling modules under `src/core/engine/`.
- Remove the `core-engine-file-length` disable when `engine/index.ts` falls
  below 500 lines.
- Each takes `EngineInternals` as a parameter and operates on
  `internals.fieldName` directly.

# Task 23: Durability guarantee statement, Inngest comparison, honest Temporal scaling disclosure, ctx.review() advantage

**Severity:** medium

## Finding: No single user-facing durability guarantee statement distinguishing today's guarantees from Tier-0 deferrals

- **Severity:** medium (marketing)
- **Files (audit snapshot):** `README.md`, `documentation/architecture/tier-0-behavioral-contract.md`

### Evidence

README.md line 19 buries the closest thing to a headline guarantee in the Problem section: 'the runtime guarantees it will complete—even if the process crashes.' tier-0-behavioral-contract.md is written for contributors not users. No dedicated Durability Guarantee page. Temporal's tagline is 'Code That Never Fails.' Weft has no equivalent — and no honest fine-print distinguishing checkpoint-level guarantees from the at-least-once crash-window gap for activities.

### Required fix

Add a Durability Guarantee section to README.md (and documentation/architecture/durability-guarantee.md): (a) every yield\* is checkpointed before the next step; (b) recovery is automatic and exactly-positional; (c) activities without idempotencyKey + verifier are at-least-once in crash windows — the honest current limit; (d) the Tier-0 roadmap item that closes the gap. Link from the existing README guarantee statement.

## Finding: No Inngest comparison page exists despite Inngest being an explicit competitive target

- **Severity:** low (marketing)
- **Files (audit snapshot):** `documentation/architecture/temporal-comparison.md`

### Evidence

Grep of all documentation files returns zero results for 'Inngest' or 'inngest'. Inngest shares direct API surface overlap (step.run vs ctx.run, step.sleep vs ctx.sleep, step.waitForEvent vs ctx.waitForSignal) and targets the same TypeScript audience.

### Required fix

Create documentation/architecture/inngest-comparison.md or add a Weft vs Inngest section to README.md. Honest matrix: Inngest has event-bus fan-out, throttle/debounce/batch, serverless-native. Weft has single binary, no cold-start per step, browser runtime, ctx.review(), no external orchestration service, fixed-cost checkpoint model.

## Finding: temporal-comparison.md does not disclose single-engine-per-store constraint vs Temporal's horizontal scaling

- **Severity:** medium (documentation)
- **Files (audit snapshot):** `documentation/architecture/temporal-comparison.md`, `documentation/guides/recovery-and-deploys.md`

### Evidence

recovery-and-deploys.md lines 58-68: 'Do not point two engines at the same durable store. Multi-process recovery is not coordinated.' tier-0-behavioral-contract.md line 143: 'MultiEngine capability... not yet implemented.' temporal-comparison.md ('ten design failures eliminated') makes no mention of this. Temporal Cloud and self-hosted Temporal have multi-worker horizontal scaling out of the box.

### Required fix

Add an honest HA/scaling row to the temporal-comparison.md comparison table: 'Multi-worker horizontal scale | Multi-worker with task queue load balancing | Single engine per durable store today; MultiEngine on pre-1.0 roadmap.' Link to singleton-service-deployment.md.

## Finding: ctx.review() is a genuine Weft-exclusive feature not framed as a competitive advantage anywhere

- **Severity:** low (marketing)
- **Files (audit snapshot):** `README.md`, `documentation/architecture/temporal-comparison.md`

### Evidence

ctx.review() does not appear in the temporal-comparison.md ten-failure list. The README's Human-in-the-Loop Review section (lines 246-287) describes the feature but contains zero competitive framing — no statement that Temporal lacks this primitive or that Inngest requires polling loops to implement approval flows.

### Required fix

Add a brief competitive callout to the README Human-in-the-Loop section: 'This is a Weft-native primitive with no equivalent in Temporal or Inngest — both require external state machines or polling loops to implement approval flows.' Add as a row or callout in temporal-comparison.md.

## Claim-verification requirement

Every competitive claim must be verifiable: claims about Weft cite the implementing source file or guide; claims about Temporal/Inngest cite their public documentation (link in prose) and must be qualified by date where behavior could change. No claim of the form "X has no equivalent" without checking the competitor's current docs first — soften to implementation-neutral wording where verification is not possible. Honest disclosure of Weft's own constraints (single-engine-per-store, pre-1.0 tiers) is part of the positioning, not a concession: under-claim and deliver. For prose tone, match the voice and structure of the existing `documentation/architecture/temporal-comparison.md` — same heading style, same table conventions, same direct second-person register; do not import a different house style. The strengths inventory from the audit (checkpoint-not-replay, no determinism constraints, single binary, browser runtime, TestEngine, ctx.review, saga/composition primitives, time-travel replayTo) is the raw material.

## Acceptance criteria (all required — completion is binary)

- [ ] A single durability-guarantee page states, in one screen, exactly what is guaranteed today vs deferred to Tier-0 — linked from README.
- [ ] An Inngest comparison page exists with the same honesty standard as temporal-comparison.md; temporal-comparison.md discloses the single-engine-per-store constraint in its scaling section.
- [ ] ctx.review() is presented as a first-class differentiator in README and the comparison pages.
- [ ] Every competitive claim carries a verifiable citation or is implementation-neutral; `bun run verify:documentation` passes.

## Standard execution requirements

- Line numbers and file paths in the evidence are from the 2026-06-11 audit snapshot and may have drifted. Re-locate every cited site by symbol or function name before editing. If current code differs from the evidence, update the plan to match reality — the invariant being fixed is the requirement, not the line numbers. If the described behavior no longer exists at all, stop and report that instead of forcing a change.
- TDD: every behavioral fix needs a regression test that fails before the fix and passes after. Documentation-only tasks need no new tests but must keep existing doctests green.
- Verification — all of these must pass before the task is complete: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test --parallel`. For documentation changes also run `bun run verify:documentation` (plus `bun run verify:markdown-doctests` when Markdown examples change). For changes to exported types or the package surface also run `bun run build` and `bun run verify:jsdoc:full`.
- Completion is binary: every acceptance criterion met and the full suite green. If a criterion cannot be met, stop and report the blocker — do not ship a partial, do not weaken a gate, do not defer silently.

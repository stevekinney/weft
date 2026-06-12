# Task 12: Marketing and competitive positioning (durability guarantee, Inngest comparison)

**Severity:** medium

## No single user-facing durability guarantee statement distinguishing today's guarantees from Tier-0 deferrals

- **Severity:** medium (marketing)
- **Files:** `README.md`, `documentation/architecture/tier-0-behavioral-contract.md`

**Evidence:** README.md line 19 buries the closest thing to a headline guarantee in the Problem section: 'the runtime guarantees it will complete—even if the process crashes.' tier-0-behavioral-contract.md is written for contributors not users. No dedicated Durability Guarantee page. Temporal's tagline is 'Code That Never Fails.' Weft has no equivalent — and no honest fine-print distinguishing checkpoint-level guarantees from the at-least-once crash-window gap for activities.

**Required fix:** Add a Durability Guarantee section to README.md (and documentation/architecture/durability-guarantee.md): (a) every yield* is checkpointed before the next step; (b) recovery is automatic and exactly-positional; (c) activities without idempotencyKey + verifier are at-least-once in crash windows — the honest current limit; (d) the Tier-0 roadmap item that closes the gap. Link from the existing README guarantee statement.

## No Inngest comparison page exists despite Inngest being an explicit competitive target

- **Severity:** low (marketing)
- **Files:** `documentation/architecture/temporal-comparison.md`

**Evidence:** Grep of all documentation files returns zero results for 'Inngest' or 'inngest'. Inngest shares direct API surface overlap (step.run vs ctx.run, step.sleep vs ctx.sleep, step.waitForEvent vs ctx.waitForSignal) and targets the same TypeScript audience.

**Required fix:** Create documentation/architecture/inngest-comparison.md or add a Weft vs Inngest section to README.md. Honest matrix: Inngest has event-bus fan-out, throttle/debounce/batch, serverless-native. Weft has single binary, no cold-start per step, browser runtime, ctx.review(), no external orchestration service, fixed-cost checkpoint model.

## temporal-comparison.md does not disclose single-engine-per-store constraint vs Temporal's horizontal scaling

- **Severity:** medium (documentation)
- **Files:** `documentation/architecture/temporal-comparison.md`, `documentation/guides/recovery-and-deploys.md`

**Evidence:** recovery-and-deploys.md lines 58-68: 'Do not point two engines at the same durable store. Multi-process recovery is not coordinated.' tier-0-behavioral-contract.md line 143: 'MultiEngine capability... not yet implemented.' temporal-comparison.md ('ten design failures eliminated') makes no mention of this. Temporal Cloud and self-hosted Temporal have multi-worker horizontal scaling out of the box.

**Required fix:** Add an honest HA/scaling row to the temporal-comparison.md comparison table: 'Multi-worker horizontal scale | Multi-worker with task queue load balancing | Single engine per durable store today; MultiEngine on pre-1.0 roadmap.' Link to singleton-service-deployment.md.

## ctx.review() is a genuine Weft-exclusive feature not framed as a competitive advantage anywhere

- **Severity:** low (marketing)
- **Files:** `README.md`, `documentation/architecture/temporal-comparison.md`

**Evidence:** ctx.review() does not appear in the temporal-comparison.md ten-failure list. The README's Human-in-the-Loop Review section (lines 246-287) describes the feature but contains zero competitive framing — no statement that Temporal lacks this primitive or that Inngest requires polling loops to implement approval flows.

**Required fix:** Add a brief competitive callout to the README Human-in-the-Loop section: 'This is a Weft-native primitive with no equivalent in Temporal or Inngest — both require external state machines or polling loops to implement approval flows.' Add as a row or callout in temporal-comparison.md.

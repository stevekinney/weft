# Weft Gap Analysis: Durable Execution for AI Agents (2024–2026 Research)

A synthesis of 30 research papers on durable execution, checkpoint-restore, transactional tool use, rollback, event sourcing, and fault tolerance for AI agents — mapped against the current state of Weft (`/Users/stevekinney/Developer/weft`).

> [!NOTE]
> This analysis predates v0.1.0, which **removed Weft's built-in agent surface** (`ctx.agent()`, `executeAgentLoop`, `weft.agent()`, `handoff`/`debate`/`supervise`, and the agent types and events). Weft no longer ships an agent primitive; agent loops are built in userland on `ctx.run()` and `ctx.review()` or in an external framework. Some recommendations below have since shipped as engine-level, agent-agnostic primitives — most notably the effect log (`src/core/effect-log/`, exporting `EffectLog`) and workflow versioning (`src/core/versioning.ts`). Where the text says "the agent loop should…," read it as "the userland loop you build on `ctx.run()` should…." See the [`CHANGELOG`](../../CHANGELOG.md) for the removed-export list and upgrade notes.

The goal is not a wishlist. The goal is to point at the specific places where Weft's architecture is ahead of the academic literature, the specific places where it is vulnerable or underspecified, and the specific places where a bounded amount of engineering work would convert a research insight into a durable, verifiable Weft primitive.

---

## 1. What Weft already gets right

Before talking about gaps, it is worth grounding the analysis in what the research actually validates about Weft's existing direction.

**Checkpoint-over-replay is the right call.** Temporal-style event-history replay dominates industry thinking, but every research paper in this corpus that deals with resumption (AgentRR, SagaLLM, KubeIntellect, Sherlock, WebRollback, AutoDW, libDSE) stores snapshots, not histories, at the step boundary the agent actually cares about. Weft's `Checkpoint` + `advanceCheckpoint` model in `src/core/checkpoint.ts` — capturing `locals`, `accumulatedResults`, and `searchAttributes` at each `yield*`, while durable signals live in separate `sig:` storage keys — is squarely aligned with the checkpoint-at-decision-boundary pattern the field is converging on. O(1) recovery is a real advantage.

**Generator-based concurrency matches the "dual stream" pattern.** CaveAgent (2601.01569) argues explicitly for separating a "semantic stream" (the LLM reasoning) from a "runtime stream" (the persistent executor). Weft's `async function*` workflows with a `Context` that only yields operation descriptors is a structural implementation of that same idea — the generator is the semantic stream, the engine is the runtime stream. This is more than a stylistic choice; CaveAgent's +10.5% success and 28.4% token reduction come from exactly this separation.

**Web-standard foundations age well.** `EventTarget`, `AbortSignal`, `structuredClone`, `Worker`, `BroadcastChannel`, `WeakRef` — research papers are rebuilding these same primitives as bespoke agent runtimes. AIOS (2403.16971) invents a whole "LLM OS kernel"; AI Runtime Infrastructure (2603.00495) invents a "closed-loop control layer"; both are redescribing things Weft gets from the platform for free.

**Yield-level checkpointing is the right granularity for agent loops.** Because each `yield* ctx.run(...)` is an independently-checkpointed boundary, a userland agent loop that models each LLM and tool call as its own `ctx.run()` step recovers at the individual tool-call boundary rather than re-running a whole turn. (Wrap a whole external-framework loop inside one activity instead and you get only activity-boundary recovery — a crash re-runs the entire loop.) Budget tracking, context-window strategies, provider health, and multi-agent coordination are all expressible on top of that boundary in userland (or an external framework), rather than baked into the engine — which keeps the durable core small while still giving agent workloads finer-grained recovery than the step-level boundaries of AgentScope 1.0 or StateFlow.

Now the gaps.

---

## 2. The critical gap: semantic rollback attacks (ACRFence)

This is the single most important finding in the corpus and it directly threatens Weft's checkpoint model.

ACRFence (arXiv 2603.20625) demonstrates that when an LLM agent is restored from a checkpoint, **even at temperature=0**, it will re-synthesize tool calls that are _semantically different_ from the ones that were in flight before the crash. In their experiments, **100% of checkpoint-restore trials produced duplicate commits** on a payment-like workload. They identify two attack classes:

- **Action Replay**: a crashed checkpoint is restored, the LLM re-emits a `charge` call with slightly different parameters, and the payment runs twice because the downstream idempotency key is derived from LLM output rather than from the checkpoint identity.
- **Authority Resurrection**: a single-use token was consumed before the crash; the restored agent re-emits a tool call that re-presents the already-consumed token, and any tool that isn't itself strictly tracking token consumption will honor it.

A naive checkpoint model is vulnerable to both. Concretely: `src/core/checkpoint.ts` captures `accumulatedResults` keyed by step index, which protects workflow-level memoization of _activity results_ — but an agent loop that runs several LLM-to-tool turns _inside_ a single activity boundary gets no protection. If the engine crashes mid-turn (e.g., during tool execution after the LLM has committed to a call), a restored loop re-runs the LLM, gets a subtly different tool call, and fires it again. The outer workflow checkpoint has no idea this happened.

The fix ACRFence proposes — and the fix Weft adopted — is an **effect log recorded at the effect boundary**, keyed by a semantic hash of the intent-critical fields of the call. On restore, the runner consults this log before executing the effect: if a semantically-equivalent call is already recorded as completed, it replays the result; if a semantically-equivalent call is recorded as in-flight with an unknown outcome, it surfaces a conflict rather than silently re-executing.

How this landed in Weft (now shipped):

1. A per-effect record store keyed by semantic hash. Record format: `{ effectName, semanticHash, status: 'in-flight'|'committed'|'aborted', output?, recordedAt, completedAt }`.
2. `src/core/effect-log/index.ts` exports `EffectLog` with `record(semanticHash, effectName)` / `lookup(semanticHash)` / `commit(semanticHash, effectName, output)` / `abort(semanticHash, effectName, reason)`: write the `in-flight` record before the effect, update to `committed` after, and on restore check the log before re-running.
3. An optional `identity: (input) => { semanticHash, intentCriticalFields }` hook lets callers mark which input fields are intent-critical (the recipient of a transfer) versus idempotent (a retry counter, a timestamp).
4. `EffectReplayConflictError` is thrown when a restored run sees an in-flight record with an unknown outcome, so observability tooling and human-review flows can intervene rather than silently re-executing.

This was not a nice-to-have. Because Weft markets checkpoint-based recovery as its differentiator, semantic rollback is the named failure mode the field expects it to handle.

> [!NOTE] Completion signal
> A test in `src/core/effect-log/index.test.ts` injects a crash mid-effect, restores, and asserts the effect was only run once with matching parameters.

---

## 3. Transactional tool use (Atomix) — effects, epochs, frontiers

Atomix (2602.14849) makes a second, independent point that Weft also needs to absorb: **LLM tool calls create side effects with different persistence contracts, and the runtime should distinguish bufferable effects from externalized effects**. In their fault-injection experiments, baseline agents with immediate tool execution scored 0–7% task success; transactional retry with epoch-gated commit scored 37–57% on the same tasks.

Their model maps cleanly onto Weft:

- Each tool call gets an **epoch** (Weft already has `attempt` in `ActivityStartedEvent`; extend it into a first-class `epoch` counter on `Context`).
- Each tool declares a **resource scope** (e.g., `"payment:customer-123"`) and an **idempotency key** (Weft already supports this on updates via `UpdateCoordinator`, but not on tool calls).
- The engine tracks a **per-resource frontier** (the highest epoch committed for that resource) and refuses to commit a new effect until prior epochs on that resource are resolved.
- Tools register **compensation handlers** keyed by `(toolName, resourceScope)`; on abort, the engine walks the compensation chain in reverse.

Weft has the plumbing for half of this already: `src/core/updates.ts` does idempotency keys, `src/storage/interface.ts` supports atomic `batch()` writes, and search attributes give you a secondary-index substrate for tracking per-resource frontiers. What's missing is the **compensation handler primitive**. `src/core/activity.ts` defines activities as `(metadata, impl)` — there's no slot for `compensate(input, result)`. SagaLLM (2503.11951) makes the same argument from a different angle: every forward action should be paired with an explicit compensator, and the engine should run compensators in reverse order on failure.

Implemented API in `src/core/activity.ts` (fields match `ActivityDefinition<TInput, TOutput>` in `src/core/types.ts`):

```ts
const charge = activity({
  name: 'charge',
  execute: async ({ customerId, amount }: { customerId: string; amount: number }) => {
    /* ... */
    return { chargeId: 'ch_123' };
  },
  compensate: async ({ customerId, amount }, result) => {
    await stripe.refunds.create({ charge: result.chargeId });
  },
  resourceScope: ({ customerId }) => `payment:${customerId}`,
  idempotencyKey: ({ customerId, orderId }) => `${customerId}:${orderId}`,
});
```

And a corresponding `ctx.saga()` helper that tracks a chain of compensatable activities and, on failure or `ctx.abort()`, walks the chain backwards. This matches SagaLLM's "compensable execution" and Atomix's "compensation on abort" in one primitive, and it gives Weft something Temporal does not ship out of the box.

> [!NOTE] Completion signal
> A failing-then-passing test in `src/core/__tests__/saga.test.ts` where a 3-activity saga fails on step 3 and the compensators for step 1 and step 2 run in reverse order, each exactly once, across an engine restart.

---

## 4. Event sourcing as a dual of checkpoints (ESAA, AgentRR)

Weft treats events as observability (`EventTarget`, OTel interceptors). ESAA (2602.23193) and AgentRR (2505.17716) treat events as **the source of truth** — an `activity.jsonl` append-only log from which current state is a deterministic projection. This is not in tension with Weft's checkpoint model; it is complementary. Checkpoints are the fast path (O(1) resume); the event log is the audit path (forensic replay, compliance, debugging).

Right now Weft's event stream exists only in memory (`EventTarget`) and via OTel export. If the engine restarts, the event history for a workflow is gone — you can only see the _current_ checkpoint state. This has two concrete costs:

1. You cannot answer "what did this agent do before the crash?" without an external log collector.
2. You cannot implement AgentRR-style "check functions" — predicates that verify an execution trace is consistent with expected behavior — because there is no trace to check against.

The fix is a storage-backed append-only event log, with the same KV interface:

```
ev:{workflowId}:{sequence}   # individual event records
ev:{workflowId}:head         # sequence counter
```

Reuse the existing MessagePack codec. Writes piggyback on the existing `storage.batch()` that already persists checkpoints. The critical design decision is that **events are written in the same batch as the checkpoint that reflects them**, so checkpoint and log can never diverge. AgentRR's "multi-level experience abstraction" (low-level traces + high-level procedural summaries) then falls out as two projections over the same log: low-level = raw events, high-level = a summarization agent that compresses runs of events into reusable procedures.

For Weft, this gives you:

- **Forensic replay**: `engine.replay(workflowId, { toStep: N })` reconstructs any prior state for debugging.
- **Hash-chained verification**: each event carries a hash of the previous one; ESAA's `esaa verify` becomes `weft verify` and can detect silent corruption.
- **Check functions**: AgentRR's TCB concept — a registered `checkFunction(state, action, outcome): boolean` that runs on every event commit and aborts the workflow if it returns false. This is strictly more powerful than interceptors because it has access to historical state.

> [!NOTE] Completion signal
> `bun test src/core/__tests__/event-log.test.ts` passes a test that (a) runs a workflow to completion, (b) replays it from the log, (c) asserts every intermediate state matches the corresponding checkpoint.

---

## 5. Speculative execution with verification (Sherlock, libDSE)

Sherlock (2511.00330) gets 18.3% accuracy gain, 48.7% latency reduction, and 26.0% cost reduction by running a node-state machine (waiting → running → **verifying** → completed) where downstream nodes start executing speculatively while verifiers run in parallel, and the engine rolls back only if verification fails. libDSE (2412.13314) makes the pure-systems version of the same argument: the durable execution abstraction can bypass synchronous persistence entirely by speculating forward and reactively repairing state on failure — they benchmark an order-of-magnitude latency improvement over Temporal.

Weft's current model is strictly sequential on the workflow's critical path: each `yield* ctx.run(...)` waits for the activity to complete _and_ the checkpoint to persist before the next line of the generator runs. For short-lived activities that's fine. For agent workflows where a turn can take 5–30 seconds of LLM latency, it is crippling.

The lift here is real but tractable. The shape:

1. Add an optional `verify` hook to activities: `verify: (result) => Promise<boolean>`.
2. Add `ctx.speculate(fn)` that runs a child workflow _against a copy-on-write view of the checkpoint_ — reusing the existing `WorkerExecutionStrategy` infrastructure — and commits it only when the parent's outstanding verifications drain.
3. Track a **speculative frontier** per workflow: the highest step that is committed vs. the highest step that has speculatively started. On verification failure, roll back to the last confirmed step and re-run from there.
4. Reuse Atomix's compensation handlers for rollback. This is why §3 should land first.

Sherlock's counterfactual fault-injection analysis for identifying error-prone nodes is out of scope for the first pass — you can get most of the latency win without it. But once effect logs (§2) and the event log (§4) are in place, you have the data to run that analysis offline and feed results back as metadata on registered workflows.

> [!NOTE] Completion signal
> A benchmark showing ≥30% latency reduction on a multi-step workflow with 500ms mock activity latency, with zero incorrect results across 100 runs.

---

## 6. Chaos engineering is missing from `TestEngine` (ReliabilityBench)

ReliabilityBench (2601.06112) has the single most actionable finding for Weft's testing story: **pass@1 overestimates production reliability by 20–40%**. An agent that passes 60% of the time on a single run may exhibit only 25% consistency across trials. Weft's `TestEngine` in `src/testing/` is excellent for deterministic replay and time control, but it does not currently offer:

- **Fault injection primitives**: inject transient timeouts, rate-limit errors, partial responses, schema drift on activities and tool calls. ReliabilityBench's four axes are the exact four axes you want.
- **Multi-run reliability metrics**: `TestEngine.runN(workflow, input, { runs: 10 })` returning `{ passRate, consistency, outcomeDistribution }`. Do not let users stop at pass@1.
- **Chaos scenarios as fixtures**: a `ChaosScenario` object that can be attached to any test run and specifies probability distributions for each fault class.

The `ActivityMockRegistry` in `src/testing/activity-mocks.ts` already has the hook points. This is mostly additive work: wrap existing mocks with a `withChaos(mock, scenario)` combinator, and add an engine-level config flag so chaos can be enabled across a whole test run without per-activity changes.

While we're here: `AgentDebug` (2509.25370) classifies failures into **memory / reflection / planning / action / system** buckets and reports 24% accuracy gains from iterative re-rollouts from identified failure points. Weft's current failure model is a single-string `error` field on `WorkflowState`. Add a typed `failureCategory` enum and populate it from the agent loop. That alone unlocks "show me all planning failures in the last hour" queries via existing search attributes.

Why do MAS fail? (2503.13657) — the Cemri et al. paper — is worth reading for a different reason: **44% of failures are system design issues, not runtime errors**. Weft should invest more heavily in design-time validation than in runtime recovery. A linter pass over registered workflows (`weft validate`) that checks for common anti-patterns (non-serializable closures, unbounded retry loops, missing compensators on stateful activities, checkpoint size warnings) would catch most of this.

> [!NOTE] Completion signal
> `bun test src/testing/__tests__/chaos.test.ts` passes a suite that asserts a known-flaky agent gets a `passRate < 1.0` under a documented chaos scenario, and that the failure categorization distributes across at least three of the five AgentDebug buckets.

---

## 7. Constraint-based diagnosis and self-healing (AgentRx, VIGIL)

AgentRx (2602.02475) gets a 23.6% failure-localization improvement and 22.9% root-cause-attribution improvement from constraint-based grounded-theory diagnosis: you register domain constraints, the runtime checks them against execution traces, and violations point to specific root causes with 68% remediation success rate.

VIGIL (2512.07094) layers a reflective "affective memory" loop on top: the runtime watches its own failures, categorizes them, and proposes prompt diffs for the next run. Weft does not need the emotional-tone framing — but the underlying mechanism (observe → diagnose → adapt prompt → orchestrate) is directly applicable to its agent hooks.

Concrete proposal — one new primitive, `Constraint`:

```ts
// Constraint checks receive a minimal state snapshot ({ id, type, status: 'running' }).
// To inspect domain state, capture it in the enclosing scope:
let balance = 0;

const positiveBalance = constraint('positiveBalance', {
  scope: 'payment',
  check: () => balance >= 0,
  onViolation: 'fail', // or 'warn' | 'compensate'
});

engine.register(workflow, { constraints: [positiveBalance] });
```

Constraints are evaluated at every checkpoint commit (inline strategy only — worker-mode workflows skip evaluation). Violations emit a `ConstraintViolatedEvent` and either fail the workflow, trigger the saga's compensation chain (§3), or log a warning. This is strictly more powerful than interceptors because the check has access to historical state via the event log (§4).

Pair this with a richer `AgentHooks` interface that exposes an `onDiagnosis(trace, failure): PromptPatch` hook. This gives framework users the pieces to build VIGIL-style self-healing without baking it into the engine itself.

> [!NOTE] Completion signal
> A test that registers a constraint, runs a workflow that violates it, and asserts both the `ConstraintViolatedEvent` fires and the appropriate compensation chain runs.

---

## 8. Byzantine fault tolerance and consensus (CP-WBFT, Six Sigma Agent)

CP-WBFT (2511.10400) tolerates **85.7% Byzantine fault rates** on multi-agent workflows by extracting per-agent confidence scores and weighting votes accordingly. Six Sigma Agent (2601.22290) gets from 78% single-shot accuracy to 94% consensus accuracy with `n=3` sampling and achieves 3.4 DPMO — actual industrial-quality reliability — via atomic task decomposition plus dynamic redundancy sizing (`n=2` for low-risk, `n=5` for high-risk).

Weft no longer ships `debate`/`supervise` coordination primitives, so confidence-weighted consensus is now a userland pattern: you fan out `n` agent activities with `ctx.all()`, collect a `confidence: number` from each, and weight the votes yourself. The one engine-level piece worth keeping is:

- **DPMO metric**: a simple counter in the metrics collector that tracks (defects / total operations × 1e6), exposed alongside the existing workflow/activity counters.

The confidence-weighted voting and dynamic n-sizing sit entirely in the userland loop on top of `ctx.run()` / `ctx.all()`. The research value is high: it lets Weft users quote a real DPMO number to risk/compliance teams, which is a conversation Temporal cannot have at all.

---

## 9. Versioning across workflow, agent, and tool definitions (AgentOrchestra)

AgentOrchestra (2506.12508) argues that **Tool, Environment, and Agent** are all independently versioned components, and that a durable execution system should support rolling each one forward or back without invalidating in-flight workflows. Weft already versions workflows (`src/core/versioning.ts`) with explicit recovery guards. The remaining gap is tool versioning:

- **Tools**: if the schema of a tool an activity calls changes mid-flight, the workflow may produce output incompatible with the new schema. No detection today.

Now that Weft has no built-in agent or provider surface, "agent versioning" and "provider versioning" are userland concerns — the userland loop pins whatever model and prompt it uses. The engine-level fix is mechanical once §4 (event log) is in place: record the version tuple `(workflowVersion, toolVersions[])` in every event, and refuse to resume a workflow whose version tuple is incompatible with the currently registered versions. This gives operators a clear pre-deploy stop for tool-schema changes, which is a hole every production system hits within six months.

---

## 10. Other things worth stealing, in order of lift-to-value

**AutoDW's stepwise planner with adaptive rollback** (2512.04445) is structurally a simpler Sherlock and could be a good starting point if §5 is too big. **EnCompass's "probabilistic angelic nondeterminism"** (2512.03571) is a programming-model win — `ctx.branchpoint(options)` with automatic backtracking — but needs §3 and §4 as prerequisites. **Helium's templated radix tree for prompt prefix caching** (2603.16104) is a 45–60% latency reduction on repeated patterns; it belongs in the userland agent loop (or a standalone caching module), independent of durable execution. **StateFlow's explicit FSM** (2403.11322) is already structurally present in Weft's generator model; exposing it as a first-class declarative API (`defineStateMachine({ states, transitions })`) is mostly a DX win. **AIR's incident-response DSL** (2602.11749) is interesting but lower priority — it's effectively a higher-level API on top of constraints (§7). **WebRollback** (2504.11788) and **CaveAgent** (2601.01569) are application-layer concerns that Weft's existing `ctx.memo` and `ctx.offload` largely cover. **KubeIntellect's PostgreSQL checkpoint store** (2509.02449) is already matched by `TursoStorage`. **libDSE's benchmark claims** (2412.13314) are the most tempting and most dangerous — do not chase the order-of-magnitude latency win until effect logs and compensators are in place, because DSE's "reactively repair state on failure" story depends on both.

Do not bother with: **AIOS** (kernel abstractions that duplicate what Weft gets from the platform), **Agents Learn Their Runtime** (training-time insight, not a framework feature), **VIGIL's affective memory framing** (the mechanism is good; the vocabulary is not).

---

## 11. The performance gaps already documented in Weft

Before adding anything from the research, the measured vs. spec gaps in `reference/IMPORTANT.md` should probably be closed:

- Activity completions: spec `>30K/sec`, measured `~9K/sec` (3x short).
- Workflow starts: spec `>50K/sec`, measured `~13K/sec` (4x short).
- Memory per workflow: spec `≤2KB`, measured `~132 bytes` for the current checkpoint blob and `~743 bytes` for the total durable idle-workflow footprint across 100K parked workflows.
- Cold start binary: spec `<100ms`, measured `~1022ms` (10x over).

Helium's prompt caching and libDSE's speculative commit both improve throughput, so §5 pulls double duty here. The old idle-workflow memory gap is now closed, so the next highest-ROI performance work has shifted back to throughput: start-path fsync pressure, completion-path cleanup cost, and long-run RSS stability under sustained load rather than checkpoint blob size.

---

## 12. Prioritized roadmap

If I were sequencing this, I would do it in four tracks that can partially parallelize once Track 1 lands.

**Track 1 — Foundations:** Effect logs at the tool-call boundary (§2 ACRFence). Storage-backed event log with hash-chained writes (§4 ESAA). Compensation handlers on activities + `ctx.saga()` (§3 SagaLLM/Atomix). These three interlock; do them in one sprint or you'll do them twice.

**Track 2 — Testing and diagnosis:** Chaos primitives in `TestEngine` (§6 ReliabilityBench). Failure categorization enum (§6 AgentDebug). `weft validate` design-time linter (§6 Cemri). Constraint primitive with `onViolation` semantics (§7 AgentRx).

**Track 3 — Latency and throughput:** Speculative execution with verifiers (§5 Sherlock/libDSE). Prompt prefix caching (§10 Helium). Close the measured-vs-spec performance gaps (§11).

**Track 4 — Reliability and versioning:** DPMO metric in the collector (§8 Six Sigma); confidence-weighted voting and dynamic n-sizing are now userland patterns on top of `ctx.run()` / `ctx.all()`. Tool versioning and the workflow version tuple (§9 AgentOrchestra).

The detailed implementation checklist for these tracks lives in [../architecture.md](../architecture.md).

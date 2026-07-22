---
name: async-lifecycle-races
description: >-
  Use this skill when a Weft change touches ack-gated flows, pending promises,
  WebSocket workers, shutdown, disposal, cancellation, retries, reconnects,
  heartbeats, timers, or any lifecycle path where ordering can leave work hanging.
---

# Async Lifecycle Races

## When to use

- Changing `RemoteWorker.connect()`, registration acknowledgements, socket close handling, or worker disposal.
- Adding or modifying shutdown, cancellation, retry, heartbeat, timeout, or reconnect behavior.
- Introducing a promise that can outlive its owner or wait on an event from another process.
- Fixing tests that rely on real sleeps, timing slack, or unbounded polling.
- Changing server task polling, request `AbortSignal` handling, or `TaskQueue` disposal.
- Changing client workflow-event streaming, including `HttpClient` `/v1/workflows/:id/watch` subscriptions, fetch-based `/v1/workflows/:id/events/sse` tails, `eventTransport` selection, `client.tail(id)`, `handle.tail()`, `whenConnected()`, reconnect catch-up, JSON-RPC `weft.workflows.subscribe` / `weft.events.subscribe`, or WebSocket factory behavior.
- Changing pending workflow updates during inline advance or resume, especially where durable update responses can drain before handlers are registered.
- Changing out-of-band activity completion, including `ActivityContext.completeAsync()`, token claiming, REST/JSON-RPC completion, or payload rejection before token consumption.
- Changing `durableActivity()` helper execution inside inline `ctx.memo()` callbacks, including memo-scoped activity identities, pending helper promises, abort forwarding, immediate fenced reconciliation, browser fallback scope tracking, or unsupported `completeAsync()` routing.
- Changing per-run workflow `services`, `resolveWorkflowServices`, delayed-start recovery, scheduled occurrences, durable `schedule-run` metadata, or the durable `wf-has-services:` marker that gates re-provisioning.
- Changing inline `waitForSignal()` parking, retained contexts, or query-handler availability while a workflow is parked, resumed, suspended, or cleaned up.
- Changing `ctx.waitUntil(predicate, timeout?)`, condition waiters, wait-condition timers, update-driven re-evaluation, or predicate failure routing.
- Changing `ctx.race()` / `ctx.raceKeyed()` / `ctx.all()` branch execution for sleeps, signal waits, or `ctx.run()` activity branches, especially keyed branch topology, deferred-consume envelopes, nested coordinator propagation, `ctx.speculate`, duplicate signal-name validation, abort ordering, buffered-signal zero-sleep drains, or engine-disposal cleanup.
- Changing workflow suspend/resume, recovered-handle observation, `recoverAll({ onRecoveredWorkflow })`, idempotent start reservation, `startOrSignal`, inline launch deferral, externally driven `runMaintenance()`, or engine disposal while queued inline launches can still flush.
- Changing scheduled occurrence launch flow or `schedule:fired` event dispatch, including overlap-policy gating, queued-drain launches, unavailable-services ordering, and process-local notification behavior.
- Changing RemoteWorker or long-poll task completion authorization, including per-dispatch `attemptToken` generation, echoing, registry restore, malformed-token rejection, and missing-token compatibility.
- Changing durable execution tokens, including per-run `workflowExecutionToken` minting, recovery stability, `start-new` rotation, activity/finalizer attempt-token derivation, worker dispatch, WebSocket task frames, or long-poll claim payloads.
- Changing durable timer cleanup or sleep operation identity, especially fired timer deletion, deadline timers, terminal cleanup, delayed starts, schedules, teardown, crash recovery, `start-new` replacement runs, or successor re-drive after deposition.
- Changing lease-owned engine write paths for schedules, purges, bulk retry reactivation, activity reconciliation, completed reviews, async-activity registration, or checkpoint side effects.

## Do not use

- Pure synchronous parsing or formatting changes.
- Tests that can be expressed as deterministic pure-function assertions.
- UI-only state changes that do not affect worker, server, engine, or storage lifecycle.

## Workflow

1. List each pending operation and the event that resolves or rejects it.
2. For every owner transition, define what happens on success, error, abort, close, disposal, and shutdown.
3. Reject or settle pending promises when the owner goes away; never leave callers waiting for an event that can no longer arrive.
4. Prefer virtual time, explicit signals, and observable conditions over fixed `Bun.sleep()` delays.
5. Cap polling and retry loops, then surface the final state when the cap is reached.
6. Check `signal.aborted` before registering listeners or claiming work; an already-aborted signal will not fire another abort event.
7. On server shutdown, clear timers, resolve parked waiters, and avoid invoking callbacks that would re-enter disposed engine or storage state.
8. For pending updates, wait for registered update handlers before draining durable requests. A resumed or inline-advanced workflow must not reject a valid persisted update merely because the handler registry has not caught up yet.
9. For pending-update delivery claims, release or make the in-memory claim recoverable if validation, rejection, response persistence, or handler delivery throws before the durable request is deleted; otherwise a swallowed drain error can strand an update until engine restart.
10. For async activity completion, claim a single-use token synchronously before storage awaits, reject malformed or oversized completion payloads before that claim so a parked workflow can still be completed later, and do not acknowledge the caller until the acknowledgement batch (token delete + durable resolution record) has committed. A failed acknowledgement must restore the in-memory claim so the token stays retryable.
11. For `durableActivity()` helpers, model the active memo scope, sequential awaited helper calls, memo return with a pending helper promise, workflow cancellation, engine disposal, keyed immediate fenced reconciliation, unkeyed crash replay, browser fallback scope ambiguity, and `completeAsync()` rejection as separate paths.
12. For workflow services and recovered-workflow hooks, treat resolver success, unavailable results, throws, hook success, hook throws, live scheduled occurrences, recovered schedule-run metadata, queued drains with unknown occurrence timestamps, terminal commit faults, delayed-start timers, terminal cleanup, purge, and retention as distinct lifecycle outcomes. The recovered hook runs after services are resolved and before the generator advances; a hook failure fails only that run.
13. For inline launch queues, model `defer: false`, queued async launch, disposal before flush, and runtimes without `MessageChannel` as separate execution paths.
14. For queryable parked workflows, retain only the context needed for `ctx.onQuery()` while parked on `waitForSignal()`, prefer the live context after resume, and evict retained contexts on suspend and terminal cleanup.
15. For wait-condition gates, model the first predicate evaluation, update-driven re-evaluation, timeout fire, predicate throw, cancellation, recovery, and disposal as separate paths. Signals are pull-only and must not wake a condition waiter.
16. For race/all branches, model the top-level coordinator, nested `race`/`all`, `raceKeyed`, and `ctx.speculate` as separate consumers. Losers must release waiters without consuming durable signals, losing inline `ctx.run()` branches inside a race must receive the coordinator `AbortSignal` on `ActivityContext.signal`, worker-pooled activities must not be documented as receiving that race-loss abort, and winners must finalize before checkpointing encoded results. For keyed races, preserve branch count/name order in checkpoints and Worker replay signatures, reject empty and symbol-keyed maps before a durable step is consumed, and stringify numeric keys in the public result.
17. For fired timers under `ownership: 'lease'`, route cleanup through the same lease-fenced commit path as the timer callback's durable writes. A deposed engine must not delete a fired timer whose fenced follow-up write was rejected; the successor needs the durable marker to re-drive.
18. For async completion, the token delete commits atomically with a durable resolution record carrying the outcome, and the resolution-record delete is staged with the workflow checkpoint that records the result; for review-timeout cleanup, stage pending-key deletion with the checkpoint commit that records the failure. Never consume a durable key through a path that can drop the outcome before the workflow adopts it.
19. For inline cancellation, preserve the prompt ordering contract: `engine.cancel()` aborts `ctx.signal` for already-running inline work before `ctx.onCancel()` handlers run, and `ctx.onCancel()` runs after the cancelled state commits but before `cancel()` resolves.
20. For `ctx.sleep()`, keep the operation id deterministic as `${workflowId}:${step}` across replay, and keep resolver settlement deadline-aware. Do not use missing `timer-idx:sleep:` storage as an early-fire signal because stale timers from a replaced run can delete the shared index before the current run's deadline. Fired sleep timers must wait for durable progress acknowledgement from the awakened inline workflow before deletion; model callback failure, suspension, termination, checkpoint failure, engine disposal, and Service Worker eviction as separate waiter-settlement paths.
21. For externally driven maintenance, prove `backgroundTasks: 'manual'` starts no process-local scheduler, update-response cleanup, retention, or alert intervals. Each awaited `engine.runMaintenance(now?)` call should drive due timers, delayed starts, scheduled occurrences, expired update responses, configured retention, and alert evaluation exactly once, and manual mode must reject lease ownership, second-instance detection, and `startScheduler: true`.
22. For CLI signal shutdown, create one memoized promise for both `SIGINT` and `SIGTERM`; test the cleanup order, best-effort lockfile removal, success/failure exit behavior, and repeated-signal at-most-once execution without process-exit test hacks.

### Client event-streaming work

- Treat connect, history catch-up, live-frame buffering, reconnect, terminal close, and manual `close()` as separate state transitions.
- Pin a connect generation around history catch-up; a stale catch-up must not emit history, drain frames from a newer socket, or inflate the delivered cursor.
- Deduplicate only the true catch-up/live overlap. If two live frames are structurally identical, consume at most one matching history entry so the second live frame is still delivered.
- Buffer from construction for `tail()` so `await tail.whenConnected(); for await (...)` still sees catch-up history. Do not buffer indefinitely for callback-only `addEventListener` subscriptions.
- Keep `HttpHandle` subscription lifetime explicit: do not silently re-open a terminal or exhausted subscription if doing so would replay already-delivered events to existing listeners.
- Fail first-connect factory errors loudly. Missing global WebSocket support or header-capability mismatches should point at `HttpClientOptions.webSocketFactory`.
- For server subscriptions, keep raw `/watch` replay bounded by cursor, raw token `/stream` separate from event feeds, `weft.events.subscribe` cursor-ordered under the current one-server-process-per-durable-store model, and fleet events purge-safe for workflow deletion.

### RemoteWorker reconnect work

- Model close, deferred requeue, same-`workerId` re-register, duplicate-live-`workerId` rejection, grace-period reconnect, heartbeat visibility extension, and stale `taskResult` arrival as separate transitions. Do not restore the old latest-socket-wins peer takeover path; a second live socket must receive `invalid_registration`.
- Treat `taskResult` send failures as durable lifecycle work: buffer bounded results, flush them after reconnect, and prove backpressure does not drop terminal outcomes silently.
- Persist task ownership before sending work across a socket; otherwise a fast worker can complete before the in-flight record exists and leave an orphan that the scanner redelivers.
- Mint a fresh `attemptToken` on every dispatch or long-poll claim, persist it with the in-flight owner before sending work, echo it from upgraded workers, and restore it when rebuilding in-flight registry state after server restart.

## Verification

- Add race regression tests for before-ack disposal, socket close, cancellation, and shutdown paths touched by the change.
- For inline cancellation, assert `ctx.signal` abort observation, `ctx.onCancel()` ordering, and the terminal cancelled status without depending on wall-clock sleeps.
- For reconnect behavior, cover grace-window cancellation, duplicate-live-`workerId` rejection, visibility-timeout takeover after the grace window, stale completion rejection, server-restart redelivery, and buffered `taskResult` resend after a socket failure.
- For client event streaming, cover connect catch-up, reconnect during catch-up, duplicate-looking live frames, callback-only no-leak behavior, `whenConnected()` after close, and missing or inadequate WebSocket factories.
- For SSE event streaming, cover replay-complete readiness, `Last-Event-ID` reconnect cursors, parked iterator close, terminal-event auto-close, and abort cleanup before iteration begins so feed listeners and connection leases cannot leak.
- For long-poll task queues, cover disconnect during wait, already-aborted signals, pending-task retention for dead callers, idempotent disposal, and timer cleanup.
- For sleep timer identity, resolver, or acknowledgement changes, cover crash-during-sleep recovery with exactly one surviving timer key, schedule-to-register early fire, stale earlier-run timers under `start-new`, callback failure that retains the fired timer, acknowledgement rejection on checkpoint failure or disposal, and Service Worker periodic-sync recovery.
- For lease-fenced timer cleanup, cover a deposed engine whose timer callback write is rejected and prove the fired timer remains for a successor scheduler to clear.
- For lease-fenced engine writes, cover each touched path with a deposed-engine or fenced-write conflict case so schedules, purge, bulk retry, activity reconciliation, async-activity registration, completed reviews, and staged side effects cannot fall back to bare `storage.batch()`.
- For pending-update drains, cover resume and inline advancement paths where the update is durable before the handler is visible.
- For wait-condition gates, cover met predicates, timed-out predicates, throwing predicates on initial and update-driven evaluation, cancellation, recovery, cleanup, and rejection inside `ctx.race()`, `ctx.all()`, and `ctx.speculate()`.
- For async activity completion, cover double-completion races, malformed JSON, oversized payload rejection that preserves the token, and cross-transport parity between `LocalClient` and `HttpClient`.
- For async activity acknowledgement under `ownership: 'lease'`, cover same-epoch precondition loss by proving the call rejects and the durable token record remains present and unconsumed; for recovery, seed malformed persisted resolution outcomes and prove they are not buffered for adoption.
- For `durableActivity()` helpers, cover package-root import portability without `process.getBuiltinModule`, scope absence, scope closure, ambiguous fallback scopes, pending-on-return failure, cancellation/disposal aborts, keyed recovery without redispatch, unkeyed at-least-once replay, retry/heartbeat state isolation, and `completeAsync()` rejection.
- For per-run services and recovered-workflow hooks, cover normal start, Worker-mode rejection, running recovery, delayed-start recovery, scheduled occurrences, recovered schedule-run metadata, queued drains with `occurrence: undefined`, resolver throw/unavailable sibling isolation, hook ordering before generator advance, hook context fields, isolated hook failure, terminal cleanup, purge, and retention marker deletion.
- For queryable parked workflows, cover the first signal park, a post-resume second park, unregistered query names, suspend teardown, terminal teardown, and wait-signal replay failure paths.
- For race/all branches, cover top-level and nested wait-signal winners and losers, losing inline `ctx.run()` activity aborts when a sibling wins, worker-pooled race-loss non-abort behavior when that boundary is touched, keyed winner replay and branch-topology mismatch failures, zero-sleep buffered-signal drain ordering, positive-timeout ordinary race behavior, `ctx.speculate` finalization, duplicate signal-name rejection, `ctx.all` finalize-after-all-settle behavior, abort reason propagation, and engine-disposal cleanup for long sleep branches.
- For suspend/resume and recovered-handle observation, cover suspended workflows as non-terminal, explicit resume after recovery, terminal/nonexistent faults, `getLaunchMetadata()` null after purge, and `snapshot()` status/step reads without awaiting `result()`.
- For start idempotency and `startOrSignal`, cover concurrent same-key callers, spent-key conflicts after retention or purge, terminal-target conflicts, bare-`signalId` non-convergence, and same-id pre-commit abort recovery.
- For inline launch scheduling, cover queued launch draining on disposal, `defer: false` synchronous launch, and the timeout flush path when `MessageChannel` is unavailable.
- For manual maintenance mode, cover construction rejections for interval-dependent options and a host-driven `runMaintenance()` tick that advances due timers, schedules, update-response cleanup, retention, and alert evaluation without relying on background intervals.
- For schedule firing events, cover interval and cron cadence, each overlap policy, recovery backfill without double-fire, queued drain with `occurrence: undefined`, and `schedule:fired` before `workflow:failed` when service resolution fails.
- For attempt-token work, cover same-worker stale completion rejection over WebSocket, long-poll stale-token rejection, malformed echoed tokens, token-less records, absent echoes from older workers, and server-restart restoration of token-bearing in-flight records.
- For workflow execution-token work, cover token stability across recovery, rotation on `start-new` replacement, propagation into inline and worker activity contexts, finalizer token exposure, and stale external-write rejection scenarios that use both the run token and the attempt token.
- For fleet event subscriptions, cover replay caps, workflow and event-kind filters, worker connect/disconnect events, purge cleanup, and request/response dispatch rejection for subscription-only operations.
- Prove no test depends on unbounded waits or real-time sleeps.
- Run the focused lifecycle or worker tests plus `bun run verify:no-test-sleeps` when relevant.

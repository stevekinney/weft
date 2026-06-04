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
- Changing client workflow-event streaming, including `HttpClient` `/v1/workflows/:id/watch` subscriptions, `client.tail(id)`, `handle.tail()`, `whenConnected()`, reconnect catch-up, or WebSocket factory behavior.
- Changing pending workflow updates during inline advance or resume, especially where durable update responses can drain before handlers are registered.
- Changing per-run workflow `services`, `resolveWorkflowServices`, delayed-start recovery, or the durable `wf-has-services:` marker that gates recovery re-provisioning.

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
9. For recovered services, treat resolver success, unavailable results, throws, terminal commit faults, delayed-start timers, terminal cleanup, purge, and retention as distinct lifecycle outcomes.

### Client event-streaming work

- Treat connect, history catch-up, live-frame buffering, reconnect, terminal close, and manual `close()` as separate state transitions.
- Pin a connect generation around history catch-up; a stale catch-up must not emit history, drain frames from a newer socket, or inflate the delivered cursor.
- Deduplicate only the true catch-up/live overlap. If two live frames are structurally identical, consume at most one matching history entry so the second live frame is still delivered.
- Buffer from construction for `tail()` so `await tail.whenConnected(); for await (...)` still sees catch-up history. Do not buffer indefinitely for callback-only `addEventListener` subscriptions.
- Keep `HttpHandle` subscription lifetime explicit: do not silently re-open a terminal or exhausted subscription if doing so would replay already-delivered events to existing listeners.
- Fail first-connect factory errors loudly. Missing global WebSocket support or header-capability mismatches should point at `HttpClientOptions.webSocketFactory`.

### RemoteWorker reconnect work

- Model close, deferred requeue, same-`workerId` re-register, peer takeover, heartbeat visibility extension, and stale `taskResult` arrival as separate transitions.
- Treat `taskResult` send failures as durable lifecycle work: buffer bounded results, flush them after reconnect, and prove backpressure does not drop terminal outcomes silently.
- Persist task ownership before sending work across a socket; otherwise a fast worker can complete before the in-flight record exists and leave an orphan that the scanner redelivers.

## Verification

- Add race regression tests for before-ack disposal, socket close, cancellation, and shutdown paths touched by the change.
- For reconnect behavior, cover grace-window cancellation, visibility-timeout takeover, stale completion rejection, server-restart redelivery, and buffered `taskResult` resend after a socket failure.
- For client event streaming, cover connect catch-up, reconnect during catch-up, duplicate-looking live frames, callback-only no-leak behavior, `whenConnected()` after close, and missing or inadequate WebSocket factories.
- For long-poll task queues, cover disconnect during wait, already-aborted signals, pending-task retention for dead callers, idempotent disposal, and timer cleanup.
- For pending-update drains, cover resume and inline advancement paths where the update is durable before the handler is visible.
- For per-run services, cover normal start, Worker-mode rejection, running recovery, delayed-start recovery, resolver throw/unavailable sibling isolation, terminal cleanup, purge, and retention marker deletion.
- Prove no test depends on unbounded waits or real-time sleeps.
- Run the focused lifecycle or worker tests plus `bun run verify:no-test-sleeps` when relevant.

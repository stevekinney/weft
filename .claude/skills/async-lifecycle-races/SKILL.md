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

### RemoteWorker reconnect work

- Model close, deferred requeue, same-`workerId` re-register, peer takeover, heartbeat visibility extension, and stale `taskResult` arrival as separate transitions.
- Persist task ownership before sending work across a socket; otherwise a fast worker can complete before the in-flight record exists and leave an orphan that the scanner redelivers.

## Verification

- Add race regression tests for before-ack disposal, socket close, cancellation, and shutdown paths touched by the change.
- For reconnect behavior, cover grace-window cancellation, visibility-timeout takeover, stale completion rejection, and server-restart redelivery.
- For long-poll task queues, cover disconnect during wait, already-aborted signals, pending-task retention for dead callers, idempotent disposal, and timer cleanup.
- Prove no test depends on unbounded waits or real-time sleeps.
- Run the focused lifecycle or worker tests plus `bun run verify:no-test-sleeps` when relevant.

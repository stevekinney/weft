# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.18.0] - 2026-08-11

### Added — principal introspection

New `weft.system.principal` operation (`GET /v1/principal`) reports the
caller's own resolved principal: authentication method, normalized subject,
and granted scopes (sorted). Public access by design — anonymous callers
receive `method: 'unauthenticated'` with an empty scope list instead of an
error, so dashboards can resolve their credential state without probing other
operations. The canonical scope vocabulary is now a public export:
`AUTHORIZATION_SCOPES`, `AuthorizationScope`, and `isAuthorizationScope` from
`@lostgradient/weft/server`, alongside the `GetPrincipalOutput` type.

## [0.17.0] - 2026-07-27

### Changed — awaited lease shutdown result

`Engine.shutdown()` now returns `Promise<boolean>` so process hosts can confirm
whether an ownership-lease holder delete committed. Update callback and stored
promise types that require `Promise<void>`. When it returns `false`, renewals
have stopped but handoff was not confirmed: a successor may already own the
lease, or a storage failure may have left the old holder valid until its
configured `leaseTtl` expires. Alert on the result and let replacement lease
acquisition distinguish those cases.

## [0.8.0] - 2026-06-24

### Added — Service Worker recovery and release automation

Browser Service Worker hosts can now opt into durable recovery with
`recover: true`, and `browser-smoke` is part of the required validation gate so
browser storage and recovery regressions are caught before release (#611, #616).

The release workflow now has a documented `release-publish` playbook and a
post-publish downstream notification job. After a successful tagged publish, the
workflow opens versioned bump issues for configured downstream repositories,
deduplicating existing issues for the same target version (#638, #640).

### Added — durable helper workflow support

Plain async helpers running inside an inline `ctx.memo()` callback can use the
package-root `durableActivity()` helper to launch durable activities while
preserving memo-scoped operation identities for retry, heartbeat,
reconciliation, diagnostics, and timeline labels (#621, #624).

### Added — explicit lease shutdown ergonomics

`Engine.shutdown()` is now the explicit awaited shutdown primitive for hosts
that need prompt lease release during process termination. Lease-owning engines
also warn on synchronous disposal through the exported
`ENGINE_LEASE_SYNCHRONOUS_DISPOSE_WARNING_NAME`, nudging rolling deployments
toward `shutdown()` or `await using` when handoff latency matters (#639).

### Fixed — worker transport and runtime hardening

Remote worker registration now rejects duplicate live `workerId` connections,
with reconnect grace still allowed for the legitimate worker, and the WebSocket
transport caps raw frames before parsing so oversized messages cannot force a
large JSON allocation (#609, #610, #614, #615).

Start-or-signal restart behavior, durable lease-fenced writes, async activity
completion, opaque signal identifiers, and JSON negative-zero handling gained
additional regression coverage and documentation refreshes to keep the runtime
contract pinned across future cleanup work (#613, #617, #623, #635, #637).

### Fixed — coverage and documentation gates

Runtime coverage is back at the repository's deterministic 100 percent adjusted
coverage gate, with refreshed coverage guidance for the restoration workflow
(#620, #625, #626). Public documentation, agent guidance, and mirrored skills
were refreshed around durable helper workflows, worker and restart behavior,
and pull request evidence collection (#619, #624, #637).

## [0.7.0] - 2026-06-20

### Added — secure REST Server-Sent Event streams

REST now exposes authenticated Server-Sent Event feeds for workflow and fleet
events (#598). The new `weft.workflows.events.sse` and `weft.events.sse`
operations stream committed event envelopes with cursor-keyed frames, idle
`ping` keepalives, `Last-Event-ID` / `fromCursor` replay, `Accept:
text/event-stream` negotiation, sanitized in-stream error frames, and
scope-aware authorization. `maxStreamConnectionsPerWorkflow` now accounts for
workflow event SSE connections alongside the existing stream and watch paths.

`HttpClient` gains `eventTransport: 'auto' | 'websocket' | 'sse'`, keeping
WebSocket delivery as the preferred path while falling back to fetch-based SSE
when the runtime cannot construct header-capable WebSockets. Shared tail
lifecycle code now backs both WebSocket and SSE clients, reducing duplicate
iterator, buffering, close, and terminal cleanup behavior (#601).

### Added — restart-capable `startOrSignal`

`engine.startOrSignal()` can now reuse a stable workflow id after the prior run
is terminal, mirroring `engine.start(..., { onTerminalConflict: 'start-new' })`
while preserving the single start-or-signal call shape (#606). The restart path
requires an explicit workflow `id` and deterministic `signal.signalId`, rejects
`idempotencyKey`, signals non-terminal runs instead of replacing them, and
purges the terminal prior run through the shared terminal-replacement path
before creating the fresh run with its initial signal.

The option is available through `WeftClient`, `LocalClient`, `HttpClient`, REST,
JSON-RPC, generated catalog/client metadata, and public exports.
`weft.workflows.startorsignal` is now classified as destructive because this
option can purge a terminal run. `WorkflowTeardownPendingError` is surfaced as a
typed conflict when durable finalizer teardown blocks the restart.

### Added — services resolver launch context

`resolveWorkflowServices` now receives optional `launchOptions` and `schedule`
context so inline hosts can rebuild services from durable launch identity rather
than duplicating that identity in workflow inputs (#605). Recovered runs include
the workflow id and current durable tags; scheduled occurrences include the
schedule id and occurrence timestamp when known. The package root now exports
`WorkflowServicesResolverLaunchOptions` and
`WorkflowServicesResolverScheduleInfo` so consumers can name every nested field
on `WorkflowServicesResolverInfo` without deep imports (#607).

### Added — timeout and scheduler diagnostics

`WorkflowTimeoutError` now exposes an optional `terminationReason`, aligned with
`WorkflowTimedOutEvent.reason`, so callers can distinguish history
circuit-breaker termination from execution-deadline timeouts directly from
`handle.result()` / Observable errors without a second `engine.get()` lookup
(#593).

`EngineOptions.schedulerPollIntervalMs` configures the durable-timer scheduler's
real-time poll interval, with positive-safe-integer validation before it reaches
`setInterval`. `DEFAULT_POLL_INTERVAL_MS` is now wired into the scheduler and
exported for diagnostics and tests (#593).

### Fixed — coverage, documentation, and source-compatibility classification

- Restored route-match, local handle wrapper, and event-stream lifecycle
  coverage without weakening the release gates (#596, #600, #601).
- Refreshed public documentation, agent guidance, and event-streaming docs after
  the recent API changes (#597, #602).
- Reclassified source-compatibility wording in tests so compatibility assertions
  describe current contracts rather than retired compatibility layers (#595).

## [0.6.0] - 2026-06-17

### Added — `Engine.create({ startScheduler })` decouples timer polling from recovery

`Engine.create()` accepts a new `startScheduler?: boolean` option that controls
the durable-timer polling loop independently of `recover` (#590). `recover`
decides _who drives `recoverAll`_; `startScheduler` decides _whether timers
fire_. It defaults to `recover !== false`, so existing behavior is unchanged. A
host that owns its own recovery — passing `recover: false` so it can capture the
recovered handles from its own `engine.recoverAll()` — can now arm the poller
with `startScheduler: true`, so durable `ctx.sleep(...)` and
`engine.schedule(...)` timers still fire. Conversely, `startScheduler: false`
keeps the poller stopped even when recovery runs, for engines that tick the
scheduler deterministically.

## [0.5.0] - 2026-06-17

### Fixed — `ctx.race` aborts a losing `ctx.run` activity branch

When a non-activity branch wins a `ctx.race([...])`, the losing `ctx.run()`
activity branch now fires its activity's `ctx.signal` (`AbortSignal`) for
cooperative cancellation, consistent with how losing `sleep` and `wait-signal`
branches were already torn down (#584). The coordinator's `AbortSignal` is
threaded through the activity sub-operation executor and composed into
`ActivityContext.signal` alongside the workflow-cancel and per-attempt-timeout
signals, so the activity aborts when any source fires. This makes the
`ctx.race` supersede idiom self-sufficient: a superseded activity is signalled
to stop rather than running to completion and risking a stale last-writer-wins
write. This reverses the prior #453 contract that left race losers running;
the pinned cancellation test now asserts the abort-on-loss behavior.

### Fixed — `Engine.create()` starts the scheduler

`Engine.create()` now starts the scheduler's timer-polling loop on the default
recovery path (`recover !== false`), so durable `ctx.sleep(...)` timers fire in
long-lived in-process hosts without an explicit `engine.scheduler.start()`
(#586). `recover: false` (tests, isolated `ScopedStorage` engines, pre-recovery
inspection) intentionally skips the auto-start, and `TestEngine`'s manual
`advanceTime()` tick-based time control is unaffected. Disposal still stops the
scheduler via `[Symbol.asyncDispose]`.

### Fixed — public `StartOrSignalOutcome` export and `LocalClient` engine typing

`StartOrSignalOutcome` (`'started' | 'signalled'`, the type carried by the
public `ClientHandle.outcome` field and the engine's `StartOrSignalResult.outcome`)
is now re-exported from both the package root
(`@lostgradient/weft`) and the `/client` barrel (`@lostgradient/weft/client`),
so consumers can name the type to annotate their own result interfaces (#583).
The `LocalClient` constructor is now generic over the engine's workflow
registry, so a branded engine returned by `Engine.create({ workflows })` is
accepted without a cast: the canonical in-process topology
`Engine.create({ workflows }) → new LocalClient(engine)` type-checks directly
(#585).

## [0.4.0] - 2026-06-17

### Added — replay-safe structured logging

`WorkflowContext` now exposes `ctx.log`, a structured logger with `.debug()`,
`.info()`, `.warn()`, and `.error()` methods (#447). Each call auto-carries
`workflowId`, `workflowType`, `level`, and `timestamp` in an engine-owned
envelope; caller attributes nest under an `attributes` key so they cannot shadow
envelope fields. Logging is replay-safe in both inline and worker execution
modes: a call within the already-committed replay window is suppressed without
consuming a durable step, while a log at an uncached live frontier may re-emit
after recovery. The `WorkflowLogger` type is exported from the package root for
typing injected loggers.

`EngineOptions.onLog` is a new optional host sink that receives `ctx.log`
records from both execution modes — inline directly, and worker-mode forwarded
back to the host over a non-terminal `log` protocol message (#491, #529). With
no sink installed, inline logs go to the host console and worker logs to the
worker console. A throwing sink falls back to console without failing the
workflow, and the same sink behavior applies inside `ctx.speculate()` branches
and across recovered and forked inline contexts (#533, #535, #549). The
worker-forwarded log lane is internally rate-limited so a misbehaving worker
that floods or repeatedly sends malformed records is torn down, without
affecting honest high-log workflows (#545).

### Added — `ctx.waitUntil` condition gate

`ctx.waitUntil(predicate, timeout?)` is a new inline-only durable condition
primitive (#448). It re-evaluates a pure predicate each time `ctx.onUpdate()`
drives workflow-local state, and consumes one durable slot regardless of how
many times it wakes. With a `timeout`, it resolves `true` once the predicate
holds or `false` if the deterministic deadline elapses first (predicate-first,
so a predicate true exactly at the deadline counts as met); without a timeout it
waits indefinitely and resolves `void`. Signals do not re-drive it, and it is
rejected inside `ctx.race()`, `ctx.all()`, and `ctx.speculate()` with an
actionable error.

### Added — sleep and wait-signal branches in `ctx.race` / `ctx.all`

`ctx.race()` and `ctx.all()` now accept `ctx.sleep(duration)` and
`ctx.waitForSignal(name)` branches alongside `ctx.run()` branches (#456). Sleep
branches use abortable in-process timers. Wait-signal branches use a
deferred-consume protocol that consumes a durable signal record only for a
branch whose result is actually kept: under `ctx.race()` that is just the
winning branch, so a losing wait-signal branch drops its envelope unfinalized
and leaves the signal available for a later `waitForSignal`; under `ctx.all()`
every branch is kept, so each fulfilled wait-signal branch consumes its signal,
but only once all branches have settled and immediately before the coordinator
checkpoints. Duplicate signal names within one coordination tree are rejected at
validation time.

### Added — `onTerminalConflict: 'start-new'` on `engine.start`

`engine.start(..., { id, onTerminalConflict: 'start-new' })` restarts a workflow
under an id whose prior run is in a terminal state (#452). The terminal run is
purged and a fresh run created atomically. It requires an explicit `id`, rejects
`idempotencyKey`, never displaces a non-terminal run, and is in-process
`engine.start` only — it is absent from REST, JSON-RPC, `engine.startOrSignal()`,
and `ctx.startChild()`.

### Added — durable finalizers

`WorkflowDefinition` accepts a new `finalizer` option — a definition-level
teardown activity driven post-terminal when a workflow is cancelled or times out
(#446). The engine drives it durably with retry and backoff, re-drives it on
crash recovery, and dead-letters it after a bounded horizon.
`ctx.setFinalizerState(value)` records the payload the finalizer receives and
commits it atomically with the next checkpoint or the terminal batch. A new
`WorkflowTeardownEvent` (kind `workflow:teardown`) is emitted as the finalizer
progresses; its `status` field carries `WorkflowTeardownStatus` —
`'completed'`, `'failed'`, or `'dead-lettered'`. Purge, bulk-delete, and
`onTerminalConflict: 'start-new'` are blocked while teardown is pending: purge
and bulk-delete skip the run and surface it under `skippedTeardownPending`,
while a restart throws `WorkflowTeardownPendingError`. The finalizer activity
always runs on the engine host, so registering a `finalizer` is allowed under
both inline and worker execution modes; staging teardown state via
`ctx.setFinalizerState` works only under inline execution, since the
worker-side `ctx` does not carry that method.

### Added — lease-fenced single-writer ownership

`EngineOptions.ownership: 'lease'` opts an engine into durable single-writer
ownership of its store (#470). The engine acquires a two-key storage lease
before `recoverAll()`, renews it on a heartbeat, and releases it on dispose;
`leaseTtl`, `leaseRenewInterval`, and `leaseWaitTimeout` tune the timings. Every
engine-owned durable write — including the scheduler's fired-timer cleanup
(#563) — is fenced on the lease epoch, so a deposed zombie engine's writes lose
a CAS against the successor's newer epoch and trigger a deferred teardown. New
error types `EngineLeaseAcquisitionTimeoutError`, `EngineLeaseCorruptedError`,
and `EngineLeaseNotHeldError`, plus the `ENGINE_LEASE_LOST_WARNING_NAME`
constant, are exported. The default remains `ownership: 'none'`.

### Added — fleet-wide event streaming

A new JSON-RPC WebSocket operation `weft.events.subscribe` provides a
fleet-wide event feed with optional `workflowId` and `kind` filters and a
`fromCursor` replay cursor over retained events (#577). It requires the
`events:read` scope. Two new engine events accompany it — `worker:connected`
(`WorkerConnectedEvent`) and `worker:disconnected` (`WorkerDisconnectedEvent`) —
and the per-workflow `weft.workflows.events` subscription gains the same
replay-from-cursor capability.

### Added — client ergonomics

`WeftClient.getHandle(id)` is a new transport-uniform handle lookup on
`WeftClient`, `LocalClient`, and `HttpClient`: it returns `null` when no
workflow with that id exists and a handle whose `result()` resolves immediately
from persisted state for terminal runs (#467). `engine.startOrSignal()` now
returns a per-call handle carrying `outcome: 'started' | 'signalled'`, with the
REST `start-or-signal` response body gaining a top-level `outcome` field and
`StartOrSignalOutcome` exported from the root (#466). A new `isWeftFault(error,
code)` predicate matches both in-process `WeftError` subclasses and
HTTP-wrapped faults carrying a `weftCode`, so transport-neutral code can branch
on error codes without `instanceof` checks (#465).

### Added — activity surface extensions

- `ActivityCallOptions.scheduleToCloseTimeout` is a cross-attempt wall-clock
  budget for an entire `ctx.run()` call, anchored on the step's first dispatch;
  overshooting throws `ActivityScheduleToCloseTimeoutError` (failure category
  `timeout`), now registered in `WeftErrorCode` and recognized by `isWeftFault`
  (#449).
- `ActivityContext.lastHeartbeatDetails` exposes the prior attempt's last
  `heartbeat()` payload, keyed per `(workflowId, step)` so a later step never
  inherits an earlier step's heartbeat (#450). It is cleared after a successful
  attempt so the next attempt starts clean (#487), and a development warning
  fires when a retry at `attempt > 1` recorded none (#493).
- Each activity attempt receives an `AbortSignal` that fires cooperatively as
  the per-attempt timeout budget is about to be exhausted, giving the
  implementation a chance to cancel in-flight work before the framework marks
  the attempt timed out (#494).

### Added — `schedule:fired` event

A new `ScheduleFiredEvent` (`schedule:fired`) is dispatched on the engine each
time a schedule actually launches an occurrence (#471). It carries `scheduleId`,
`workflowId`, `firedAt` (the actual launch time), and `occurrence` (the
scheduled grid timestamp, `undefined` for queue-drained runs). Delivery is
process-local and best-effort after the durable start commits; skipped ticks
stay silent, and catch-up occurrences during recovery emit exactly once.

### Added — MCP anonymous-session continuation token

Every session-creating MCP `initialize` response now carries a random
`Mcp-Session-Token` alongside its `Mcp-Session-Id`, disclosed exactly once and
never echoed again (#525). The token is _required_ only to continue an anonymous
session under `authRequired: false`: every subsequent `POST`, `GET`, and
`DELETE` for such a session must echo it, and a missing or wrong token is
rejected with `403`. Authenticated callers re-present their credential on each
request, so their session binding is unchanged and is not gated on the token.

### Added — Neon storage schema/table configuration

`NeonStorageOptions` accepts optional `schema` and `table` identifiers (#468),
validated at construction and injected as SQL identifiers rather than string
parameters. A custom `schema` triggers `CREATE SCHEMA IF NOT EXISTS`, letting
multiple engines share one Neon database under distinct schemas.

### Changed — collapsed Neon batch round trips

`NeonStorage.batch()` and `conditionalBatch()` now resolve to the net effect per
key (last write wins, with the put-set and delete-set kept disjoint) and issue
at most one `unnest(...)` upsert plus one `DELETE ... = ANY(...)` per call,
regardless of operation count (#469). `conditionalBatch` reads all preconditions
with a single `key = ANY(...)` query inside the same `SERIALIZABLE` transaction
as its writes, and the whole `read → compare → write → commit` cycle is retried
as a unit on a `40001` serialization failure. This collapses O(keys) sequential
round trips to O(1) per attempt for checkpoint commits.

### Changed — `startOrSignal` same-tick ordering and signal key format

The start signal is now always consumed before any concurrent anonymous signal
buffered for the same workflow in the same event-loop tick (#458). Making this
deterministic required changing the internal buffered-signal storage key layout.
**This is a breaking change to the persisted key format**: there is no migration
path for in-flight buffered signals across the boundary, so drain in-flight
signals and upgrade between runs rather than mid-run.

### Changed — scheduled occurrences resolve workflow services

`engine.schedule()` occurrences now run `resolveWorkflowServices` before
launching, so per-run inline `services` are re-provided on scheduled launches
(#459). A missing or throwing resolver fails only that occurrence (failure
category `system`) and leaves the schedule active, ordered as `schedule:fired`
before `workflow:failed`.

### Changed — additional public surface refinements

- `WorkflowContext.workflowType` is now a required `readonly` member of the
  interface, not just a property on the concrete class (#451).
- Inline workflows parked on `ctx.waitForSignal()` now keep their `ctx.onQuery()`
  handlers callable while parked, switching to the fresh context on resume and
  tearing down on suspend or terminal cleanup (#457).
- `Engine.create({ workflows: {} })` is now equivalent to omitting `workflows`
  and yields the default-registry engine accepted by `ServeOptions` (#455).

### Removed (breaking) — historical compatibility shape

The `{ definition: { name } }` element shape previously tolerated by
`collectToolVersions` has been removed (#514). Callers must supply `{ name,
version? }` directly; the old shape now fails at compile time and at runtime.

## [0.3.0] - 2026-06-06

### Added — durable step-based workflows

`ctx.step(name, fn)` (the "progressive disclosure" API compiled with
`compileStepWorkflow`) is now genuinely crash-durable. Each step routes through
the same positional replay machinery as `ctx.run`, so a completed step is
replayed from the checkpoint rather than re-executed on recovery. Durability is
positional, so steps must be awaited in order; step workflows require
`workflowExecutionMode: 'inline'` and fail fast with an actionable error under
worker mode.

### Added — Neon/Postgres storage adapter

New `@lostgradient/weft/storage/neon` export with `NeonStorage` and
`resolveStorage({ type: 'neon' })`, backed by the official `@neondatabase/serverless`
driver. The driver is an **optional peer dependency** — it is not installed
automatically; add it to your project (`bun add @neondatabase/serverless`) when
you use `NeonStorage`, and the adapter imports it lazily. Stores opaque bytes
with lexicographic scan ordering and full
`get`/`put`/`delete`/`scan`/`batch`/`conditionalBatch` support. `assertDurableStorageForRecovery()` now accepts `persistence: 'remote'`
for a durable remote store that proves linearizable read-after-write, snapshot
scans, atomic batches, and `conditionalBatch`. Neon integration tests skip
cleanly without `NEON_DATABASE_URL`.

### Added — idempotent starts and atomic `startOrSignal`

`engine.start(..., { idempotencyKey })` now enforces at-most-once creation with
a durable `start-idem:` mapping committed atomically via `conditionalBatch`; `id`
and `idempotencyKey` are mutually exclusive. New `engine.startOrSignal()`
(signal-with-start) creates a workflow and persists a signal atomically when
absent, signals when running, and reports a `Conflict` fault when terminal.
Surfaced through `Engine`, `LocalClient`, `HttpClient`, REST, JSON-RPC, and the
generated operation client. A spent idempotency key whose workflow record is
gone surfaces a conflict rather than starting a replacement.

### Added — RemoteWorker attempt tokens

Each dispatched attempt now carries a unique `attemptToken` that the worker
echoes on completion; the server validates `(operationId, workerId,
attemptToken)` so a stale same-worker completion after reassignment is rejected.
Validation is lenient (an absent echo falls back to the prior workerId-only
check) to keep single-worker deployments from livelocking. No worker protocol
version bump.

### Changed — suspend/resume stabilization

`engine.suspend()` / `engine.resume()` are surfaced through `LocalClient`,
`HttpClient`, REST, and JSON-RPC. Suspend parks before the durable commit;
cancel/fail now transition a suspended workflow to terminal and reject
outstanding `result()` waiters (previously they could hang); the execution
deadline is re-armed on resume; worker-mode suspend loads state before rejecting
the mode.

### Added — singleton second-instance detector

Optional, best-effort startup guard (`detectSecondInstance`, default off) that
warns when a second engine process appears to be running against the same
durable store. Detection is sequence-based (a foreign monotonic heartbeat
sequence advancing across two of our ticks), so it survives skewed or frozen
peer clocks. This is a misconfiguration warning, not fencing — Weft remains one
engine process per durable store. Ships with a singleton-deployment guide.

### Added — history circuit breaker

New `EngineOptions.history: { maxEvents?: number }`. Activation rehydrates a
workflow by replaying its event log, so cost is O(history); an unbounded log
(e.g. a runaway infinite-yield loop) can stall the shared single-process engine
for every workflow. When `maxEvents` is set, a workflow whose durable event-log
record count would exceed it is forced to a terminal `timed-out` state — both on
the per-yield checkpoint write path and before replaying an already-oversized
history at recovery. The terminal state and the emitted `WorkflowTimedOutEvent`
carry a distinct `terminationReason: 'history-circuit-breaker'`
(`HISTORY_CIRCUIT_BREAKER_REASON`) so operators can tell circuit-breaker
termination apart from an ordinary deadline timeout. There are no baked-in
defaults; omit `history` (or set `maxEvents: 0`) to disable. New public exports:
`HistoryPolicy`, `TerminationReason`, `HISTORY_CIRCUIT_BREAKER_REASON`, and
`WorkflowState.terminationReason`.

### Removed — multi-tenancy (BREAKING)

weft is now single-tenant by default. The open-source core exposes generic
prefix-scoping primitives, not tenant policy. All built-in tenancy and per-tenant
quota machinery has been removed. This is a breaking change to the public API,
the wire contract, and the persisted-state shape.

Removed public exports (from `weft`): `tenantFromInputField`, `TenantContext`,
`TenantResolver`, `QuotaExceededError`, `TenantQuotaOptions`, `TenantQuotaUsage`,
`TenantQuotaMetricUsage`, `TenantWorkflowCreationRateLimit`, and
`TenantWorkflowCreationRateUsage`.

Removed engine surface: `EngineOptions.tenantResolver`, `EngineOptions.quotas`,
`engine.getQuotaUsage()`, `ctx.tenant`, and `ctx.state.tenant()`. The
`ctx.state.workflow()` and `engine.state.workflow()` factories no longer take a
tenant id — workflow-type-shared durable state is now namespaced under a constant
default scope. `ListFilter.tenantId` and aggregate `groupBy: 'tenant'` are gone.

Removed server surface: the `GET /v1/tenants/:id/quota` REST route, the
`quota:read` authorization scope, the `RateLimited` fault code (and its HTTP 429
mapping), and the JWT tenant-claim plumbing on the authenticated principal.
Schedule operations no longer accept tenant access options or filter by tenant.

Persisted state: the optional `tenant` field on workflow state and schedule
records is no longer written. The checkpoint schema version is unchanged
(`CURRENT_CHECKPOINT_SCHEMA_VERSION = 2`); a legacy `tenant` field on an older
persisted record is tolerated and dropped on read, so existing workflows and
schedules still decode and resume. State written under a previously configured
tenant partition (`state:workflow:<tenantId>:…`, `state:tenant:<tenantId>:…`) is
intentionally not migrated: migrating legacy partitions to the default scope
requires operator involvement and should be planned as a separate operation.
Workflow-shared state now lives under the `state:workflow-scope:` prefix, which
is deliberately distinct from the legacy `state:workflow:<tenantId>:` layout so a
historical tenant id equal to the default scope cannot alias into the new global
namespace.

Retained: `ScopedStorage` (the generic prefix-namespacing primitive) is
unchanged. Workflow-owned state is still written under a constant default scope
prefix rather than at the storage root, so a future re-partition is a key rename
rather than a data migration.

### Changed — failure category semantics

`FailureCategory` remains part of the public workflow visibility surface, but
its values are now execution-oriented instead of AI-agent-oriented:
`application`, `timeout`, `cancellation`, `resource`, and `system`. Fresh
workflow failures persist only the new values. Stored records with the old
`memory`, `reflection`, `planning`, or `action` categories are normalized on
read (`memory` to `resource`, the others to `application`) so existing workflow
state and legacy search-attribute records still surface through the new public
type.

### Changed — API surface polish

- `ctx.all([...])`, `ctx.race([...])`, and `ctx.runAll({ ... })` now preserve
  per-branch output inference in TypeScript instead of collapsing results to
  `unknown[]`, `unknown`, or `Record<key, unknown>`.
- `ChildWorkflowOptions` is now a closed shape with only the `id` field the
  engine currently reads.
- Standard Schema and Standard JSON Schema helper types moved from the package
  root to `weft/json-schema`.
- OpenTelemetry, trace propagation, metrics, and Prometheus infrastructure
  types moved from the package root to `weft/observability`.

### Renamed (breaking)

- `EngineOptions.workerExecution.concurrency` is now
  `EngineOptions.workerExecution.poolSize`, matching
  `activityExecution.poolSize`.

### Changed — Engine lifecycle and registration ergonomics

`Engine.create()` no longer recovers stored workflows by default. Pass
`recover: true` to run `recoverAll()` after definition registration, or call
`await engine.recoverAll()` explicitly after manual registration. This matches
the constructor path, where recovery has always been an explicit async step.

Activity definitions now register through `engine.register(activityDefinition)`.
The previous `engine.registerActivity()`, `engine.withWorkflow()`, and
`engine.withActivity()` sibling methods were removed so workflow and activity
definitions share one registration surface. Leaked engines now emit a
development warning when garbage collection observes that `[Symbol.dispose]`
was never called.

### Added — workflow visibility surface

`engine.list` and the `weft.workflows.list` operation now accept a richer
filter shape, and a new `engine.aggregate` / `weft.workflows.aggregate`
surface returns single-dimension group-by counts over the same filter.

- **`ListFilter` extensions.** New optional fields: `idPrefix`
  (restricted to `[A-Za-z0-9_-]+`), `createdAt` / `updatedAt` /
  `executionDeadline` time ranges (each accepts `gte`/`gt`/`lte`/`lt`),
  `tenantId` (string or array), and `failureCategory`. The `status`
  filter now also accepts an array of statuses.
- **`WorkflowSummary` extensions.** Three new optional fields are
  populated when present: `tenantId`, `executionDeadline`,
  `failureCategory`.
- **`engine.aggregate(filter, { groupBy, limit? })`** runs a single
  group-by over the visibility surface. `groupBy` is `status`, `type`,
  `tenant`, `failureCategory`, or `{ attribute: <name> }`. Groups are
  sorted `count desc, key asc`; the response carries `truncated: true`
  when more groups existed than `limit` allowed.
- **REST.** `GET /v1/workflows` accepts `?id_prefix`, `?tenant_id`
  (repeating), `?failure_category` (repeating), `?created_at_{gte,gt,lte,lt}`,
  `?updated_at_{...}`, `?execution_deadline_{...}`, and a list of
  `?status` values. `GET /v1/workflows/aggregate` is the new aggregate
  endpoint; `?group_by` accepts `status|type|tenant|failureCategory|attribute:<name>`.
- **JSON-RPC.** `weft.workflows.list` accepts the structured shape on
  every transport. `weft.workflows.aggregate` is new.
- **Errors.** Filter shape violations map to the existing
  `Unprocessable` fault (HTTP 400 / JSON-RPC -32602). New caps:
  `WorkflowListScanCapExceededError` (1,000,000 candidates) and
  `AggregateDistinctKeyCapExceededError` (100,000 distinct keys) both
  surface as `Unprocessable`. The aggregate cap is a hard error, never
  silently truncated, because scan-order would bias which groups win.

### Changed — `engine.list` ordering contract

Previously `engine.list` returned workflows in undocumented
storage-scan order, which depended on backend and on whether a
constrained-id fast path or full scan ran. The contract is now
**`createdAt` descending with `id` ascending as the tiebreaker**,
applied after filter intersection and before pagination. The prior
behavior was unspecified, so this is a tightening of the contract
rather than a break — but worth flagging for any caller that
unintentionally depended on the old order.

### Added — visibility indexes and backfill

A new family of secondary-index keys (`wf-idx-status:`, `wf-idx-type:`,
`wf-idx-tenant:`, `wf-idx-created:`, `wf-idx-updated:`,
`wf-idx-deadline:`, plus a per-workflow `wf-idx-manifest:`) lets
`engine.list` and `engine.aggregate` narrow candidates through indexes
rather than scanning every workflow.

- **Watermark gate.** The engine reads `wf-idx-meta:version` once per
  query and only consults the indexes when the persisted version
  matches `WORKFLOW_VISIBILITY_INDEX_VERSION`. Pre-watermark, queries
  fall back to the existing slow path with post-filtering — correct,
  just slower. `idPrefix` works in both states via a primary-key
  prefix scan.
- **Runtime lifecycle.** Every state-write chokepoint (start, fork,
  resume, update, tag mutation, completion, delayed-start → running,
  purge) keeps the indexes in sync via
  `buildWorkflowVisibilityIndexTransition`, which derives the
  previous-state keys directly from the prior `WorkflowState` so
  there is no extra storage read on the hot path.
- **Backfill.** `scripts/rebuild-workflow-visibility-indexes.ts`
  builds the indexes for an existing database. Conditional-batch
  pre-image guards against racing runtime writes; the watermark
  advances only on a zero-conflict pass. `--drop` removes the
  watermark first, then sweeps every `wf-idx-*` row, then clears the
  cursor — reversing the order would leave a window where the engine
  trusts a watermark for indexes that no longer exist. Storage
  backends without `conditionalBatch` must run the engine offline
  during the backfill.

### Changed — bulk filter scoping

`hasScopedBulkWorkflowFilter` (which gates destructive
`cancelAll` / `deleteAll` / `signalAll` / `mutateTagsAll` bulk
operations) now recognizes two new valid scopes:

- `tenantId` (non-empty after normalization, single or array).
- `idPrefix` (length ≥ 3 — short prefixes match too much to be safe).

`failureCategory` alone is **not** a valid scope: the engine doesn't
enforce the "failureCategory implies failed status" invariant, so
deleting on the attribute alone would be a footgun. Combine it with
`status` for a safe scope. Time ranges (`createdAt`, `updatedAt`,
`executionDeadline`) likewise need a non-temporal scope to qualify.

The error message returned when a bulk filter is too broad now
enumerates the new valid scopes.

### Removed (breaking)

The `suspendOnLlmWait` engine option has been removed from `EngineOptions` (and
therefore from the `new Engine({...})` constructor and `Engine.create({...})`
option bags). It was never functional: passing `true` threw
`'suspendOnLlmWait is not yet implemented'` at construction, and passing `false`
was a no-op. The provider-resume-hint surface it was meant to park work on was
removed in v0.1.0, so there is nothing left for it to gate.

The `weft/server/handler` subpath no longer exports the internal legacy route
precedence helpers `countLiteralSegments`, `countPathParameters`, or
`shouldPreferLegacyRoute`. Direct meta and discovery endpoints are now modeled
as reserved direct HTTP routes instead of legacy fallbacks.

The `weft/storage/compressed` subpath no longer exports
`AgentCompressionOptions`, and `CompressedStorage` no longer accepts
agent-specific compression option names (`agentWorkflowIds`, `agentAlgorithm`,
or `agentThreshold`). Compression now has one storage-level configuration path:
`CompressionOptions`.

### Removed (breaking) — deprecated workflow registration paths

The deprecated registration overloads and module-augmentation types that
bridged callers across the tRPC-style workflow-builder refactor are now
gone. The chained `workflow(options).execute(handler)` form is the only
supported path.

Removed `Engine.register` overloads:

- `engine.register(name: string, handler: WorkflowFunction): void`
- `engine.register(name: string, registration: WorkflowRegistration): void`

`engine.register(activityDefinition)` and
`engine.register(workflowDefinition)` (where `workflowDefinition` is the
result of `workflow({...}).execute(fn)`) remain supported.

Removed `workflow()` overloads:

- `workflow(handler)` (bare-function form)
- The three `workflow({ ..., handler })` options-with-handler forms
- The bare-function form previously inferred a workflow name from the
  passed function's `.name`; the builder form requires an explicit
  `name` in the options object.

Removed types:

- `WorkflowRegistration` (use `BuiltWorkflowDefinition` or the
  builder's return type instead — the builder takes the same fields
  as builder options or chain-method arguments)
- `WorkflowDefinitionOptions`
- `UnknownActivityNameWhenRegistryIsEmpty` (no longer needed; activity
  names are now typed through the builder's `.activities({...})` step)

Removed global module augmentation:

- `interface ActivityTypes` in `weft` (use the per-workflow
  `.activities({...})` chain method to type activity names instead).
  The matching `ctx.run<TName extends keyof ActivityTypes>` overload
  on `WorkflowContext` is also removed.
- `weft codegen` no longer emits an `ActivityTypes` block; activity
  typing now lives on each builder definition. The emitted
  `WorkflowRegistry` block is unchanged.

### Migration — Phase 6C builder cleanup

Replace each call site with the chained builder form:

```ts
// Before — bare async generator
engine.register('greet', async function* (ctx, input) {
  return `hello ${input}`;
});

// After
engine.register(
  workflow({ name: 'greet' }).execute(async function* (ctx, input) {
    return `hello ${input}`;
  }),
);
```

```ts
// Before — object form with metadata
engine.register('checkout', {
  version: '2.0',
  description: 'Runs checkout for an order.',
  tags: ['orders'],
  inputSchema,
  outputSchema,
  searchAttributes: { customerId: { type: 'string' } },
  handler,
});

// After — non-`searchAttributes` fields stay in options; that field
// moves to a chain method.
engine.register(
  workflow({
    name: 'checkout',
    version: '2.0',
    description: 'Runs checkout for an order.',
    tags: ['orders'],
    inputSchema,
    outputSchema,
  })
    .searchAttributes({ customerId: { type: 'string' } })
    .execute(handler),
);
```

```ts
// Before — global ActivityTypes augmentation
declare module 'weft' {
  interface ActivityTypes {
    formatGreeting: { args: [string]; result: string };
  }
}
engine.register('welcome', async function* (ctx, input: string) {
  return yield* ctx.run<'formatGreeting'>('formatGreeting', input);
});

// After — per-workflow activity typing on the builder
const welcome = workflow({ name: 'welcome' })
  .activities({
    formatGreeting: async (name: string) => `Hello, ${name}!`,
  })
  .execute(async function* (ctx, input: string) {
    return yield* ctx.run('formatGreeting', input);
  });
engine.register(welcome);
```

## [0.2.1] - 2026-06-03

### Changed

- Tightened the release-version verification path so `package.json`, the
  exported `VERSION`, and discovery-document defaults stay aligned before
  publishing.
- Folded first real integrator feedback into the package and documentation
  surface.
- Restored deterministic coverage and package validation gates for the release
  line.

### Breaking Changes

No breaking changes were introduced in `0.2.1`.

## [0.1.0] - 2026-05-11

### Removed (breaking)

Weft no longer ships an AI agent surface. All agent loops, declarations, and
coordination primitives now live outside Weft — in an external agent
framework or in your own loop on top of `ctx.run()` and `ctx.review()`.

Removed exports:

- `executeAgentLoop`, `AgentLoopSuspendedError`
- `AgentOptions`, `AgentResult`, `AgentTool`, `PendingProviderResumeState`,
  `PersistedAgentLoopState`, `TurnUsageEntry`, `VerificationRecorder`
- `AgentBureauConversationHistory`, `ChatOptions`, `ChatResponse`,
  `ChatResumeContext`, `ChatResumeHint`, `ConversationHistoryMessage`,
  `LLMProvider`, `NormalizedChatResponse`
- `ToolCall`, `ToolCallInput`, `ToolDefinition`, `ToolDescriptor`,
  `ToolResult`, `ToolResultInput`, `ToolErrorShape`, `ToolActionShape`,
  `ToolErrorCategory`, `TokenUsage`
- `debate`, `handoff`, `supervise`, `createChildHeaders`
- `agent`, `isAgentDefinition`, `AgentDefinition`, `AgentToolDefinition`,
  `ToolIdentityResult`, `AgentRegistrationOptions`
- `AgentTurnStartedEvent`, `AgentTurnCompletedEvent`, `AgentToolCalledEvent`,
  `AgentToolReturnedEvent`, `AgentCheckpointResumedEvent`,
  `AgentCheckpointSizeWarningEvent`, `WeftAgentEventMap`
- `Message`, `MessageRole`, `ConversationHistory`
- `ctx.agent()`, `ctx.handoff()`, `ctx.debate()`, `ctx.supervise()` removed
  from `Context`

### Renamed (breaking)

The following generic primitives were promoted out of `src/ai/` and renamed:

- `ToolEffectLog` → `EffectLog` (class)
- `ToolCallReplayConflictError` → `EffectReplayConflictError`
- `EffectLog` constructor parameter `agentId` → `operationId`
- `EffectRecord.toolName` → `EffectRecord.effectName` (no observed
  persisted-data impact — Phase 0 inventory found zero stored records with
  the field)
- `HumanReviewRequestedEvent` → `ReviewRequestedEvent` (TypeScript symbol only)
- `HumanReviewCompletedEvent` → `ReviewCompletedEvent` (TypeScript symbol only)
- `WeftAgentEventMap` → `WeftReviewEventMap`
- `ctx.humanReview()` → `ctx.review()`
- `HumanReviewOptions.conversation` field removed

### Wire format

Persisted event `type` strings remain unchanged: `'human-review:requested'`
and `'human-review:completed'`. Historical event records replay without
migration.

### Migration

Weft now focuses on durable execution and human-in-the-loop review. If you
were using Weft's agent loop or coordination primitives, migrate to an
external agent framework or build your loop on top of `ctx.run()` and
`ctx.review()`.

---

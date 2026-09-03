/**
 * EngineInternals — the shared mutable state object backing every Engine
 * instance. Engine state lives here, on a WeakMap-backed object reached via
 * `getInternals(this)`, rather than on `#private` class fields.
 *
 * Why a WeakMap instead of `private _field`?  TypeScript's `private` modifier
 * is class-private, not module-private — sibling modules under
 * `src/core/engine/` cannot access an Engine's `private _field` even though
 * they live next to the class. The WeakMap pattern lets every extracted
 * helper read and write the same mutable kernel state via
 * `getInternals(engine)`, which type-checks under `strict: true`.
 *
 * Why not move state into a sub-service object?  Replay determinism depends
 * on call ordering and field-access ordering staying identical to the
 * pre-refactor engine. A single mutable container preserves that; ownership
 * stays in one place.
 *
 * Internal-only.  This module is allow-listed for import only from
 * `src/core/engine/**` (see documentation/internal-imports-allowlist.json).
 */

import type { AlertManager } from '../../alerting/alert-manager.ts';
import type { Storage as WeftStorage } from '../../storage/interface.ts';
import type { ActivityWorkerDispatcher } from '../../workers/activity-worker-dispatcher.ts';
import type { ActivityRegistry } from '../activity-registry.ts';
import type { ContextOperationRequest } from '../context.ts';
import type { EventHeadRecord } from '../event-log.ts';
import type { ExecutionStrategy } from '../execution-strategy.ts';
import type { InlineExecutionStrategy } from '../inline-execution-strategy.ts';
import type {
  ComposedActivityInterceptor,
  ComposedWorkflowInterceptor,
  Interceptor,
} from '../interceptor.ts';
import type { HumanReviewResult, ReviewCoordinator } from '../review/index.ts';
import type { Scheduler } from '../scheduler.ts';
import type { Checkpoint, StartWorkflowOptions } from '../types.ts';
import type { UpdateCoordinator } from '../updates.ts';
import type { WorkflowVersionTuple } from '../workflow-version-tuple.ts';
import type { RecoveredWorkflowInfo } from './lifecycle/shared.ts';

import type { ActivityHeartbeatKey } from './activity-heartbeat-tracking.ts';
import type {
  PendingTimelineEntry,
  QueuedInlineWorkflowExecutionStart,
  RegistrationEntry,
  ResolvedOptions,
  TrackedWaiterKeys,
  WorkflowResultWaiter,
} from './engine-internal-types.ts';
import type { EngineCleanupIntervalDisposalTracker } from './engine-leak-warnings.ts';
import type { WorkflowHandle, WorkflowHandleEngine } from './handles.ts';
import type { WorkflowFeedListener } from './index.ts';
import type { LeaseManager } from './lease-manager.ts';
import type { ScheduleHandleEngine } from './schedule-handle.ts';
import type { SecondInstanceDetector } from './second-instance-detector.ts';
import type { WorkflowClaimMetricsRecorder } from './workflow-claim-metrics.ts';
import type { WorkflowClaimRegistry } from './workflow-claim-registry.ts';
import type { WorkflowClaimRenewalTask } from './workflow-claim-renewal-task.ts';

export type SleepTimerAcknowledgementWaiter = {
  fireAt: number;
  operationId: string;
  reject: (error: Error) => void;
  resolve: () => void;
};

export type DurableInlineOperation = {
  operationId: string;
  scheduledFireAt?: number;
  type: ContextOperationRequest['type'];
};

type EngineRuntime = WorkflowHandleEngine &
  ScheduleHandleEngine & {
    start(type: string, input: unknown, options?: StartWorkflowOptions): Promise<WorkflowHandle>;
  };

// ---------------------------------------------------------------------------
// EngineInternals
// ---------------------------------------------------------------------------

export interface EngineInternals {
  engine: EngineRuntime;
  storage: WeftStorage;
  registrations: Map<string, RegistrationEntry>;
  workflowTypesByHandler: WeakMap<Function, string>;
  abortController: AbortController;
  /**
   * Set to `true` by {@link disposeEngine}. Guards post-dispose entry points
   * (such as `handle.result()`) so they reject with {@link EngineDisposedError}
   * instead of registering a waiter the torn-down engine can never settle.
   */
  disposed: boolean;
  scheduler: Scheduler;
  options: ResolvedOptions;
  strategy: ExecutionStrategy;
  inlineStrategy: InlineExecutionStrategy | null;
  queuedInlineWorkflowStarts: QueuedInlineWorkflowExecutionStart[];
  queuedInlineWorkflowStartIds: Set<string>;
  queuedOrLaunchingInlineWorkflowStartIds: Set<string>;
  queuedInlineWorkflowStartFlushScheduled: boolean;
  queuedInlineWorkflowStartChannel: MessageChannel | null;
  handleCache: Map<string, { ref: WeakRef<WorkflowHandle>; unregisterToken: object }>;
  finalizationRegistry: FinalizationRegistry<string>;
  resultResolvers: Map<string, WorkflowResultWaiter>;
  signalWaiters: Map<string, () => void>;
  signalWaitersByWorkflow: Map<string, TrackedWaiterKeys>;
  /**
   * In-process resolvers for inline `ctx.waitUntil` waits, keyed by `workflowId`
   * ALONE — a workflow has at most one active wait-condition because its inline
   * generator is suspended at exactly one yield, and the top-level-only guard in
   * `executeSubOperation` rejects `waitUntil` as a `race`/`all`/`speculate`
   * branch. So unlike `signalWaiters` (which need a per-workflow string-or-Set
   * index because they CAN be concurrent sub-operations), this is a flat map with
   * no secondary index. Calling the resolver wakes `processWaitConditionOperation`
   * to re-evaluate its predicate. Never checkpointed — engine-memory state cleared
   * on terminal cleanup.
   *
   * Note: the deadline TIMER is still keyed `cond:${workflowId}:${step}` (step is
   * stable across replay, so recovery does not double-arm). Only this waiter map
   * keys by `workflowId`. If `waitUntil`-in-`race`/`all`/`speculate` is ever
   * supported, this keying must revert to `${workflowId}:${step}` + a Set index.
   */
  conditionWaiters: Map<string, () => void>;
  updateWaiters: Map<string, (payload: unknown) => void>;
  updateWaitersByWorkflow: Map<string, TrackedWaiterKeys>;
  /**
   * In-process sleep resolvers keyed by `${workflowId}:${operationId}`. Each
   * carries the run's expected `fireAt` so a fired timer only settles the sleep
   * whose deadline it represents — a stale timer from a terminated run that
   * reused the same deterministic operationId (its durable timer outlives
   * terminal cleanup) is ignored rather than resolving a replacement run early.
   */
  sleepResolvers: Map<string, { resolve: () => void; fireAt: number }>;
  sleepResolversByWorkflow: Map<string, Set<string>>;
  /** Test-only event waiters notified when a workflow registers a sleep resolver. */
  sleepResolverReadyWaitersForTesting?: Map<string, Set<() => void>>;
  /**
   * Fired sleep timers awaiting proof that the awakened inline workflow reached
   * its next durable checkpoint or terminal state. External schedulers must not
   * delete a timer before these waiters settle, or a Service Worker eviction can
   * lose the only durable wake-up between resolver settlement and checkpointing.
   */
  sleepTimerAcknowledgementWaiters: Map<string, Set<SleepTimerAcknowledgementWaiter>>;
  /** Most recently persisted inline operation, used to reject stale sleep-timer callbacks. */
  durableInlineOperations: Map<string, DurableInlineOperation>;
  /**
   * Per-workflow maps of `operationId` → fired timer `fireAt` for sleep timers
   * the scheduler tick fired before the resolver was registered. Keyed by
   * `workflowId` so per-workflow cleanup (`cleanupSleepResolvers`,
   * `evictSleepResolversWithoutResolving`) can call `.delete(workflowId)` and
   * sweep all markers in O(1) — including orphaned ones where the timer fired
   * while the workflow was suspended (no `sleepResolversByWorkflow` entry) or
   * during recovery of an already-elapsed sleep that takes the early-return
   * path. The `fireAt` lets `processSleepOperation` ignore a marker left by a
   * stale earlier-run timer. Cleared entirely at engine disposal.
   */
  sleepTimersFiredWithoutResolver: Map<string, Map<string, number>>;
  interceptors: Interceptor[];
  // `undefined` means "not yet computed". `null` means "computed and empty —
  // no interceptor implements hooks for this side". Distinguishing the two
  // lets `getComposed*Interceptor` cache the empty-slice result instead of
  // re-running `splitInterceptors` on every call when only one side has
  // hooks (e.g. an observability interceptor with workflow hooks but no
  // `execute`).
  composedWorkflowInterceptor: ComposedWorkflowInterceptor | null | undefined;
  composedActivityInterceptor: ComposedActivityInterceptor | null | undefined;
  updateCoordinator: UpdateCoordinator;
  activityRegistry: ActivityRegistry;
  /**
   * Per-workflow activity registries built from
   * `workflow({ name }).activities({ ... }).execute(...)`, indexed by workflow
   * type. Activity lookup is per-activity: it consults the workflow's
   * `activityRegistriesByWorkflow.get(type)` registry first and, for any activity
   * that registry does not contain, falls back to the engine-wide
   * {@link EngineInternals.activityRegistry}. Both sources are first-class — a
   * workflow can resolve some activities from its own `activities(...)` map and
   * others (shared/globally-registered) from the global registry, and a workflow
   * with no per-workflow map resolves entirely from the global one. Each
   * per-workflow registry is a defensive deep clone+freeze of the workflow's
   * `activities` map so post-registration mutation cannot reach the engine.
   */
  activityRegistriesByWorkflow: Map<string, ActivityRegistry>;
  /**
   * Per-workflow definition references — the actual `WorkflowDefinition`
   * object passed to `engine.register(workflow)`. Used for collision detection
   * (same-reference re-register is idempotent; same-name-different-object
   * throws) and as the canonical record of `BuiltWorkflowDefinition`s for
   * worker-protocol qualified-name dispatch in Phase 4.
   */
  workflowDefinitionsByName: Map<string, object>;
  /**
   * In-memory cache of `workflowId -> workflowType` populated when a workflow
   * starts executing (see lifecycle/start-exec.ts) and cleared on terminal
   * cleanup. Lets the activity-dispatch hot path resolve the correct
   * per-workflow registry synchronously without re-reading storage.
   */
  workflowTypeByWorkflowId: Map<string, string>;
  activityWorkerDispatcher: ActivityWorkerDispatcher | null;
  checkpoints: Map<string, Checkpoint>;
  broadcastChannel: BroadcastChannel | null;
  pendingNestingDepth: number | undefined;
  pendingParentHeaders: Map<string, string> | undefined;
  pendingExecutionStateOwnerId: string | null | undefined;
  pendingParentWorkflowId: string | undefined;
  pendingParentWorkflowExecutionToken: string | undefined;
  workflowNestingDepths: Map<string, number>;
  workflowHeaders: Map<string, Map<string, string>>;
  workflowStateWriteChains: Map<string, Promise<void>>;
  scheduleStateOperationChains: Map<string, Promise<void>>;
  heartbeatDetails: Map<string, unknown>;
  /**
   * Last heartbeat payload PER ACTIVITY STEP, so a retry of a step can read the
   * heartbeat its previous attempt recorded (the resumable-batch pattern). Keyed
   * `workflowId -> step -> details`. This is separate from {@link heartbeatDetails}
   * (which is keyed by `workflowId` alone and powers the `activityProgress` query):
   * concurrent activities inside one `ctx.all` would clobber a workflow-keyed map,
   * so a retry could read a sibling's heartbeat. The step is stable across attempts
   * (assigned once at `stepIndex++`), so a retry reads its OWN prior heartbeat.
   * Never checkpointed — held only in engine memory and cleared (by workflowId, the
   * outer key) on terminal cleanup and purge, the same lifecycle as
   * {@link heartbeatDetails}. Inline-execution only; worker-executed activities run
   * their function out of process and never observe this.
   */
  lastHeartbeatDetailsByStep: Map<string, Map<ActivityHeartbeatKey, unknown>>;
  /**
   * Per-run, non-serialized `services` value exposed to the workflow body as
   * `ctx.services`. Set at `engine.start({ services })` and re-provided on
   * recovery by `resolveWorkflowServices`. Never checkpointed — held only in
   * engine memory, keyed by workflowId, and cleared on terminal cleanup (the
   * same lifecycle as {@link heartbeatDetails}).
   */
  workflowServices: Map<string, unknown>;
  /**
   * Activities that called `ctx.completeAsync()` and are awaiting out-of-band
   * completion via `engine.completeAsyncActivity` / `failAsyncActivity`, keyed
   * by their durable task token. Mirrored to storage (`KEYS.asyncActivity`) and
   * reloaded by `recoverAll()`. See `async-activity-completion.ts`.
   */
  pendingAsyncActivities: Map<string, import('./async-activity-records.ts').PendingAsyncActivity>;
  /**
   * Completed or failed async-activity tokens that were consumed before inline
   * recovery adopted the workflow generator. Replay drains these by workflow id
   * when it reaches the same deterministic async-activity token again.
   */
  pendingAsyncActivityResolutions: Map<
    string,
    import('./async-activity-records.ts').PendingAsyncActivityResolution[]
  >;
  pendingStarts: Set<string>;
  pendingScheduleCreations: Set<string>;
  workflowsNeedingTerminalCleanup: Set<string>;
  cleanupInterval: ReturnType<typeof setInterval> | null;
  cleanupIntervalDisposalTracker: EngineCleanupIntervalDisposalTracker | null;
  retentionSweepInterval: ReturnType<typeof setInterval> | null;
  retentionSweepInFlight: Promise<void> | null;
  nextRetentionSweepAt: number | null;
  /** Interval driving the best-effort second-instance detector; `null` when off. */
  secondInstanceDetectionInterval: ReturnType<typeof setInterval> | null;
  /** The active second-instance detector; `null` when detection is disabled. */
  secondInstanceDetector: SecondInstanceDetector | null;
  /**
   * The active lease manager for `ownership: 'lease'`; `null` when ownership is
   * `'none'`. Acquired before recovery, renewed on a heartbeat, released on
   * dispose. Unlike the second-instance detector its acquire/renew errors are real
   * (a failed acquire blocks recovery). Renewal loss is surfaced as a warning in
   * Step 1; epoch fencing of durable writes (Step 2) is what makes it enforceable.
   */
  leaseManager: LeaseManager | null;
  /**
   * The active per-workflow claim registry for `ownership: 'workflow-lease'`;
   * `null` under `'none'`/`'lease'` and, for now, ALSO under `'workflow-lease'`
   * itself — wiring construction (Gate 1/Gate 2, actually instantiating the
   * registry, and folding `acquire()` into start/resume/delayed-start-fire) is a
   * later stage. Its presence here lets {@link commitFencedEngineWrite} read
   * {@link WorkflowClaimRegistry.currentEpochBytes} for a workflow-scoped write
   * without that later stage having to touch the fencing path again. Until it is
   * populated, every workflow-scoped write under `'workflow-lease'` fails closed
   * with {@link EngineDeposedError} — correct, not a bug: this engine holds no
   * claim for any workflow yet.
   */
  workflowClaimRegistry: WorkflowClaimRegistry | null;
  /**
   * The active per-workflow claim-renewal task for `ownership: 'workflow-lease'`;
   * `null` under `'none'`/`'lease'` and until `#bootstrapOwnershipIfConfigured`
   * completes. Renews every claim this engine holds (active or parked) on its
   * own cadence — independent of the durable-timer scheduler, so `startScheduler:
   * false` still renews claims — or via `runMaintenance()` under
   * `backgroundTasks: 'manual'`, which never starts its interval. Stopped
   * (interval cleared, never awaited — stopping is synchronous) and detached at
   * every `disposeEngine` call site; releasing the claims it was renewing is the
   * separate, best-effort `workflowClaimRegistry.releaseAll()` step each
   * disposal path drives on its own schedule.
   */
  workflowClaimRenewalTask: WorkflowClaimRenewalTask | null;
  /**
   * Bounded-cardinality observability recorder for the `ownership:
   * 'workflow-lease'` claim protocol (ADR 0002 § Observability); `null` under
   * `'none'`/`'lease'` and until `#bootstrapOwnershipIfConfigured` completes.
   * One instance per engine process, shared by this engine's claim-renewal task
   * (which feeds it renewal-failure counts and the active-claim gauge after
   * every pass) and, in a later stage, its claim-acquiring entry points (start,
   * resume, delayed-start fire), which would record `acquired`/`takeover`/
   * `lost_race`/`deposed`/`backoff_skipped` attempts into the same instance.
   */
  workflowClaimMetrics: WorkflowClaimMetricsRecorder | null;
  /**
   * The in-flight lease acquisition, or `null` when none is running. Set while
   * `#acquireLeaseIfConfigured` awaits `acquire()` (which can park for the whole
   * `leaseWaitTimeout` waiting for a handoff) and cleared when it settles. Disposal
   * awaits this so a dispose that races a parked acquire is a clean handoff — the
   * holder this engine may take is released before `asyncDispose` resolves, rather
   * than leaking until TTL on an already-disposed engine.
   */
  inFlightLeaseAcquire: Promise<void> | null;
  /**
   * The in-flight `ownership: 'workflow-lease'` bootstrap (Gate 1, Gate 2, and
   * claim-registry/renewal-task construction), or `null` when none is running.
   * Mirrors {@link inFlightLeaseAcquire}'s idempotency shape: concurrent
   * `Engine.create` + `recoverAll` (and repeated `recoverAll`/`runMaintenance`)
   * callers await this same promise rather than racing the gates twice. Always
   * `null` under `ownership: 'none'`/`'lease'`, which never run this bootstrap.
   */
  inFlightOwnershipBootstrap: Promise<void> | null;
  /**
   * Set to `true` the instant this engine is detected as deposed under
   * `ownership: 'lease'` — either a fenced durable write's CAS failed against a
   * newer epoch ({@link commitFencedEngineWrite}) or the lease manager reported
   * `onLeaseLost('deposed')`. It is the synchronous half of the deposition halt:
   * {@link commitFencedEngineWrite} short-circuits at its top on this flag, so a
   * write that *starts* after detection is rejected before reaching storage,
   * while writes already in flight are caught by the epoch CAS itself. Set once
   * by {@link handleDeposition}, which also warns the operator and schedules a
   * deferred engine teardown. Always `false` under `ownership: 'none'`.
   */
  deposed: boolean;
  /**
   * Teardown callback invoked (deferred to a later tick) when this engine is
   * deposed. Set once during engine construction to the engine's own
   * `disposeAfterDeposition` method. It exists as an injected field rather than a
   * direct import so {@link handleDeposition} (reached from the durable-write
   * helper) does not statically import `disposal.ts`, which would close an import
   * cycle (`storage-io → fenced-write → lease-deposition → disposal → … →
   * storage-io`). `null` until the constructor wires it.
   */
  tearDownAfterDeposition: (() => void) | null;
  reviewCoordinator: ReviewCoordinator;
  reviewWaiters: Map<string, (decision: HumanReviewResult) => void>;
  reviewWaitersByWorkflow: Map<string, TrackedWaiterKeys>;
  reviewEscalationHandlers: Map<
    string,
    (entry: { id: string; workflowId: string }) => Promise<boolean>
  >;
  workflowReviewIds: Map<string, Set<string>>;
  parkedInlineWorkflows: Set<string>;
  terminalizingWorkflows: Set<string>;
  /**
   * Coordinated update IDs already claimed for delivery by a pending-update
   * drain, keyed by workflow. Several drain triggers (each `update()` schedules a
   * `setTimeout(0)` drain; the post-advance path drains too) can fire
   * near-simultaneously, and the durable consume-delete (`buildResponseOperations`
   * deletes the pending key via async `storage.batch`) lags the in-memory
   * `getPendingUpdates` scan — so overlapping drains would re-read and re-deliver
   * the same buffered update. Each drain claims an update's id SYNCHRONOUSLY (no
   * `await` between the membership check and the add) before delivering it, so a
   * racing drain that scans the same id skips it. The claim persists across
   * drains (unlike a per-drain guard), which is what makes delivery idempotent
   * against the cross-drain race. Cleared per workflow on terminal cleanup; empty
   * after a crash, which matches durable state (recovery re-delivers exactly the
   * updates whose delete never committed).
   */
  deliveredPendingUpdateIds: Map<string, Set<string>>;
  /**
   * The most recent `recoverAll({ onRecoveredWorkflow })` hook installed by
   * this host, retained so a LATER same-engine reclaim (ADR 0002's recurring
   * scan, after `recover: false` skipped this workflow entirely at startup
   * because another engine held it then) still runs it before resuming.
   * Without this, `index.ts`'s `onWorkflowClaimReclaimed` callback would pass
   * `undefined` for every reclaim-driven resume, silently skipping whatever
   * host initialization/validation the hook contract guarantees runs before
   * recovered execution. `undefined` until `recoverAll()` is ever called with
   * this option.
   */
  onRecoveredWorkflowHook: ((info: RecoveredWorkflowInfo) => void | Promise<void>) | undefined;
  cancelHandlersByWorkflow: Map<string, Array<() => Promise<void> | void>>;
  reviewTimerIds: Map<string, string[]>;
  pendingWebhooks: Set<AbortController>;
  /**
   * Every `setTimeout` handle `scheduleCrossEngineResultPollIfPending`
   * (`handle-result.ts`) currently has pending, so disposal can cancel them.
   * Without this, disposing an automatic-mode engine while a cross-engine
   * result waiter is parked rejects and clears the waiter but leaves this
   * untracked timer alive — the timer queue retains the waiter, engine
   * internals, and storage reference until `workflowClaimRenewIntervalMs`
   * elapses, and its callback then calls `bootstrapWorkflowResultResolver`
   * against already-disposed storage.
   */
  pendingResultPollTimers: Set<ReturnType<typeof setTimeout>>;
  alertManager: AlertManager | null;
  eventLogHeads: Map<string, Readonly<EventHeadRecord>>;
  workflowFeedListeners: Map<string, Set<WorkflowFeedListener>>;
  workflowVersionTuples: Map<string, WorkflowVersionTuple>;
  /**
   * Cached visibility-index watermark for query planning. `undefined` means the
   * watermark has not been read yet or an in-process caller invalidated it.
   * `workflowVisibilityWatermarkExpiresAt` bounds how long external maintenance
   * commands can leave this process planning against a stale watermark.
   */
  workflowVisibilityWatermark: 'current' | 'stale' | undefined;
  workflowVisibilityWatermarkExpiresAt: number | undefined;
  pendingTimelineEntries: Map<string, PendingTimelineEntry>;
  pendingAtomicWorkflowCommitSideEffects: Map<
    string,
    import('./checkpoint-side-effects.ts').AtomicWorkflowCommitSideEffects
  >;
  /**
   * The durable workflow catalog (WFT-9/WFT-10), `null` until
   * {@link import('./catalog-readiness.ts').ensureWorkflowCatalogReady} first
   * restores it from storage. Read via {@link getWorkflowCatalog}, never
   * directly.
   */
  workflowCatalog: import('../catalog/index.ts').WorkflowCatalog | null;
  /**
   * Workflow names `commitWorkflowDefinition` (`registration.ts`) has queued
   * for catalog install+activate since the last drain. `engine.register()`
   * stays synchronous — it cannot itself build a manifest (that requires
   * `crypto.subtle`) — so it defers the actual durable install/activation to
   * the next `ensureWorkflowCatalogReady` call instead.
   */
  pendingCatalogInstalls: string[];
  /** Whether {@link workflowCatalog} has been restored from storage at least once. */
  catalogRestored: boolean;
  /**
   * The in-flight catalog restore-and-drain, or `null` when none is
   * running. Concurrent `ensureWorkflowCatalogReady` callers await this same
   * promise rather than racing a second restore/drain.
   */
  catalogDrainPromise: Promise<void> | null;
  /** Name -> revision this process's own register()-drain most recently activated (WFT-12, `catalog-readiness.ts`). Process-local, never persisted. */
  registeredCatalogRevisions: Map<string, string>;
  /** Name -> revision -> in-flight `startWorkflow` count (WFT-12, `lifecycle/start.ts`). Process-local, never persisted. */
  inFlightStartsByRevision: Map<string, Map<string, number>>;
}

const INTERNALS = new WeakMap<object, EngineInternals>();

/**
 * Set up an empty `EngineInternals` skeleton in the WeakMap. The Engine
 * constructor calls this immediately after `super()`, before any field
 * write, so subsequent `getInternals(this).fieldName = expr` assignments
 * succeed.
 *
 * The constructor body then runs the same field-initialization expressions
 * the original `engine.ts` had — preserving the original ordering, which
 * is load-bearing for replay determinism.
 */
export function initializeInternals(engine: EngineRuntime): void {
  const internals = { engine } as EngineInternals;
  INTERNALS.set(engine, internals);
}

/**
 * Look up the `EngineInternals` object for an Engine instance. Throws when
 * `initializeInternals(engine)` has not been called yet — this only happens
 * if a method runs before/around `super()` finishes (e.g. an event listener
 * fires from the EventTarget super class). All Engine methods rely on
 * internals existing.
 */
export function getInternals(engine: object): EngineInternals {
  const internals = INTERNALS.get(engine);
  if (!internals) {
    throw new Error(
      'Engine internals not initialized — initializeInternals(this) was not called in the Engine constructor',
    );
  }
  return internals;
}

/**
 * Read an engine's durable workflow catalog. Throws when it has not been
 * restored yet — every public entry point that can observe catalog state
 * (`start`, `startOrSignal`, `schedule`/`pauseSchedule`/`resumeSchedule`/
 * `cancelSchedule`/`updateSchedule`, `fork`, `resume`, `recoverAll`,
 * `Engine.create`, and `buildRegistrySnapshot`) awaits
 * `ensureWorkflowCatalogReady(engine)` first, which restores it. Calling
 * this before that await boundary — for example from a pathological
 * direct-internals test — is a programming error, not a recoverable runtime
 * condition, so it fails loud rather than returning a placeholder catalog.
 */
export function getWorkflowCatalog(engine: object): import('../catalog/index.ts').WorkflowCatalog {
  const internals = getInternals(engine);
  if (internals.workflowCatalog === null) {
    throw new Error(
      'Workflow catalog not restored — ensureWorkflowCatalogReady(engine) was not awaited before ' +
        'getWorkflowCatalog(engine) was called.',
    );
  }
  return internals.workflowCatalog;
}

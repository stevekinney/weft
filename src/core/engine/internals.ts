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
  sleepResolvers: Map<string, () => void>;
  sleepResolversByWorkflow: Map<string, Set<string>>;
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
  workflowNestingDepths: Map<string, number>;
  workflowHeaders: Map<string, Map<string, string>>;
  workflowStateWriteChains: Map<string, Promise<void>>;
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
  lastHeartbeatDetailsByStep: Map<string, Map<number, unknown>>;
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
  pendingAsyncActivities: Map<
    string,
    import('./async-activity-completion.ts').PendingAsyncActivity
  >;
  /**
   * Completed or failed async-activity tokens that were consumed before inline
   * recovery adopted the workflow generator. Replay drains these by workflow id
   * when it reaches the same deterministic async-activity token again.
   */
  pendingAsyncActivityResolutions: Map<
    string,
    import('./async-activity-completion.ts').PendingAsyncActivityResolution[]
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
  cancelHandlersByWorkflow: Map<string, Array<() => Promise<void> | void>>;
  reviewTimerIds: Map<string, string[]>;
  pendingWebhooks: Set<AbortController>;
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

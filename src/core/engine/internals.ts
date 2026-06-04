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
import type { Checkpoint } from '../types.ts';
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
import type { ScheduleHandleEngine, WorkflowHandle, WorkflowHandleEngine } from './handles.ts';
import type { WorkflowFeedListener } from './index.ts';

type EngineRuntime = WorkflowHandleEngine & ScheduleHandleEngine;

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
   * `workflow({ name }).activities({ ... }).execute(...)`. Indexed by workflow
   * type. Phase 3 wires lookups via `activityRegistriesByWorkflow.get(type)`
   * first, falling back to {@link EngineInternals.activityRegistry} so the
   * legacy global path keeps working until Phase 6 removes it. Each registry
   * is constructed from a defensive deep clone+freeze of the workflow's
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
  pendingExecutionStateOwnerId: string | undefined;
  workflowNestingDepths: Map<string, number>;
  workflowHeaders: Map<string, Map<string, string>>;
  workflowStateWriteChains: Map<string, Promise<void>>;
  heartbeatDetails: Map<string, unknown>;
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
  pendingStarts: Set<string>;
  pendingScheduleCreations: Set<string>;
  workflowsNeedingTerminalCleanup: Set<string>;
  cleanupInterval: ReturnType<typeof setInterval> | null;
  cleanupIntervalDisposalTracker: {
    disposed: boolean;
    cleanupInterval: ReturnType<typeof setInterval> | null;
  } | null;
  retentionSweepInterval: ReturnType<typeof setInterval> | null;
  retentionSweepInFlight: Promise<void> | null;
  nextRetentionSweepAt: number | null;
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
  cancelHandlersByWorkflow: Map<string, Array<() => Promise<void> | void>>;
  reviewTimerIds: Map<string, string[]>;
  pendingWebhooks: Set<AbortController>;
  alertManager: AlertManager | null;
  eventLogHeads: Map<string, Readonly<EventHeadRecord>>;
  workflowFeedListeners: Map<string, Set<WorkflowFeedListener>>;
  workflowVersionTuples: Map<string, WorkflowVersionTuple>;
  pendingTimelineEntries: Map<string, PendingTimelineEntry>;
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

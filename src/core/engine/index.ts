/* oxlint-disable max-lines -- Engine's public overload signatures (~191 lines: register/start/signal/update/query, the five bulk dry-run-vs-commit methods, schedule, and static create) plus member JSDoc (~130 lines) ARE the published declaration surface, gated byte-for-byte by verify:jsdoc:declarations and the scoped Engine class-block .d.ts oracle; the irreducible declaration floor alone (>=531 lines, counted with skipBlankLines:false skipComments:false) exceeds the 500 ceiling before any method body is counted. The aggressive class split was attempted (task 3765ffa6, documentation/engine-split-log/PR-33.md): a class-expression mixin regresses the emitted .d.ts (Engine extends a synthetic any-typed Engine_base intersection; schedule methods leave the Engine block), and a verbatim class move only relocates this suppression because max-lines is repo-wide; rejected. All extractable bodies live in ~90 sibling modules under src/core/engine/. */
import { AlertManager } from '../../alerting/alert-manager.ts';
import type { AlertStateSnapshot } from '../../alerting/types.ts';
import {
  KEYS,
  requireStorageCapability,
  type Storage as WeftStorage,
} from '../../storage/interface.ts';
import {
  ActivityRegistry,
  type ActivityMetadata,
  type ActivityRegistrationOptions,
  type RegisteredActivityFunction,
} from '../activity-registry.ts';
import { AtomicState, type AtomicStateOptions } from '../atomic-state.ts';
import { deserializeCheckpoint } from '../checkpoint.ts';
import type { StoredStreamChunk } from '../context.ts';
import { createHandleCacheFinalizer } from '../engine-helpers.ts';
import type { TypedEventTarget, WeftEventMap } from '../events.ts';
import type { Interceptor } from '../interceptor.ts';
import { ReviewCoordinator, type ReviewRequest } from '../review/index.ts';
import { Scheduler } from '../scheduler.ts';
import {
  messageName,
  type AnyActivityDefinition,
  type AnyWorkflowDefinition,
  type AttributeFilterKey,
  type BulkCancelResult,
  type BulkDeleteResult,
  type BulkOperationCommitOptions,
  type BulkOperationDryRunOptions,
  type BulkOperationDryRunResult,
  type BulkRetryFailedResult,
  type BulkSignalAllCommitOptions,
  type BulkSignalAllDryRunOptions,
  type BulkSignalResult,
  type BulkTagResult,
  type CheckpointState,
  type CheckpointSummary,
  type CoordinatedUpdateResult,
  type DefaultActivityTypes,
  type DefaultWorkflowRegistry,
  type ForkOptions,
  type InferActivityEntries,
  type InferActivityEntry,
  type InferWorkflowEntries,
  type InferWorkflowEntry,
  type ListFilter,
  type ListOptions,
  type MessageName,
  type PaginatedResult,
  type PendingAsyncActivityListOptions,
  type PendingAsyncActivityPage,
  type PurgeResult,
  type QueryDefinition,
  type RegisteredWorkflowDefinition,
  type RetentionOverview,
  type ReviewListEntry,
  type ReviewListFilter,
  type ScheduleDefinition,
  type ScheduleFilter,
  type ScheduleOptions,
  type ScheduleSpec,
  type ScheduleSummary,
  type ScheduleUpdateOptions,
  type SearchAttributeValue,
  type SignalDefinition,
  type SignalDeliveryOptions,
  type StartOrSignalOptions,
  type StartOrSignalSignal,
  type StartWorkflowOptions,
  type SubmitReviewOptions,
  type TypedListFilter,
  type UpdateDefinition,
  type WorkerOutboundMessage,
  type WorkflowEvent,
  type WorkflowFinalizerStatus,
  type WorkflowInput,
  type WorkflowOutput,
  type WorkflowReplay,
  type WorkflowScheduleProvenance,
  type WorkflowServices,
  type WorkflowServicesUnion,
  type WorkflowState,
  type WorkflowSummary,
  type WorkflowTimelineEntry,
} from '../types.ts';
import type { TimerEntry } from '../types/checkpoint.ts';
import type { WorkflowAlreadyRegistered } from '../types/workflow-builder.ts';
import { UpdateCoordinator } from '../updates.ts';
import {
  aggregate as aggregateWorkflows,
  type AggregateOptions,
  type AggregateResult,
} from './aggregate.ts';
import {
  completeAsyncActivity as completeAsyncActivityFromInternals,
  failAsyncActivity as failAsyncActivityFromInternals,
} from './async-activity-completion.ts';
import {
  listPendingAsyncActivities as listPendingAsyncActivitiesFromInternals,
  recoverPendingAsyncActivities,
} from './async-activity-records.ts';
import { broadcast as broadcastFromInternals, type BroadcastCallbacks } from './broadcast.ts';
import {
  cancelAll as cancelAllWorkflows,
  deleteAll as deleteAllWorkflows,
  purge as purgeWorkflows,
  retryFailedAll as retryFailedAllWorkflows,
  signalAll as signalAllWorkflows,
  tagAll as tagAllWorkflows,
  untagAll as untagAllWorkflows,
} from './bulk-operations.ts';
import { createTimeOperationCallbacks as createTimeOperationCallbacksForEngine } from './callback-creators-bundles.ts';
import {
  createBroadcastCallbacks as createBroadcastCallbacksForEngine,
  createInlineParkingCallbacks as createInlineParkingCallbacksForEngine,
  createLifecycleCallbacks as createLifecycleCallbacksForEngine,
  createRegistrationCallbacks as createRegistrationCallbacksForEngine,
  createTerminationCallbacks as createTerminationCallbacksForEngine,
  createUpdateCallbacks as createUpdateCallbacksForEngine,
} from './callback-creators.ts';
import { registerCancelHandler } from './cancel-handlers.ts';
import {
  getCheckpointAt as getCheckpointStateAt,
  getEvents as getWorkflowEvents,
  getTimeline as getWorkflowTimeline,
  listCheckpoints as listCheckpointHistory,
  replayTo as replayWorkflowToCheckpoint,
} from './checkpoint-reads.ts';
import {
  copyWorkflowDefinition,
  createActivityWorkerDispatcher,
  createExecutionStrategyBundle,
  definitionEntries,
  resolveEngineInterceptors,
  resolveEngineOptions,
  resolveEngineStorage,
  typedEngineView,
  type EmptyActivityDefinitions,
  type EmptyWorkflowDefinitions,
  type EngineCreateRuntimeOptions,
  type KnownWorkflowNames,
} from './construction.ts';
import { disposeEngine } from './disposal.ts';
import {
  type ActivityDefinitionName,
  type EngineCreateOptions,
  type EngineCreateWorkflowRegistry,
  type RegisteredActivityDefinitionExecute,
  type UnknownWorkflowNameWhenDefaultRegistryIsEmpty,
} from './engine-create-types.ts';
import type { EngineConstructorOptions } from './engine-internal-types.ts';
import {
  consumeNextEngineLeakWarningTokenForTesting,
  engineCleanupIntervalFinalizer,
  type EngineCleanupIntervalDisposalTracker,
} from './engine-leak-warnings.ts';
import {
  createCleanupIntervalTick,
  createQueuedInlineWorkflowStartHandler,
  createSecondInstanceDetectorResolver,
  drainQueuedInlineWorkflowStartsForEngine,
  isActivityDefinition,
  shouldStartEngineScheduler,
  validateEngineCreateBackgroundTaskOptions,
} from './engine-runtime-helpers.ts';
import type { EngineStateNamespace } from './engine-state-namespace.ts';
import {
  EngineCreateNameMismatchError,
  EngineDisposalError,
  EngineDisposedError,
  StartOrSignalConflictError,
} from './errors.ts';
import { assertLeaseHeldForEngineWork, commitFencedEngineWrite } from './fenced-write.ts';
import { recordFinalizerState } from './finalizer-state.ts';
import { getFinalizerStatus as getFinalizerStatusFromInternals } from './finalizer-status.ts';
import {
  createWorkflowHandleWithResultPromise as createWorkflowHandleWithResultPromiseFromInternals,
  getWorkflowResultPromise as getWorkflowResultPromiseFromInternals,
} from './handle-result.ts';
import { HANDLE_RESULT_PROMISE, WorkflowHandle } from './handles.ts';
import { hasQueuedInlineWorkflowStart } from './inline-launch-queue.ts';
import {
  handleStrategyMessage as handleStrategyMessageFromInternals,
  resumeParkedInlineWorkflow as resumeParkedInlineWorkflowFromInternals,
  type InlineParkingCallbacks,
} from './inline-parking.ts';
import { getInternals, initializeInternals, type EngineInternals } from './internals.ts';
import { ENGINE_LEASE_LOST_WARNING_NAME, handleDeposition } from './lease-deposition.ts';
import type { EngineLeaseHealth, LeaseLostReason } from './lease-health.ts';
import { createLeaseManager } from './lease-manager.ts';
import {
  fork as forkFromLifecycle,
  recoverAll as recoverAllFromLifecycle,
  resume as resumeFromLifecycle,
  startOrSignal as startOrSignalFromLifecycle,
  startWithIdempotency as startWithIdempotencyFromLifecycle,
  startWorkflow as startWorkflowFromLifecycle,
  type LifecycleCallbacks,
  type RecoverAllOptions,
  type StartOrSignalCallbacks,
  type StartOrSignalResult,
} from './lifecycle.ts';
import {
  addTags as addWorkflowTags,
  getAttributes as getWorkflowAttributes,
  list as listWorkflows,
  removeTags as removeWorkflowTags,
  setAttributes as setWorkflowAttributes,
} from './listing.ts';
import { getOffloadFromInternals } from './operations-data.ts';
import { getStreamChunksFromInternals } from './operations-stream.ts';
import {
  handleTimerFired as handleTimerFiredFromInternals,
  type TimeOperationCallbacks,
} from './operations-time.ts';
import { assertCompatiblePersistedDataVersion } from './persisted-data-version.ts';
import { query as queryWorkflow } from './queries.ts';
import {
  register as registerWorkflow,
  resolveWorkflowTypeTarget as resolveWorkflowTypeTargetFromRegistration,
  type RegistrationCallbacks,
} from './registration.ts';
import {
  ensureRetentionSweepInterval,
  getRetentionOverview as getRetentionOverviewSnapshot,
  hasConfiguredRetention,
  resolveWorkflowTypeRetention,
  runRetentionSweep,
  setNextRetentionSweepAt,
} from './retention.ts';
import {
  getReview as getReviewFromInternals,
  listReviews as listReviewsFromInternals,
  submitReview as submitReviewFromInternals,
} from './reviews.ts';
import { ScheduleHandle } from './schedule-handle.ts';
import { decodeScheduleRunMetadata } from './schedule-run-metadata.ts';
import {
  cancelSchedule as cancelScheduleFromInternals,
  listSchedules as listSchedulesFromInternals,
  pauseSchedule as pauseScheduleFromInternals,
  recoverOrphanedScheduleTimers,
  resumeSchedule as resumeScheduleFromInternals,
  schedule as scheduleFromInternals,
  toScheduleSummary,
  updateSchedule as updateScheduleFromInternals,
} from './schedules.ts';
import {
  createSecondInstanceDetectionTick,
  createSecondInstanceDetector,
} from './second-instance-detector.ts';
import { signal as signalWorkflow } from './signals.ts';
import {
  loadScheduleState,
  loadWorkflowState,
  runSerializedWorkflowStateWrite,
} from './storage-io.ts';
import {
  feedOperationResult,
  getComposedWorkflowInterceptor,
  swallowPromiseRejection,
} from './strategy-helpers.ts';
import {
  cancelWorkflow as cancelWorkflowFromTermination,
  cleanupWaiters as cleanupWaitersFromTermination,
  finalizePendingTimelineEntry,
  suspendWorkflow as suspendWorkflowFromTermination,
  timeoutWorkflow as timeoutWorkflowFromTermination,
  type TerminationCallbacks,
} from './termination.ts';
import {
  getUpdateResult as getUpdateResultFromInternals,
  submitCoordinatedUpdate as submitCoordinatedUpdateFromInternals,
  update as updateFromInternals,
  type UpdateCallbacks,
} from './updates.ts';
import { isTerminalWorkflowStatus } from './validation.ts';
import { coerceScheduleId } from './validation/schedule.ts';
import {
  replayWorkflowFeed,
  snapshotWorkflowFeedTail,
  subscribeWorkflowFeedCommits,
  type WorkflowFeedListener,
  type WorkflowFeedRecord,
  type WorkflowFeedSelector,
} from './workflow-feed.ts';

export {
  ActivityReconciliationCapabilityError,
  ActivityReconciliationConflictError,
  ActivityReconciliationIndeterminateError,
} from './activity-reconciliation.ts';
export { AsyncActivityTokenNotFoundError } from './async-activity-completion.ts';
export type { PendingAsyncActivity } from './async-activity-records.ts';
export type {
  PendingTimelineEntry,
  RegistrationEntry,
  ResolvedOptions,
  TrackedWaiterKeys,
  WorkflowResultWaiter,
} from './engine-internal-types.ts';
export {
  ActivityResolutionError,
  BulkDeleteRequiresTerminalWorkflowsError,
  BulkOperationConfirmationError,
  EngineCreateNameMismatchError,
  EngineDisposalError,
  EngineDisposedError,
  IdempotencyKeyPurgedError,
  PersistedDataIncompatibleError,
  StartOrSignalConflictError,
  WorkflowAlreadyExistsError,
  WorkflowConcurrencyLimitExceededError,
  WorkflowNotFoundError,
  WorkflowNotRegisteredError,
  WorkflowSuspendNotSupportedError,
  WorkflowTeardownPendingError,
  WorkflowTypeNotRegisteredForRecoveryError,
} from './errors.ts';
export { HANDLE_RESULT_PROMISE, WorkflowHandle } from './handles.ts';
export {
  EngineLeaseAcquisitionTimeoutError,
  EngineLeaseCorruptedError,
  EngineLeaseNotHeldError,
} from './lease-errors.ts';
export type { EngineLeaseHealth, LeaseLostReason } from './lease-health.ts';
export type { RecoverAllOptions, RecoveredWorkflowInfo } from './lifecycle.ts';
export { ScheduleHandle } from './schedule-handle.ts';
export type {
  WorkflowFeedListener,
  WorkflowFeedRecord,
  WorkflowFeedSelector,
} from './workflow-feed.ts';

// Public type definitions and runtime helpers used by the Engine class were
// extracted to sibling modules to keep this file under the lint threshold.
// They are re-exported here to preserve the public API surface.
export type { EngineCreateOptions } from './engine-create-types.ts';
export {
  clearEngineLeakWarningTokenForTesting,
  getEngineLeakCollectionCountForTesting,
  hasEngineLeakWarningTokenForTesting,
  setEngineLeakWarningOverrideForTesting,
  setNextEngineLeakWarningTokenForTesting,
  shouldEmitEngineLeakWarningForTesting,
} from './engine-leak-warnings.ts';
export type { EngineStateNamespace } from './engine-state-namespace.ts';
export { assertCompatiblePersistedDataVersion };

export const ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING = Symbol(
  'engineParkedWorkflowCountForTesting',
);
export const ENGINE_SIGNAL_WAITER_COUNT_FOR_TESTING = Symbol('engineSignalWaiterCountForTesting');
export const ENGINE_SLEEP_RESOLVER_COUNT_FOR_TESTING = Symbol('engineSleepResolverCountForTesting');
export const ENGINE_WAIT_FOR_SLEEP_RESOLVER_FOR_TESTING = Symbol(
  'engineWaitForSleepResolverForTesting',
);
export const ENGINE_SET_WORKER_TURN_TIMEOUT_RESOLVER_FOR_TESTING = Symbol(
  'engineSetWorkerTurnTimeoutResolverForTesting',
);

/**
 * The `name` of the `process` warning emitted when a lease-owning engine is
 * disposed through the synchronous `[Symbol.dispose]()` path. Sync disposal can
 * only fire the lease release in the background; use `await engine.shutdown()`,
 * `await using`, or `await engine[Symbol.asyncDispose]()` when prompt rolling
 * deploy handoff matters.
 *
 * @example
 * ```ts
 * import { ENGINE_LEASE_SYNCHRONOUS_DISPOSE_WARNING_NAME } from '@lostgradient/weft';
 *
 * process.on('warning', (warning) => {
 *   if (warning.name === ENGINE_LEASE_SYNCHRONOUS_DISPOSE_WARNING_NAME) {
 *     // Alert on shutdown paths that can make lease handoff wait for leaseTtl.
 *   }
 * });
 * ```
 */
export const ENGINE_LEASE_SYNCHRONOUS_DISPOSE_WARNING_NAME =
  'WeftEngineLeaseSynchronousDisposeWarning';

export { ENGINE_LEASE_LOST_WARNING_NAME };

function scheduleDefinitionFromInternals(
  internals: EngineInternals,
  definition: ScheduleDefinition,
): Promise<ScheduleHandle> {
  const workflowType =
    typeof definition.workflow === 'string' ? definition.workflow : definition.workflow.name;
  const definitionSpec: ScheduleSpec =
    definition.every !== undefined ? { every: definition.every } : { cron: definition.cron ?? '' };
  return scheduleFromInternals(internals, workflowType, definition.input, definitionSpec, {
    ...(definition.id !== undefined && { id: definition.id }),
    ...(definition.description !== undefined && { description: definition.description }),
    ...(definition.overlapPolicy !== undefined && { overlap: definition.overlapPolicy }),
    ...(definition.backfill !== undefined && { backfill: definition.backfill }),
    ...(definition.jitter !== undefined && { jitter: definition.jitter }),
  });
}

/**
 * Durable execution engine.
 *
 * Register workflow and activity definitions with {@link Engine.register},
 * start workflows with {@link Engine.start},
 * and observe or cancel them via the returned {@link WorkflowHandle}. Each
 * workflow is a generator that yields to a {@link Context}; the engine
 * persists a checkpoint at every yield so the workflow survives crashes,
 * restarts, and worker reassignment without losing progress.
 *
 * The default type parameters preserve the module-augmentation registry
 * model. Use `new Engine<{}, {}>()` when you want an engine-local registry
 * that only accepts definitions added through `register`.
 *
 * @example Run a workflow with an activity
 * ```ts
 * import { workflow, activity, Engine, type Context, type WorkflowContext } from '@lostgradient/weft';
 * const fetchUser = activity({
 *   name: 'fetchUser',
 *   execute: async (input: unknown) => ({ name: 'Alice' }),
 * });
 * const engine = new Engine();
 * engine.register(
 *   workflow({ name: 'greet' }).execute(async function* (ctx: WorkflowContext, input: unknown) {
 *     const user = yield* ctx.run(fetchUser, input);
 *     return `Hello, ${user.name}`;
 *   }),
 * );
 * const handle = await engine.start('greet', 'user-1');
 * void handle;
 * ```
 *
 * @example With a SQLite backend
 * ```ts
 * import { Engine } from '@lostgradient/weft';
 * import { BunSQLiteStorage } from '@lostgradient/weft/storage/sqlite/bun';
 * await using storage = new BunSQLiteStorage('./weft.db');
 * await using engine = new Engine({ storage });
 * await engine.recoverAll();
 * void engine;
 * ```
 */
export class Engine<
  TWorkflows extends object = DefaultWorkflowRegistry,
  TActivities extends object = DefaultActivityTypes,
>
  extends EventTarget
  implements Disposable, AsyncDisposable, TypedEventTarget<WeftEventMap>
{
  #asyncDisposeResult: Promise<boolean> | null = null;
  #shutdownResult: Promise<boolean> | null = null;
  #synchronousDisposeResult: Promise<boolean> | null = null;

  /**
   * Construct and register an engine in one step. Activities are registered
   * before workflows. Recovery runs by default after all definitions are
   * installed; pass `recover: false` to opt out.
   *
   * @example
   * ```ts
   * import { activity, Engine, workflow } from '@lostgradient/weft';
   *
   * const greet = activity({ name: 'greet', execute: async (name: string) => `Hi ${name}` });
   * const welcome = workflow({ name: 'welcome' }).execute(async function* (ctx, input: string) {
   *   return yield* ctx.run(greet, input);
   * });
   *
   * const engine = await Engine.create({
   *   activities: { greet },
   *   workflows: { welcome },
   * });
   * void engine;
   * ```
   */
  static create(
    options: EngineCreateOptions<EmptyWorkflowDefinitions, EmptyActivityDefinitions> & {
      activities?: undefined;
      workflows?: undefined;
    },
  ): Promise<Engine>;
  static create<TWorkflowDefinitions extends Record<string, AnyWorkflowDefinition>>(
    options: EngineCreateOptions<TWorkflowDefinitions, EmptyActivityDefinitions> & {
      activities?: undefined;
      workflows: TWorkflowDefinitions;
    },
  ): Promise<Engine<EngineCreateWorkflowRegistry<TWorkflowDefinitions>>>;
  static create<TActivityDefinitions extends Record<string, AnyActivityDefinition>>(
    options: EngineCreateOptions<EmptyWorkflowDefinitions, TActivityDefinitions> & {
      activities: TActivityDefinitions;
      workflows?: undefined;
    },
  ): Promise<Engine<DefaultWorkflowRegistry, InferActivityEntries<TActivityDefinitions>>>;
  static create<
    TWorkflowDefinitions extends Record<string, AnyWorkflowDefinition>,
    TActivityDefinitions extends Record<string, AnyActivityDefinition>,
  >(
    options: EngineCreateOptions<TWorkflowDefinitions, TActivityDefinitions> & {
      activities: TActivityDefinitions;
      workflows: TWorkflowDefinitions;
    },
  ): Promise<
    Engine<
      EngineCreateWorkflowRegistry<TWorkflowDefinitions>,
      InferActivityEntries<TActivityDefinitions>
    >
  >;
  static async create(options: EngineCreateRuntimeOptions): Promise<unknown> {
    validateEngineCreateBackgroundTaskOptions(options);
    const engine = new Engine<object, object>(options);

    try {
      await assertCompatiblePersistedDataVersion(getInternals(engine).storage);
      for (const [name, definition] of definitionEntries(options.activities)) {
        if (name !== definition.name) {
          throw new EngineCreateNameMismatchError('activity', name, definition.name);
        }
        engine.#registerActivityDefinition(definition);
      }

      for (const [name, definition] of definitionEntries(options.workflows)) {
        if (name !== definition.name) {
          throw new EngineCreateNameMismatchError('workflow', name, definition.name);
        }
        engine.register(definition);
      }

      // Acquire single-writer ownership BEFORE recovery so a rolling deploy is a
      // clean handoff: the incoming instance parks here until the outgoing one
      // releases (or its lease expires), and only then recovers. On the try's
      // failure path the asyncDispose below releases the lease. Throws
      // EngineLeaseAcquisitionTimeoutError if the lease cannot be acquired in time.
      await engine.#acquireLeaseIfConfigured();

      if (options.recover !== false) {
        await engine.recoverAll(
          options.acknowledgeUnknownWorkflowTypes !== undefined
            ? { acknowledgeUnknownWorkflowTypes: options.acknowledgeUnknownWorkflowTypes }
            : {},
        );
      }
      // Start polling so durable timers fire for long-lived in-process engines
      // (#586, #590). This is independent of `recover`: the flag controls who
      // drives `recoverAll`, not whether timers should fire. Defaults to
      // `recover !== false`, so the existing behavior is preserved — but a
      // `recover: false` host that owns its own recovery can arm the poller with
      // `startScheduler: true`, and tests / `ScopedStorage` engines that tick the
      // scheduler deterministically can keep it stopped with `startScheduler: false`.
      const shouldStartScheduler = shouldStartEngineScheduler(
        options,
        getInternals(engine).options.backgroundTaskMode,
      );
      if (shouldStartScheduler) {
        getInternals(engine).scheduler.start();
      }
    } catch (error) {
      // Constructor side effects (broadcast channel, scheduler, dispatchers,
      // alert manager) are alive even when registration or recovery fails.
      // Dispose before propagating so callers don't have to recover from a
      // half-booted engine they never received a reference to.
      await engine[Symbol.asyncDispose]();
      throw error;
    }

    return engine;
  }

  constructor(options?: EngineConstructorOptions<WorkflowServicesUnion<TWorkflows>>) {
    super();
    initializeInternals(this);
    getInternals(this).registrations = new Map();
    getInternals(this).workflowTypesByHandler = new WeakMap();
    const storage = resolveEngineStorage(options);
    const getNow = options?.getNow ?? Date.now;
    const resolvedOptions = resolveEngineOptions(storage, options, getNow);
    const strategyBundle = createExecutionStrategyBundle({
      options,
      getNow,
      maxNestingDepth: resolvedOptions.maxNestingDepth,
      development: resolvedOptions.development,
      broadcastEvents: resolvedOptions.broadcastEvents,
      getRegistration: getInternals(this).registrations.get.bind(getInternals(this).registrations),
      getComposedWorkflowInterceptor: () => getComposedWorkflowInterceptor(getInternals(this)),
      resolveWorkflowType: this.#resolveWorkflowTypeTarget.bind(this),
      registerCancelHandler: (workflowId, handler) =>
        registerCancelHandler(getInternals(this), workflowId, handler),
      recordFinalizerState: (workflowId, value) =>
        recordFinalizerState(getInternals(this), workflowId, value),
      getWorkflowServices: (workflowId) => getInternals(this).workflowServices.get(workflowId),
      // Capture the resolved-options local, not `getInternals(this).options` (assigned
      // later in this constructor): the worker path resolves the sink eagerly during
      // bundle construction, before that field is set. `onLog` has no setter, so the
      // captured value never goes stale; it is the same object stored on internals. (#529)
      getLogSink: () => resolvedOptions.onLog ?? undefined,
    });
    getInternals(this).storage = storage;
    getInternals(this).abortController = new AbortController();
    getInternals(this).disposed = false;
    getInternals(this).handleCache = new Map();
    getInternals(this).resultResolvers = new Map();
    getInternals(this).signalWaiters = new Map();
    getInternals(this).signalWaitersByWorkflow = new Map();
    getInternals(this).conditionWaiters = new Map();
    getInternals(this).updateWaiters = new Map();
    getInternals(this).updateWaitersByWorkflow = new Map();
    getInternals(this).sleepResolvers = new Map();
    getInternals(this).sleepResolversByWorkflow = new Map();
    getInternals(this).sleepResolverReadyWaitersForTesting = new Map();
    getInternals(this).sleepTimerAcknowledgementWaiters = new Map();
    getInternals(this).durableInlineOperations = new Map();
    getInternals(this).sleepTimersFiredWithoutResolver = new Map();
    getInternals(this).interceptors = resolveEngineInterceptors(options);
    getInternals(this).composedWorkflowInterceptor = undefined;
    getInternals(this).composedActivityInterceptor = undefined;
    getInternals(this).updateCoordinator = new UpdateCoordinator(storage);
    getInternals(this).activityRegistry = new ActivityRegistry();
    getInternals(this).activityRegistriesByWorkflow = new Map();
    getInternals(this).workflowDefinitionsByName = new Map();
    getInternals(this).workflowTypeByWorkflowId = new Map();
    getInternals(this).activityWorkerDispatcher = null;
    getInternals(this).checkpoints = new Map();
    getInternals(this).broadcastChannel = null;
    getInternals(this).pendingNestingDepth = undefined;
    getInternals(this).pendingParentHeaders = undefined;
    getInternals(this).pendingExecutionStateOwnerId = undefined;
    getInternals(this).pendingParentWorkflowId = undefined;
    getInternals(this).pendingParentWorkflowExecutionToken = undefined;
    getInternals(this).workflowNestingDepths = new Map();
    getInternals(this).workflowHeaders = new Map();
    getInternals(this).workflowStateWriteChains = new Map();
    getInternals(this).scheduleStateOperationChains = new Map();
    getInternals(this).finalizationRegistry = new FinalizationRegistry<string>(
      createHandleCacheFinalizer(getInternals(this).handleCache),
    );
    getInternals(this).options = resolvedOptions;
    getInternals(this).scheduler = new Scheduler({
      storage,
      onTimerFired: (entry) =>
        handleTimerFiredFromInternals(
          getInternals(this),
          entry,
          this.#createTimeOperationCallbacks(),
        ),
      pollIntervalMs: resolvedOptions.schedulerPollIntervalMs,
      getNow,
      // Fence the fired-timer delete on the lease epoch (#563) so a deposed
      // engine cannot drop a timer while its callback's fenced reschedule/clear
      // was rejected. Empty base conditions: the only guard is the epoch fence,
      // so under single-engine ownership this commits like the unfenced default.
      commitTimerCleanup: (operations) =>
        commitFencedEngineWrite(
          getInternals(this),
          operations,
          [],
          () => new Error('Timer cleanup lost its fenced CAS race'),
        ),
    });
    getInternals(this).strategy = strategyBundle.strategy;
    getInternals(this).inlineStrategy = strategyBundle.inlineStrategy;
    getInternals(this).queuedInlineWorkflowStarts = [];
    getInternals(this).queuedInlineWorkflowStartIds = new Set();
    getInternals(this).queuedOrLaunchingInlineWorkflowStartIds = new Set();
    getInternals(this).queuedInlineWorkflowStartFlushScheduled = false;
    const weakEngine = new WeakRef(this);
    const queuedInlineWorkflowStartChannel =
      strategyBundle.inlineStrategy !== null ? new MessageChannel() : null;
    getInternals(this).queuedInlineWorkflowStartChannel = queuedInlineWorkflowStartChannel;
    if (queuedInlineWorkflowStartChannel !== null) {
      queuedInlineWorkflowStartChannel.port1.onmessage = createQueuedInlineWorkflowStartHandler(
        weakEngine,
        queuedInlineWorkflowStartChannel,
      );
    }
    getInternals(this).heartbeatDetails = new Map();
    getInternals(this).lastHeartbeatDetailsByStep = new Map();
    getInternals(this).workflowServices = new Map();
    getInternals(this).pendingAsyncActivities = new Map();
    getInternals(this).pendingAsyncActivityResolutions = new Map();
    getInternals(this).pendingStarts = new Set();
    getInternals(this).pendingScheduleCreations = new Set();
    getInternals(this).workflowsNeedingTerminalCleanup = new Set();
    getInternals(this).reviewCoordinator = new ReviewCoordinator(storage, getNow);
    getInternals(this).reviewWaiters = new Map();
    getInternals(this).reviewWaitersByWorkflow = new Map();
    getInternals(this).reviewEscalationHandlers = new Map();
    getInternals(this).workflowReviewIds = new Map();
    getInternals(this).parkedInlineWorkflows = new Set();
    getInternals(this).terminalizingWorkflows = new Set();
    getInternals(this).deliveredPendingUpdateIds = new Map();
    getInternals(this).cancelHandlersByWorkflow = new Map();
    getInternals(this).reviewTimerIds = new Map();
    getInternals(this).pendingWebhooks = new Set();
    getInternals(this).pendingTimelineEntries = new Map();
    getInternals(this).pendingAtomicWorkflowCommitSideEffects = new Map();
    getInternals(this).cleanupIntervalDisposalTracker = null;
    const cleanupIntervalDisposalTracker: EngineCleanupIntervalDisposalTracker = {
      disposed: false,
      cleanupInterval: null,
      secondInstanceDetectionInterval: null,
      testToken: consumeNextEngineLeakWarningTokenForTesting(),
    };
    const cleanupInterval =
      resolvedOptions.backgroundTaskMode === 'automatic'
        ? setInterval(createCleanupIntervalTick(weakEngine, cleanupIntervalDisposalTracker), 60_000)
        : null;
    cleanupIntervalDisposalTracker.cleanupInterval = cleanupInterval;
    getInternals(this).cleanupInterval = cleanupInterval;
    getInternals(this).cleanupIntervalDisposalTracker = cleanupIntervalDisposalTracker;
    engineCleanupIntervalFinalizer.register(
      this,
      cleanupIntervalDisposalTracker,
      cleanupIntervalDisposalTracker,
    );
    getInternals(this).retentionSweepInterval = null;
    getInternals(this).retentionSweepInFlight = null;
    getInternals(this).nextRetentionSweepAt = null;
    getInternals(this).secondInstanceDetectionInterval = null;
    getInternals(this).secondInstanceDetector = null;
    getInternals(this).leaseManager = null;
    getInternals(this).inFlightLeaseAcquire = null;
    getInternals(this).deposed = false;
    getInternals(this).tearDownAfterDeposition = (): void => {
      this.#disposeAfterDeposition();
    };
    getInternals(this).eventLogHeads = new Map();
    getInternals(this).workflowFeedListeners = new Map();
    getInternals(this).workflowVersionTuples = new Map();
    getInternals(this).workflowVisibilityWatermark = undefined;
    getInternals(this).workflowVisibilityWatermarkExpiresAt = undefined;
    getInternals(this).activityWorkerDispatcher = createActivityWorkerDispatcher(
      options?.activityExecution,
    );
    getInternals(this).strategy.onMessage(this.#handleStrategyMessage.bind(this));
    getInternals(this).alertManager = options?.alerts
      ? new AlertManager(
          this,
          options.alerts,
          getNow,
          resolvedOptions.backgroundTaskMode === 'automatic',
        )
      : null;
    this.#ensureRetentionSweepInterval();
    this.#startSecondInstanceDetection();
  }

  override addEventListener<K extends Extract<keyof WeftEventMap, string>>(
    type: K,
    listener: (event: WeftEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    super.addEventListener(type, listener, options);
  }

  override removeEventListener<K extends Extract<keyof WeftEventMap, string>>(
    type: K,
    listener: (event: WeftEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ): void;
  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void;
  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    super.removeEventListener(type, listener, options);
  }

  /**
   * Start the best-effort second-instance liveness detector when enabled. The
   * engine owns the interval so disposal clears it through the same path as the
   * other engine intervals (no leak warning). A `WeakRef` keeps the interval from
   * pinning the engine alive past garbage collection. On a GC-without-dispose the
   * interval is cleared two ways: the tick self-clears on its first post-GC fire
   * (prompt, via the tracker handle) and the shared finalizer clears it on
   * collection (backstop). Mirrors the cleanup-interval lifecycle exactly.
   */
  /**
   * Acquire the ownership lease when `ownership: 'lease'` is configured, then start
   * renewing it. No-op for the default `'none'` posture. Requires the storage
   * `conditionalBatch` capability (every durable recovery backend provides it);
   * fails fast with a clear diagnostic otherwise. Called by {@link Engine.create}
   * before recovery; the lease is released on dispose.
   *
   * In Step 1, losing the lease while running emits a process warning — the lease
   * is deploy ergonomics, not yet a correctness backstop (epoch fencing of durable
   * writes is the follow-on that makes loss enforceable).
   */
  async #acquireLeaseIfConfigured(): Promise<void> {
    const internals = getInternals(this);
    if (internals.options.ownershipMode !== 'lease') return;
    // Never start (or report success for) an acquire on a disposed engine: that is
    // the contract `recoverAll` relies on — `await` resolves ONLY when the lease is
    // actually held right now, otherwise it throws.
    if (internals.disposed) throw new EngineDisposedError();
    // Idempotent across the concurrent `Engine.create` + `recoverAll` (and repeated
    // `recoverAll`) callers. The genuine "lease held" signal is the in-flight
    // acquisition promise, NOT `leaseManager` (which is published before `acquire()`
    // resolves so disposal can reach `stop()`). A second caller that observes only
    // `leaseManager` set could proceed into recovery before the lease is truly held —
    // so when an acquire is in flight, await IT, then return. Once it has settled and
    // the manager is live, the lease is held and we can short-circuit.
    if (internals.inFlightLeaseAcquire !== null) {
      await internals.inFlightLeaseAcquire;
      return;
    }
    if (internals.leaseManager !== null) return;
    requireStorageCapability(internals.storage, 'conditionalBatch', "ownership: 'lease'");
    const manager = createLeaseManager({
      storage: internals.storage,
      holderId: crypto.randomUUID(),
      getNow: internals.options.getNow,
      ttlMs: internals.options.leaseTtlMs,
      renewIntervalMs: internals.options.leaseRenewIntervalMs,
      waitTimeoutMs: internals.options.leaseWaitTimeoutMs,
      onLeaseLost: (reason: LeaseLostReason) => {
        if (reason === 'deposed') {
          // A successor stole the lease out from under an otherwise-idle engine.
          // Step 2 halts: set the deposed flag, warn, and tear down so the engine
          // stops promptly instead of lingering until its next fenced write fails.
          handleDeposition(internals);
          return;
        }
        // 'renewal-unconfirmable': a transient storage error left the holder
        // unable to prove it still holds. This is NOT a confirmed deposition —
        // halting on a momentary storage blip would be a self-inflicted outage —
        // so warn only. If the holder really was deposed, the next fenced write
        // (or a later renewal) detects it and halts then.
        process.emitWarning(
          'engine ownership lease renewal could not be confirmed (transient storage error); ' +
            'another instance may take over if this persists. Weft supports one engine process ' +
            'per store — keep infrastructure-level single-instance enforcement in place.',
          ENGINE_LEASE_LOST_WARNING_NAME,
        );
      },
    });
    // Assign the manager BEFORE awaiting acquire(), so a concurrent disposal that
    // races a parked acquire can still see it: disposeEngine() stops the manager,
    // and the parked acquire's wait loop exits on its `stopped` check. The lease
    // lifecycle is a small state machine; each transition is handled explicitly:
    //
    //   uninitialized → acquiring : assign manager, set inFlightLeaseAcquire
    //   acquiring (acquire throws) : null the manager → a later recoverAll() retries
    //                               (not stuck on the idempotency guard)
    //   acquiring → disposed       : release the holder we may have just taken and
    //                               do NOT startRenewal on a dead engine
    //   acquiring → acquired       : startRenewal
    //
    // Disposal awaits `inFlightLeaseAcquire` so an acquire that commits a holder in
    // the same tick disposal runs is released before asyncDispose resolves (clean
    // handoff), rather than leaking a holder + heartbeat until TTL.
    internals.leaseManager = manager;
    const acquisition = (async () => {
      try {
        await manager.acquire();
      } catch (error) {
        // Nothing durable was taken (acquire is commit-or-throw). Detach so the
        // idempotency guard does not skip a later retry.
        if (internals.leaseManager === manager) internals.leaseManager = null;
        throw error;
      }
      if (internals.disposed) {
        // Disposal raced this parked acquire. We may have just committed a holder;
        // release it, stay detached, and THROW — never renew on a disposed engine,
        // and never let the caller (recoverAll / Engine.create) treat this as a
        // held lease and proceed into recovery. The throw is the contract: `await`
        // resolves only when the lease is genuinely held.
        const releaseResult = manager.release();
        this.#synchronousDisposeResult = releaseResult;
        await releaseResult;
        if (internals.leaseManager === manager) internals.leaseManager = null;
        throw new EngineDisposedError();
      }
      manager.startRenewal();
    })();
    internals.inFlightLeaseAcquire = acquisition;
    try {
      await acquisition;
    } finally {
      if (internals.inFlightLeaseAcquire === acquisition) {
        internals.inFlightLeaseAcquire = null;
      }
    }
  }

  /**
   * Tear down this engine after it has been deposed (a fenced durable write lost
   * its CAS to a newer lease epoch, or the lease manager reported a confirmed
   * `'deposed'` loss). Wired onto `internals.tearDownAfterDeposition` at
   * construction and invoked deferred (a tick after detection) by
   * {@link handleDeposition}, never inline — inline teardown would clear maps a
   * mid-advance generator still reads. Captures the lease manager before
   * `disposeEngine` detaches it, then best-effort releases the holder; the release
   * CAS-fails (the successor owns the holder now) and is a no-op that cannot
   * clobber the new owner. Skipped if the engine is already disposed, so a
   * deposition that races a normal dispose does not double-tear-down. The release
   * rejection is swallowed — best-effort teardown must not leak an unhandled
   * rejection while the engine is already unwinding.
   */
  #disposeAfterDeposition(): void {
    const internals = getInternals(this);
    if (internals.disposed) return;
    const leaseManager = internals.leaseManager;
    disposeEngine(internals);
    if (this.#synchronousDisposeResult === null) {
      this.#synchronousDisposeResult = (leaseManager?.release() ?? Promise.resolve(true)).catch(
        () => false,
      );
    }
    void this.#synchronousDisposeResult;
  }

  #startSecondInstanceDetection(): void {
    const internals = getInternals(this);
    if (!internals.options.secondInstanceDetectionEnabled) return;
    const detector = createSecondInstanceDetector({
      storage: internals.storage,
      instanceId: crypto.randomUUID(),
      getNow: internals.options.getNow,
      intervalMs: internals.options.secondInstanceHeartbeatIntervalMs,
    });
    internals.secondInstanceDetector = detector;
    const tracker = internals.cleanupIntervalDisposalTracker;
    // The tracker is constructed unconditionally just before this method runs, so
    // it is always present here; guard defensively rather than assert.
    if (tracker === null) return;
    const weakEngine = new WeakRef(this);
    const detectionInterval = setInterval(
      createSecondInstanceDetectionTick(createSecondInstanceDetectorResolver(weakEngine), tracker),
      internals.options.secondInstanceHeartbeatIntervalMs,
    );
    internals.secondInstanceDetectionInterval = detectionInterval;
    // Track the interval on the cleanup disposal tracker so BOTH cleanup paths
    // clear it: the tick self-clears via this handle on the first post-GC fire
    // (prompt), and the shared engine finalizer clears it on collection (backstop,
    // since FinalizationRegistry callbacks are not guaranteed to run promptly).
    tracker.secondInstanceDetectionInterval = detectionInterval;
  }

  #hasConfiguredRetention(): boolean {
    return hasConfiguredRetention(getInternals(this));
  }
  #setNextRetentionSweepAt(): void {
    setNextRetentionSweepAt(getInternals(this));
  }
  #ensureRetentionSweepInterval(): void {
    ensureRetentionSweepInterval(getInternals(this), {
      hasConfiguredRetention: () => this.#hasConfiguredRetention(),
      runRetentionSweep: () => this.#runRetentionSweep(),
      setNextRetentionSweepAt: () => this.#setNextRetentionSweepAt(),
    });
  }
  async #runRetentionSweep(): Promise<void> {
    return runRetentionSweep(
      getInternals(this),
      (source, error) => this.#createTerminationCallbacks().handleCleanupError(source, error),
      (workflowId) =>
        cleanupWaitersFromTermination(
          getInternals(this),
          workflowId,
          this.#createTerminationCallbacks(),
        ),
    );
  }
  #createLifecycleCallbacks(): LifecycleCallbacks {
    return createLifecycleCallbacksForEngine(this);
  }
  #createTerminationCallbacks(): TerminationCallbacks {
    return createTerminationCallbacksForEngine(this);
  }
  #createRegistrationCallbacks(): RegistrationCallbacks {
    return createRegistrationCallbacksForEngine(this);
  }
  #createBroadcastCallbacks(): BroadcastCallbacks {
    return createBroadcastCallbacksForEngine(this);
  }
  #createInlineParkingCallbacks(): InlineParkingCallbacks {
    return createInlineParkingCallbacksForEngine(this);
  }
  #createUpdateCallbacks(): UpdateCallbacks {
    return createUpdateCallbacksForEngine(this);
  }
  #createTimeOperationCallbacks(): TimeOperationCallbacks {
    return createTimeOperationCallbacksForEngine(this);
  }
  #resolveWorkflowTypeTarget(target: string | Function): string {
    return resolveWorkflowTypeTargetFromRegistration(
      getInternals(this),
      target,
      this.#createRegistrationCallbacks(),
    );
  }
  get state(): EngineStateNamespace {
    const storage = getInternals(this).storage;
    return {
      execution: <T>(
        ownerWorkflowId: string,
        key: string,
        options?: AtomicStateOptions<T>,
      ): AtomicState<T> =>
        new AtomicState<T>(storage, KEYS.stateExecution(ownerWorkflowId, key), options),
      workflow: <T>(
        workflowType: string,
        key: string,
        options?: AtomicStateOptions<T>,
      ): AtomicState<T> =>
        new AtomicState<T>(storage, KEYS.stateWorkflow(workflowType, key), options),
    };
  }

  /** Return detached snapshots of the alert rules that are currently firing. */
  getActiveAlerts(): readonly AlertStateSnapshot[] {
    return getInternals(this).alertManager?.activeStates ?? [];
  }

  async #handleStrategyMessage(message: WorkerOutboundMessage): Promise<void> {
    return handleStrategyMessageFromInternals(
      getInternals(this),
      message,
      this.#createInlineParkingCallbacks(),
    );
  }
  #broadcast(message: Record<string, unknown>): void {
    return broadcastFromInternals(getInternals(this), message, this.#createBroadcastCallbacks());
  }

  /**
   * Register a workflow by name or definition, or register an activity
   * definition. Definition overloads return this same engine with the
   * definition added to its phantom type registry. This is additive over the
   * module-augmented default registry; construct `new Engine<{}, {}>()` for a
   * strict local registry.
   *
   * @example
   * ```ts
   * import { Engine, workflow, type WorkflowContext } from '@lostgradient/weft';
   *
   * const engine = new Engine();
   * engine.register(
   *   workflow({ name: 'hello' }).execute(async function* (_ctx: WorkflowContext, name: string) {
   *     return `Hello, ${name}`;
   *   }),
   * );
   * ```
   */
  /**
   * Builder-workflow registration with a parameter-position name-conflict
   * guard. New names widen the engine's typed workflow registry; re-registering
   * a name already present intersects the parameter type with
   * {@link WorkflowAlreadyRegistered} — a branded marker no real
   * `WorkflowDefinition` satisfies — so the call line itself fails to compile.
   *
   * Runtime is more lenient: registering the same `WorkflowDefinition` object
   * reference again is idempotent (no-op); same-name-different-object throws.
   * TypeScript cannot distinguish the two at the type level. Callers needing
   * the runtime-idempotent path from TypeScript must use a documented escape
   * hatch (e.g. `engine.register(welcome as never)`).
   */
  // Workflow-definition overload — single overload combining the
  // name-conflict guard and the additive case. Splitting the guard onto a
  // separate overload would let the unguarded fallback absorb conflict calls
  // (TS overload resolution picks the next overload when an earlier one's
  // parameter is unsatisfiable). The conditional intersection on the
  // parameter keeps the call line itself failing to compile when the name is
  // already registered.
  register<TDefinition extends AnyWorkflowDefinition>(
    workflow: TDefinition &
      (TDefinition['name'] extends keyof TWorkflows
        ? WorkflowAlreadyRegistered<TDefinition['name']>
        : unknown),
  ): Engine<TWorkflows & InferWorkflowEntry<TDefinition>, TActivities>;
  register<
    TDefinition extends AnyActivityDefinition,
    TName extends Extract<keyof TActivities, string> & ActivityDefinitionName<TDefinition>,
  >(
    definition: TDefinition & {
      readonly name: TName;
      readonly execute: RegisteredActivityDefinitionExecute<TActivities, TName>;
    },
  ): Engine<TWorkflows, TActivities & InferActivityEntry<TDefinition>>;
  register<TDefinition extends AnyActivityDefinition>(
    definition: ActivityDefinitionName<TDefinition> extends Extract<keyof TActivities, string>
      ? never
      : TDefinition,
  ): Engine<TWorkflows, TActivities & InferActivityEntry<TDefinition>>;
  register(definition: unknown): unknown {
    if (isActivityDefinition(definition)) {
      this.#registerActivityDefinition(definition);
      return typedEngineView<TWorkflows, TActivities>(this);
    }

    registerWorkflow(getInternals(this), definition, this.#createRegistrationCallbacks());
    return typedEngineView<TWorkflows, TActivities>(this);
  }
  /**
   * Register every workflow from an object map at once and return a typed
   * engine view that exposes the newly added workflow names.
   *
   * Mirrors `Engine.create({ workflows })` for post-construction use. The map
   * key is canonical: if a value's runtime `name` disagrees with its key, the
   * call throws {@link EngineCreateNameMismatchError} before any partial
   * registration completes (insertion order — earlier entries persist).
   *
   * @example
   * ```ts
   * import { Engine, workflow } from '@lostgradient/weft';
   *
   * const welcome = workflow({ name: 'welcome' })
   *   .execute(async function* (_ctx, name: string) {
   *     return `Hello, ${name}`;
   *   });
   *
   * const engine = new Engine();
   * const typedEngine = engine.registerWorkflows({ welcome });
   * await typedEngine.start('welcome', 'Ada');
   * ```
   */
  registerWorkflows<TWorkflowDefinitions extends Record<string, AnyWorkflowDefinition>>(
    workflows: TWorkflowDefinitions,
  ): Engine<TWorkflows & InferWorkflowEntries<TWorkflowDefinitions>, TActivities> {
    for (const [name, definition] of Object.entries(workflows)) {
      if (name !== definition.name) {
        throw new EngineCreateNameMismatchError('workflow', name, definition.name);
      }
      // Cast through `never` to bypass the parameter-position collision guard.
      // `registerWorkflows` is the documented opt-in for batch registration
      // and validates key=name above; the runtime collision rule still
      // applies and throws same-name-different-ref. The brand only protects
      // call-site typos in user code, not the engine's own batch helper.
      (this.register as (workflow: AnyWorkflowDefinition) => unknown)(definition);
    }
    return typedEngineView<TWorkflows & InferWorkflowEntries<TWorkflowDefinitions>, TActivities>(
      this,
    );
  }

  addInterceptor(interceptor: Interceptor): void {
    getInternals(this).interceptors.push(interceptor);
    // Adding ANY interceptor invalidates BOTH composed caches because the
    // unified list feeds both pipelines. Use `undefined` to mean
    // "uncomputed" so the next call recomputes; `null` would be
    // indistinguishable from a legitimate computed-empty result.
    getInternals(this).composedWorkflowInterceptor = undefined;
    getInternals(this).composedActivityInterceptor = undefined;
  }
  #registerActivityDefinition<TDefinition extends AnyActivityDefinition>(
    definition: TDefinition,
  ): void {
    getInternals(this).activityRegistry.register(definition.name, definition);
  }

  protected resolveRegisteredActivity(name: string): RegisteredActivityFunction | undefined {
    return getInternals(this).activityRegistry.resolve(name);
  }

  protected registerActivityFunction(
    name: string,
    fn: Function,
    options?: ActivityRegistrationOptions,
  ): void {
    getInternals(this).activityRegistry.register(name, fn, options);
  }

  protected unregisterRegisteredActivity(name: string): void {
    getInternals(this).activityRegistry.unregister(name);
  }

  getWorkflowDefinition(type: string): RegisteredWorkflowDefinition | undefined {
    const registration = getInternals(this).registrations.get(type);
    return registration === undefined ? undefined : copyWorkflowDefinition(type, registration);
  }
  listWorkflowDefinitions(): RegisteredWorkflowDefinition[] {
    return [...getInternals(this).registrations.entries()].map(([type, registration]) =>
      copyWorkflowDefinition(type, registration),
    );
  }
  getActivityDefinition(name: string): ActivityMetadata | undefined {
    return getInternals(this).activityRegistry.getDefinition(name);
  }
  listActivityDefinitions(): ActivityMetadata[] {
    return getInternals(this).activityRegistry.listDefinitions();
  }
  async start<TName extends KnownWorkflowNames<TWorkflows>>(
    type: TName,
    input: WorkflowInput<TWorkflows, TName>,
    options?: StartWorkflowOptions<WorkflowServices<TWorkflows, TName>>,
  ): Promise<WorkflowHandle<WorkflowOutput<TWorkflows, TName>>>;
  async start<TName extends string>(
    type: UnknownWorkflowNameWhenDefaultRegistryIsEmpty<TWorkflows, TName>,
    input: unknown,
    options?: StartWorkflowOptions,
  ): Promise<WorkflowHandle>;
  async start(
    type: string,
    input: unknown,
    options?: StartWorkflowOptions,
  ): Promise<WorkflowHandle> {
    // Lease-ownership precondition: a new-workflow start must hold the lease (and
    // have recovered) first. This rejects on the awaited entry — unlike the
    // fenced-write throw, which the inline strategy swallows. No-op when
    // ownership is 'none'.
    assertLeaseHeldForEngineWork(getInternals(this));
    if (options?.idempotencyKey !== undefined) {
      return startWithIdempotencyFromLifecycle(
        getInternals(this),
        type,
        input,
        options,
        this.#createLifecycleCallbacks(),
      );
    }
    return startWorkflowFromLifecycle(
      getInternals(this),
      type,
      input,
      options,
      undefined,
      this.#createLifecycleCallbacks(),
    );
  }
  /**
   * Atomically start a workflow or signal it if it already exists
   * (signal-with-start). With an absent target, the workflow record and the
   * first signal commit in one batch and the freshly-launched run consumes the
   * signal on its first drive. A non-terminal target (running, pending, or
   * suspended) is signalled through a workflow-serialized signal path. If
   * terminal completion wins that handoff, the target is treated as terminal:
   * the default path throws {@link StartOrSignalConflictError}, while
   * `options.onTerminalConflict: 'start-new'` transfers the signal to the
   * replacement run. A terminal target throws {@link StartOrSignalConflictError}
   * unless `options.onTerminalConflict: 'start-new'` is supplied with an explicit
   * workflow id and deterministic `signal.signalId`.
   *
   * Concurrent callers converge on one workflow and one delivered signal. Pass
   * `options.idempotencyKey` to dedup independent callers (e.g. retried
   * webhooks); the signal id derives from the key when `signal.signalId` is
   * omitted, so callers that share only the key still converge. `signal.signalId`
   * and `options.idempotencyKey` are mutually exclusive (provide exactly one), as
   * are `options.id` and `options.idempotencyKey`. Requires a storage backend
   * with `conditionalBatch`.
   */
  async startOrSignal<TName extends KnownWorkflowNames<TWorkflows>>(
    type: TName,
    input: WorkflowInput<TWorkflows, TName>,
    signal: StartOrSignalSignal,
    options?: StartOrSignalOptions<WorkflowServices<TWorkflows, TName>>,
  ): Promise<StartOrSignalResult<WorkflowOutput<TWorkflows, TName>>>;
  async startOrSignal<TName extends string>(
    type: UnknownWorkflowNameWhenDefaultRegistryIsEmpty<TWorkflows, TName>,
    input: unknown,
    signal: StartOrSignalSignal,
    options?: StartOrSignalOptions,
  ): Promise<StartOrSignalResult>;
  async startOrSignal(
    type: string,
    input: unknown,
    signal: StartOrSignalSignal,
    options?: StartOrSignalOptions,
  ): Promise<StartOrSignalResult> {
    // Lease-ownership precondition (same as `start`): startOrSignal may durably
    // create a fresh run, so it must hold the lease first. No-op for 'none'.
    assertLeaseHeldForEngineWork(getInternals(this));
    return startOrSignalFromLifecycle(
      getInternals(this),
      type,
      input,
      signal,
      options,
      this.#createStartOrSignalCallbacks(),
    );
  }
  #createStartOrSignalCallbacks(): StartOrSignalCallbacks {
    return {
      ...this.#createLifecycleCallbacks(),
      signalExistingWorkflow: (workflowId, signalName, payload, signalId) =>
        runSerializedWorkflowStateWrite(getInternals(this), workflowId, async () => {
          const state = await loadWorkflowState(getInternals(this), workflowId);
          if (state && isTerminalWorkflowStatus(state.status)) {
            throw new StartOrSignalConflictError(workflowId, state.status);
          }
          await this.signal(workflowId, signalName, payload, { signalId });
        }),
    };
  }
  getHandle(workflowId: string): WorkflowHandle {
    const entry = getInternals(this).handleCache.get(workflowId);
    if (entry) {
      const existing = entry.ref.deref();
      if (existing) return existing;
    }
    return createWorkflowHandleWithResultPromiseFromInternals(getInternals(this), workflowId);
  }
  async list<
    const TAttributeKeys extends readonly AttributeFilterKey[] = readonly AttributeFilterKey[],
  >(
    filter?: TypedListFilter<TAttributeKeys>,
    options?: ListOptions,
  ): Promise<PaginatedResult<WorkflowSummary>> {
    return listWorkflows(getInternals(this), filter, options);
  }
  async aggregate(
    filter: ListFilter | undefined,
    options: AggregateOptions,
  ): Promise<AggregateResult> {
    return aggregateWorkflows(getInternals(this), filter, options);
  }
  getRetentionOverview(): RetentionOverview {
    return getRetentionOverviewSnapshot(getInternals(this), (type) =>
      resolveWorkflowTypeRetention(getInternals(this), type),
    );
  }
  /**
   * Run one host-driven maintenance cycle. This fires due durable timers,
   * deletes expired update responses, applies configured retention, and
   * re-evaluates alert rules without relying on process-local intervals.
   *
   * Use with `backgroundTasks: 'manual'` from a serverless alarm, Cron trigger,
   * or another externally scheduled wake-up. Concurrent calls are safe, but a
   * host should await each cycle before scheduling another.
   */
  async runMaintenance(now = getInternals(this).options.getNow()): Promise<void> {
    const internals = getInternals(this);
    await internals.scheduler.tick(now);
    try {
      await internals.updateCoordinator.cleanupExpiredResponses();
    } catch (error) {
      this.#createTerminationCallbacks().handleCleanupError('cleanupExpiredResponses', error);
    }
    if (this.#hasConfiguredRetention()) {
      await this.#runRetentionSweep();
    }
    internals.alertManager?.tick();
  }
  async purge(filter?: ListFilter): Promise<PurgeResult> {
    return purgeWorkflows(getInternals(this), filter, (workflowId) =>
      cleanupWaitersFromTermination(
        getInternals(this),
        workflowId,
        this.#createTerminationCallbacks(),
      ),
    );
  }
  async cancelAll(
    filter: ListFilter,
    options: BulkOperationDryRunOptions,
  ): Promise<BulkOperationDryRunResult>;
  async cancelAll(
    filter: ListFilter,
    options?: BulkOperationCommitOptions,
  ): Promise<BulkCancelResult>;
  async cancelAll(
    filter: ListFilter,
    options?: BulkOperationDryRunOptions | BulkOperationCommitOptions,
  ): Promise<BulkCancelResult | BulkOperationDryRunResult> {
    return cancelAllWorkflows(getInternals(this), filter, options);
  }
  async retryFailedAll(
    filter: ListFilter,
    options: BulkOperationDryRunOptions,
  ): Promise<BulkOperationDryRunResult>;
  async retryFailedAll(
    filter: ListFilter,
    options?: BulkOperationCommitOptions,
  ): Promise<BulkRetryFailedResult>;
  async retryFailedAll(
    filter: ListFilter,
    options?: BulkOperationDryRunOptions | BulkOperationCommitOptions,
  ): Promise<BulkRetryFailedResult | BulkOperationDryRunResult> {
    return retryFailedAllWorkflows(getInternals(this), filter, options);
  }
  async signalAll(
    filter: ListFilter,
    name: string,
    payload: unknown,
    options: BulkSignalAllDryRunOptions,
  ): Promise<BulkOperationDryRunResult>;
  async signalAll(
    filter: ListFilter,
    name: string,
    payload: unknown,
    options: BulkSignalAllCommitOptions,
  ): Promise<BulkSignalResult>;
  async signalAll(
    filter: ListFilter,
    name: string,
    payload?: unknown,
    options?: BulkOperationCommitOptions,
  ): Promise<BulkSignalResult>;
  async signalAll(
    filter: ListFilter,
    name: string,
    payloadOrOptions?: unknown,
    options?: BulkOperationDryRunOptions | BulkOperationCommitOptions,
  ): Promise<BulkSignalResult | BulkOperationDryRunResult> {
    if (options === undefined) {
      return signalAllWorkflows(getInternals(this), filter, name, payloadOrOptions);
    }
    return signalAllWorkflows(getInternals(this), filter, name, payloadOrOptions, options);
  }
  async deleteAll(
    filter: ListFilter,
    options: BulkOperationDryRunOptions,
  ): Promise<BulkOperationDryRunResult>;
  async deleteAll(
    filter: ListFilter,
    options?: BulkOperationCommitOptions,
  ): Promise<BulkDeleteResult>;
  async deleteAll(
    filter: ListFilter,
    options?: BulkOperationDryRunOptions | BulkOperationCommitOptions,
  ): Promise<BulkDeleteResult | BulkOperationDryRunResult> {
    return deleteAllWorkflows(
      getInternals(this),
      filter,
      (workflowId) =>
        cleanupWaitersFromTermination(
          getInternals(this),
          workflowId,
          this.#createTerminationCallbacks(),
        ),
      options,
    );
  }
  async tagAll(
    filter: ListFilter,
    tags: string[],
    options: BulkOperationDryRunOptions,
  ): Promise<BulkOperationDryRunResult>;
  async tagAll(
    filter: ListFilter,
    tags: string[],
    options?: BulkOperationCommitOptions,
  ): Promise<BulkTagResult>;
  async tagAll(
    filter: ListFilter,
    tags: string[],
    options?: BulkOperationDryRunOptions | BulkOperationCommitOptions,
  ): Promise<BulkTagResult | BulkOperationDryRunResult> {
    return tagAllWorkflows(getInternals(this), filter, tags, options);
  }
  async untagAll(
    filter: ListFilter,
    tags: string[],
    options: BulkOperationDryRunOptions,
  ): Promise<BulkOperationDryRunResult>;
  async untagAll(
    filter: ListFilter,
    tags: string[],
    options?: BulkOperationCommitOptions,
  ): Promise<BulkTagResult>;
  async untagAll(
    filter: ListFilter,
    tags: string[],
    options?: BulkOperationDryRunOptions | BulkOperationCommitOptions,
  ): Promise<BulkTagResult | BulkOperationDryRunResult> {
    return untagAllWorkflows(getInternals(this), filter, tags, options);
  }
  /**
   * Register a recurring schedule that starts a workflow on a cron expression or
   * fixed interval. Returns a {@link ScheduleHandle} for pausing, resuming,
   * updating, or cancelling the schedule.
   *
   * Two call forms:
   * - A {@link ScheduleDefinition} object: `engine.schedule({ workflow, cron, input })`.
   *   Carries the workflow (definition or type name), the `cron`/`every` spec,
   *   optional `input`, `id`, `overlapPolicy`, `backfill`, and `jitter`.
   * - Positional: `engine.schedule(type, input, spec, options?)` where `spec` is
   *   a cron string or a {@link ScheduleSpec} (`{ cron }` or `{ every }`).
   *
   * The {@link ScheduleOptions.overlap} policy governs what happens when a tick
   * fires while the previous run is still in flight.
   *
   * @example
   * ```ts
   * import { workflow, Engine } from '@lostgradient/weft';
   *
   * const engine = new Engine();
   * engine.register(workflow({ name: 'sweep' }).execute(async function* () { return 'ok'; }));
   *
   * // Definition form: every day at 09:00, skip a tick if the prior run is still running.
   * const handle = await engine.schedule({
   *   workflow: 'sweep',
   *   cron: '0 9 * * *',
   *   overlapPolicy: 'skip',
   * });
   * await handle.pause();
   * ```
   */
  async schedule<TInput>(definition: ScheduleDefinition<TInput>): Promise<ScheduleHandle>;
  async schedule(
    type: string,
    input: unknown,
    spec: string | ScheduleSpec,
    options?: ScheduleOptions,
  ): Promise<ScheduleHandle>;
  async schedule(
    typeOrDefinition: string | ScheduleDefinition,
    input?: unknown,
    spec?: string | ScheduleSpec,
    options?: ScheduleOptions,
  ): Promise<ScheduleHandle> {
    const internals = getInternals(this);
    assertLeaseHeldForEngineWork(internals);
    if (typeof typeOrDefinition === 'object') {
      return scheduleDefinitionFromInternals(internals, typeOrDefinition);
    }
    if (spec === undefined) {
      throw new Error(
        'A cron string or schedule spec must be provided when scheduling by workflow type.',
      );
    }
    return scheduleFromInternals(internals, typeOrDefinition, input, spec, options);
  }
  async getSchedule(scheduleId: string): Promise<ScheduleSummary | null> {
    const normalizedScheduleId = coerceScheduleId(scheduleId, 'scheduleId');
    const state = await loadScheduleState(getInternals(this), normalizedScheduleId);
    return state ? toScheduleSummary(state) : null;
  }
  async listSchedules(filter?: ScheduleFilter): Promise<PaginatedResult<ScheduleSummary>> {
    return listSchedulesFromInternals(getInternals(this), filter);
  }
  async pauseSchedule(scheduleId: string): Promise<void> {
    const internals = getInternals(this);
    assertLeaseHeldForEngineWork(internals);
    return pauseScheduleFromInternals(internals, scheduleId);
  }
  async resumeSchedule(scheduleId: string): Promise<void> {
    const internals = getInternals(this);
    assertLeaseHeldForEngineWork(internals);
    return resumeScheduleFromInternals(internals, scheduleId);
  }
  async cancelSchedule(scheduleId: string): Promise<void> {
    const internals = getInternals(this);
    assertLeaseHeldForEngineWork(internals);
    return cancelScheduleFromInternals(internals, scheduleId);
  }
  async updateSchedule(
    scheduleId: string,
    newSpec: string | ScheduleSpec,
    options?: ScheduleUpdateOptions,
  ): Promise<void> {
    const internals = getInternals(this);
    assertLeaseHeldForEngineWork(internals);
    return updateScheduleFromInternals(internals, scheduleId, newSpec, options);
  }
  [HANDLE_RESULT_PROMISE](workflowId: string): Promise<unknown> {
    return getWorkflowResultPromiseFromInternals(getInternals(this), workflowId);
  }
  [ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING](): number {
    return getInternals(this).parkedInlineWorkflows.size;
  }
  [ENGINE_SIGNAL_WAITER_COUNT_FOR_TESTING](): number {
    return getInternals(this).signalWaiters.size;
  }
  [ENGINE_SLEEP_RESOLVER_COUNT_FOR_TESTING](): number {
    return getInternals(this).sleepResolvers.size;
  }
  async [ENGINE_WAIT_FOR_SLEEP_RESOLVER_FOR_TESTING](workflowId: string): Promise<void> {
    const internals = getInternals(this);
    if (internals.sleepResolversByWorkflow.has(workflowId)) return;

    const { promise, resolve } = Promise.withResolvers<void>();
    let waiters = internals.sleepResolverReadyWaitersForTesting?.get(workflowId);
    if (waiters === undefined) {
      waiters = new Set();
      internals.sleepResolverReadyWaitersForTesting?.set(workflowId, waiters);
    }
    waiters.add(resolve);
    await promise;
  }
  [ENGINE_SET_WORKER_TURN_TIMEOUT_RESOLVER_FOR_TESTING](
    resolver: (turn: { workflowId: string; kind: 'run' | 'resume' }) => number,
  ): void {
    const strategy = getInternals(this).strategy;
    if (strategy.setWorkflowTurnTimeoutResolverForTesting === undefined) {
      throw new Error('Worker turn timeout resolver is only available in Worker execution mode');
    }
    strategy.setWorkflowTurnTimeoutResolverForTesting(resolver);
  }
  async signal(workflowId: string, name: SignalDefinition): Promise<void>;
  async signal<TInput>(
    workflowId: string,
    name: SignalDefinition<TInput>,
    payload: TInput,
    options?: SignalDeliveryOptions,
  ): Promise<void>;
  async signal(
    workflowId: string,
    name: string,
    payload?: unknown,
    options?: SignalDeliveryOptions,
  ): Promise<void>;
  async signal(
    workflowId: string,
    nameOrDefinition: MessageName,
    payload?: unknown,
    options?: SignalDeliveryOptions,
  ): Promise<void> {
    return signalWorkflow(
      getInternals(this),
      workflowId,
      messageName(nameOrDefinition),
      payload,
      {
        loadWorkflowState: (id) => loadWorkflowState(getInternals(this), id),
        dispatchEvent: (event) => this.dispatchEvent(event),
        broadcast: (message) => this.#broadcast(message),
        getComposedInterceptor: () => getComposedWorkflowInterceptor(getInternals(this)),
        resumeParkedInlineWorkflow: (id) =>
          swallowPromiseRejection(
            resumeParkedInlineWorkflowFromInternals(
              getInternals(this),
              id,
              this.#createInlineParkingCallbacks(),
            ),
          ),
      },
      options,
    );
  }
  async update(
    workflowId: string,
    name: UpdateDefinition,
    payload?: void,
    options?: { timeout?: number },
  ): Promise<unknown>;
  async update<TInput, TOutput>(
    workflowId: string,
    name: UpdateDefinition<TInput, TOutput>,
    payload: TInput,
    options?: { timeout?: number },
  ): Promise<TOutput>;
  async update(
    workflowId: string,
    name: string,
    payload?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown>;
  async update(
    workflowId: string,
    name: MessageName,
    payload?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown> {
    return updateFromInternals(
      getInternals(this),
      workflowId,
      messageName(name),
      payload,
      options,
      this.#createUpdateCallbacks(),
    );
  }
  async query<TOutput>(workflowId: string, name: QueryDefinition<void, TOutput>): Promise<TOutput>;
  async query<TInput, TOutput>(
    workflowId: string,
    name: QueryDefinition<TInput, TOutput>,
    input: TInput,
  ): Promise<TOutput>;
  async query(workflowId: string, name: string, input?: unknown): Promise<unknown>;
  async query(
    workflowId: string,
    nameOrDefinition: MessageName,
    input?: unknown,
  ): Promise<unknown> {
    return queryWorkflow(getInternals(this), workflowId, messageName(nameOrDefinition), input);
  }
  async getStreamChunks(
    workflowId: string,
    key: string,
    options?: { after?: number },
  ): Promise<StoredStreamChunk[]> {
    return getStreamChunksFromInternals(getInternals(this), workflowId, key, options);
  }
  /**
   * Read a value a workflow offloaded with `ctx.offload(key, ...)` back out of
   * storage by `workflowId` + `key`.
   *
   * This is the external, post-completion reader for offloaded artifacts — the
   * missing sibling of {@link getStreamChunks} and {@link getEvents}. Offloaded
   * values survive normal completion (`completeWorkflow`/`failWorkflow` preserve
   * them) so a consumer can read a finished workflow's offloaded output after
   * `handle.result()` resolves. They are swept only when a workflow is
   * terminated, cancelled, or times out.
   *
   * @returns The decoded offload value, or `null` when no value is stored under
   *   that key (key was never written, workflow ID unknown, or artifact swept).
   *
   * @example
   * ```ts
   * import { Engine } from '@lostgradient/weft';
   *
   * async function readReport(engine: Engine, workflowId: string): Promise<unknown> {
   *   // `null` when the workflow offloaded nothing under this key, or after a
   *   // terminated workflow swept its output artifacts.
   *   return engine.getOffload(workflowId, 'report');
   * }
   * ```
   */
  async getOffload(workflowId: string, key: string): Promise<unknown> {
    return getOffloadFromInternals(getInternals(this), workflowId, key);
  }
  async fork(sourceWorkflowId: string, options?: ForkOptions): Promise<WorkflowHandle> {
    // Fork plants a new run (engine-owned work) — require the lease first so a
    // pre-recovery fork surfaces EngineLeaseNotHeldError rather than being
    // misreported as a deposition by the fenced commit. No-op for 'none'.
    assertLeaseHeldForEngineWork(getInternals(this));
    return forkFromLifecycle(
      getInternals(this),
      sourceWorkflowId,
      options,
      this.#createLifecycleCallbacks(),
    );
  }
  /**
   * Re-drive a workflow from its persisted checkpoint and return a live handle.
   * Accepts a workflow left `'running'` (e.g. recovered after a process restart)
   * or one explicitly `'suspended'` via {@link Engine.suspend} — a suspended
   * workflow is durably flipped back to `'running'` as part of resuming. Throws
   * if the workflow is in any other status (terminal, pending) or not found.
   */
  async resume(workflowId: string): Promise<WorkflowHandle> {
    // Resume reactivates a workflow (engine-owned advance) — require the lease
    // first so a pre-recovery resume surfaces EngineLeaseNotHeldError rather than
    // a deposition misreport from the fenced commit. No-op for 'none'.
    assertLeaseHeldForEngineWork(getInternals(this));
    return resumeFromLifecycle(getInternals(this), workflowId, this.#createLifecycleCallbacks());
  }
  /**
   * Recover every running workflow found in storage. By default, recovery
   * fails before doing any resume work if a stored running workflow has no
   * registered workflow type on this engine.
   *
   * `acknowledgeUnknownWorkflowTypes` is a dangerous escape hatch for rolling
   * deploys or explicit operator storage repair.
   * When set, unknown workflow types are skipped and reported through
   * {@link WorkflowRecoverySkippedEvent}.
   *
   * A recovered workflow whose persisted version metadata no longer matches
   * its registered `WorkflowDefinition.version` is isolated per
   * {@link RecoverAllOptions.versionMismatchPolicy} (default `'fail-run'`):
   * only that workflow fails, and `recoverAll()` continues recovering its
   * siblings in the same call.
   */
  async recoverAll(options?: RecoverAllOptions): Promise<WorkflowHandle[]> {
    // Acquire the ownership lease before recovery on the `new Engine()` +
    // `recoverAll()` boot path too, not just via `Engine.create`. Idempotent —
    // a no-op when `Engine.create` already acquired it. NOTE: a caller that
    // does `new Engine({ ownership: 'lease' })` then `engine.start(...)` WITHOUT
    // ever calling `recoverAll` still writes without holding the lease; the
    // lease is acquired only on the create/recover paths in Step 1. Use
    // `Engine.create` (or call `recoverAll` before accepting traffic) to be safe.
    await this.#acquireLeaseIfConfigured();
    // Recovery must never run on a torn-down engine. This is the single closing
    // guard for every disposal interleaving: a direct recoverAll() after dispose, a
    // concurrent waiter that resumes after `#acquireLeaseIfConfigured` resolved, and
    // the window where disposal + lease release land between the lease being acquired
    // and recovery starting. (The lease itself is Step-1 deploy ergonomics, not a
    // correctness backstop — but running recovery against disposed engine machinery
    // is a real defect regardless of the lease, so it is gated here at the entry.)
    if (getInternals(this).disposed) throw new EngineDisposedError();
    // Reload durable async-activity tokens first so a callback that arrives
    // before (or during) workflow replay still resolves a parked activity.
    await recoverPendingAsyncActivities(getInternals(this));
    await recoverOrphanedScheduleTimers(getInternals(this));
    return recoverAllFromLifecycle(getInternals(this), this.#createLifecycleCallbacks(), options);
  }

  /**
   * Complete a deferred activity out-of-band with `result`. The activity must
   * have parked itself via `ActivityContext.completeAsync()`; pass the durable
   * task token announced through the `activity:async-pending` event (or
   * persisted by your callback dispatcher). The parked workflow resumes as
   * though the activity had returned `result` inline. During recovery, a
   * completion that arrives after token recovery but before replay adopts the
   * workflow generator is buffered and delivered when replay reaches the same
   * async-activity token. Await `recoverAll()` before accepting callback traffic
   * when your application needs startup ordering to be fully deterministic.
   *
   * @throws {AsyncActivityTokenNotFoundError} when no pending activity matches
   * the token (unknown, or already completed/failed — tokens are single-use).
   */
  async completeAsyncActivity(token: string, result: unknown): Promise<void> {
    await completeAsyncActivityFromInternals(getInternals(this), token, result, {
      feedOperationResult: (workflowId, outcome) =>
        feedOperationResult(getInternals(this), workflowId, outcome),
      finalizeTimeline: (workflowId, status, output) =>
        finalizePendingTimelineEntry(getInternals(this), workflowId, status, output),
    });
  }

  /**
   * List a bounded page of durable async activities awaiting out-of-band
   * completion for one workflow. This reads storage directly, so callers can
   * recover tokens after a process restart before `recoverAll()` repopulates
   * the in-memory completion map.
   */
  async listPendingAsyncActivities(
    workflowId: string,
    options?: PendingAsyncActivityListOptions,
  ): Promise<PendingAsyncActivityPage> {
    return listPendingAsyncActivitiesFromInternals(getInternals(this), workflowId, options);
  }

  /**
   * Fail a deferred activity out-of-band with `error`. The error is thrown into
   * the workflow generator at the parked step — identical to an inline activity
   * that threw — so the workflow's own try/catch and any configured retry
   * policy apply unchanged. During recovery, a failure that arrives after token
   * recovery but before replay adopts the workflow generator is buffered and
   * delivered when replay reaches the same async-activity token. Await
   * `recoverAll()` before accepting callback traffic when your application needs
   * startup ordering to be fully deterministic.
   *
   * @throws {AsyncActivityTokenNotFoundError} when no pending activity matches
   * the token (unknown, or already completed/failed — tokens are single-use).
   */
  async failAsyncActivity(token: string, error: unknown): Promise<void> {
    await failAsyncActivityFromInternals(getInternals(this), token, error, {
      feedOperationResult: (workflowId, outcome, originalReason) =>
        feedOperationResult(getInternals(this), workflowId, outcome, originalReason),
      finalizeTimeline: (workflowId, status, output) =>
        finalizePendingTimelineEntry(getInternals(this), workflowId, status, output),
    });
  }
  async cancel(workflowId: string): Promise<void> {
    await cancelWorkflowFromTermination(
      getInternals(this),
      workflowId,
      this.#createTerminationCallbacks(),
    );
  }
  /**
   * Suspend a running workflow without terminating it. The workflow transitions
   * to the non-terminal `'suspended'` status, keeps its durable checkpoint, and
   * is later resumable via {@link Engine.resume} (or `handle.resume()`). Unlike
   * {@link Engine.cancel}, this does not run cancel handlers and does not settle
   * the result promise — `handle.result()` stays pending until a later `resume()`
   * drives the run to completion.
   *
   * Suspension is client-driven preemption, so a suspended workflow is NOT
   * auto-recovered by {@link Engine.recoverAll}; resume it explicitly. Calling
   * `suspend` on a workflow that is not running (already terminal, or never
   * started) is a no-op.
   */
  async suspend(workflowId: string): Promise<void> {
    await suspendWorkflowFromTermination(
      getInternals(this),
      workflowId,
      this.#createTerminationCallbacks(),
    );
  }
  async timeout(workflowId: string): Promise<void> {
    await timeoutWorkflowFromTermination(
      getInternals(this),
      workflowId,
      this.#createTerminationCallbacks(),
    );
  }
  async get(workflowId: string): Promise<WorkflowState | null> {
    const state = await loadWorkflowState(getInternals(this), workflowId);
    if (
      state?.status === 'running' &&
      hasQueuedInlineWorkflowStart(getInternals(this), workflowId)
    ) {
      return { ...state, status: 'pending' };
    }
    return state;
  }
  /** Return the schedule occurrence that launched a workflow, when applicable. */
  async getScheduleProvenance(workflowId: string): Promise<WorkflowScheduleProvenance | null> {
    const bytes = await getInternals(this).storage.get(KEYS.scheduleRunLink(workflowId));
    if (bytes === null) return null;
    const metadata = decodeScheduleRunMetadata(bytes);
    if (metadata === null) return null;
    return {
      scheduleId: metadata.id,
      ...(metadata.occurrence === undefined ? {} : { occurrence: metadata.occurrence }),
    };
  }
  /** Return durable post-terminal finalizer progress or outcome, when applicable. */
  async getFinalizerStatus(workflowId: string): Promise<WorkflowFinalizerStatus | null> {
    const internals = getInternals(this);
    const state = await loadWorkflowState(internals, workflowId);
    return getFinalizerStatusFromInternals(internals, workflowId, state);
  }
  /**
   * Return this process's last-known ownership-lease health.
   *
   * This is a synchronous diagnostic snapshot: it never performs a storage read
   * and therefore remains available to operator transports after a confirmed
   * deposition has detached the lease manager. Holder identifiers and timestamps
   * are present only while the manager still has its own last-written holder
   * record; a detached deposed engine reports the confirmed loss without
   * inventing successor details.
   */
  getLeaseHealth(): EngineLeaseHealth {
    const internals = getInternals(this);
    if (internals.options.ownershipMode === 'none') {
      return { mode: 'none', status: 'disabled', holdsLease: false };
    }
    if (internals.deposed) {
      const lastKnownLease = internals.leaseManager?.health();
      if (lastKnownLease !== undefined && lastKnownLease.status !== 'no-lease') {
        return {
          mode: 'lease',
          ...lastKnownLease,
          status: 'contested',
          holdsLease: false,
          lossReason: 'deposed',
        };
      }
      return {
        mode: 'lease',
        status: 'contested',
        holdsLease: false,
        lossReason: 'deposed',
      };
    }
    return {
      mode: 'lease',
      ...(internals.leaseManager?.health() ?? { status: 'no-lease', holdsLease: false }),
    };
  }
  async getCurrentCheckpointStep(workflowId: string): Promise<number | null> {
    // Prefer the in-memory checkpoint: for a run live in this engine it is the
    // freshest cursor, ahead of the last durable commit. Fall back to the
    // persisted checkpoint so a recovered or cross-process-inspected run still
    // reports its durable step.
    const inMemory = getInternals(this).checkpoints.get(workflowId);
    if (inMemory !== undefined) {
      return inMemory.step;
    }
    const bytes = await getInternals(this).storage.get(KEYS.checkpoint(workflowId));
    if (bytes === null) {
      return null;
    }
    return deserializeCheckpoint(bytes).step;
  }
  async getAttributes(workflowId: string): Promise<Record<string, SearchAttributeValue> | null> {
    return getWorkflowAttributes(getInternals(this), workflowId);
  }
  async setAttributes(
    workflowId: string,
    attributes: Record<string, SearchAttributeValue>,
  ): Promise<void> {
    return setWorkflowAttributes(getInternals(this), workflowId, attributes);
  }
  async addTags(workflowId: string, ...tags: string[]): Promise<void> {
    return addWorkflowTags(getInternals(this), workflowId, ...tags);
  }
  async removeTags(workflowId: string, ...tags: string[]): Promise<void> {
    return removeWorkflowTags(getInternals(this), workflowId, ...tags);
  }
  async getEvents(workflowId: string): Promise<WorkflowEvent[]> {
    return getWorkflowEvents(getInternals(this), workflowId);
  }
  async *replayWorkflowFeed(
    workflowId: string,
    selector: WorkflowFeedSelector,
    afterSequence: number,
  ): AsyncIterable<WorkflowFeedRecord> {
    yield* replayWorkflowFeed(getInternals(this), workflowId, selector, afterSequence);
  }
  async snapshotWorkflowFeedTail(
    workflowId: string,
    selector: WorkflowFeedSelector,
  ): Promise<number> {
    return snapshotWorkflowFeedTail(getInternals(this), workflowId, selector);
  }
  subscribeWorkflowFeedCommits(
    workflowId: string,
    selector: WorkflowFeedSelector,
    listener: WorkflowFeedListener,
  ): () => void {
    return subscribeWorkflowFeedCommits(getInternals(this), workflowId, selector, listener);
  }
  async listCheckpoints(workflowId: string): Promise<CheckpointSummary[]> {
    return listCheckpointHistory(getInternals(this), workflowId);
  }
  async getCheckpointAt(workflowId: string, step: number): Promise<CheckpointState | null> {
    return getCheckpointStateAt(getInternals(this), workflowId, step);
  }
  async getTimeline(workflowId: string): Promise<WorkflowTimelineEntry[]> {
    return getWorkflowTimeline(getInternals(this), workflowId);
  }
  async replayTo(workflowId: string, step: number): Promise<WorkflowReplay | null> {
    return replayWorkflowToCheckpoint(getInternals(this), workflowId, step);
  }
  async listReviews(filter?: ReviewListFilter): Promise<ReviewListEntry[]> {
    return listReviewsFromInternals(getInternals(this), filter);
  }
  async getReview(workflowId: string, reviewId: string): Promise<ReviewRequest | null> {
    return getReviewFromInternals(getInternals(this), workflowId, reviewId);
  }
  async submitReview(reviewId: string, options: SubmitReviewOptions): Promise<void> {
    return submitReviewFromInternals(getInternals(this), reviewId, options, {
      dispatchEvent: this.dispatchEvent.bind(this),
    });
  }
  async getUpdateResult(updateId: string): Promise<import('../updates.ts').UpdateResponse | null> {
    return getUpdateResultFromInternals(getInternals(this), updateId);
  }
  async submitCoordinatedUpdate(
    workflowId: string,
    name: string,
    payload?: unknown,
    options?: { timeout?: number; idempotencyKey?: string },
  ): Promise<CoordinatedUpdateResult> {
    return submitCoordinatedUpdateFromInternals(
      getInternals(this),
      workflowId,
      name,
      payload,
      options,
      this.#createUpdateCallbacks(),
    );
  }
  /**
   * Awaited engine shutdown. Equivalent to
   * `await engine[Symbol.asyncDispose]()` and useful in explicit signal handlers
   * where `await using` syntax cannot own the process lifetime directly.
   *
   * Under `ownership: 'lease'`, this is the explicit prompt-handoff primitive:
   * it drains queued inline starts, tears down in-memory write paths, and awaits
   * lease release before resolving. The returned boolean is `true` when no lease
   * needed release or the holder delete committed, and `false` when the delete
   * did not commit. Synchronous disposal remains immediate and can make the next
   * engine wait for `leaseTtl` if the process exits before its background release
   * completes.
   */
  async shutdown(): Promise<boolean> {
    if (this.#shutdownResult === null) {
      this.#shutdownResult = (async () => {
        await this[Symbol.asyncDispose]();
        const baseResult = this.#asyncDisposeResult;
        if (baseResult === null) {
          await getInternals(this).inFlightLeaseAcquire?.catch(() => {});
          return (await this.#synchronousDisposeResult) ?? true;
        }
        try {
          return await baseResult;
        } catch (error) {
          return error instanceof EngineDisposalError ? error.leaseReleased : true;
        }
      })();
    }
    return this.#shutdownResult;
  }

  /**
   * Synchronous teardown (`using engine = ...`). Pending inline launches that
   * have not yet run are **discarded**, not executed. When you need queued
   * starts to complete before teardown — or want a clean event loop with no
   * dangling deferred-launch macrotask — prefer {@link Engine[Symbol.asyncDispose]}
   * via `await using`.
   */
  [Symbol.dispose](): void {
    // Async disposal owns the complete drain → teardown → lease-release
    // sequence once it starts. A concurrent synchronous disposal must not abort
    // that drain or release its holder early.
    if (this.#asyncDisposeResult !== null) {
      void this.#asyncDisposeResult;
      return;
    }

    // Capture the lease manager before disposeEngine() detaches it (disposeEngine
    // only stops renewals — it does NOT release the holder, so each disposal path
    // releases exactly once). Fire the holder release best-effort: synchronous
    // disposal cannot await a storage round-trip.
    const leaseManager = getInternals(this).leaseManager;
    if (leaseManager !== null && leaseManager.currentEpochBytes() !== null) {
      process.emitWarning(
        'engine ownership lease disposed synchronously; lease release is fire-and-forget, ' +
          'so exiting before the release completes can make the next instance wait for leaseTtl. ' +
          'Use await engine.shutdown(), await using, or await engine[Symbol.asyncDispose]() for ' +
          'prompt rolling-deploy handoff.',
        ENGINE_LEASE_SYNCHRONOUS_DISPOSE_WARNING_NAME,
      );
    }
    disposeEngine(getInternals(this));
    if (this.#synchronousDisposeResult === null) {
      this.#synchronousDisposeResult = leaseManager?.release() ?? Promise.resolve(true);
    }
    void this.#synchronousDisposeResult;
  }
  /**
   * Async teardown (`await using engine = ...`). Drains pending inline launches
   * so each queued workflow completes its first turn before disposal, leaving no
   * deferred-launch macrotask to fire against torn-down state. The drain is
   * bounded (a pass cap and the abort signal); in the pathological case where it
   * cannot converge, anything still queued is discarded by the synchronous
   * teardown that always follows. Prefer this over the synchronous
   * {@link Engine[Symbol.dispose]} in async contexts and tests.
   */
  async #disposeAsyncWithLeaseResult(): Promise<boolean> {
    // Drain pending inline launches BEFORE synchronous disposal aborts the
    // signal (which would discard them). This makes a disposed engine leave no
    // dangling deferred-launch macrotask — the clean async teardown that lets
    // callers (and test runners) avoid manual macrotask draining.
    //
    // The drain runs in try/finally so synchronous disposal ALWAYS completes,
    // even if the drain rejects: a half-disposed engine (abort un-fired,
    // awaiters hung, channels open) is worse than the footgun this fixes.
    if (!getInternals(this).disposed) {
      // Capture the lease manager before in-memory teardown detaches it; release it
      // LAST (see below).
      const leaseManager = getInternals(this).leaseManager;
      let leaseReleased = true;
      let drainFailure: { error: unknown } | null = null;
      try {
        await drainQueuedInlineWorkflowStartsForEngine(this, {
          abortStartedWorkflows: true,
        });
      } catch (error) {
        drainFailure = { error };
      } finally {
        // Call disposeEngine DIRECTLY rather than this[Symbol.dispose](): the sync
        // path fires a best-effort release, which would double-release and race the
        // authoritative awaited release below. disposeEngine only aborts the engine
        // and tears down every workflow/activity/storage-writing path in memory
        // (and stops lease renewals) — it issues no storage writes itself. The
        // caller owns the storage lifecycle (`await using storage`), so storage
        // stays open and the awaited release below can still delete the holder.
        disposeEngine(getInternals(this));
        // A lease acquire may still be parked (waiting for handoff) when disposal
        // runs. disposeEngine() set `disposed` and stopped the manager, so the
        // parked acquire's wait loop exits (or, if it already committed a holder
        // this tick, its post-acquire `disposed` check releases it). Await it so
        // cleanup completes before we resolve — otherwise a holder it takes could
        // outlive dispose until TTL. A disposal-cancelled acquire now REJECTS
        // (EngineDisposedError) — that rejection is the intended outcome, not a
        // failure to surface, so swallow it here.
        await getInternals(this).inFlightLeaseAcquire?.catch(() => {});
        // Clean deploy handoff: release the ownership lease as the LAST durable
        // action, AFTER queued starts have drained and all write paths are down, so
        // the incoming instance cannot acquire and recover while this one is still
        // writing. Awaiting makes `await using engine` a zero-overlap handoff, and
        // this is the single release on the async path. Idempotent if the parked
        // acquire's own `disposed`-branch already released.
        const releaseResult =
          this.#synchronousDisposeResult ?? leaseManager?.release() ?? Promise.resolve(true);
        leaseReleased = await releaseResult;
      }
      if (drainFailure !== null) {
        throw new EngineDisposalError(drainFailure.error, leaseReleased);
      }
      return leaseReleased;
    }
    this[Symbol.dispose]();
    await getInternals(this).inFlightLeaseAcquire?.catch(() => {});
    return (await this.#synchronousDisposeResult) ?? true;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#asyncDisposeResult === null) {
      this.#asyncDisposeResult = this.#disposeAsyncWithLeaseResult();
    }
    await this.#asyncDisposeResult;
  }
  get storage(): WeftStorage {
    return getInternals(this).storage;
  }
  get scheduler(): Scheduler {
    return getInternals(this).scheduler;
  }

  /**
   * Fire a single timer entry directly. Intended for external schedulers
   * (Service Worker, custom transports) that own timer dispatch but want
   * the engine to actually resume the workflow associated with the entry.
   *
   * Most users do not call this directly. The internal `Scheduler` invokes
   * the same code path automatically when its tick observes a due entry.
   *
   * @example
   * ```ts
   * import { Engine } from '@lostgradient/weft';
   * declare const externalEntry: import('@lostgradient/weft').TimerEntry;
   * const engine = new Engine();
   * await engine.fireTimer(externalEntry);
   * ```
   */
  async fireTimer(entry: TimerEntry): Promise<void> {
    await handleTimerFiredFromInternals(
      getInternals(this),
      entry,
      this.#createTimeOperationCallbacks(),
    );
  }
}

/**
 * `Engine` with its two chained-builder registration methods removed —
 * `register` and `registerWorkflows`, whose return type is itself
 * `Engine<NarrowedRegistry>` (see `register()`'s JSDoc: registering returns
 * "this same engine with the definition added to its phantom type
 * registry"). That self-reference is what makes `Engine` invariant in its
 * registry generics: a concretely narrowed `Engine<Concrete>` (e.g. from
 * `Engine.create({ workflows })`) is not structurally assignable to the
 * plain default `Engine<DefaultWorkflowRegistry>`, even though every other
 * member — including `start` and `startOrSignal`, whose *parameter* types
 * (not return types) reference `TWorkflows` but never produce another
 * `Engine<T>` — is not part of that recursive comparison.
 *
 * `start` and `startOrSignal` are deliberately KEPT (not omitted): hosted
 * transports genuinely call them at runtime (REST/JSON-RPC workflow starts,
 * MCP tool invocations) via `runtimeWorkflowEngine()`'s registry-erased
 * dynamic-name overload, so a value satisfying this type must still provide
 * them — a duck-typed engine substitute lacking `start` correctly fails to
 * satisfy `RegistryAgnosticEngine` (see this type's `.test-d.ts` coverage).
 *
 * Host-facing options that accept an already-constructed `Engine` without
 * needing the two chained-builder registration methods — `serve({ engine })`,
 * the Service Worker helpers, the MCP session/HTTP/stdio surfaces — use this
 * type instead of the bare default `Engine`, so both `new Engine({ storage })`
 * and `Engine.create({ workflows })` are accepted without a call-site cast.
 * See #708.
 *
 * (`Engine<object, object>` looks like the obvious fix — the widest legal
 * instantiation of the registry generics — but TypeScript's structural check
 * on `register()`'s self-referential return type does not reliably resolve
 * that relationship: it can pass or fail for the identical `Engine<A>` /
 * `Engine<B>` pair depending on unrelated compilation context, such as other
 * files in the same program. Removing the registry-typed members entirely,
 * rather than widening their generic arguments, avoids the recursive
 * comparison altogether.)
 */
export type RegistryAgnosticEngine = Omit<Engine, 'register' | 'registerWorkflows'>;

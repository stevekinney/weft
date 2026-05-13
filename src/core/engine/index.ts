/* oxlint-disable max-lines -- ID:core-engine-index-file-length */
import { AlertManager } from '../../alerting/alert-manager.ts';
import { CompressedStorage } from '../../storage/compressed-storage.ts';
import { KEYS, type Storage as WeftStorage } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { ActivityWorkerDispatcher } from '../../workers/activity-worker-dispatcher.ts';
import { WorkerPool } from '../../workers/pool.ts';
import {
  ActivityRegistry,
  type ActivityMetadata,
  type ActivityRegistrationOptions,
} from '../activity-registry.ts';
import { AtomicState, type AtomicStateOptions } from '../atomic-state.ts';
import type { StoredStreamChunk } from '../context.ts';
import { createExpiredResponseCleanupTick, createHandleCacheFinalizer } from '../engine-helpers.ts';
import { InlineExecutionStrategy } from '../inline-execution-strategy.ts';
import type { Interceptor } from '../interceptor.ts';
import { ReviewCoordinator, type ReviewRequest } from '../review/index.ts';
import { Scheduler } from '../scheduler.ts';
import { TenantQuotaManager } from '../tenant-quotas.ts';
import {
  DEFAULT_RETENTION_SWEEP_BATCH_SIZE,
  DEFAULT_RETENTION_SWEEP_INTERVAL_MS,
  messageName,
  type ActivityContext,
  type ActivityTypes,
  type AllowsDynamicWorkflowNames,
  type AnyActivityDefinition,
  type AnyWorkflowDefinition,
  type AttributeFilterKey,
  type BulkCancelResult,
  type BulkDeleteResult,
  type BulkOperationCommitOptions,
  type BulkOperationDryRunOptions,
  type BulkOperationDryRunResult,
  type BulkSignalAllCommitOptions,
  type BulkSignalAllDryRunOptions,
  type BulkSignalResult,
  type BulkTagResult,
  type CheckpointState,
  type CheckpointSummary,
  type CoordinatedUpdateResult,
  type DefaultWorkflowRegistry,
  type EngineOptions,
  type ForkOptions,
  type InferActivityEntries,
  type InferActivityEntry,
  type InferWorkflowEntries,
  type InferWorkflowEntry,
  type ListFilter,
  type ListOptions,
  type MessageName,
  type PaginatedResult,
  type PurgeResult,
  type QueryDefinition,
  type RegisteredActivityFunction,
  type RegisteredWorkflowDefinition,
  type RetentionOverview,
  type ReviewListEntry,
  type ReviewListFilter,
  type ScheduleAccessOptions,
  type ScheduleDefinition,
  type ScheduleFilter,
  type ScheduleOptions,
  type ScheduleSummary,
  type SearchAttributeValue,
  type SignalDefinition,
  type StartOptions,
  type StepWorkflowFunction,
  type SubmitReviewOptions,
  type TenantQuotaUsage,
  type TypedListFilter,
  type UnregisteredName,
  type UpdateDefinition,
  type WorkerOutboundMessage,
  type WorkflowEvent,
  type WorkflowFunction,
  type WorkflowInput,
  type WorkflowOutput,
  type WorkflowRegistration,
  type WorkflowReplay,
  type WorkflowState,
  type WorkflowSummary,
  type WorkflowTimelineEntry,
} from '../types.ts';
import type { TimerEntry } from '../types/checkpoint.ts';
import { UpdateCoordinator } from '../updates.ts';
import { WorkerExecutionStrategy } from '../worker-execution-strategy.ts';
import {
  aggregate as aggregateWorkflows,
  type AggregateOptions,
  type AggregateResult,
} from './aggregate.ts';
import { broadcast as broadcastFromInternals, type BroadcastCallbacks } from './broadcast.ts';
import {
  cancelAll as cancelAllWorkflows,
  deleteAll as deleteAllWorkflows,
  purge as purgeWorkflows,
  signalAll as signalAllWorkflows,
  tagAll as tagAllWorkflows,
  untagAll as untagAllWorkflows,
} from './bulk-operations.ts';
import {
  createBroadcastCallbacks as createBroadcastCallbacksForEngine,
  createInlineParkingCallbacks as createInlineParkingCallbacksForEngine,
  createLifecycleCallbacks as createLifecycleCallbacksForEngine,
  createRegistrationCallbacks as createRegistrationCallbacksForEngine,
  createTerminationCallbacks as createTerminationCallbacksForEngine,
  createTimeOperationCallbacks as createTimeOperationCallbacksForEngine,
  createUpdateCallbacks as createUpdateCallbacksForEngine,
} from './callback-creators.ts';
import {
  getCheckpointAt as getCheckpointStateAt,
  getEvents as getWorkflowEvents,
  getTimeline as getWorkflowTimeline,
  listCheckpoints as listCheckpointHistory,
  replayTo as replayWorkflowToCheckpoint,
} from './checkpoint-io.ts';
import type {
  EngineConstructorOptions,
  ExecutionStrategyBundle,
  RegistrationEntry,
  ResolvedOptions,
} from './engine-internal-types.ts';
import { EngineCreateNameMismatchError } from './errors.ts';
import {
  createWorkflowHandleWithResultPromise as createWorkflowHandleWithResultPromiseFromInternals,
  getWorkflowResultPromise as getWorkflowResultPromiseFromInternals,
} from './handle-result.ts';
import { HANDLE_RESULT_PROMISE, ScheduleHandle, WorkflowHandle } from './handles.ts';
import {
  disposeQueuedInlineWorkflowStarts,
  flushQueuedInlineWorkflowStarts,
  hasQueuedInlineWorkflowStart,
} from './inline-launch-queue.ts';
import {
  handleStrategyMessage as handleStrategyMessageFromInternals,
  resumeParkedInlineWorkflow as resumeParkedInlineWorkflowFromInternals,
  type InlineParkingCallbacks,
} from './inline-parking.ts';
import { getInternals, initializeInternals } from './internals.ts';
import {
  fork as forkFromLifecycle,
  recoverAll as recoverAllFromLifecycle,
  resume as resumeFromLifecycle,
  startWorkflow as startWorkflowFromLifecycle,
  type LifecycleCallbacks,
  type RecoverAllOptions,
} from './lifecycle.ts';
import {
  addTags as addWorkflowTags,
  getAttributes as getWorkflowAttributes,
  list as listWorkflows,
  removeTags as removeWorkflowTags,
  setAttributes as setWorkflowAttributes,
} from './listing.ts';
import { getStreamChunksFromInternals } from './operations-stream.ts';
import {
  handleTimerFired as handleTimerFiredFromInternals,
  type TimeOperationCallbacks,
} from './operations-time.ts';
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
import {
  cancelSchedule as cancelScheduleFromInternals,
  listSchedules as listSchedulesFromInternals,
  pauseSchedule as pauseScheduleFromInternals,
  resumeSchedule as resumeScheduleFromInternals,
  schedule as scheduleFromInternals,
  toScheduleSummary,
  updateSchedule as updateScheduleFromInternals,
} from './schedules.ts';
import { signal as signalWorkflow } from './signals.ts';
import { canAccessSchedule } from './state-utilities.ts';
import { loadScheduleState, loadWorkflowState } from './storage-io.ts';
import { getComposedWorkflowInterceptor, swallowPromiseRejection } from './strategy-helpers.ts';
import {
  cancelWorkflow as cancelWorkflowFromTermination,
  cleanupWaiters as cleanupWaitersFromTermination,
  timeoutWorkflow as timeoutWorkflowFromTermination,
  type TerminationCallbacks,
} from './termination.ts';
import {
  getUpdateResult as getUpdateResultFromInternals,
  submitCoordinatedUpdate as submitCoordinatedUpdateFromInternals,
  update as updateFromInternals,
  type UpdateCallbacks,
} from './updates.ts';
import {
  coerceScheduleId,
  normalizeRetentionDuration,
  normalizeRetentionPolicy,
  normalizeScheduleAccessOptions,
} from './validation.ts';
import {
  replayWorkflowFeed,
  snapshotWorkflowFeedTail,
  subscribeWorkflowFeedCommits,
  type WorkflowFeedListener,
  type WorkflowFeedRecord,
  type WorkflowFeedSelector,
} from './workflow-feed.ts';

export type {
  PendingTimelineEntry,
  RegistrationEntry,
  ResolvedOptions,
  TrackedWaiterKeys,
  WorkflowResultWaiter,
} from './engine-internal-types.ts';
export {
  BulkDeleteRequiresTerminalWorkflowsError,
  BulkOperationConfirmationError,
  EngineCreateNameMismatchError,
  WorkflowAlreadyExistsError,
  WorkflowNotFoundError,
  WorkflowNotRegisteredError,
  WorkflowTypeNotRegisteredForRecoveryError,
} from './errors.ts';
export { HANDLE_RESULT_PROMISE, ScheduleHandle, WorkflowHandle } from './handles.ts';
export type { RecoverAllOptions } from './lifecycle.ts';
export type {
  WorkflowFeedListener,
  WorkflowFeedRecord,
  WorkflowFeedSelector,
} from './workflow-feed.ts';

/**
 * Admin-facing factories for storage-backed {@link AtomicState} handles.
 * Workflow code should prefer `ctx.state.*`; external maintenance and
 * administrative code can use `engine.state.*` with explicit scope inputs.
 *
 * @example
 * ```ts
 * import { Engine, type EngineStateNamespace } from 'weft';
 *
 * const engine = new Engine();
 * const state: EngineStateNamespace = engine.state;
 * const counter = state.tenant<number>('acme', 'count', { initial: 0 });
 * void counter;
 * ```
 */
export interface EngineStateNamespace {
  execution<T>(
    ownerWorkflowId: string,
    key: string,
    options?: AtomicStateOptions<T>,
  ): AtomicState<T>;
  workflow<T>(
    tenantId: string,
    workflowType: string,
    key: string,
    options?: AtomicStateOptions<T>,
  ): AtomicState<T>;
  tenant<T>(tenantId: string, key: string, options?: AtomicStateOptions<T>): AtomicState<T>;
}

/**
 * Options accepted by {@link Engine.create}. Definition maps are used for
 * type inference, then each map key is checked against the definition's
 * runtime `name` before registration.
 *
 * @example
 * ```ts
 * import { activity, Engine, workflow, type EngineCreateOptions } from 'weft';
 *
 * const greet = activity({ name: 'greet', execute: async (name: string) => `Hello, ${name}` });
 * const welcome = workflow({
 *   name: 'welcome',
 *   handler: async function* (ctx, input: string) {
 *     return yield* ctx.run(greet, input);
 *   },
 * });
 *
 * const options = {
 *   workflows: { welcome },
 *   activities: { greet },
 * } satisfies EngineCreateOptions<{ welcome: typeof welcome }, { greet: typeof greet }>;
 * const engine = await Engine.create(options);
 * void engine;
 * ```
 */
export type EngineCreateOptions<
  TWorkflowDefinitions extends Record<string, AnyWorkflowDefinition> = {},
  TActivityDefinitions extends Record<string, AnyActivityDefinition> = {},
> = EngineConstructorOptions & {
  /** Workflow definitions to register before recovery. */
  workflows?: TWorkflowDefinitions;
  /** Activity definitions to register before workflows. */
  activities?: TActivityDefinitions;
  /** Whether to recover stored running workflows after registration. Defaults to `true`. */
  recover?: boolean;
  /**
   * Forwarded to {@link Engine.recoverAll}. Only use this during rolling
   * deploys, explicit storage migrations, or intentional tenant partitioning.
   */
  acknowledgeUnknownWorkflowTypes?: boolean;
};

type KnownWorkflowNames<TWorkflows extends object> = Extract<keyof TWorkflows, string>;
declare const emptyWorkflowDefinitions: unique symbol;
declare const emptyActivityDefinitions: unique symbol;
type EmptyWorkflowDefinitions = Record<string, never> & {
  readonly [emptyWorkflowDefinitions]: true;
};
type EmptyActivityDefinitions = Record<string, never> & {
  readonly [emptyActivityDefinitions]: true;
};
type EngineCreateRuntimeOptions = EngineConstructorOptions & {
  activities?: Record<string, AnyActivityDefinition>;
  workflows?: Record<string, AnyWorkflowDefinition>;
  recover?: boolean;
  acknowledgeUnknownWorkflowTypes?: boolean;
};

type DynamicWorkflowName<TWorkflows extends object, TName extends string> =
  AllowsDynamicWorkflowNames<TWorkflows> extends true
    ? UnregisteredName<TName, KnownWorkflowNames<TWorkflows>>
    : never;

function definitionEntries<TDefinition extends object>(
  definitions: Record<string, TDefinition> | undefined,
): Array<[string, TDefinition]> {
  return Object.entries(definitions ?? {});
}

function typedEngineView<TViewWorkflows extends object, TViewActivities extends object>(
  engine: object,
): Engine<TViewWorkflows, TViewActivities> {
  // The runtime instance is the same Engine; this re-narrows the phantom type
  // parameters after `register` / `registerActivity` has mutated the
  // underlying registries. There is no sound type-system bridge: `Engine` is
  // invariant in both type parameters because the `register` method makes them
  // contravariant, so any cast that preserves the structural relationship
  // would have to flow through `unknown`/`never`. The bypass is contained to
  // this single helper and the `engine: object` parameter ensures callers can
  // only pass an actual instance (the Engine class extends EventTarget which
  // extends object).
  return engine as never;
}

function resolveEngineStorage(options?: EngineConstructorOptions): WeftStorage {
  const baseStorage = options?.storage ?? new MemoryStorage();
  if (!options?.compression) return baseStorage;
  return new CompressedStorage(baseStorage, options.compression);
}

function resolveEngineInterceptors(options?: EngineConstructorOptions): Interceptor[] {
  // Defensive copy: callers must not mutate the engine's interceptor list
  // after construction. Mutating the source array directly would bypass
  // the composed-interceptor cache invalidation in `addInterceptor`.
  return options?.interceptors ? [...options.interceptors] : [];
}

function copyWorkflowDefinition(
  type: string,
  registration: RegistrationEntry,
): RegisteredWorkflowDefinition {
  return {
    type,
    version: registration.version,
    tags: registration.tags === undefined ? [] : [...registration.tags],
    ...(registration.description === undefined ? {} : { description: registration.description }),
    ...(registration.inputSchema === undefined ? {} : { inputSchema: registration.inputSchema }),
    ...(registration.outputSchema === undefined ? {} : { outputSchema: registration.outputSchema }),
  };
}

// oxlint-disable-next-line complexity -- ID:core-engine-resolve-engine-options-complexity
function resolveEngineOptions(
  storage: WeftStorage,
  options: EngineConstructorOptions | undefined,
  getNow: () => number,
): ResolvedOptions {
  return {
    storage,
    development: options?.development ?? false,
    checkpointHistory: options?.checkpointHistory ?? 10,
    checkpointSizeWarningThreshold: options?.checkpointSizeWarningThreshold ?? 65_536,
    maxNestingDepth: options?.maxNestingDepth ?? 10,
    broadcastEvents: options?.broadcastEvents ?? false,
    suspendOnLlmWait: options?.suspendOnLlmWait ?? false,
    retention: normalizeRetentionPolicy(options?.retention, 'options.retention'),
    retentionSweepIntervalMs:
      normalizeRetentionDuration(
        options?.retentionSweepInterval,
        'options.retentionSweepInterval',
      ) ?? DEFAULT_RETENTION_SWEEP_INTERVAL_MS,
    retentionSweepBatchSize:
      options?.retentionSweepBatchSize !== undefined
        ? Math.max(1, Math.floor(options.retentionSweepBatchSize))
        : DEFAULT_RETENTION_SWEEP_BATCH_SIZE,
    getNow,
    tenantResolver: options?.tenantResolver,
  };
}

function createExecutionStrategyBundle(parameters: {
  options: EngineConstructorOptions | undefined;
  getNow: () => number;
  maxNestingDepth: number;
  development: boolean;
  broadcastEvents: boolean;
  getRegistration: (workflowType: string) => RegistrationEntry | undefined;
  resolveWorkflowType: (target: string | Function) => string;
}): ExecutionStrategyBundle {
  const {
    options,
    getNow,
    maxNestingDepth,
    development,
    broadcastEvents,
    getRegistration,
    resolveWorkflowType,
  } = parameters;
  if (options?.workerExecution) {
    const pool = new WorkerPool({
      workerUrl: options.workerExecution.workerUrl,
      concurrency: options.workerExecution.concurrency ?? 4,
      smol: options.workerExecution.smol ?? false,
    });
    return {
      strategy: new WorkerExecutionStrategy(pool, { broadcastEvents }),
      inlineStrategy: null,
    };
  }
  const inlineStrategy = new InlineExecutionStrategy({
    getRegistration,
    getNow,
    maxNestingDepth,
    development,
    resolveWorkflowType,
  });
  return { strategy: inlineStrategy, inlineStrategy };
}

function createActivityWorkerDispatcher(
  activityExecution: EngineConstructorOptions['activityExecution'],
): ActivityWorkerDispatcher | null {
  if (!activityExecution) return null;
  return new ActivityWorkerDispatcher(
    new WorkerPool({
      workerUrl: activityExecution.workerUrl,
      concurrency: activityExecution.poolSize ?? 4,
      smol: activityExecution.smol ?? false,
    }),
  );
}

function createAlertManagerForEngine<
  TAlertWorkflows extends object,
  TAlertActivities extends object,
>(
  engine: Engine<TAlertWorkflows, TAlertActivities>,
  alerts: EngineOptions['alerts'] | undefined,
  getNow: () => number,
): AlertManager | null {
  return alerts ? new AlertManager(engine, alerts, getNow) : null;
}

export const ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING = Symbol(
  'engineParkedWorkflowCountForTesting',
);
export const ENGINE_SIGNAL_WAITER_COUNT_FOR_TESTING = Symbol('engineSignalWaiterCountForTesting');

/**
 * Durable execution engine.
 *
 * Register workflow functions with {@link Engine.register} or the typed
 * {@link Engine.withWorkflow} builder, start them with {@link Engine.start},
 * and observe or cancel them via the returned {@link WorkflowHandle}. Each
 * workflow is a generator that yields to a {@link Context}; the engine
 * persists a checkpoint at every yield so the workflow survives crashes,
 * restarts, and worker reassignment without losing progress.
 *
 * The default type parameters preserve the module-augmentation registry
 * model. Use `new Engine<{}, {}>()` when you want an engine-local registry
 * that only accepts definitions added through `withWorkflow` and
 * `withActivity`.
 *
 * @example Run a workflow with an activity
 * ```ts
 * import { activity, Engine, type Context, type WorkflowContext } from 'weft';
 * const fetchUser = activity({
 *   name: 'fetchUser',
 *   execute: async (input: unknown) => ({ name: 'Alice' }),
 * });
 * const engine = new Engine();
 * engine.register('greet', async function* (ctx: WorkflowContext, input: unknown) {
 *   const user = yield* ctx.run(fetchUser, input);
 *   return `Hello, ${user.name}`;
 * });
 * const handle = await engine.start('greet', 'user-1');
 * void handle;
 * ```
 *
 * @example With a SQLite backend
 * ```ts
 * import { Engine } from 'weft';
 * import { BunSQLiteStorage } from 'weft/storage/sqlite/bun';
 * await using storage = new BunSQLiteStorage('./weft.db');
 * await using engine = new Engine({ storage });
 * void engine;
 * ```
 */
export class Engine<
  TWorkflows extends object = DefaultWorkflowRegistry,
  TActivities extends object = ActivityTypes,
>
  extends EventTarget
  implements Disposable, AsyncDisposable
{
  /**
   * Construct, register, and recover an engine in one step. Activities are
   * registered before workflows, and recovery runs by default after all
   * definitions are installed.
   *
   * @example
   * ```ts
   * import { activity, Engine, workflow } from 'weft';
   *
   * const greet = activity({ name: 'greet', execute: async (name: string) => `Hi ${name}` });
   * const welcome = workflow({
   *   name: 'welcome',
   *   handler: async function* (ctx, input: string) {
   *     return yield* ctx.run(greet, input);
   *   },
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
  ): Promise<Engine<InferWorkflowEntries<TWorkflowDefinitions>>>;
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
    Engine<InferWorkflowEntries<TWorkflowDefinitions>, InferActivityEntries<TActivityDefinitions>>
  >;
  static async create(options: EngineCreateRuntimeOptions): Promise<unknown> {
    const engine = new Engine<object, object>(options);

    try {
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

      if (options.recover !== false) {
        const recoverOptions =
          options.acknowledgeUnknownWorkflowTypes === undefined
            ? undefined
            : { acknowledgeUnknownWorkflowTypes: options.acknowledgeUnknownWorkflowTypes };
        await engine.recoverAll(recoverOptions);
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

  constructor(options?: EngineConstructorOptions) {
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
      resolveWorkflowType: this.#resolveWorkflowTypeTarget.bind(this),
    });
    getInternals(this).storage = storage;
    getInternals(this).abortController = new AbortController();
    getInternals(this).handleCache = new Map();
    getInternals(this).resultResolvers = new Map();
    getInternals(this).signalWaiters = new Map();
    getInternals(this).signalWaitersByWorkflow = new Map();
    getInternals(this).updateWaiters = new Map();
    getInternals(this).updateWaitersByWorkflow = new Map();
    getInternals(this).sleepResolvers = new Map();
    getInternals(this).sleepResolversByWorkflow = new Map();
    getInternals(this).interceptors = resolveEngineInterceptors(options);
    getInternals(this).composedWorkflowInterceptor = undefined;
    getInternals(this).composedActivityInterceptor = undefined;
    getInternals(this).updateCoordinator = new UpdateCoordinator(storage);
    getInternals(this).activityRegistry = new ActivityRegistry();
    getInternals(this).activityWorkerDispatcher = null;
    getInternals(this).checkpoints = new Map();
    getInternals(this).broadcastChannel = null;
    getInternals(this).pendingNestingDepth = undefined;
    getInternals(this).pendingParentHeaders = undefined;
    getInternals(this).pendingExecutionStateOwnerId = undefined;
    getInternals(this).workflowNestingDepths = new Map();
    getInternals(this).workflowHeaders = new Map();
    getInternals(this).workflowStateWriteChains = new Map();
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
      getNow,
    });
    getInternals(this).strategy = strategyBundle.strategy;
    getInternals(this).inlineStrategy = strategyBundle.inlineStrategy;
    getInternals(this).queuedInlineWorkflowStarts = [];
    getInternals(this).queuedInlineWorkflowStartIds = new Set();
    getInternals(this).queuedOrLaunchingInlineWorkflowStartIds = new Set();
    getInternals(this).queuedInlineWorkflowStartFlushScheduled = false;
    const queuedInlineWorkflowStartChannel =
      strategyBundle.inlineStrategy !== null ? new MessageChannel() : null;
    getInternals(this).queuedInlineWorkflowStartChannel = queuedInlineWorkflowStartChannel;
    if (queuedInlineWorkflowStartChannel !== null) {
      queuedInlineWorkflowStartChannel.port1.onmessage = () => {
        getInternals(this).queuedInlineWorkflowStartFlushScheduled = false;
        void swallowPromiseRejection(
          flushQueuedInlineWorkflowStarts(getInternals(this), {
            processPendingUpdatesAfterInlineAdvance: (workflowId) =>
              this.#createLifecycleCallbacks().processPendingUpdatesAfterInlineAdvance(workflowId),
            swallowPromiseRejection: (promise) => swallowPromiseRejection(promise),
          }),
        );
      };
    }
    getInternals(this).tenantQuotaManager = new TenantQuotaManager(
      storage,
      getNow,
      options?.quotas,
    );
    getInternals(this).heartbeatDetails = new Map();
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
    getInternals(this).reviewTimerIds = new Map();
    getInternals(this).pendingWebhooks = new Set();
    getInternals(this).pendingTimelineEntries = new Map();
    getInternals(this).cleanupInterval = setInterval(
      createExpiredResponseCleanupTick(getInternals(this).updateCoordinator, (source, error) =>
        this.#createTerminationCallbacks().handleCleanupError(source, error),
      ),
      60_000,
    );
    getInternals(this).retentionSweepInterval = null;
    getInternals(this).retentionSweepInFlight = null;
    getInternals(this).nextRetentionSweepAt = null;
    getInternals(this).eventLogHeads = new Map();
    getInternals(this).workflowFeedListeners = new Map();
    getInternals(this).workflowVersionTuples = new Map();
    getInternals(this).activityWorkerDispatcher = createActivityWorkerDispatcher(
      options?.activityExecution,
    );
    getInternals(this).strategy.onMessage(this.#handleStrategyMessage.bind(this));
    getInternals(this).alertManager = createAlertManagerForEngine(this, options?.alerts, getNow);
    this.#ensureRetentionSweepInterval();
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
        tenantId: string,
        workflowType: string,
        key: string,
        options?: AtomicStateOptions<T>,
      ): AtomicState<T> =>
        new AtomicState<T>(storage, KEYS.stateWorkflow(tenantId, workflowType, key), options),
      tenant: <T>(tenantId: string, key: string, options?: AtomicStateOptions<T>): AtomicState<T> =>
        new AtomicState<T>(storage, KEYS.stateTenant(tenantId, key), options),
    };
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
   * Register a workflow definition and return this same engine with the
   * definition added to its phantom type registry. This is additive over the
   * module-augmented default registry; construct `new Engine<{}, {}>()` for a
   * strict local registry.
   */
  withWorkflow<TDefinition extends AnyWorkflowDefinition>(
    definition: TDefinition,
  ): Engine<TWorkflows & InferWorkflowEntry<TDefinition>, TActivities> {
    this.register(definition);
    return typedEngineView<TWorkflows & InferWorkflowEntry<TDefinition>, TActivities>(this);
  }

  /**
   * Register an activity definition and return this same engine with the
   * definition added to its phantom type registry. The callable definition is
   * registered directly so retry, timeout, schema, verification, and
   * compensation metadata stays attached to the function object.
   */
  withActivity<TDefinition extends AnyActivityDefinition>(
    definition: TDefinition,
  ): Engine<TWorkflows, TActivities & InferActivityEntry<TDefinition>> {
    this.#registerActivityDefinition(definition);
    return typedEngineView<TWorkflows, TActivities & InferActivityEntry<TDefinition>>(this);
  }

  /**
   * Register a workflow by name, registration object, or workflow definition.
   *
   * @example
   * ```ts
   * import { Engine, type WorkflowContext } from 'weft';
   *
   * const engine = new Engine();
   * engine.register('hello', async function* (_ctx: WorkflowContext, name: string) {
   *   return `Hello, ${name}`;
   * });
   * ```
   */
  register<TName extends KnownWorkflowNames<TWorkflows>>(
    name: TName,
    handler:
      | WorkflowFunction<WorkflowInput<TWorkflows, TName>, WorkflowOutput<TWorkflows, TName>>
      | StepWorkflowFunction<WorkflowInput<TWorkflows, TName>, WorkflowOutput<TWorkflows, TName>>,
  ): void;
  register<TName extends KnownWorkflowNames<TWorkflows>>(
    name: TName,
    registration: WorkflowRegistration<
      WorkflowInput<TWorkflows, TName>,
      WorkflowOutput<TWorkflows, TName>
    >,
  ): void;
  register<TName extends string, TInput = unknown, TOutput = unknown>(
    name: UnregisteredName<TName, KnownWorkflowNames<TWorkflows>>,
    handler: WorkflowFunction<TInput, TOutput> | StepWorkflowFunction<TInput, TOutput>,
  ): void;
  register<TName extends string, TInput = unknown, TOutput = unknown>(
    name: UnregisteredName<TName, KnownWorkflowNames<TWorkflows>>,
    registration: WorkflowRegistration<TInput, TOutput>,
  ): void;
  register<TDefinition extends AnyWorkflowDefinition>(definition: TDefinition): void;
  register(nameOrDefinition: unknown, handlerOrRegistrationOrOptions?: unknown): void {
    return registerWorkflow(
      getInternals(this),
      nameOrDefinition,
      handlerOrRegistrationOrOptions,
      this.#createRegistrationCallbacks(),
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

  registerActivity<TName extends Extract<keyof TActivities, string>>(
    name: TName,
    fn: RegisteredActivityFunction<TActivities, TName>,
    options?: ActivityRegistrationOptions,
  ): void;
  registerActivity<TName extends string, TResult>(
    name: UnregisteredName<TName, Extract<keyof TActivities, string>>,
    fn: () => TResult | Promise<TResult>,
    options?: ActivityRegistrationOptions,
  ): void;
  registerActivity<TName extends string, TInput, TResult>(
    name: UnregisteredName<TName, Extract<keyof TActivities, string>>,
    fn: (input: TInput, context?: ActivityContext) => TResult | Promise<TResult>,
    options?: ActivityRegistrationOptions,
  ): void;
  registerActivity(name: string, fn: Function, options?: ActivityRegistrationOptions): void {
    getInternals(this).activityRegistry.register(name, fn, options);
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
    options?: StartOptions,
  ): Promise<WorkflowHandle<WorkflowOutput<TWorkflows, TName>>>;
  async start<TName extends string>(
    type: DynamicWorkflowName<TWorkflows, TName>,
    input: unknown,
    options?: StartOptions,
  ): Promise<WorkflowHandle>;
  async start(type: string, input: unknown, options?: StartOptions): Promise<WorkflowHandle> {
    return startWorkflowFromLifecycle(
      getInternals(this),
      type,
      input,
      options,
      undefined,
      undefined,
      this.#createLifecycleCallbacks(),
    );
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
  async schedule<TInput>(
    definition: ScheduleDefinition<TInput>,
    accessOptions?: ScheduleAccessOptions,
  ): Promise<ScheduleHandle>;
  async schedule(
    type: string,
    input: unknown,
    cronExpression: string,
    options?: ScheduleOptions,
    accessOptions?: ScheduleAccessOptions,
  ): Promise<ScheduleHandle>;
  async schedule(
    typeOrDefinition: string | ScheduleDefinition,
    inputOrAccessOptions?: unknown,
    cronExpression?: string,
    options?: ScheduleOptions,
    accessOptions?: ScheduleAccessOptions,
  ): Promise<ScheduleHandle> {
    if (typeof typeOrDefinition === 'object') {
      const definition = typeOrDefinition;
      const workflowType =
        typeof definition.workflow === 'string' ? definition.workflow : definition.workflow.name;
      return scheduleFromInternals(
        getInternals(this),
        workflowType,
        definition.input,
        definition.cron,
        {
          ...(definition.id !== undefined && { id: definition.id }),
          ...(definition.overlapPolicy !== undefined && { overlap: definition.overlapPolicy }),
          ...(definition.backfill !== undefined && { backfill: definition.backfill }),
        },
        inputOrAccessOptions as ScheduleAccessOptions | undefined,
      );
    }
    if (cronExpression === undefined) {
      throw new Error('cronExpression must be provided when scheduling by workflow type.');
    }
    return scheduleFromInternals(
      getInternals(this),
      typeOrDefinition,
      inputOrAccessOptions,
      cronExpression,
      options,
      accessOptions,
    );
  }
  async getSchedule(
    scheduleId: string,
    accessOptions?: ScheduleAccessOptions,
  ): Promise<ScheduleSummary | null> {
    const normalizedScheduleId = coerceScheduleId(scheduleId, 'scheduleId');
    const normalizedAccessOptions = normalizeScheduleAccessOptions(accessOptions);
    const state = await loadScheduleState(getInternals(this), normalizedScheduleId);
    return state && canAccessSchedule(state, normalizedAccessOptions)
      ? toScheduleSummary(state)
      : null;
  }
  async listSchedules(filter?: ScheduleFilter): Promise<PaginatedResult<ScheduleSummary>> {
    return listSchedulesFromInternals(getInternals(this), filter);
  }
  async pauseSchedule(scheduleId: string, accessOptions?: ScheduleAccessOptions): Promise<void> {
    return pauseScheduleFromInternals(getInternals(this), scheduleId, accessOptions);
  }
  async resumeSchedule(scheduleId: string, accessOptions?: ScheduleAccessOptions): Promise<void> {
    return resumeScheduleFromInternals(getInternals(this), scheduleId, accessOptions);
  }
  async cancelSchedule(scheduleId: string, accessOptions?: ScheduleAccessOptions): Promise<void> {
    return cancelScheduleFromInternals(getInternals(this), scheduleId, accessOptions);
  }
  async updateSchedule(
    scheduleId: string,
    newCronExpression: string,
    accessOptions?: ScheduleAccessOptions,
  ): Promise<void> {
    return updateScheduleFromInternals(
      getInternals(this),
      scheduleId,
      newCronExpression,
      accessOptions,
    );
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
  async signal(workflowId: string, name: SignalDefinition): Promise<void>;
  async signal<TInput>(
    workflowId: string,
    name: SignalDefinition<TInput>,
    payload: TInput,
  ): Promise<void>;
  async signal(workflowId: string, name: string, payload?: unknown): Promise<void>;
  async signal(
    workflowId: string,
    nameOrDefinition: MessageName,
    payload?: unknown,
  ): Promise<void> {
    return signalWorkflow(getInternals(this), workflowId, messageName(nameOrDefinition), payload, {
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
    });
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
  async getQuotaUsage(tenantId: string): Promise<TenantQuotaUsage> {
    return getInternals(this).tenantQuotaManager.getUsage(tenantId);
  }
  async getStreamChunks(
    workflowId: string,
    key: string,
    options?: { after?: number },
  ): Promise<StoredStreamChunk[]> {
    return getStreamChunksFromInternals(getInternals(this), workflowId, key, options);
  }
  async fork(sourceWorkflowId: string, options?: ForkOptions): Promise<WorkflowHandle> {
    return forkFromLifecycle(
      getInternals(this),
      sourceWorkflowId,
      options,
      this.#createLifecycleCallbacks(),
    );
  }
  async resume(workflowId: string): Promise<WorkflowHandle> {
    return resumeFromLifecycle(getInternals(this), workflowId, this.#createLifecycleCallbacks());
  }
  /**
   * Recover every running workflow found in storage. By default, recovery
   * fails before doing any resume work if a stored running workflow has no
   * registered workflow type on this engine.
   *
   * `acknowledgeUnknownWorkflowTypes` is a dangerous escape hatch for rolling
   * deploys, explicit storage migrations, or intentional tenant partitioning.
   * When set, unknown workflow types are skipped and reported through
   * {@link WorkflowRecoverySkippedEvent}.
   */
  async recoverAll(options?: RecoverAllOptions): Promise<WorkflowHandle[]> {
    return recoverAllFromLifecycle(getInternals(this), this.#createLifecycleCallbacks(), options);
  }
  async cancel(workflowId: string): Promise<void> {
    await cancelWorkflowFromTermination(
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
  [Symbol.dispose](): void {
    const internals = getInternals(this);
    internals.alertManager?.[Symbol.dispose]();
    internals.alertManager = null;
    internals.abortController.abort();
    for (const resolveSignalWaiter of internals.signalWaiters.values()) {
      resolveSignalWaiter();
    }
    internals.signalWaiters.clear();
    internals.signalWaitersByWorkflow.clear();
    disposeQueuedInlineWorkflowStarts(internals);
    internals.scheduler[Symbol.dispose]();
    internals.strategy[Symbol.dispose]();
    internals.activityWorkerDispatcher?.[Symbol.dispose]();
    internals.activityWorkerDispatcher = null;
    internals.inlineStrategy = null;
    if (internals.cleanupInterval !== null) {
      clearInterval(internals.cleanupInterval ?? undefined);
      internals.cleanupInterval = null;
    }
    if (internals.retentionSweepInterval !== null) {
      clearInterval(internals.retentionSweepInterval ?? undefined);
      internals.retentionSweepInterval = null;
    }
    internals.nextRetentionSweepAt = null;
    internals.handleCache.clear();
    internals.resultResolvers.clear();
    internals.updateWaiters.clear();
    internals.updateWaitersByWorkflow.clear();
    internals.reviewWaiters.clear();
    internals.reviewWaitersByWorkflow.clear();
    internals.reviewEscalationHandlers.clear();
    internals.workflowReviewIds.clear();
    internals.parkedInlineWorkflows.clear();
    internals.terminalizingWorkflows.clear();
    internals.reviewTimerIds.clear();
    for (const controller of internals.pendingWebhooks) controller.abort();
    internals.pendingWebhooks.clear();
    internals.sleepResolvers.clear();
    internals.sleepResolversByWorkflow.clear();
    internals.checkpoints.clear();
    internals.pendingExecutionStateOwnerId = undefined;
    internals.workflowNestingDepths.clear();
    internals.workflowHeaders.clear();
    internals.pendingStarts.clear();
    internals.pendingScheduleCreations.clear();
    internals.eventLogHeads.clear();
    internals.pendingTimelineEntries.clear();
    internals.workflowVersionTuples.clear();
    internals.workflowFeedListeners.clear();
    internals.broadcastChannel?.close();
    internals.broadcastChannel = null;
  }
  async [Symbol.asyncDispose](): Promise<void> {
    this[Symbol.dispose]();
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
   * import { Engine } from 'weft';
   * declare const externalEntry: import('weft').TimerEntry;
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

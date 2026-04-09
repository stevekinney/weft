/**
 * Core workflow engine. Orchestrates workflow execution, manages lifecycle
 * events, and coordinates storage, scheduling, and signal delivery.
 *
 * Execution is delegated to an {@link ExecutionStrategy}. By default the
 * engine uses {@link InlineExecutionStrategy} which drives generators on
 * the main thread. A {@link WorkerExecutionStrategy} can be supplied to
 * run workflows in isolated Web Workers.
 *
 * @module core/engine
 */

import { isAgentDefinition, type AgentDefinition } from '../ai/declaration.ts';
import { HumanReviewCompletedEvent, HumanReviewRequestedEvent } from '../ai/events.ts';
import {
  ReviewCoordinator,
  ReviewTimeoutError,
  type HumanReviewOptions,
  type HumanReviewResult,
  type ReviewRequest,
} from '../ai/human-review.ts';
import type { LLMProvider } from '../ai/providers/interface.ts';
import { AlertManager } from '../alerting/alert-manager.ts';
import { CompressedStorage } from '../storage/compressed-storage.ts';
import type { Storage as WeftStorage } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { ActivityWorkerDispatcher } from '../workers/activity-worker-dispatcher.ts';
import { WorkerPool } from '../workers/pool.ts';
import type { ActivityRegistrationOptions } from './activity-registry.ts';
import { ActivityRegistry } from './activity-registry.ts';
import {
  advanceCheckpoint,
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
  validateCheckpointRoundTrip,
} from './checkpoint.ts';
import { decode, encode } from './codec.ts';
import type { ContextOperationRequest, StreamReference, StreamSink } from './context.ts';
import { Context } from './context.ts';
import {
  cleanupPartialStreamChunks,
  createAgentInterceptorExecute,
  createCleanupErrorReporter,
  createExpiredResponseCleanupTick,
  createHandleCacheFinalizer,
  executeRunAllBranches,
} from './engine-helpers.ts';
import type { EventHeadRecord } from './event-log.ts';
import { EMPTY_EVENT_HEAD, EventLog } from './event-log.ts';
import {
  AttributesChangedEvent,
  CheckpointSizeWarningEvent,
  CleanupWarningEvent,
  DevelopmentWarningEvent,
  SignalReceivedEvent,
  UpdateCompletedEvent,
  UpdateReceivedEvent,
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowResumedEvent,
  WorkflowStartedEvent,
  WorkflowTimedOutEvent,
} from './events.ts';
import type { ExecutionStrategy } from './execution-strategy.ts';
import { InlineExecutionStrategy } from './inline-execution-strategy.ts';
import type {
  ActivityInterceptor,
  ComposedActivityInterceptor,
  ComposedWorkflowInterceptor,
  WorkflowInterceptor,
} from './interceptor.ts';
import { composeActivityInterceptors, composeWorkflowInterceptors } from './interceptor.ts';
import { Scheduler, parseDuration } from './scheduler.ts';
import {
  buildIndexOperations,
  encodeAttributeValue,
  validateAttributeType,
  validateEncodedValueSize,
} from './search-attributes.ts';
import {
  compileStepWorkflow,
  isAsyncGeneratorFunction,
  isGeneratorResult,
} from './step-context.ts';
import { WorkflowTimeoutError } from './timeouts.ts';
import type {
  AttributeFilter,
  Checkpoint,
  CoordinatedUpdateResult,
  EngineOptions,
  ListFilter,
  OperationOutcome,
  PaginatedResult,
  SearchAttributeSchema,
  SearchAttributeValue,
  StartOptions,
  StepWorkflowFunction,
  SubmitReviewOptions,
  WorkerOutboundMessage,
  WorkflowEvent,
  WorkflowFunction,
  WorkflowRegistration,
  WorkflowState,
  WorkflowStatus,
  WorkflowSummary,
} from './types.ts';
import {
  UpdateCoordinator,
  UpdateTimeoutError,
  WorkflowTerminalError,
  type UpdateRequest,
} from './updates.ts';
import { checkVersionCompatibility, migrateCheckpoint } from './versioning.ts';
import { WorkerExecutionStrategy } from './worker-execution-strategy.ts';

declare global {
  interface SymbolConstructor {
    readonly observable: unique symbol;
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface RegistrationEntry {
  handler: WorkflowFunction;
  version: string;
  migrate?: (checkpoint: unknown, fromVersion: string) => unknown;
  searchAttributes?: SearchAttributeSchema;
  /** True when this registration originated from an AgentDefinition. */
  isAgent?: boolean;
  /** LLM provider for agent-typed registrations (used for connection pre-warming). */
  provider?: LLMProvider;
}

/** Options required when registering an AgentDefinition as a workflow. */
export interface AgentRegistrationOptions {
  /** The LLM provider to use when running the agent. */
  provider: LLMProvider;
}

interface ResolvedOptions {
  storage: WeftStorage;
  development: boolean;
  checkpointHistory: number;
  checkpointSizeWarningThreshold: number;
  maxNestingDepth: number;
  broadcastEvents: boolean;
  getNow: () => number;
  tenantResolver: import('./tenant.ts').TenantResolver | undefined;
}

interface WorkflowResultResolver {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

type EngineConstructorOptions = Partial<EngineOptions> & { getNow?: () => number };

type ExecutionStrategyBundle = {
  strategy: ExecutionStrategy;
  inlineStrategy: InlineExecutionStrategy | null;
};

type OperationWithCallerStack = {
  callerStack?: string;
};

type ConsumedSignalResult =
  | { found: false }
  | {
      found: true;
      payload: unknown;
    };

type WorkflowHandleEventQueue = {
  events: Event[];
  resolver: (() => void) | undefined;
};

type WorkflowHandleIteratorState = {
  done: boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely cast a `Function` stored on a ContextOperationRequest
 * to a callable signature.  We trust the Context layer to populate
 * `fn` with the correct reference—the Engine merely invokes it.
 */
function callActivityFunction(fn: Function, args: unknown[]): unknown {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return
  return (fn as (...a: unknown[]) => unknown)(...args);
}

function callMemoFunction(fn: Function): unknown {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return
  return (fn as () => unknown)();
}

/**
 * Type predicate that validates a decoded `tenant` field is shaped like a
 * {@link import('./tenant.ts').TenantContext}. Returns true only when `tenant`
 * is `undefined`, or an object with a non-empty string `id` and (when present)
 * an `attributes` object. Defensive because `state.tenant` is fed directly
 * into agent `validateInput` and `toolsForTenant` hooks; a corrupt or tampered
 * storage record could otherwise inject a forged tenant identity into
 * security decisions.
 *
 * `null` is rejected intentionally — the canonical "no tenant" value is
 * `undefined`. A stored `null` indicates corruption.
 */
function isValidDecodedTenant(
  value: unknown,
): value is import('./tenant.ts').TenantContext | undefined {
  if (value === undefined) return true;
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const id = record['id'];
  if (typeof id !== 'string' || id.length === 0) return false;
  const attributes = record['attributes'];
  if (attributes !== undefined && (attributes === null || typeof attributes !== 'object')) {
    return false;
  }
  return true;
}

function decodeWorkflowState(bytes: Uint8Array): WorkflowState {
  // bytes were written by encode(WorkflowState) — shape is guaranteed by our own storage
  const state = decode(bytes) as WorkflowState;
  // Defensive check on the security-relevant tenant field. Other fields are
  // trusted by construction, but `tenant` feeds directly into agent decision
  // functions so we refuse to propagate a forged identity. On invalid shape we
  // log a warning and fall back to `undefined` (the safe default) rather than
  // throwing — refusing to decode would break recovery for unrelated workflows
  // sharing the same storage backend.
  if (!isValidDecodedTenant(state.tenant)) {
    console.warn(
      `[weft] Decoded workflow state for "${String(state.id)}" has an invalid tenant field; ` +
        `falling back to undefined tenant. This usually indicates corruption or tampering of ` +
        `the storage record.`,
    );
    delete state.tenant;
  }
  return state;
}

function enqueueWorkflowHandleEvent(queue: WorkflowHandleEventQueue, event: Event): void {
  queue.events.push(event);
  queue.resolver?.();
}

function finishWorkflowHandleIteration(
  state: WorkflowHandleIteratorState,
  queue: WorkflowHandleEventQueue,
  event: Event,
): void {
  // Guard against the "synthesized terminal event already landed" race: when
  // iteration starts after a workflow has already finished, the asyncIterator
  // synthesizes a terminal event from persisted state and sets `state.done =
  // true`. If the real terminal event then arrives (because it was in flight
  // between `addEventListener` and `await this.#engine.get()`), we must not
  // enqueue it a second time — the test suite asserts terminal events are
  // yielded exactly once.
  if (state.done) return;
  state.done = true;
  enqueueWorkflowHandleEvent(queue, event);
}

/**
 * Build a synthetic terminal event matching the persisted status of a
 * workflow that has already finished. Returns `null` for non-terminal states.
 *
 * Used by {@link WorkflowHandle[Symbol.asyncIterator]} and
 * {@link WorkflowHandle[Symbol.observable]} to avoid hanging when a consumer
 * starts iterating after the workflow has already reached a terminal state —
 * the real terminal event was dispatched before any listener was attached and
 * will never re-fire.
 */
function synthesizeTerminalEventFromState(state: WorkflowState): Event | null {
  switch (state.status) {
    case 'completed': {
      const duration = state.updatedAt - state.createdAt;
      return new WorkflowCompletedEvent(state.id, state.result, duration);
    }
    case 'failed': {
      const error = new Error(state.error ?? 'Workflow failed');
      if (state.errorStack) error.stack = state.errorStack;
      return new WorkflowFailedEvent(state.id, error);
    }
    case 'cancelled':
      return new WorkflowCancelledEvent(state.id);
    case 'timed-out': {
      // Mirror the real dispatch in `#terminateWorkflow`, which computes
      // `elapsed` as `getNow() - state.createdAt` and then persists the
      // termination wall-clock time as `state.updatedAt`. Reading
      // `updatedAt - createdAt` here recovers the same value the real event
      // carried; `executionDeadline` would be the configured timeout budget
      // instead of the actual elapsed, which is a subtly different number
      // when the scheduler ticks past the deadline.
      const elapsed = state.updatedAt - state.createdAt;
      return new WorkflowTimedOutEvent(state.id, 'execution', elapsed);
    }
    default:
      return null;
  }
}

function resolveEngineStorage(
  options?: EngineConstructorOptions,
  getAgentWorkflowIds?: () => ReadonlySet<string>,
): WeftStorage {
  const baseStorage = options?.storage ?? new MemoryStorage();
  if (!options?.compression) return baseStorage;
  return new CompressedStorage(baseStorage, {
    ...options.compression,
    ...(getAgentWorkflowIds
      ? {
          agentWorkflowIds: getAgentWorkflowIds,
          // Default to brotli for agent checkpoints (conversation data compresses
          // exceptionally well with brotli). Users may override via compression.agentAlgorithm.
          agentAlgorithm: options.compression.agentAlgorithm ?? 'brotli',
          ...(options.compression.agentThreshold !== undefined
            ? { agentThreshold: options.compression.agentThreshold }
            : {}),
        }
      : {}),
  });
}

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
}): ExecutionStrategyBundle {
  const { options, getNow, maxNestingDepth, development, broadcastEvents, getRegistration } =
    parameters;

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
  });

  return {
    strategy: inlineStrategy,
    inlineStrategy,
  };
}

function createActivityWorkerDispatcher(
  activityExecution: EngineConstructorOptions['activityExecution'],
): ActivityWorkerDispatcher | null {
  if (!activityExecution) {
    return null;
  }

  const activityPool = new WorkerPool({
    workerUrl: activityExecution.workerUrl,
    concurrency: activityExecution.poolSize ?? 4,
    smol: activityExecution.smol ?? false,
  });
  return new ActivityWorkerDispatcher(activityPool);
}

function createAlertManagerForEngine(
  engine: Engine,
  alerts: EngineOptions['alerts'] | undefined,
  getNow: () => number,
): AlertManager | null {
  return alerts ? new AlertManager(engine, alerts, getNow) : null;
}

/**
 * Maximum number of attribute-index scans to run in parallel during a single
 * `engine.list()` call. Bounds fan-out on connection-limited storage backends.
 */
const ATTRIBUTE_SCAN_CONCURRENCY = 8;

function intersectIdentifierSets(idSets: Set<string>[]): Set<string> | null {
  const [firstSet, ...remainingSets] = idSets;
  if (!firstSet) {
    return null;
  }

  const intersected = new Set(firstSet);
  for (const nextSet of remainingSets) {
    for (const id of intersected) {
      if (!nextSet.has(id)) {
        intersected.delete(id);
      }
    }
  }

  return intersected;
}

function matchesListFilter(
  state: WorkflowState,
  filter: ListFilter | undefined,
  constrainedIds: Set<string> | null,
): boolean {
  if (constrainedIds !== null && !constrainedIds.has(state.id)) {
    return false;
  }

  if (filter?.status !== undefined) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!statuses.includes(state.status)) {
      return false;
    }
  }

  return filter?.type === undefined || state.type === filter.type;
}

/**
 * Slice an in-memory list of {@link WorkflowSummary} into a {@link PaginatedResult}.
 *
 * Important note on `total` semantics: the returned `total` reflects the number
 * of workflows that matched the supplied {@link ListFilter} (status, type, and
 * search attribute filters). It is **not** the absolute count of workflows in
 * storage. A UI computing "page 1 of N" from `total` will see the page count
 * for the active filter; the unfiltered population is intentionally not
 * surfaced through this response, since recovering it would require a separate
 * full scan that defeats the purpose of the filter fast path.
 */
function paginateWorkflowSummaries(
  items: WorkflowSummary[],
  filter?: ListFilter,
): PaginatedResult<WorkflowSummary> {
  const offset = filter?.offset ?? 0;
  const limit = filter?.limit ?? items.length;
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    offset,
    limit,
  };
}

// ---------------------------------------------------------------------------
// WorkflowHandle
// ---------------------------------------------------------------------------

export class WorkflowHandle extends EventTarget implements AsyncDisposable {
  readonly id: string;
  readonly #engine: Engine;
  readonly #resultPromise: Promise<unknown>;

  constructor(id: string, engine: Engine, resultPromise: Promise<unknown>) {
    super();
    this.id = id;
    this.#engine = engine;
    this.#resultPromise = resultPromise;
  }

  async result(): Promise<unknown> {
    return this.#resultPromise;
  }

  async cancel(): Promise<void> {
    return this.#engine.cancel(this.id);
  }

  async signal(name: string, payload?: unknown): Promise<void> {
    return this.#engine.signal(this.id, name, payload);
  }

  async update(name: string, payload?: unknown, options?: { timeout?: number }): Promise<unknown> {
    return this.#engine.update(this.id, name, payload, options);
  }

  async query(name: string): Promise<unknown> {
    return this.#engine.query(this.id, name);
  }

  async getAttributes(): Promise<Record<string, SearchAttributeValue> | null> {
    return this.#engine.getAttributes(this.id);
  }

  async setAttributes(attributes: Record<string, SearchAttributeValue>): Promise<void> {
    return this.#engine.setAttributes(this.id, attributes);
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<Event> {
    const queue: WorkflowHandleEventQueue = { events: [], resolver: undefined };
    const state = { done: false };
    const listener = enqueueWorkflowHandleEvent.bind(undefined, queue);
    const terminal = finishWorkflowHandleIteration.bind(undefined, state, queue);

    // Non-terminal events use the plain enqueuing listener; terminal events
    // use `terminal`, which both enqueues the event AND sets `state.done =
    // true`. Registering `listener` and `terminal` on the same type would
    // enqueue the terminal event twice, so terminal types are handled only by
    // `terminal`.
    const nonTerminalTypes = ['activity:started', 'activity:completed', 'signal:received'];
    const terminalTypes = [
      'workflow:completed',
      'workflow:failed',
      'workflow:cancelled',
      'workflow:timed-out',
    ];

    for (const type of nonTerminalTypes) {
      this.addEventListener(type, listener);
    }
    for (const type of terminalTypes) {
      this.addEventListener(type, terminal);
    }

    try {
      // Guard against the "started iterating after workflow already finished"
      // hang: terminal events fire exactly once and are not replayed, so a
      // consumer that attaches listeners post-termination would wait forever.
      // We intentionally attach listeners BEFORE checking persisted status so
      // the race is trivially safe — if the workflow transitions between
      // listener attachment and the status read, the real event is already
      // queued and `state.done` is true, and we skip synthesis.
      if (!state.done) {
        const persisted = await this.#engine.get(this.id);
        if (persisted && !state.done) {
          const synthetic = synthesizeTerminalEventFromState(persisted);
          if (synthetic) {
            queue.events.push(synthetic);
            state.done = true;
          }
        }
      }

      while (!state.done || queue.events.length > 0) {
        if (queue.events.length === 0) {
          const { promise, resolve } = Promise.withResolvers<void>();
          queue.resolver = resolve;
          await promise;
          queue.resolver = undefined;
        }
        while (queue.events.length > 0) {
          yield queue.events.shift()!;
        }
      }
    } finally {
      for (const type of nonTerminalTypes) {
        this.removeEventListener(type, listener);
      }
      for (const type of terminalTypes) {
        this.removeEventListener(type, terminal);
      }
    }
  }

  [Symbol.observable](): {
    subscribe: (observer: {
      next?: (event: Event) => void;
      complete?: () => void;
      error?: (error: Error) => void;
    }) => { unsubscribe: () => void };
  } {
    return {
      subscribe: (observer: {
        next?: (event: Event) => void;
        complete?: () => void;
        error?: (error: Error) => void;
      }) => {
        const controller = new AbortController();
        const nextListener = observer.next?.bind(observer);

        const types = [
          'workflow:completed',
          'workflow:failed',
          'workflow:cancelled',
          'workflow:timed-out',
          'activity:started',
          'activity:completed',
        ];

        // Track whether the subscription has been terminated (via `complete`
        // or `error`). Per the Observable contract these are mutually
        // exclusive — once one fires, the subscription is closed and no
        // further `next`/`error`/`complete` notifications may be delivered.
        // This flag is checked by EVERY listener (not just error/complete)
        // so that a late real terminal event arriving after a synthesized
        // one cannot re-emit `observer.next` after the subscription is
        // already closed.
        let terminalDelivered = false;

        if (nextListener) {
          const guardedNext = (event: Event) => {
            if (terminalDelivered) return;
            nextListener(event);
          };
          for (const type of types) {
            this.addEventListener(type, guardedNext, { signal: controller.signal });
          }
        }

        // errorHandler terminates the subscription with `error` for the two
        // error-terminal event types and marks the subscription delivered so
        // the `complete` dispatcher below does not also fire — per the
        // Observable contract, `error` and `complete` are mutually exclusive.
        const errorHandler = (event: Event) => {
          if (terminalDelivered) return;
          if (event instanceof WorkflowFailedEvent) {
            terminalDelivered = true;
            observer.error?.(event.error);
          } else if (event instanceof WorkflowTimedOutEvent) {
            terminalDelivered = true;
            observer.error?.(
              new WorkflowTimeoutError(event.workflowId, event.timeoutType, event.elapsed),
            );
          }
        };
        this.addEventListener('workflow:failed', errorHandler, { signal: controller.signal });
        this.addEventListener('workflow:timed-out', errorHandler, { signal: controller.signal });

        // completeDispatcher fires `complete()` on the two non-error terminal
        // statuses. Previously only `workflow:completed` was wired, which
        // meant subscribers to a cancelled workflow never saw `complete` —
        // this closes that latent bug. `failed` and `timed-out` deliberately
        // do not register here because they terminate via `error` instead.
        const completeListener = observer.complete?.bind(observer);
        const completeDispatcher = () => {
          if (terminalDelivered) return;
          terminalDelivered = true;
          completeListener?.();
        };
        this.addEventListener('workflow:completed', completeDispatcher, {
          signal: controller.signal,
        });
        this.addEventListener('workflow:cancelled', completeDispatcher, {
          signal: controller.signal,
        });

        // Guard against the "subscribed after workflow already finished"
        // hang: terminal events fire once and are not replayed. Listeners
        // are attached synchronously above, so if the workflow transitions
        // between attachment and the async status read, the real event wins
        // and `terminalDelivered` is set, causing us to skip synthesis.
        //
        // We deliver the synthetic event directly to this subscription's
        // handlers rather than via `this.dispatchEvent(...)`, which would
        // broadcast the event to every other listener on the handle
        // (concurrent iterators, other observables, application code). The
        // synthetic event is a private reconstruction for this subscription
        // alone and must not leak into the handle's global dispatch stream.
        void (async () => {
          const persisted = await this.#engine.get(this.id);
          if (controller.signal.aborted || terminalDelivered || !persisted) return;
          const synthetic = synthesizeTerminalEventFromState(persisted);
          if (!synthetic) return;
          // Mirror the dispatch order EventTarget would use: next → error or
          // complete. The `terminalDelivered` guard is already respected
          // inside each handler.
          nextListener?.(synthetic);
          if (synthetic instanceof WorkflowFailedEvent) {
            errorHandler(synthetic);
          } else if (synthetic instanceof WorkflowTimedOutEvent) {
            errorHandler(synthetic);
          } else {
            completeDispatcher();
          }
        })();

        return {
          unsubscribe: controller.abort.bind(controller),
        };
      },
    };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    // No-op for now; handles are lightweight
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Durable execution engine.
 *
 * Register workflow functions with {@link Engine.register}, start them with
 * {@link Engine.start}, and query or cancel them via the returned
 * {@link WorkflowHandle}. Each workflow is a generator that yields to a
 * {@link Context}; the engine persists a checkpoint at every yield so the
 * workflow survives crashes, restarts, and worker reassignment without
 * losing progress.
 *
 * @example Run a workflow with an activity
 * ```ts
 * import { Engine, activity } from 'weft';
 *
 * const fetchUser = activity('fetchUser', async (id: string) => {
 *   const response = await fetch(`https://api.example.com/users/${id}`);
 *   return response.json();
 * });
 *
 * const engine = new Engine();
 * engine.register('greet-user', async function* (ctx, id: string) {
 *   const user = yield* ctx.run(fetchUser, id);
 *   return `Hello, ${(user as { name: string }).name}`;
 * });
 *
 * const handle = await engine.start('greet-user', 'user-123');
 * const greeting = await handle.result();
 * ```
 *
 * @example Run with a SQLite backend
 * ```ts
 * import { Engine } from 'weft';
 * import { BunSQLiteStorage } from 'weft/storage/bun-sqlite';
 *
 * await using storage = new BunSQLiteStorage('./weft.db');
 * await using engine = new Engine({ storage });
 * // ...register and start workflows
 * ```
 */
export class Engine extends EventTarget implements Disposable, AsyncDisposable {
  #storage: WeftStorage;
  #registrations: Map<string, RegistrationEntry>;
  #abortController: AbortController;
  #scheduler: Scheduler;
  #options: ResolvedOptions;
  #strategy: ExecutionStrategy;
  #inlineStrategy: InlineExecutionStrategy | null;
  #handleCache: Map<string, { ref: WeakRef<WorkflowHandle>; unregisterToken: object }>;
  #finalizationRegistry: FinalizationRegistry<string>;
  #resultResolvers: Map<string, WorkflowResultResolver>;
  #signalWaiters: Map<string, () => void>;
  #updateWaiters: Map<string, (payload: unknown) => void>;
  #sleepResolvers: Map<string, () => void>;
  #sleepResolversByWorkflow: Map<string, Set<string>>;
  #interceptors: WorkflowInterceptor[];
  #activityInterceptors: ActivityInterceptor[];
  #composedWorkflowInterceptor: ComposedWorkflowInterceptor | null;
  #composedActivityInterceptor: ComposedActivityInterceptor | null;
  #updateCoordinator: UpdateCoordinator;
  #activityRegistry: ActivityRegistry;
  #activityWorkerDispatcher: ActivityWorkerDispatcher | null;
  #checkpoints: Map<string, Checkpoint>;
  #broadcastChannel: BroadcastChannel | null;
  #pendingNestingDepth: number | undefined;
  #pendingParentHeaders: Map<string, string> | undefined;
  #workflowNestingDepths: Map<string, number>;
  #workflowHeaders: Map<string, Map<string, string>>;
  #budgetPolicyEnforcer: import('../ai/budget-policy.ts').BudgetPolicyEnforcer | null;
  #heartbeatDetails: Map<string, unknown>;
  #pendingStarts: Set<string>;
  /**
   * Dedup set for recorded agent operation budget costs. Entries live here
   * for the lifetime of their parent workflow and are removed in
   * `#cleanupTerminalWorkflow` so the set does not grow unbounded.
   *
   * Removal is O(1) per workflow because `#chargedAgentOperationsByWorkflow`
   * keeps a reverse index — see `#recordAgentBudgetCost` for the write path.
   */
  #chargedAgentOperations: Set<string>;
  /**
   * Reverse index from `workflowId` to the set of operation ids it charged.
   * Lets terminal-state cleanup drop the workflow's dedup entries in O(k)
   * where k is that workflow's agent operation count, rather than scanning
   * the engine-wide `#chargedAgentOperations` set.
   */
  #chargedAgentOperationsByWorkflow: Map<string, Set<string>>;
  #cleanupInterval: ReturnType<typeof setInterval> | null;
  #defaultModelRouter: import('../ai/model-router.ts').ModelRouter | undefined;
  #reviewCoordinator: ReviewCoordinator;
  #reviewWaiters: Map<string, (decision: HumanReviewResult) => void>;
  #reviewEscalationHandlers: Map<
    string,
    (entry: { id: string; workflowId: string }) => Promise<boolean>
  >;
  #workflowReviewIds: Map<string, Set<string>>;
  /** Timer IDs scheduled for each review (escalation + timeout), keyed by reviewId. */
  #reviewTimerIds: Map<string, string[]>;
  #pendingWebhooks: Set<AbortController>;
  #alertManager: AlertManager | null;
  /** Tracks workflow IDs that belong to agent-typed workflows for optimization. */
  #agentWorkflowIds = new Set<string>();
  /**
   * In-memory cache of the event log head for each workflow.
   * Avoids a storage.get() in the checkpoint hot path by keeping the latest
   * sequence number and hash in memory. Cleared when a workflow is cleaned up.
   */
  #eventLogHeads: Map<string, EventHeadRecord> = new Map();

  constructor(options?: EngineConstructorOptions) {
    super();

    this.#registrations = new Map();

    const storage = resolveEngineStorage(options, this.#getAgentWorkflowIds.bind(this));
    const getNow = options?.getNow ?? Date.now;
    const resolvedOptions = resolveEngineOptions(storage, options, getNow);
    const strategyBundle = createExecutionStrategyBundle({
      options,
      getNow,
      maxNestingDepth: resolvedOptions.maxNestingDepth,
      development: resolvedOptions.development,
      broadcastEvents: resolvedOptions.broadcastEvents,
      getRegistration: this.#registrations.get.bind(this.#registrations),
    });

    this.#storage = storage;
    this.#abortController = new AbortController();
    this.#handleCache = new Map();
    this.#resultResolvers = new Map();
    this.#signalWaiters = new Map();
    this.#updateWaiters = new Map();
    this.#sleepResolvers = new Map();
    this.#sleepResolversByWorkflow = new Map();
    this.#interceptors = [];
    this.#activityInterceptors = [];
    this.#composedWorkflowInterceptor = null;
    this.#composedActivityInterceptor = null;
    this.#updateCoordinator = new UpdateCoordinator(storage);
    this.#activityRegistry = new ActivityRegistry();
    this.#activityWorkerDispatcher = null;
    this.#checkpoints = new Map();
    this.#broadcastChannel = null;
    this.#pendingNestingDepth = undefined;
    this.#pendingParentHeaders = undefined;
    this.#workflowNestingDepths = new Map();
    this.#workflowHeaders = new Map();
    this.#finalizationRegistry = new FinalizationRegistry<string>(
      createHandleCacheFinalizer(this.#handleCache),
    );

    this.#options = resolvedOptions;

    this.#defaultModelRouter = options?.defaultModelRouter;
    this.#scheduler = new Scheduler({
      storage,
      onTimerFired: this.#handleTimerFired.bind(this),
      getNow,
    });
    this.#strategy = strategyBundle.strategy;
    this.#inlineStrategy = strategyBundle.inlineStrategy;

    this.#budgetPolicyEnforcer = null;
    this.#heartbeatDetails = new Map();
    this.#pendingStarts = new Set();
    this.#chargedAgentOperations = new Set();
    this.#chargedAgentOperationsByWorkflow = new Map();
    this.#reviewCoordinator = new ReviewCoordinator(storage, getNow);
    this.#reviewWaiters = new Map();
    this.#reviewEscalationHandlers = new Map();
    this.#workflowReviewIds = new Map();
    this.#reviewTimerIds = new Map();
    this.#pendingWebhooks = new Set();
    this.#cleanupInterval = setInterval(
      createExpiredResponseCleanupTick(
        this.#updateCoordinator,
        this.#handleCleanupError.bind(this),
      ),
      60_000,
    );

    this.#activityWorkerDispatcher = createActivityWorkerDispatcher(options?.activityExecution);

    // Wire up the strategy message handler
    this.#strategy.onMessage(this.#handleStrategyMessage.bind(this));

    this.#alertManager = createAlertManagerForEngine(this, options?.alerts, getNow);
  }

  async #swallowPromiseRejection(promise: Promise<unknown> | undefined): Promise<void> {
    if (!promise) {
      return;
    }

    try {
      await promise;
    } catch {
      // Best-effort cleanup and warmup operations intentionally ignore rejections.
    }
  }

  #getAgentWorkflowIds(): ReadonlySet<string> {
    return this.#agentWorkflowIds;
  }

  async #processPendingUpdatesAfterReplay(workflowId: string): Promise<void> {
    try {
      await this.#processPendingUpdatesForHandlers(workflowId);
    } catch (error: unknown) {
      this.#handleCleanupError('processPendingUpdates', error, workflowId);
    }
  }

  async #persistCoordinatedUpdateResponse(
    workflowId: string,
    updateName: string,
    updateId: string,
    idempotencyKey: string | undefined,
    value: unknown,
  ): Promise<void> {
    const responseOperations = this.#updateCoordinator.buildResponseOperations(
      updateId,
      workflowId,
      value,
      undefined,
      idempotencyKey,
    );

    try {
      await this.#storage.batch(responseOperations);
      this.dispatchEvent(new UpdateCompletedEvent(updateId, workflowId, updateName, value));
      this.#broadcast({
        type: 'update:completed',
        workflowId,
        updateId,
      });
    } catch (error: unknown) {
      this.#handleCleanupError('writeCoordinatedUpdateResponse', error, workflowId);
    }
  }

  #resolveChainedResult(
    originalResolve: (value: unknown) => void,
    chainedResolve: (value: unknown) => void,
    value: unknown,
  ): void {
    originalResolve(value);
    chainedResolve(value);
  }

  #rejectChainedResult(
    originalReject: (reason: unknown) => void,
    chainedReject: (reason: unknown) => void,
    reason: unknown,
  ): void {
    originalReject(reason);
    chainedReject(reason);
  }

  #resolveReviewDecision(
    resolve: (result: { ok: true; value: HumanReviewResult }) => void,
    decision: HumanReviewResult,
  ): void {
    resolve({ ok: true, value: decision });
  }

  #captureWorkflowStartHeaders(
    workflowId: string,
    interception: { headers: Map<string, string> },
  ): void {
    this.#workflowHeaders.set(workflowId, interception.headers);
  }

  async #handleReviewEscalationTimer(
    workflowId: string,
    reviewId: string,
    waiterKey: string,
    reviewRequest: import('../ai/human-review.ts').ReviewRequest,
    options: HumanReviewOptions,
    resolve: (result: { ok: true; value: HumanReviewResult } | { ok: false; error: Error }) => void,
    entry: { id: string; workflowId: string },
  ): Promise<boolean> {
    if (
      !entry.id.startsWith(`review-escalation:${reviewId}:`) &&
      entry.id !== `review-timeout:${reviewId}`
    ) {
      return false;
    }

    if (entry.id === `review-timeout:${reviewId}`) {
      this.#reviewWaiters.delete(waiterKey);
      const elapsed = this.#options.getNow() - reviewRequest.createdAt;
      await this.#storage.delete(KEYS.review(workflowId, reviewId));

      const timeoutError = new ReviewTimeoutError(reviewId, elapsed);
      await this.#failWorkflow(workflowId, timeoutError);
      resolve({ ok: false, error: timeoutError });
      return true;
    }

    if (!options.escalation) {
      return false;
    }

    const action = this.#reviewCoordinator.checkEscalations(
      reviewRequest,
      options.escalation,
      this.#options.getNow(),
    );

    if (!action) {
      return false;
    }

    if (action.type === 'escalate') {
      options.onEscalation?.(action);
      return false;
    }

    this.#reviewWaiters.delete(waiterKey);
    const autoResult: HumanReviewResult = {
      reviewId,
      decision: action.decision,
      reviewer: 'system',
      feedback: action.auditReason,
      timestamp: this.#options.getNow(),
    };

    await this.#storage.delete(KEYS.review(workflowId, reviewId));
    resolve({ ok: true, value: autoResult });
    return true;
  }

  async #sendReviewWebhook(
    workflowId: string,
    reviewRequest: import('../ai/human-review.ts').ReviewRequest,
    webhookUrl: string,
    webhookAbort: AbortController,
  ): Promise<void> {
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowId,
          reviewId: reviewRequest.reviewId,
          reviewType: reviewRequest.reviewType,
          reviewers: reviewRequest.reviewers,
          artifact: reviewRequest.artifact,
        }),
        signal: webhookAbort.signal,
      });
    } catch (error: unknown) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        console.warn(`[weft] Failed to send review webhook for ${reviewRequest.reviewId}`, error);
      }
    } finally {
      this.#pendingWebhooks.delete(webhookAbort);
    }
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  register(name: string, handler: WorkflowFunction | StepWorkflowFunction): void;
  register(name: string, registration: WorkflowRegistration): void;
  register(agentDef: AgentDefinition, options: AgentRegistrationOptions): void;
  register(
    nameOrAgent: string | AgentDefinition,
    handlerOrRegistrationOrOptions?:
      | WorkflowFunction
      | StepWorkflowFunction
      | WorkflowRegistration
      | AgentRegistrationOptions,
  ): void {
    // --- AgentDefinition overload ---
    if (isAgentDefinition(nameOrAgent)) {
      const agentDef = nameOrAgent;
      const agentOptions = handlerOrRegistrationOrOptions as AgentRegistrationOptions;

      // Build a workflow function that delegates to ctx.agent(), ensuring the
      // agent execution flows through the engine's operation handler for budget
      // policy enforcement, observability, and durable checkpointing.
      const handler: WorkflowFunction = async function* (ctx, input) {
        const tenant = ctx.tenant;

        // Per-tenant input validation runs before any tool resolution so a
        // malformed payload fails fast without burning budget.
        if (agentDef.validateInput) {
          agentDef.validateInput(input, tenant);
        }

        // Resolve the effective tool set: per-tenant override takes precedence
        // over the static definition.
        const effectiveTools = agentDef.toolsForTenant
          ? agentDef.toolsForTenant(tenant)
          : agentDef.tools;

        const prompt = typeof input === 'string' ? input : JSON.stringify(input);
        const agentOpts: import('./context.ts').AgentContextOptions = {
          model: agentDef.model,
          prompt,
          provider: agentOptions.provider,
        };
        if (agentDef.systemPrompt) agentOpts.systemPrompt = agentDef.systemPrompt;
        if (effectiveTools) agentOpts.tools = effectiveTools;
        if (agentDef.maxTurns !== undefined) agentOpts.maxTurns = agentDef.maxTurns;
        if (agentDef.budget) agentOpts.budget = agentDef.budget;
        if (agentDef.modelRouter) agentOpts.modelRouter = agentDef.modelRouter;
        if (agentDef.contextStrategy) agentOpts.contextStrategy = agentDef.contextStrategy;
        if (agentDef.hooks) agentOpts.hooks = agentDef.hooks;

        const result = yield* (ctx as Context).agent(agentOpts);
        return result;
      };

      this.#registrations.set(agentDef.name, {
        handler,
        version: '1',
        isAgent: true,
        provider: agentOptions.provider,
      });
      return;
    }

    // --- Existing overloads (name + handler/registration) ---
    const name = nameOrAgent;
    const handlerOrRegistration = handlerOrRegistrationOrOptions as
      | WorkflowFunction
      | StepWorkflowFunction
      | WorkflowRegistration;

    const isRegistration =
      typeof handlerOrRegistration === 'object' &&
      handlerOrRegistration !== null &&
      'handler' in handlerOrRegistration;

    if (isRegistration) {
      const registration = handlerOrRegistration;
      const entry: RegistrationEntry = {
        handler: registration.handler,
        version: registration.version ?? '1',
      };
      if (registration.migrate) {
        entry.migrate = registration.migrate;
      }
      if (registration.searchAttributes) {
        entry.searchAttributes = registration.searchAttributes;
      }
      this.#registrations.set(name, entry);
    } else {
      // Auto-detect step-based (non-generator) workflow functions and compile them
      let handler = handlerOrRegistration;
      if (typeof handler === 'function' && !isAsyncGeneratorFunction(handler)) {
        handler = compileStepWorkflow(handler as StepWorkflowFunction);
      }

      this.#registrations.set(name, {
        handler: handler as WorkflowFunction,
        version: '1',
      });
    }
  }

  // -------------------------------------------------------------------------
  // Interceptor registration
  // -------------------------------------------------------------------------

  addInterceptor(interceptor: WorkflowInterceptor): void {
    this.#interceptors.push(interceptor);
    this.#composedWorkflowInterceptor = null;
  }

  addActivityInterceptor(interceptor: ActivityInterceptor): void {
    this.#activityInterceptors.push(interceptor);
    this.#composedActivityInterceptor = null;
  }

  #getComposedWorkflowInterceptor(): ComposedWorkflowInterceptor | null {
    if (this.#interceptors.length === 0) return null;
    this.#composedWorkflowInterceptor ??= composeWorkflowInterceptors(this.#interceptors);
    return this.#composedWorkflowInterceptor;
  }

  #getComposedActivityInterceptor(): ComposedActivityInterceptor | null {
    if (this.#activityInterceptors.length === 0) return null;
    this.#composedActivityInterceptor ??= composeActivityInterceptors(this.#activityInterceptors);
    return this.#composedActivityInterceptor;
  }

  // -------------------------------------------------------------------------
  // Activity registration (for worker-based execution)
  // -------------------------------------------------------------------------

  /**
   * Register a named activity function. In worker mode, the generator yields
   * an operation request with `activityName` (not a function reference). The
   * engine uses this registry to look up the function by name and execute it
   * on the main thread.
   *
   * If `fn` was created via the `activity()` helper, metadata (retry, timeout,
   * queue, idempotent) is auto-extracted from its colocated properties.
   * Explicit `options` take precedence over auto-extracted values.
   */
  registerActivity(
    name: string,
    fn: (...arguments_: unknown[]) => unknown,
    options?: ActivityRegistrationOptions,
  ): void {
    this.#activityRegistry.register(name, fn, options);
  }

  // -------------------------------------------------------------------------
  // Start workflow
  // -------------------------------------------------------------------------

  async start(type: string, input: unknown, options?: StartOptions): Promise<WorkflowHandle> {
    const registration = this.#registrations.get(type);
    if (!registration) {
      throw new Error(`No workflow registered with name "${type}"`);
    }

    if (options?.id !== undefined && options.id.length === 0) {
      throw new Error('options.id must not be an empty string');
    }
    const callerProvidedId = options?.id !== undefined;
    const workflowId = options?.id ?? crypto.randomUUID();

    // Capture and clear pending parent headers immediately, before any async
    // work, to prevent a concurrent child-workflow start from overwriting them.
    const parentHeaders = this.#pendingParentHeaders;
    this.#pendingParentHeaders = undefined;

    // Atomic check-and-reserve: prevent two concurrent start() calls with the
    // same ID from both passing the storage check before either writes state.
    if (this.#pendingStarts.has(workflowId)) {
      throw new Error(`Workflow with id "${workflowId}" already exists`);
    }
    this.#pendingStarts.add(workflowId);
    let startSucceeded = false;

    try {
      // Only hit storage to dedup when the caller supplied the id. A
      // freshly-generated v4 UUID is (for all practical purposes) unique, so
      // the extra round trip is wasted work on the hot start path. This is
      // the dominant optimization behind the workflow-start benchmark — the
      // get → batch sequence was two storage calls per start, now one.
      if (callerProvidedId) {
        const existingBytes = await this.#storage.get(KEYS.workflow(workflowId));
        if (existingBytes !== null) {
          throw new Error(`Workflow with id "${workflowId}" already exists`);
        }
      }

      // Resolve the tenant context before the first checkpoint is written so
      // it gets persisted as part of the initial state blob.
      const tenant = await this.#resolveTenantForStart(workflowId, type, input);

      const state = this.#createInitialWorkflowState(
        workflowId,
        type,
        input,
        registration,
        options,
        tenant,
      );
      const checkpoint = this.#createInitialCheckpoint(workflowId, registration, options);
      this.#checkpoints.set(workflowId, checkpoint);

      // Agent optimization: register before the initial storage batch so the
      // first checkpoint write uses agent-specific compression (brotli).
      if (registration.isAgent) {
        this.#agentWorkflowIds.add(workflowId);
      }

      await this.#storage.batch(
        this.#buildStartBatchOperations(workflowId, state, checkpoint, registration, options),
      );
      await this.#scheduleExecutionDeadlineIfNeeded(workflowId, state.executionDeadline);
      this.#runWorkflowStartInterceptor(workflowId, type, input, parentHeaders);

      // Pre-warm LLM connection after the batch write (fire-and-forget).
      if (registration.isAgent) {
        try {
          const warmupResult = registration.provider?.warmup?.();
          void this.#swallowPromiseRejection(warmupResult);
        } catch {
          // Warmup is best-effort; ignore synchronous failures.
        }
      }

      this.dispatchEvent(new WorkflowStartedEvent(workflowId, type, input));

      const handle = this.#createWorkflowHandle(workflowId);
      this.#startWorkflowExecution(
        workflowId,
        type,
        input,
        checkpoint,
        state.executionDeadline,
        tenant,
      );
      startSucceeded = true;
      return handle;
    } finally {
      this.#pendingStarts.delete(workflowId);
      if (!startSucceeded && registration.isAgent) {
        this.#agentWorkflowIds.delete(workflowId);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Handle retrieval
  // -------------------------------------------------------------------------

  getHandle(workflowId: string): WorkflowHandle {
    // Check cache
    const entry = this.#handleCache.get(workflowId);
    if (entry) {
      const existing = entry.ref.deref();
      if (existing) return existing;
    }

    // Create a new handle. We need a result promise.
    const existingResolver = this.#resultResolvers.get(workflowId);
    let resultPromise: Promise<unknown>;

    if (existingResolver) {
      // Workflow is still running; create a new promise that chains off the resolver
      const { promise, resolve, reject } = Promise.withResolvers<unknown>();
      const originalResolve = existingResolver.resolve;
      const originalReject = existingResolver.reject;
      existingResolver.resolve = this.#resolveChainedResult.bind(this, originalResolve, resolve);
      existingResolver.reject = this.#rejectChainedResult.bind(this, originalReject, reject);
      resultPromise = promise;
    } else {
      // Workflow may already be complete; load from storage
      resultPromise = this.#loadWorkflowResult(workflowId);
    }

    const handle = new WorkflowHandle(workflowId, this, resultPromise);
    this.#cacheHandle(workflowId, handle);
    return handle;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async list(filter?: ListFilter): Promise<PaginatedResult<WorkflowSummary>> {
    const constrainedIds = await this.#resolveConstrainedIds(filter);

    const items: WorkflowSummary[] = [];

    // Fast path: when attribute filters constrained the set of candidate IDs,
    // load only those rows by key instead of scanning every `wf:*` entry.
    // This turns the cost from O(total workflows) into O(matches), which is
    // the shape the architecture "<1ms single-attribute equality" target
    // assumes.
    if (constrainedIds !== null) {
      // Parallelize storage reads. On in-memory backends this is essentially
      // free; on remote backends (network KV, S3-backed) it converts N
      // sequential round-trips into a single fan-out, which is what the
      // architecture's <1ms attribute-equality target relies on.
      // `Promise.all` preserves input order, so iterating the resolved array
      // in lockstep with the original id list keeps results deterministic
      // (insertion order from the attribute index intersection).
      const orderedIds = [...constrainedIds];
      const stateBytesList = await Promise.all(
        orderedIds.map((workflowId) => this.#storage.get(KEYS.workflow(workflowId))),
      );

      for (const stateBytes of stateBytesList) {
        if (!stateBytes) continue;

        const state = decodeWorkflowState(stateBytes);
        if (!matchesListFilter(state, filter, constrainedIds)) continue;

        items.push({
          id: state.id,
          type: state.type,
          status: state.status,
          version: state.version,
          createdAt: state.createdAt,
          updatedAt: state.updatedAt,
        });
      }
      return paginateWorkflowSummaries(items, filter);
    }

    for await (const [key, value] of this.#storage.scan('wf:')) {
      if (!this.#isTopLevelWorkflowStateKey(key)) continue;

      const state = decodeWorkflowState(value);
      if (!matchesListFilter(state, filter, constrainedIds)) continue;

      items.push({
        id: state.id,
        type: state.type,
        status: state.status,
        version: state.version,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
      });
    }

    return paginateWorkflowSummaries(items, filter);
  }

  #createInitialWorkflowState(
    workflowId: string,
    type: string,
    input: unknown,
    registration: RegistrationEntry,
    options?: StartOptions,
    tenant?: import('./tenant.ts').TenantContext,
  ): WorkflowState {
    const now = this.#options.getNow();
    const state: WorkflowState = {
      id: workflowId,
      type,
      status: 'running',
      input,
      version: registration.version,
      createdAt: now,
      updatedAt: now,
    };

    if (options?.executionTimeout !== undefined) {
      state.executionDeadline = now + parseDuration(options.executionTimeout);
    }

    if (tenant !== undefined) {
      state.tenant = tenant;
    }

    return state;
  }

  /**
   * Resolve the tenant for a new workflow via the configured resolver. Returns
   * `undefined` when no resolver is set or the resolver itself returned
   * `undefined`. Thrown errors are surfaced to the caller of `start()` so
   * misconfigured resolvers fail loudly instead of silently bypassing tenancy.
   */
  async #resolveTenantForStart(
    workflowId: string,
    workflowType: string,
    input: unknown,
  ): Promise<import('./tenant.ts').TenantContext | undefined> {
    const resolver = this.#options.tenantResolver;
    if (!resolver) return undefined;
    const resolved = await resolver.resolve(workflowId, input, workflowType);
    return resolved;
  }

  #createInitialCheckpoint(
    workflowId: string,
    registration: RegistrationEntry,
    options?: StartOptions,
  ): Checkpoint {
    const checkpoint = createCheckpoint(workflowId, registration.version, this.#options.getNow());
    if (options?.searchAttributes) {
      checkpoint.searchAttributes = { ...options.searchAttributes };
    }
    return checkpoint;
  }

  #buildStartBatchOperations(
    workflowId: string,
    state: WorkflowState,
    checkpoint: Checkpoint,
    registration: RegistrationEntry,
    options?: StartOptions,
  ): import('../storage/interface.ts').BatchOperation[] {
    return [
      { type: 'put', key: KEYS.workflow(workflowId), value: encode(state) },
      {
        type: 'put',
        key: KEYS.checkpoint(workflowId),
        value: serializeCheckpoint(checkpoint),
      },
      ...this.#buildInitialSearchAttributeOperations(
        workflowId,
        registration,
        options?.searchAttributes,
      ),
    ];
  }

  #buildInitialSearchAttributeOperations(
    workflowId: string,
    registration: RegistrationEntry,
    searchAttributes: StartOptions['searchAttributes'],
  ): import('../storage/interface.ts').BatchOperation[] {
    if (!searchAttributes || Object.keys(searchAttributes).length === 0) {
      return [];
    }

    this.#validateSearchAttributes(registration, searchAttributes);
    this.#validateAttributeValueSizes(searchAttributes);

    return [
      {
        type: 'put',
        key: KEYS.attribute(workflowId),
        value: encode(searchAttributes),
      },
      ...buildIndexOperations(workflowId, {}, searchAttributes),
    ];
  }

  #validateSearchAttributes(
    registration: RegistrationEntry,
    searchAttributes: Record<string, SearchAttributeValue>,
  ): void {
    if (!registration.searchAttributes) {
      return;
    }

    const schema = registration.searchAttributes;
    for (const [key, value] of Object.entries(searchAttributes)) {
      if (!(key in schema)) {
        throw new Error(
          `Unknown search attribute "${key}". Registered attributes: ${Object.keys(schema).join(', ')}`,
        );
      }
      validateAttributeType(key, value, schema[key]!);
    }
  }

  async #scheduleExecutionDeadlineIfNeeded(
    workflowId: string,
    executionDeadline: number | undefined,
  ): Promise<void> {
    if (executionDeadline === undefined) {
      return;
    }

    await this.#scheduler.schedule({
      id: `deadline:${workflowId}`,
      workflowId,
      fireAt: executionDeadline,
      kind: 'execution-deadline',
    });
  }

  #runWorkflowStartInterceptor(
    workflowId: string,
    workflowType: string,
    input: unknown,
    parentHeaders: Map<string, string> | undefined,
  ): void {
    const composedInterceptor = this.#getComposedWorkflowInterceptor();
    if (!composedInterceptor) {
      return;
    }

    const headers = new Map<string, string>();
    if (parentHeaders) {
      for (const [key, value] of parentHeaders) {
        headers.set(key, value);
      }
    }

    composedInterceptor.workflowStart(
      {
        workflowId,
        workflowType,
        input,
        headers,
      },
      this.#captureWorkflowStartHeaders.bind(this, workflowId),
    );
  }

  #createWorkflowHandle(workflowId: string): WorkflowHandle {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.#resultResolvers.set(workflowId, { resolve, reject });

    const handle = new WorkflowHandle(workflowId, this, promise);
    this.#cacheHandle(workflowId, handle);
    return handle;
  }

  /**
   * Store a WorkflowHandle in the cache and register it with the finalization
   * registry. If an earlier cached entry exists for the same workflowId, its
   * previous registration is unregistered first so that GC of the old handle
   * cannot evict the newly-cached entry.
   */
  #cacheHandle(workflowId: string, handle: WorkflowHandle): void {
    const existing = this.#handleCache.get(workflowId);
    if (existing) {
      this.#finalizationRegistry.unregister(existing.unregisterToken);
    }
    const unregisterToken = {};
    this.#handleCache.set(workflowId, {
      ref: new WeakRef(handle),
      unregisterToken,
    });
    this.#finalizationRegistry.register(handle, workflowId, unregisterToken);
  }

  #startWorkflowExecution(
    workflowId: string,
    workflowType: string,
    input: unknown,
    checkpoint: Checkpoint,
    executionDeadline: number | undefined,
    tenant: import('./tenant.ts').TenantContext | undefined,
  ): void {
    const nestingDepth = this.#pendingNestingDepth ?? 0;
    this.#pendingNestingDepth = undefined;
    // Skip the map entry for the common non-nested case — readers fall back
    // to 0. Saves per-workflow V8 Map overhead (~80 bytes) on the hot path.
    if (nestingDepth !== 0) {
      this.#workflowNestingDepths.set(workflowId, nestingDepth);
    }
    this.#strategy.startWorkflow({
      workflowId,
      workflowType,
      input,
      checkpoint: serializeCheckpoint(checkpoint),
      nestingDepth,
      ...(executionDeadline !== undefined && { deadline: executionDeadline }),
      ...(tenant !== undefined && { tenant }),
    });
  }

  async #resolveConstrainedIds(filter?: ListFilter): Promise<Set<string> | null> {
    const attributeFilters = filter?.attributes;
    if (!attributeFilters || attributeFilters.length === 0) {
      return null;
    }

    // Bound concurrency so a request with many attribute filters can't
    // saturate a connection-limited storage backend with N parallel scans.
    // Inline worker-pool loop: each worker pulls the next unclaimed filter
    // and writes the result into its original index. JavaScript is
    // single-threaded, so the `nextIndex += 1` read-modify-write is atomic
    // across event-loop yields.
    const idSets: Array<Set<string> | undefined> = Array.from({
      length: attributeFilters.length,
    });
    const workerLimit = Math.max(1, Math.min(ATTRIBUTE_SCAN_CONCURRENCY, attributeFilters.length));
    let nextIndex = 0;
    const runWorker = async (): Promise<void> => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= attributeFilters.length) return;
        const attributeFilter = attributeFilters[currentIndex]!;
        idSets[currentIndex] = await this.#queryAttributeIndex(attributeFilter);
      }
    };
    const workers: Promise<void>[] = [];
    for (let workerIndex = 0; workerIndex < workerLimit; workerIndex += 1) {
      workers.push(runWorker());
    }
    await Promise.all(workers);
    return intersectIdentifierSets(idSets as Set<string>[]);
  }

  #isTopLevelWorkflowStateKey(key: string): boolean {
    const idPart = key.slice(3);
    return !idPart.includes(':');
  }

  // -------------------------------------------------------------------------
  // Private: attribute index queries
  // -------------------------------------------------------------------------

  async #queryAttributeIndex(filter: AttributeFilter): Promise<Set<string>> {
    const ids = new Set<string>();
    const prefix = `idx:${filter.key}:`;

    if (filter.value !== undefined) {
      // Exact match: scan idx:{name}:{encodedValue}: prefix
      const encodedValue = encodeAttributeValue(filter.value);
      const exactPrefix = `idx:${filter.key}:${encodedValue}:`;
      for await (const [key] of this.#storage.scan(exactPrefix)) {
        // Key format: idx:{name}:{encodedValue}:{workflowId}
        const workflowId = key.slice(exactPrefix.length);
        ids.add(workflowId);
      }
    } else {
      // Range scan with gte/lte/gt/lt boundaries
      const scanOptions: import('../storage/interface.ts').ScanOptions = {};
      if (filter.gte !== undefined) {
        scanOptions.gte = `idx:${filter.key}:${encodeAttributeValue(filter.gte)}:`;
      }
      if (filter.gt !== undefined) {
        scanOptions.gt = `idx:${filter.key}:${encodeAttributeValue(filter.gt)}:\xff`;
      }
      if (filter.lte !== undefined) {
        // Use a boundary that includes all workflow IDs for the lte value
        const encodedLte = encodeAttributeValue(filter.lte);
        // Append a character after the last ':' to ensure we include all IDs under this value
        scanOptions.lte = `idx:${filter.key}:${encodedLte}:\xff`;
      }
      if (filter.lt !== undefined) {
        scanOptions.lt = `idx:${filter.key}:${encodeAttributeValue(filter.lt)}:`;
      }

      for await (const [key] of this.#storage.scan(prefix, scanOptions)) {
        // Key format: idx:{name}:{encodedValue}:{workflowId}
        // Extract workflowId: everything after the last ':'
        const afterPrefix = key.slice(prefix.length);
        const lastColon = afterPrefix.lastIndexOf(':');
        if (lastColon >= 0) {
          ids.add(afterPrefix.slice(lastColon + 1));
        }
      }
    }

    return ids;
  }

  // -------------------------------------------------------------------------
  // Private: attribute index cleanup
  // -------------------------------------------------------------------------

  async #cleanupAttributeIndex(workflowId: string): Promise<void> {
    const attributeBytes = await this.#storage.get(KEYS.attribute(workflowId));
    if (!attributeBytes) return;

    const currentAttributes = decode(attributeBytes) as Record<string, SearchAttributeValue>;
    const deleteOperations = buildIndexOperations(workflowId, currentAttributes, {});

    // Delete the attribute record itself along with all index entries
    deleteOperations.push({ type: 'delete', key: KEYS.attribute(workflowId) });

    if (deleteOperations.length > 0) {
      await this.#storage.batch(deleteOperations);
    }
  }

  // -------------------------------------------------------------------------
  // Signal
  // -------------------------------------------------------------------------

  async signal(workflowId: string, name: string, payload?: unknown): Promise<void> {
    const deliverSignal = async (
      targetWorkflowId: string,
      signalName: string,
      signalPayload: unknown,
    ): Promise<void> => {
      const signalId = crypto.randomUUID();
      const signalKey = KEYS.signal(targetWorkflowId, signalName, signalId);
      await this.#storage.put(signalKey, encode(signalPayload));

      this.dispatchEvent(new SignalReceivedEvent(targetWorkflowId, signalName, signalPayload));

      this.#broadcast({ type: 'signal:received', workflowId: targetWorkflowId, signalName });

      // Check if workflow is waiting for this signal
      const waiterKey = `${targetWorkflowId}:${signalName}`;
      const waiter = this.#signalWaiters.get(waiterKey);
      if (waiter) {
        this.#signalWaiters.delete(waiterKey);
        waiter();
      }
    };

    // Run signalReceived interceptor hook wrapping actual delivery
    const composed = this.#getComposedWorkflowInterceptor();
    if (composed) {
      let deliveryPromise: Promise<void> | undefined;
      let nextCalled = false;
      try {
        composed.signalReceived(
          {
            workflowId,
            signalName: name,
            payload: payload,
            headers: new Map<string, string>(),
          },
          (interception) => {
            if (nextCalled) {
              throw new Error('signalReceived interceptor called next() more than once');
            }
            nextCalled = true;
            deliveryPromise = deliverSignal(
              interception.workflowId,
              interception.signalName,
              interception.payload,
            );
          },
        );
      } catch (error) {
        // Always await the delivery promise even if the interceptor threw after
        // calling next, to avoid orphaned unhandled promise rejections.
        if (deliveryPromise) await deliveryPromise;
        throw error;
      }
      // If interceptor blocked delivery by not calling next, return early
      if (!deliveryPromise) return;
      await deliveryPromise;
    } else {
      await deliverSignal(workflowId, name, payload);
    }
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  async update(
    workflowId: string,
    name: string,
    payload?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown> {
    const timeout = options?.timeout ?? 30_000;

    // Reject updates to workflows in terminal states
    await this.#guardTerminalWorkflow(workflowId);

    // Check if the workflow has an active context with an update handler.
    // Note: in worker mode, #inlineStrategy is null so synchronous update
    // handlers registered via ctx.onUpdate() are not available. Updates in
    // worker mode go through the #updateWaiters or UpdateCoordinator paths.
    const context = this.#inlineStrategy?.getContext(workflowId);
    if (context) {
      const handler = context.updateHandlers.get(name);
      if (handler) {
        const updateId = crypto.randomUUID();
        this.dispatchEvent(new UpdateReceivedEvent(updateId, workflowId, name, payload));

        try {
          const result = await this.#invokeUpdateHandler(name, handler, payload);
          this.dispatchEvent(new UpdateCompletedEvent(updateId, workflowId, name, result));
          this.#broadcast({ type: 'update:completed', workflowId, updateId });
          return result;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.dispatchEvent(
            new UpdateCompletedEvent(updateId, workflowId, name, undefined, errorMessage),
          );
          this.#broadcast({ type: 'update:completed', workflowId, updateId });
          throw error;
        }
      }
    }

    // Check if workflow is waiting for this update via waitForUpdate
    const waiterKey = `${workflowId}:${name}`;
    const updateWaiter = this.#updateWaiters.get(waiterKey);
    const existingPendingUpdate = updateWaiter
      ? await this.#findPendingUpdateByName(workflowId, name)
      : undefined;
    const currentWaiter = updateWaiter ? this.#updateWaiters.get(waiterKey) : undefined;
    if (updateWaiter && currentWaiter === updateWaiter && !existingPendingUpdate) {
      this.#updateWaiters.delete(waiterKey);
      const updateId = crypto.randomUUID();
      this.dispatchEvent(new UpdateReceivedEvent(updateId, workflowId, name, payload));

      const { promise: respondPromise, resolve: resolveRespond } = Promise.withResolvers<unknown>();
      let responded = false;
      const respond = (value: unknown) => {
        if (responded) return;
        responded = true;
        resolveRespond(value);
      };

      updateWaiter({ payload, respond });

      // Race the respond promise against the timeout, clearing the timer on either outcome
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          respondPromise,
          new Promise<never>((_resolve, reject) => {
            timeoutId = setTimeout(
              () => reject(new UpdateTimeoutError(updateId, timeout)),
              timeout,
            );
          }),
        ]);

        clearTimeout(timeoutId);

        this.dispatchEvent(new UpdateCompletedEvent(updateId, workflowId, name, result));
        this.#broadcast({ type: 'update:completed', workflowId, updateId });
        return result;
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }
    }

    // If no active handler, use the UpdateCoordinator with polling
    const updateId = await this.#updateCoordinator.createRequest(workflowId, name, payload);
    this.dispatchEvent(new UpdateReceivedEvent(updateId, workflowId, name, payload));

    await this.#deliverCoordinatedUpdateToWaiterIfAvailable(workflowId, {
      updateId,
      workflowId,
      name,
      payload,
      createdAt: Date.now(),
    });

    const response = await this.#updateCoordinator.waitForResponse(updateId, timeout);

    if (response.error) {
      throw new Error(response.error);
    }

    return response.result;
  }

  async query(workflowId: string, name: string): Promise<unknown> {
    // Built-in query: return latest heartbeat details for this workflow
    if (name === 'activityProgress') {
      return this.#heartbeatDetails.get(workflowId);
    }

    if (!this.#inlineStrategy) {
      throw new Error(
        'Workflow queries are not supported when using the worker execution strategy.',
      );
    }
    const context = this.#inlineStrategy.getContext(workflowId);
    if (!context) {
      return undefined;
    }
    const accessor = context.exposedAccessors.get(name);
    if (!accessor) return undefined;
    return accessor();
  }

  async setBudgetPolicy(
    options: import('../ai/budget-policy.ts').BudgetPolicyOptions,
  ): Promise<void> {
    if (!this.#budgetPolicyEnforcer) {
      const { BudgetPolicyEnforcer } = await import('../ai/budget-policy.ts');
      this.#budgetPolicyEnforcer = new BudgetPolicyEnforcer(this.#storage, this.#options.getNow);
    }
    this.#budgetPolicyEnforcer.setPolicy(options);
  }

  /** Retrieve the budget policy for a namespace, or `null` if none is set. */
  async getBudgetPolicy(
    namespace: string,
  ): Promise<import('../ai/budget-policy.ts').BudgetPolicyOptions | null> {
    if (!this.#budgetPolicyEnforcer) return null;
    return this.#budgetPolicyEnforcer.policies.get(namespace) ?? null;
  }

  /** Read stream chunks back from storage for a completed stream operation. */
  async getStreamChunks(workflowId: string, key: string): Promise<unknown[]> {
    const metadataBytes = await this.#storage.get(KEYS.streamMetadata(workflowId, key));
    if (!metadataBytes) return [];

    const metadata = decode(metadataBytes) as StreamReference;
    const chunks: unknown[] = [];

    for (let i = 0; i < metadata.chunkCount; i++) {
      const chunkBytes = await this.#storage.get(KEYS.streamChunk(workflowId, key, i));
      if (chunkBytes) {
        chunks.push(decode(chunkBytes));
      }
    }

    return chunks;
  }

  // -------------------------------------------------------------------------
  // Resume / Recovery
  // -------------------------------------------------------------------------

  async resume(workflowId: string): Promise<WorkflowHandle> {
    // Load workflow state
    const stateBytes = await this.#storage.get(KEYS.workflow(workflowId));
    if (!stateBytes) {
      throw new Error(`Workflow "${workflowId}" not found in storage`);
    }

    const state = decodeWorkflowState(stateBytes);
    if (state.status !== 'running') {
      throw new Error(
        `Cannot resume workflow "${workflowId}": status is "${state.status}", expected "running"`,
      );
    }

    // Load checkpoint
    const checkpointBytes = await this.#storage.get(KEYS.checkpoint(workflowId));
    if (!checkpointBytes) {
      throw new Error(`Checkpoint not found for workflow "${workflowId}"`);
    }

    const checkpoint = deserializeCheckpoint(checkpointBytes);

    // Look up registration
    const registration = this.#registrations.get(state.type);
    if (!registration) {
      throw new Error(
        `No workflow registered with name "${state.type}" (needed to resume "${workflowId}")`,
      );
    }

    // Agent optimization: track resumed agent workflows for storage-layer optimization.
    if (registration.isAgent) {
      this.#agentWorkflowIds.add(workflowId);
    }

    // Check version compatibility
    const compatibility = checkVersionCompatibility(
      checkpoint.version,
      registration.version,
      !!registration.migrate,
    );

    let resumeCheckpoint = checkpoint;
    if (compatibility === 'needs-migration' && registration.migrate) {
      const migrated = migrateCheckpoint(
        checkpoint,
        checkpoint.version,
        registration.version,
        registration.migrate,
      ) as import('./types.ts').Checkpoint;
      migrated.version = registration.version;
      resumeCheckpoint = migrated;

      // Persist migrated checkpoint
      await this.#storage.put(KEYS.checkpoint(workflowId), serializeCheckpoint(resumeCheckpoint));
    }

    // Store checkpoint for future persistence
    this.#checkpoints.set(workflowId, resumeCheckpoint);

    // Create result promise and handle
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.#resultResolvers.set(workflowId, { resolve, reject });

    const handle = new WorkflowHandle(workflowId, this, promise);
    this.#cacheHandle(workflowId, handle);

    // Dispatch resumed event
    this.dispatchEvent(new WorkflowResumedEvent(workflowId, resumeCheckpoint.step));

    if (this.#inlineStrategy) {
      // Inline mode: create context and generator, adopt into strategy
      const accumulatedResults = new Map<number, unknown>(resumeCheckpoint.accumulatedResults);
      const workflowAbort = new AbortController();

      // Create context with recovery state. Pass the checkpoint's createdAt as
      // the sleep reference time so that expired sleeps resolve immediately via
      // the fast path instead of scheduling a brand-new full-duration timer.
      const context = new Context({
        workflowId,
        workflowType: state.type,
        startedAt: state.createdAt,
        abortController: workflowAbort,
        getNow: this.#options.getNow,
        accumulatedResults,
        searchAttributes: resumeCheckpoint.searchAttributes,
        ...(registration.searchAttributes && {
          searchAttributeSchema: registration.searchAttributes,
        }),
        sleepReferenceTime: resumeCheckpoint.createdAt,
        ...(state.executionDeadline !== undefined && { deadline: state.executionDeadline }),
        ...(state.tenant !== undefined && { tenant: state.tenant }),
      });

      if (this.#options.development) {
        context.explain(true);
      }

      const generator = registration.handler(context, state.input);
      this.#inlineStrategy.adoptWorkflow(workflowId, generator, context, workflowAbort);

      // Drive the generator (non-blocking) via the strategy
      this.#inlineStrategy.continueWorkflow(workflowId, undefined);

      // After replay, process any pending coordinated updates that match
      // registered inline handlers. Schedule on next microtask so the
      // generator has a chance to register its onUpdate handlers first.
      queueMicrotask(this.#processPendingUpdatesAfterReplay.bind(this, workflowId));
    } else {
      // Worker mode: send run message to the worker with the checkpoint
      const serialized = serializeCheckpoint(resumeCheckpoint);
      this.#strategy.startWorkflow({
        workflowId,
        workflowType: state.type,
        input: state.input,
        checkpoint: serialized,
        nestingDepth: this.#workflowNestingDepths.get(workflowId) ?? 0,
        ...(state.executionDeadline !== undefined && { deadline: state.executionDeadline }),
        ...(state.tenant !== undefined && { tenant: state.tenant }),
      });
    }

    return handle;
  }

  async recoverAll(): Promise<WorkflowHandle[]> {
    const handles: WorkflowHandle[] = [];

    for await (const [key, value] of this.#storage.scan('wf:')) {
      // Skip checkpoint and history keys
      if (key.includes(':ckpt') || key.includes(':offload') || key.includes(':archive')) continue;

      const state = decodeWorkflowState(value);
      if (state.status !== 'running') continue;

      const registration = this.#registrations.get(state.type);
      if (!registration) continue;

      const handle = await this.resume(state.id);
      handles.push(handle);
    }

    return handles;
  }

  // -------------------------------------------------------------------------
  // Cancel / Timeout
  // -------------------------------------------------------------------------

  async cancel(workflowId: string): Promise<void> {
    await this.#terminateWorkflow(workflowId, 'cancelled');
  }

  async timeout(workflowId: string): Promise<void> {
    await this.#terminateWorkflow(workflowId, 'timed-out');
  }

  /** Returns true if the given workflow ID belongs to an agent-typed workflow. */
  isAgentWorkflow(workflowId: string): boolean {
    return this.#agentWorkflowIds.has(workflowId);
  }

  /** Returns the set of currently tracked agent workflow IDs (for storage layer optimization). */
  get agentWorkflowIds(): ReadonlySet<string> {
    return this.#agentWorkflowIds;
  }

  async #terminateWorkflow(workflowId: string, status: 'cancelled' | 'timed-out'): Promise<void> {
    this.#strategy.cancelWorkflow(workflowId);

    const state = await this.#loadWorkflowState(workflowId);
    if (!state) return;
    const elapsed = this.#options.getNow() - state.createdAt;

    await this.#updateWorkflowState(workflowId, { status });
    await this.#cleanupAttributeIndex(workflowId);
    await this.#scheduler.cancel(`deadline:${workflowId}`, workflowId);

    // Drop in-memory state, release charged operations, and delete durable
    // workflow-keyed records (reviews, offload, blob, shared, signal).
    // Cancelled/timed-out workflows have no consumers waiting on output
    // artifacts, so drop them alongside the internal bookkeeping.
    await this.#cleanupTerminalWorkflow(workflowId, true);

    const event =
      status === 'timed-out'
        ? new WorkflowTimedOutEvent(workflowId, 'execution', elapsed)
        : new WorkflowCancelledEvent(workflowId);
    this.dispatchEvent(event);
    this.#forwardEventToHandle(workflowId, event);

    const resolver = this.#resultResolvers.get(workflowId);
    if (resolver) {
      resolver.reject(
        status === 'timed-out'
          ? new WorkflowTimeoutError(workflowId, 'execution', elapsed)
          : new Error('Workflow cancelled'),
      );
      this.#resultResolvers.delete(workflowId);
    }
  }

  // -------------------------------------------------------------------------
  // State retrieval (public API for HTTP handlers and clients)
  // -------------------------------------------------------------------------

  /** Retrieve the current state of a workflow by ID. */
  async get(workflowId: string): Promise<WorkflowState | null> {
    return this.#loadWorkflowState(workflowId);
  }

  /** Retrieve search attributes for a workflow. */
  async getAttributes(workflowId: string): Promise<Record<string, SearchAttributeValue> | null> {
    const bytes = await this.#storage.get(KEYS.attribute(workflowId));
    if (!bytes) return null;
    return decode(bytes) as Record<string, SearchAttributeValue>;
  }

  /** Merge search attributes into a workflow's existing attributes, updating the index. */
  async setAttributes(
    workflowId: string,
    attributes: Record<string, SearchAttributeValue>,
  ): Promise<void> {
    // Validate against the registration's schema if one exists
    const stateBytes = await this.#storage.get(KEYS.workflow(workflowId));
    if (stateBytes) {
      const state = decodeWorkflowState(stateBytes);
      const registration = this.#registrations.get(state.type);
      if (registration?.searchAttributes) {
        const schema = registration.searchAttributes;
        for (const [key, value] of Object.entries(attributes)) {
          if (!(key in schema)) {
            throw new Error(
              `Unknown search attribute "${key}". Registered attributes: ${Object.keys(schema).join(', ')}`,
            );
          }
          validateAttributeType(key, value, schema[key]!);
        }
      }
    }

    this.#validateAttributeValueSizes(attributes);

    const existingBytes = await this.#storage.get(KEYS.attribute(workflowId));
    const existing: Record<string, SearchAttributeValue> = existingBytes
      ? (decode(existingBytes) as Record<string, SearchAttributeValue>)
      : {};

    const merged: Record<string, SearchAttributeValue> = { ...existing, ...attributes };

    const indexOperations = buildIndexOperations(workflowId, existing, merged);

    const operations: import('../storage/interface.ts').BatchOperation[] = [
      { type: 'put', key: KEYS.attribute(workflowId), value: encode(merged) },
      ...indexOperations,
    ];

    await this.#storage.batch(operations);
  }

  /** Validate that all attribute values in a record fit within the storage key size limit. */
  #validateAttributeValueSizes(attributes: Record<string, SearchAttributeValue>): void {
    for (const [key, value] of Object.entries(attributes)) {
      if (Array.isArray(value)) {
        for (const element of value) {
          validateEncodedValueSize(encodeAttributeValue(element), key);
        }
      } else {
        validateEncodedValueSize(encodeAttributeValue(value), key);
      }
    }
  }

  /** Retrieve the event history for a workflow. */
  async getEvents(workflowId: string): Promise<WorkflowEvent[]> {
    const events: WorkflowEvent[] = [];
    const prefix = `ev:${workflowId}:`;

    for await (const [, value] of this.#storage.scan(prefix)) {
      const event = decode(value) as Record<string, unknown>;
      events.push({
        type: (event['type'] as string) ?? 'unknown',
        timestamp: (event['timestamp'] as number) ?? 0,
        data: (event['data'] as Record<string, unknown>) ?? {},
      });
    }

    return events;
  }

  /** List all pending reviews. */
  async listReviews(): Promise<Array<Record<string, unknown>>> {
    const reviews: Array<Record<string, unknown>> = [];

    for await (const [, value] of this.#storage.scan('review:')) {
      reviews.push(decode(value) as Record<string, unknown>);
    }

    return reviews;
  }

  /** Retrieve a specific review by workflowId and reviewId. */
  async getReview(workflowId: string, reviewId: string): Promise<ReviewRequest | null> {
    return this.#reviewCoordinator.getReview(workflowId, reviewId);
  }

  /**
   * Submit a decision for a pending review. Stores the decision, removes
   * the pending review, and wakes the paused workflow if one is waiting.
   */
  async submitReview(reviewId: string, options: SubmitReviewOptions): Promise<void> {
    const { decision, reviewer, feedback, sectionDecisions, workflowId } = options;

    // Look up the review by direct key when workflowId is provided (O(1)),
    // otherwise fall back to scanning all review entries (O(n)).
    let reviewKey: string | null = null;
    let resolvedWorkflowId: string | undefined = workflowId;
    let reviewData: ReviewRequest | undefined;

    if (workflowId !== undefined) {
      const directKey = KEYS.review(workflowId, reviewId);
      const existing = await this.#storage.get(directKey);
      if (existing !== null) {
        reviewKey = directKey;
        reviewData = decode(existing) as ReviewRequest;
      }
    } else {
      for await (const [key, value] of this.#storage.scan('review:')) {
        const review = decode(value) as Record<string, unknown>;
        if (review['reviewId'] === reviewId) {
          reviewKey = key;
          reviewData = review as unknown as ReviewRequest;
          resolvedWorkflowId = review['workflowId'] as string;
          break;
        }
      }
    }

    if (reviewKey === null) {
      throw new Error(`Review "${reviewId}" not found`);
    }

    const now = this.#options.getNow();
    const decisionResult: HumanReviewResult = {
      reviewId,
      decision,
      reviewer,
      timestamp: now,
    };

    if (feedback !== undefined) {
      decisionResult.feedback = feedback;
    }

    if (sectionDecisions !== undefined) {
      decisionResult.sectionDecisions = sectionDecisions;
    }

    await this.#storage.batch([
      { type: 'put', key: `review-decision:${reviewId}`, value: encode(decisionResult) },
      { type: 'delete', key: reviewKey },
    ]);

    // Dispatch HumanReviewCompletedEvent
    const duration = reviewData ? now - reviewData.createdAt : 0;
    this.dispatchEvent(
      new HumanReviewCompletedEvent(
        resolvedWorkflowId ?? '',
        reviewId,
        decision,
        reviewer,
        duration,
      ),
    );

    // Wake the waiting workflow by resolving its review waiter
    const waiterKey = `${resolvedWorkflowId}:${reviewId}`;
    const waiter = this.#reviewWaiters.get(waiterKey);
    if (waiter) {
      this.#reviewWaiters.delete(waiterKey);
      waiter(decisionResult);
    }
  }

  /** Retrieve the result of a coordinated update by its ID. */
  async getUpdateResult(updateId: string): Promise<import('./updates.ts').UpdateResponse | null> {
    return this.#updateCoordinator.getResponse(updateId);
  }

  /**
   * Submit a coordinated update request. Handles idempotency checking,
   * creates the request, and waits for a response within the timeout.
   */
  async submitCoordinatedUpdate(
    workflowId: string,
    name: string,
    payload?: unknown,
    options?: { timeout?: number; idempotencyKey?: string },
  ): Promise<CoordinatedUpdateResult> {
    const timeout = options?.timeout ?? 30_000;
    const idempotencyKey = options?.idempotencyKey;

    // Check idempotency first — a retry for an already-processed key should
    // return the cached result even if the workflow has since completed.
    if (idempotencyKey !== undefined) {
      const existing = await this.#updateCoordinator.checkIdempotency(workflowId, idempotencyKey);
      if (existing !== null) {
        return { updateId: existing.updateId, result: existing.result };
      }
    }

    // Reject updates to workflows in terminal states
    await this.#guardTerminalWorkflow(workflowId);

    const requestOptions: { timeout: number; idempotencyKey?: string } = { timeout };
    if (idempotencyKey !== undefined) {
      requestOptions.idempotencyKey = idempotencyKey;
    }

    const updateId = await this.#updateCoordinator.createRequest(
      workflowId,
      name,
      payload,
      requestOptions,
    );

    await this.#deliverCoordinatedUpdateToWaiterIfAvailable(
      workflowId,
      {
        updateId,
        workflowId,
        name,
        payload,
        createdAt: Date.now(),
        idempotencyKey,
      },
      true,
    );

    const response = await this.#updateCoordinator.waitForResponse(updateId, timeout);

    const result: CoordinatedUpdateResult = {
      updateId: response.updateId,
      result: response.result,
    };

    if (response.error !== undefined) {
      result.error = response.error;
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Disposal
  // -------------------------------------------------------------------------

  [Symbol.dispose](): void {
    this.#alertManager?.[Symbol.dispose]();
    this.#alertManager = null;
    this.#abortController.abort();
    this.#scheduler[Symbol.dispose]();
    this.#strategy[Symbol.dispose]();
    this.#activityWorkerDispatcher?.[Symbol.dispose]();
    this.#activityWorkerDispatcher = null;
    this.#inlineStrategy = null;
    if (this.#cleanupInterval !== null) {
      clearInterval(this.#cleanupInterval);
      this.#cleanupInterval = null;
    }
    this.#handleCache.clear();
    this.#resultResolvers.clear();
    this.#signalWaiters.clear();
    this.#updateWaiters.clear();
    this.#reviewWaiters.clear();
    this.#reviewEscalationHandlers.clear();
    this.#workflowReviewIds.clear();
    this.#reviewTimerIds.clear();
    for (const controller of this.#pendingWebhooks) {
      controller.abort();
    }
    this.#pendingWebhooks.clear();
    this.#sleepResolvers.clear();
    this.#sleepResolversByWorkflow.clear();
    this.#checkpoints.clear();
    this.#workflowNestingDepths.clear();
    this.#workflowHeaders.clear();
    this.#pendingStarts.clear();
    this.#chargedAgentOperations.clear();
    this.#chargedAgentOperationsByWorkflow.clear();
    this.#agentWorkflowIds.clear();
    this.#eventLogHeads.clear();
    this.#broadcastChannel?.close();
    this.#broadcastChannel = null;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this[Symbol.dispose]();
  }

  // -------------------------------------------------------------------------
  // Accessors (for TestEngine and internal use)
  // -------------------------------------------------------------------------

  get storage(): WeftStorage {
    return this.#storage;
  }

  get scheduler(): Scheduler {
    return this.#scheduler;
  }

  // -------------------------------------------------------------------------
  // Private: cleanup error handling
  // -------------------------------------------------------------------------

  /**
   * Handle errors from fire-and-forget cleanup operations. Dispatches a
   * {@link CleanupWarningEvent} so callers can observe failures without
   * affecting the primary workflow result.
   */
  #handleCleanupError(source: string, error: unknown, workflowId?: string): void {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    this.dispatchEvent(new CleanupWarningEvent(source, normalizedError, workflowId));
  }

  // -------------------------------------------------------------------------
  // Private: checkpoint persistence
  // -------------------------------------------------------------------------

  async #persistCheckpoint(workflowId: string, workerCheckpointBytes?: ArrayBuffer): Promise<void> {
    const context = this.#inlineStrategy?.getContext(workflowId);

    if (context) {
      // Inline strategy: advance checkpoint from context state
      const current = this.#checkpoints.get(workflowId);
      if (!current) return;

      const previousAttributes = { ...current.searchAttributes };
      const hasPendingAttributeChanges = Object.keys(context.pendingAttributeChanges).length > 0;

      const accumulatedResults = Array.from(context.accumulatedResults.entries());
      const advanced = advanceCheckpoint(current, current.locals, {
        searchAttributes: context.pendingAttributeChanges,
        accumulatedResults,
        now: this.#options.getNow(),
      });

      const serialized = serializeCheckpoint(advanced);

      if (serialized.byteLength >= this.#options.checkpointSizeWarningThreshold) {
        this.dispatchEvent(
          new CheckpointSizeWarningEvent(workflowId, serialized.byteLength, advanced.step),
        );
      }

      const operations: import('../storage/interface.ts').BatchOperation[] = [
        { type: 'put', key: KEYS.checkpoint(workflowId), value: serialized },
      ];

      if (this.#options.checkpointHistory > 0) {
        operations.push({
          type: 'put',
          key: KEYS.checkpointHistory(workflowId, advanced.step),
          value: serialized,
        });
      }

      if (hasPendingAttributeChanges) {
        this.#validateAttributeValueSizes(context.pendingAttributeChanges);
        operations.push({
          type: 'put',
          key: KEYS.attribute(workflowId),
          value: encode(advanced.searchAttributes),
        });
        operations.push(
          ...buildIndexOperations(workflowId, previousAttributes, advanced.searchAttributes),
        );
      }

      // Co-write event log entry in the same batch so checkpoint and log never diverge.
      // appendToBatch() is synchronous — no storage reads, no extra await.
      const eventLog = new EventLog(this.#storage, workflowId);
      const newHead = eventLog.appendToBatch(
        { type: 'workflow:checkpoint', payload: { step: advanced.step } },
        operations,
        this.#eventLogHeads.get(workflowId) ?? EMPTY_EVENT_HEAD,
      );

      await this.#storage.batch(operations);
      this.#checkpoints.set(workflowId, advanced);
      this.#eventLogHeads.set(workflowId, newHead);

      if (hasPendingAttributeChanges) {
        this.dispatchEvent(
          new AttributesChangedEvent(workflowId, { ...context.pendingAttributeChanges }),
        );
      }
    } else if (workerCheckpointBytes && workerCheckpointBytes.byteLength > 0) {
      // Worker strategy: persist the checkpoint bytes sent from the worker
      const serialized = new Uint8Array(workerCheckpointBytes);
      const checkpoint = deserializeCheckpoint(serialized);

      if (serialized.byteLength >= this.#options.checkpointSizeWarningThreshold) {
        this.dispatchEvent(
          new CheckpointSizeWarningEvent(workflowId, serialized.byteLength, checkpoint.step),
        );
      }

      const operations: import('../storage/interface.ts').BatchOperation[] = [
        { type: 'put', key: KEYS.checkpoint(workflowId), value: serialized },
      ];

      if (this.#options.checkpointHistory > 0) {
        operations.push({
          type: 'put',
          key: KEYS.checkpointHistory(workflowId, checkpoint.step),
          value: serialized,
        });
      }

      // Co-write event log entry in the same batch so checkpoint and log never diverge.
      // appendToBatch() is synchronous — no storage reads, no extra await.
      const eventLog = new EventLog(this.#storage, workflowId);
      const newHead = eventLog.appendToBatch(
        { type: 'workflow:checkpoint', payload: { step: checkpoint.step } },
        operations,
        this.#eventLogHeads.get(workflowId) ?? EMPTY_EVENT_HEAD,
      );

      await this.#storage.batch(operations);
      this.#checkpoints.set(workflowId, checkpoint);
      this.#eventLogHeads.set(workflowId, newHead);
    }
  }

  // -------------------------------------------------------------------------
  // Private: strategy helpers
  // -------------------------------------------------------------------------

  /**
   * Feed an operation result back into the workflow. Works for both inline
   * and worker strategies by routing through the appropriate method.
   */
  #feedOperationResult(workflowId: string, outcome: OperationOutcome, originalError?: Error): void {
    if (this.#inlineStrategy) {
      // Inline: use the direct methods for efficiency
      if (outcome.status === 'completed') {
        this.#inlineStrategy.continueWorkflow(workflowId, outcome.value);
      } else {
        this.#inlineStrategy.throwIntoWorkflow(
          workflowId,
          originalError ?? new Error(outcome.error),
        );
      }
    } else {
      // Worker: send resume message with the checkpoint
      const checkpoint = this.#checkpoints.get(workflowId);
      const serialized = checkpoint ? serializeCheckpoint(checkpoint) : new ArrayBuffer(0);
      this.#strategy.resumeWorkflow({
        workflowId,
        checkpoint: serialized,
        operationResult: outcome,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Private: strategy message handling
  // -------------------------------------------------------------------------

  async #handleStrategyMessage(message: WorkerOutboundMessage): Promise<void> {
    switch (message.type) {
      case 'completed':
        await this.#completeWorkflow(message.workflowId, message.result);
        break;

      case 'failed': {
        const failedError = new Error(message.error);
        // Preserve the original error stack from the strategy if available,
        // rather than using the stack pointing to engine internals.
        if (message.errorStack) {
          failedError.stack = message.errorStack;
        }
        await this.#failWorkflow(message.workflowId, failedError);
        break;
      }

      case 'checkpoint': {
        // Persist checkpoint at this yield boundary
        await this.#persistCheckpoint(message.workflowId, message.checkpoint);

        // Development mode: validate checkpoint round-trip
        this.#validateDevelopmentCheckpoint(message.workflowId);

        // Translate the operation request: worker protocol uses `kind` while the
        // engine uses `type`. Inline strategy already emits ContextOperationRequest.
        const operation = this.#translateOperationRequest(message.operationRequest);
        await this.#processOperation(message.workflowId, operation);
        break;
      }
    }
  }

  /**
   * Translate an operation request from a strategy into a {@link ContextOperationRequest}.
   *
   * The inline strategy already produces `ContextOperationRequest` (with `type`).
   * The worker protocol produces `OperationRequest` (with `kind`). This method
   * normalizes both shapes so {@link #processOperation} can switch on `type`.
   */
  #translateOperationRequest(operationRequest: unknown): ContextOperationRequest {
    const operation = operationRequest as Record<string, unknown>;

    if (operation == null || typeof operation !== 'object') {
      throw new Error('Invalid operation request received from execution strategy');
    }

    // Already in ContextOperationRequest shape (inline strategy)
    if ('type' in operation && typeof operation['type'] === 'string') {
      // Inline execution strategy yields ContextOperationRequest directly
      return operation as ContextOperationRequest;
    }

    // Worker OperationRequest uses `kind` — translate to `type`
    if ('kind' in operation && typeof operation['kind'] === 'string') {
      const kind = operation['kind'];

      // Map OperationRequest.kind values to ContextOperationRequest.type values
      const kindToType: Record<string, string> = {
        activity: 'activity',
        timer: 'sleep',
        'signal-wait': 'wait-signal',
        'child-workflow': 'child-workflow',
      };

      const type = kindToType[kind] ?? kind;

      // Worker protocol omits `fn` — it is resolved from the activity registry later
      return {
        ...operation,
        type,
        operationId: (operation['id'] as string) ?? crypto.randomUUID(),
        activityName: (operation['activityName'] as string) ?? '',
        args: operation['input'] !== undefined ? [operation['input']] : [],
      } as ContextOperationRequest;
    }

    throw new Error('Unsupported operation request shape received from execution strategy');
  }

  async #processOperation(workflowId: string, operation: ContextOperationRequest): Promise<void> {
    switch (operation.type) {
      case 'activity':
        return this.#processActivityOperation(workflowId, operation);
      case 'sleep':
        return this.#processSleepOperation(workflowId, operation);
      case 'wait-signal':
        return this.#processWaitSignalOperation(workflowId, operation);
      case 'wait-update':
        return this.#processWaitUpdateOperation(workflowId, operation);
      case 'parallel':
        return this.#processParallelOperation(workflowId, operation);
      case 'race':
        return this.#processRaceOperation(workflowId, operation);
      case 'memo':
        return this.#processMemoOperation(workflowId, operation);
      case 'child-workflow':
        return this.#processChildWorkflowOperation(workflowId, operation);
      case 'offload':
        return this.#processOffloadOperation(workflowId, operation);
      case 'load':
        return this.#processLoadOperation(workflowId, operation);
      case 'archive':
        return this.#processArchiveOperation(workflowId, operation);
      case 'run-all':
        return this.#processRunAllOperation(workflowId, operation);
      case 'agent':
        return this.#processAgentContextOperation(workflowId, operation);
      case 'stream':
        return this.#processStreamOperation(workflowId, operation);
      case 'wait-review':
        return this.#processWaitReviewOperation(workflowId, operation);
      case 'handoff':
        return this.#processHandoffOperation(workflowId, operation);
      case 'debate':
        return this.#processDebateOperation(workflowId, operation);
      case 'supervise':
        return this.#processSuperviseOperation(workflowId, operation);
      default:
        const unsupportedType = String((operation as Record<string, unknown>)['type']);
        this.#failOperation(
          workflowId,
          operation,
          new Error(`Unsupported operation type: ${unsupportedType}`),
        );
        return;
    }
  }

  #completeOperation(workflowId: string, value: unknown): void {
    this.#feedOperationResult(workflowId, { status: 'completed', value });
  }

  #failOperation(workflowId: string, operation: OperationWithCallerStack, error: unknown): void {
    if (error instanceof Error && operation.callerStack) {
      error.stack = `${error.stack}\n    --- workflow call site ---\n${operation.callerStack}`;
    }

    const enrichedError = error instanceof Error ? error : new Error(String(error));
    this.#feedOperationResult(
      workflowId,
      { status: 'failed', error: enrichedError.message },
      enrichedError,
    );
  }

  async #runOperationWithResult(
    workflowId: string,
    operation: OperationWithCallerStack,
    execute: () => Promise<unknown>,
  ): Promise<void> {
    try {
      const value = await execute();
      this.#completeOperation(workflowId, value);
    } catch (error) {
      this.#failOperation(workflowId, operation, error);
    }
  }

  async #runOperationWithoutResult(
    workflowId: string,
    operation: OperationWithCallerStack,
    execute: () => Promise<void>,
  ): Promise<void> {
    try {
      await execute();
    } catch (error) {
      this.#failOperation(workflowId, operation, error);
    }
  }

  async #processActivityOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'activity' }>,
  ): Promise<void> {
    return this.#runOperationWithResult(workflowId, operation, () =>
      this.#executeActivity(workflowId, operation),
    );
  }

  async #processSleepOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'sleep' }>,
  ): Promise<void> {
    if (operation.scheduledFireAt <= this.#options.getNow()) {
      this.#completeOperation(workflowId, undefined);
      return;
    }

    const { promise, resolve } = Promise.withResolvers<void>();
    await this.#scheduler.schedule({
      id: `sleep:${operation.operationId}`,
      workflowId,
      fireAt: operation.scheduledFireAt,
      kind: 'sleep',
    });
    this.#registerSleepResolver(workflowId, operation.operationId, resolve);
    await promise;

    const postSleepState = await this.#loadWorkflowState(workflowId);
    if (postSleepState?.status === 'running') {
      this.#completeOperation(workflowId, undefined);
    }
  }

  #registerSleepResolver(workflowId: string, operationId: string, resolve: () => void): void {
    this.#sleepResolvers.set(`${workflowId}:${operationId}`, resolve);

    let workflowOperations = this.#sleepResolversByWorkflow.get(workflowId);
    if (!workflowOperations) {
      workflowOperations = new Set();
      this.#sleepResolversByWorkflow.set(workflowId, workflowOperations);
    }
    workflowOperations.add(operationId);
  }

  async #processWaitSignalOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'wait-signal' }>,
  ): Promise<void> {
    const abortSignal = this.#abortController.signal;
    const waiterKey = `${workflowId}:${operation.signalName}`;

    while (true) {
      if (abortSignal.aborted) {
        return;
      }

      const existingPayload = await this.#consumeSignal(workflowId, operation.signalName);
      if (existingPayload.found) {
        this.#completeOperation(workflowId, existingPayload.payload);
        return;
      }

      const { promise, resolve } = Promise.withResolvers<void>();
      this.#signalWaiters.set(waiterKey, resolve);

      if (abortSignal.aborted) {
        this.#signalWaiters.delete(waiterKey);
        return;
      }

      const bufferedPayload = await this.#consumeSignal(workflowId, operation.signalName);
      if (bufferedPayload.found) {
        if (this.#signalWaiters.get(waiterKey) === resolve) {
          this.#signalWaiters.delete(waiterKey);
        }
        this.#completeOperation(workflowId, bufferedPayload.payload);
        return;
      }

      await promise;

      if (abortSignal.aborted) {
        return;
      }
    }
  }

  async #processWaitUpdateOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'wait-update' }>,
  ): Promise<void> {
    const waiterKey = `${workflowId}:${operation.updateName}`;
    const matchingUpdate = await this.#findPendingUpdateByName(workflowId, operation.updateName);

    if (matchingUpdate) {
      this.#dispatchPendingUpdateReceived(workflowId, operation.updateName, matchingUpdate);
      this.#completeOperation(workflowId, {
        payload: matchingUpdate.payload,
        respond: this.#createCoordinatedUpdateResponder(
          workflowId,
          operation.updateName,
          matchingUpdate,
        ),
      });
      return;
    }

    const { promise, resolve } = Promise.withResolvers<unknown>();
    this.#updateWaiters.set(waiterKey, resolve);

    const pendingUpdateAfterRegistration = await this.#findPendingUpdateByName(
      workflowId,
      operation.updateName,
    );
    if (pendingUpdateAfterRegistration) {
      if (this.#updateWaiters.get(waiterKey) === resolve) {
        this.#updateWaiters.delete(waiterKey);
      }

      this.#dispatchPendingUpdateReceived(
        workflowId,
        operation.updateName,
        pendingUpdateAfterRegistration,
      );
      this.#completeOperation(workflowId, {
        payload: pendingUpdateAfterRegistration.payload,
        respond: this.#createCoordinatedUpdateResponder(
          workflowId,
          operation.updateName,
          pendingUpdateAfterRegistration,
        ),
      });
      return;
    }

    this.#completeOperation(workflowId, await promise);
  }

  #dispatchPendingUpdateReceived(
    workflowId: string,
    updateName: string,
    update: UpdateRequest,
  ): void {
    this.dispatchEvent(
      new UpdateReceivedEvent(update.updateId, workflowId, updateName, update.payload),
    );
  }

  #createCoordinatedUpdateResponder(
    workflowId: string,
    updateName: string,
    update: UpdateRequest,
  ): (value: unknown) => void {
    let coordinatedResponded = false;

    return (value: unknown) => {
      if (coordinatedResponded) return;
      coordinatedResponded = true;

      void this.#persistCoordinatedUpdateResponse(
        workflowId,
        updateName,
        update.updateId,
        update.idempotencyKey,
        value,
      );
    };
  }

  async #deliverCoordinatedUpdateToWaiterIfAvailable(
    workflowId: string,
    update: UpdateRequest,
    dispatchReceivedEvent = false,
  ): Promise<boolean> {
    const waiterKey = `${workflowId}:${update.name}`;
    const waiter = this.#updateWaiters.get(waiterKey);
    if (!waiter) {
      return false;
    }

    const oldestPendingUpdate = await this.#findPendingUpdateByName(workflowId, update.name);
    if (!oldestPendingUpdate || oldestPendingUpdate.updateId !== update.updateId) {
      return false;
    }

    this.#updateWaiters.delete(waiterKey);
    if (dispatchReceivedEvent) {
      this.#dispatchPendingUpdateReceived(workflowId, update.name, update);
    }

    waiter({
      payload: update.payload,
      respond: this.#createCoordinatedUpdateResponder(workflowId, update.name, update),
    });
    return true;
  }

  async #findPendingUpdateByName(
    workflowId: string,
    name: string,
  ): Promise<UpdateRequest | undefined> {
    const pendingUpdates = await this.#updateCoordinator.getPendingUpdates(workflowId);
    return pendingUpdates.find((update) => update.name === name);
  }

  async #processParallelOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'parallel' }>,
  ): Promise<void> {
    // `ctx.all()` awaits every branch, so there's no "loser" to abort like
    // there is for `ctx.race()`. Each sub-operation runs to completion or
    // throws; `Promise.all` short-circuits on the first rejection, but the
    // surviving branches' budgets are intentionally preserved — callers that
    // want cancellation on failure should use `ctx.race()` with a guard.
    return this.#runOperationWithResult(workflowId, operation, async () =>
      Promise.all(
        operation.operations.map((subOperation) =>
          this.#executeSubOperation(workflowId, subOperation),
        ),
      ),
    );
  }

  async #processRaceOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'race' }>,
  ): Promise<void> {
    return this.#runOperationWithResult(workflowId, operation, async () => {
      // Abort losing sub-operations once the race settles. Without this,
      // a losing agent sub-op would continue running its full LLM loop in
      // the background, consuming budget and emitting events with no
      // observer.
      const controller = new AbortController();
      const subOperations = operation.operations.map((subOperation) =>
        this.#executeSubOperation(workflowId, subOperation, controller.signal),
      );
      // Swallow rejections from losing branches — only the race winner's
      // result (or error) is surfaced. Losers typically reject with
      // AbortError after the controller fires in the finally block, and
      // without a handler those would surface as unhandled promise
      // rejections.
      for (const promise of subOperations) {
        promise.catch(() => {});
      }
      try {
        return await Promise.race(subOperations);
      } finally {
        controller.abort();
      }
    });
  }

  async #processMemoOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'memo' }>,
  ): Promise<void> {
    return this.#runOperationWithResult(workflowId, operation, async () =>
      callMemoFunction(operation.fn),
    );
  }

  async #processOffloadOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'offload' }>,
  ): Promise<void> {
    return this.#runOperationWithResult(workflowId, operation, async () => {
      const data = await (operation.fn as () => Promise<unknown>)();
      const encoded = encode(data);
      await this.#storage.put(KEYS.offload(workflowId, operation.key), encoded);
      return {
        key: operation.key,
        workflowId,
        sizeBytes: encoded.byteLength,
      };
    });
  }

  async #processLoadOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'load' }>,
  ): Promise<void> {
    return this.#runOperationWithResult(workflowId, operation, async () => {
      const raw = await this.#storage.get(
        KEYS.offload(operation.reference.workflowId, operation.reference.key),
      );
      if (raw === null) {
        throw new Error(
          `Offloaded data not found for key "${operation.reference.key}" in workflow "${operation.reference.workflowId}"`,
        );
      }
      return decode(raw);
    });
  }

  async #processArchiveOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'archive' }>,
  ): Promise<void> {
    return this.#runOperationWithResult(workflowId, operation, async () => {
      await this.#storage.put(KEYS.archive(workflowId, operation.key), encode(operation.data));
      return undefined;
    });
  }

  async #processStreamOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'stream' }>,
  ): Promise<void> {
    return this.#runOperationWithResult(workflowId, operation, () =>
      this.#createStreamReference(workflowId, operation),
    );
  }

  async #createStreamReference(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'stream' }>,
  ): Promise<StreamReference> {
    const sink: StreamSink = {
      heartbeat: (details?: unknown) => {
        this.#heartbeatDetails.set(workflowId, details);
      },
    };

    const writtenKeys: string[] = [];
    try {
      const streamSummary = await this.#writeStreamChunks(
        workflowId,
        operation,
        operation.fn(sink),
        writtenKeys,
      );
      const reference: StreamReference = {
        key: operation.key,
        workflowId,
        chunkCount: streamSummary.chunkCount,
        totalSizeBytes: streamSummary.totalSizeBytes,
      };
      await this.#storage.put(KEYS.streamMetadata(workflowId, operation.key), encode(reference));
      return reference;
    } catch (error) {
      await this.#cleanupStreamChunks(workflowId, operation.key, writtenKeys);
      throw error;
    }
  }

  async #writeStreamChunks(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'stream' }>,
    asyncGenerator: AsyncGenerator<unknown, void, unknown>,
    writtenKeys: string[],
  ): Promise<{ chunkCount: number; totalSizeBytes: number }> {
    let chunkCount = 0;
    let totalSizeBytes = 0;

    for await (const chunk of asyncGenerator) {
      const encoded = encode(chunk);
      const chunkKey = KEYS.streamChunk(workflowId, operation.key, chunkCount);
      await this.#storage.put(chunkKey, encoded);
      writtenKeys.push(chunkKey);
      totalSizeBytes += encoded.byteLength;
      chunkCount++;
    }

    return { chunkCount, totalSizeBytes };
  }

  async #cleanupStreamChunks(
    workflowId: string,
    key: string,
    writtenKeys: string[],
  ): Promise<void> {
    await cleanupPartialStreamChunks(
      this.#storage,
      workflowId,
      key,
      writtenKeys,
      createCleanupErrorReporter(this.#handleCleanupError.bind(this), workflowId),
    );
  }

  async #processRunAllOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'run-all' }>,
  ): Promise<void> {
    return this.#runOperationWithResult(workflowId, operation, () =>
      executeRunAllBranches(
        // `ctx.runAll()` stores raw Function references on the request by construction.
        operation.branches as Parameters<typeof executeRunAllBranches>[0],
        callActivityFunction as Parameters<typeof executeRunAllBranches>[1],
      ),
    );
  }

  async #processAgentContextOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'agent' }>,
  ): Promise<void> {
    return this.#runOperationWithResult(workflowId, operation, () =>
      this.#executeAgentContextOperationResult(workflowId, operation),
    );
  }

  async #executeAgentContextOperationResult(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'agent' }>,
  ): Promise<unknown> {
    const { executeAgentLoop } = await import('../ai/agent.ts');
    const {
      prompt,
      budget: budgetOptions,
      budgetNamespace,
      contextStrategy: _contextStrategy,
      ...rest
    } = operation.options;
    const budgetTracker = await this.#createAgentBudgetTracker(
      workflowId,
      operation,
      budgetOptions,
    );
    const resolvedBudgetNamespace = this.#resolveAgentBudgetNamespace(budgetNamespace);
    await this.#checkAgentBudgetPolicy(workflowId, budgetOptions, resolvedBudgetNamespace);

    const context = this.#inlineStrategy?.getContext(workflowId);
    this.#exposeTokenUsageAccessor(context, budgetTracker);

    const agentInterception = this.#createAgentInterception(workflowId, rest.model, prompt);
    const agentInterceptorGenerator = this.#openAgentInterceptor(agentInterception);
    const { ToolEffectLog } = await import('../ai/tool-effect-log.ts');
    const toolEffectLog = new ToolEffectLog(this.#storage, workflowId, operation.operationId);
    const agentResult = await executeAgentLoop(
      {
        ...rest,
        modelRouter: rest.modelRouter ?? this.#defaultModelRouter,
        budget: budgetTracker,
        eventTarget: this,
        workflowId,
        agentId: operation.operationId,
        onTurnStarted: agentInterception.onTurnStarted,
        onTurnCompleted: agentInterception.onTurnCompleted,
        onToolCalled: agentInterception.onToolCalled,
        onToolReturned: agentInterception.onToolReturned,
        toolEffectLog,
      },
      prompt,
    );
    this.#closeAgentInterceptor(agentInterceptorGenerator, agentResult.content);
    this.#exposeAgentObservability(context, agentResult, rest.maxTurns ?? 10);
    this.#recordAgentContextCost(context, agentResult.totalCost);
    await this.#recordAgentBudgetCost(
      workflowId,
      operation.operationId,
      resolvedBudgetNamespace,
      agentResult.totalCost,
    );
    return agentResult.content;
  }

  async #createAgentBudgetTracker(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'agent' }>,
    budgetOptions: Extract<ContextOperationRequest, { type: 'agent' }>['options']['budget'],
  ): Promise<InstanceType<(typeof import('../ai/budget.ts'))['BudgetTracker']> | undefined> {
    if (!budgetOptions) {
      return undefined;
    }

    const { BudgetTracker } = await import('../ai/budget.ts');
    const { AgentBudgetWarningEvent, AgentBudgetExceededEvent } = await import('../ai/events.ts');

    return new BudgetTracker(budgetOptions, {
      onWarning: (state) => {
        const threshold = budgetOptions.warningThreshold ?? 0.8;
        const costFraction =
          budgetOptions.maxCost !== undefined && budgetOptions.maxCost > 0
            ? state.costUsed / budgetOptions.maxCost
            : 0;
        const tokenFraction =
          budgetOptions.maxTokens !== undefined && budgetOptions.maxTokens > 0
            ? state.tokensUsed / budgetOptions.maxTokens
            : 0;
        const usedPercent = Math.max(costFraction, tokenFraction);
        const event = new AgentBudgetWarningEvent(
          workflowId,
          operation.operationId,
          usedPercent,
          state.tokensRemaining,
          state.costRemaining,
          threshold,
        );
        this.dispatchEvent(event);
        this.#forwardEventToHandle(workflowId, event);
      },
      onExceeded: (state) => {
        const event = new AgentBudgetExceededEvent(
          workflowId,
          operation.operationId,
          state.tokensUsed,
          state.costUsed,
          budgetOptions.maxTokens ?? 0,
          budgetOptions.maxCost ?? 0,
        );
        this.dispatchEvent(event);
        this.#forwardEventToHandle(workflowId, event);
      },
    });
  }

  #resolveAgentBudgetNamespace(budgetNamespace: string | undefined): string | undefined {
    if (!this.#budgetPolicyEnforcer) {
      return undefined;
    }

    return (
      budgetNamespace ??
      (this.#budgetPolicyEnforcer.policies.size === 1
        ? this.#budgetPolicyEnforcer.policies.keys().next().value
        : undefined)
    );
  }

  async #checkAgentBudgetPolicy(
    workflowId: string,
    budgetOptions: Extract<ContextOperationRequest, { type: 'agent' }>['options']['budget'],
    resolvedBudgetNamespace: string | undefined,
  ): Promise<void> {
    if (!this.#budgetPolicyEnforcer || !resolvedBudgetNamespace) {
      return;
    }

    if (!budgetOptions) {
      this.dispatchEvent(
        new DevelopmentWarningEvent(
          workflowId,
          'Organization budget policy is active but ctx.agent() was called without budget options. Provide budget with model pricing to enable cost tracking and org budget enforcement.',
          [],
        ),
      );
    }

    await this.#budgetPolicyEnforcer.checkBudget(resolvedBudgetNamespace);
  }

  #exposeTokenUsageAccessor(
    context: ReturnType<InlineExecutionStrategy['getContext']> | undefined,
    budgetTracker: InstanceType<(typeof import('../ai/budget.ts'))['BudgetTracker']> | undefined,
  ): void {
    if (!context || !budgetTracker) {
      return;
    }

    const previousAccessor = context.exposedAccessors.get('tokenUsage');
    context.expose({
      tokenUsage: () => {
        const current = budgetTracker.budgetRemaining();
        if (!previousAccessor) {
          return current;
        }

        const previous = previousAccessor() as typeof current;
        const mergedBreakdown = new Map<
          string,
          { model: string; inputTokens: number; outputTokens: number; cost: number }
        >();
        for (const entry of previous.breakdown) {
          mergedBreakdown.set(entry.model, { ...entry });
        }
        for (const entry of current.breakdown) {
          const existing = mergedBreakdown.get(entry.model);
          if (existing) {
            existing.inputTokens += entry.inputTokens;
            existing.outputTokens += entry.outputTokens;
            existing.cost += entry.cost;
            continue;
          }

          mergedBreakdown.set(entry.model, { ...entry });
        }

        return {
          tokensUsed: current.tokensUsed + previous.tokensUsed,
          costUsed: current.costUsed + previous.costUsed,
          tokensRemaining: current.tokensRemaining,
          costRemaining: current.costRemaining,
          breakdown: [...mergedBreakdown.values()],
        };
      },
    });
  }

  #createAgentInterception(
    workflowId: string,
    model: string,
    prompt: string,
  ): import('./interceptor.ts').AgentInterception {
    return {
      workflowId,
      model,
      prompt,
      headers: new Map<string, string>(),
    };
  }

  #openAgentInterceptor(
    agentInterception: import('./interceptor.ts').AgentInterception,
  ): Generator<unknown, unknown, unknown> | undefined {
    const composedInterceptor = this.#getComposedWorkflowInterceptor();
    if (!composedInterceptor) {
      return undefined;
    }

    const generator = composedInterceptor.agent(
      agentInterception,
      createAgentInterceptorExecute(agentInterception),
    );
    generator.next();
    return generator;
  }

  #closeAgentInterceptor(
    generator: Generator<unknown, unknown, unknown> | undefined,
    content: string,
  ): void {
    if (generator) {
      generator.next(content);
    }
  }

  #exposeAgentObservability(
    context: ReturnType<InlineExecutionStrategy['getContext']> | undefined,
    agentResult: Awaited<ReturnType<(typeof import('../ai/agent.ts'))['executeAgentLoop']>>,
    agentMaxTurns: number,
  ): void {
    if (!context) {
      return;
    }

    const previousWaterfallAccessor = context.exposedAccessors.get('agentCostWaterfall');
    const previousConversationAccessor = context.exposedAccessors.get('agentConversation');
    const previousProjectionAccessor = context.exposedAccessors.get('agentCostProjection');
    const currentTurnCosts = agentResult.turnCosts;
    const currentConversation = agentResult.conversation;
    const currentTurnCount = agentResult.turnCount;
    const currentTotalCost = agentResult.totalCost;

    context.expose({
      agentCostWaterfall: () => {
        const previous = previousWaterfallAccessor
          ? (previousWaterfallAccessor() as typeof currentTurnCosts)
          : [];
        return [...previous, ...currentTurnCosts];
      },
      agentConversation: () => {
        const previous = previousConversationAccessor
          ? (previousConversationAccessor() as typeof currentConversation)
          : [];
        return [...previous, ...currentConversation];
      },
      agentCostProjection: () => {
        const previousProjection = previousProjectionAccessor
          ? (previousProjectionAccessor() as {
              averageCostPerTurn: number;
              turnsCompleted: number;
              maxTurns: number;
              projectedTotalCost: number;
            })
          : null;

        const totalTurns = (previousProjection?.turnsCompleted ?? 0) + currentTurnCount;
        const totalCost =
          (previousProjection
            ? previousProjection.averageCostPerTurn * previousProjection.turnsCompleted
            : 0) + currentTotalCost;
        const averageCostPerTurn = totalTurns > 0 ? totalCost / totalTurns : 0;

        return {
          averageCostPerTurn,
          turnsCompleted: totalTurns,
          maxTurns: Math.max(previousProjection?.maxTurns ?? 0, agentMaxTurns),
          projectedTotalCost:
            averageCostPerTurn * Math.max(previousProjection?.maxTurns ?? 0, agentMaxTurns),
        };
      },
    });
  }

  #recordAgentContextCost(
    context: ReturnType<InlineExecutionStrategy['getContext']> | undefined,
    totalCost: number,
  ): void {
    if (!context || totalCost <= 0) {
      return;
    }

    const previousCost = context.getAttribute<number>('weft:tokenCost') ?? 0;
    context.setAttribute('weft:tokenCost', previousCost + totalCost);
  }

  async #recordAgentBudgetCost(
    workflowId: string,
    operationId: string,
    resolvedBudgetNamespace: string | undefined,
    totalCost: number,
  ): Promise<void> {
    if (!this.#budgetPolicyEnforcer || !resolvedBudgetNamespace || totalCost <= 0) {
      return;
    }

    const chargedKey = KEYS.budgetCharged(operationId);
    const alreadyCharged =
      this.#chargedAgentOperations.has(operationId) ||
      (await this.#storage.get(chargedKey)) !== null;

    if (alreadyCharged) {
      return;
    }

    await this.#storage.put(chargedKey, encode({ cost: totalCost }));
    await this.#budgetPolicyEnforcer.recordCost(resolvedBudgetNamespace, totalCost);
    this.#chargedAgentOperations.add(operationId);

    // Maintain the reverse index so terminal cleanup is O(k) in the
    // workflow's own agent operations rather than O(N) in the engine-wide
    // dedup set.
    let workflowOperations = this.#chargedAgentOperationsByWorkflow.get(workflowId);
    if (!workflowOperations) {
      workflowOperations = new Set();
      this.#chargedAgentOperationsByWorkflow.set(workflowId, workflowOperations);
    }
    workflowOperations.add(operationId);
  }

  async #processChildWorkflowOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'child-workflow' }>,
  ): Promise<void> {
    const currentDepth = this.#getWorkflowNestingDepth(workflowId);
    if (currentDepth + 1 > this.#options.maxNestingDepth) {
      this.#feedOperationResult(workflowId, {
        status: 'failed',
        error:
          `Child workflow nesting depth exceeded: ${currentDepth + 1} exceeds maximum of ${this.#options.maxNestingDepth}. ` +
          'Configure maxNestingDepth in engine options to increase the limit.',
      });
      return;
    }

    return this.#runOperationWithResult(workflowId, operation, () =>
      this.#executeChildWorkflow(workflowId, operation, currentDepth),
    );
  }

  #getWorkflowNestingDepth(workflowId: string): number {
    const currentContext = this.#inlineStrategy?.getContext(workflowId);
    return currentContext?.nestingDepth ?? this.#workflowNestingDepths.get(workflowId) ?? 0;
  }

  async #executeChildWorkflow(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'child-workflow' }>,
    currentDepth: number,
  ): Promise<unknown> {
    const rawId = operation.options?.['id'];
    const childWorkflowId = typeof rawId === 'string' ? rawId : crypto.randomUUID();
    const parentHeaders = this.#workflowHeaders.get(workflowId) ?? new Map<string, string>();
    const executeChild = async () => {
      this.#pendingNestingDepth = currentDepth + 1;
      this.#pendingParentHeaders = this.#workflowHeaders.get(workflowId);
      const childHandle = await this.start(operation.workflowType, operation.input, {
        id: childWorkflowId,
      });
      return childHandle.result();
    };

    const composedInterceptor = this.#getComposedWorkflowInterceptor();
    if (!composedInterceptor) {
      return executeChild();
    }

    return composedInterceptor.childWorkflow(
      {
        workflowId,
        childWorkflowId,
        workflowType: operation.workflowType,
        input: operation.input,
        headers: new Map<string, string>(),
        parentHeaders,
      },
      executeChild,
    );
  }

  async #processWaitReviewOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'wait-review' }>,
  ): Promise<void> {
    return this.#runOperationWithoutResult(workflowId, operation, () =>
      this.#processReviewOperation(workflowId, operation.reviewOptions),
    );
  }

  async #processHandoffOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'handoff' }>,
  ): Promise<void> {
    return this.#runOperationWithResult(workflowId, operation, async () => {
      const { handoff: executeHandoff, createChildHeaders } = await import('../ai/coordination.ts');
      return executeHandoff({
        ...operation.options,
        headers: createChildHeaders(this.#workflowHeaders.get(workflowId)),
      });
    });
  }

  async #processDebateOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'debate' }>,
  ): Promise<void> {
    return this.#runOperationWithResult(workflowId, operation, async () => {
      const { debate: executeDebate } = await import('../ai/coordination.ts');
      return executeDebate(operation.options);
    });
  }

  async #processSuperviseOperation(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'supervise' }>,
  ): Promise<void> {
    return this.#runOperationWithResult(workflowId, operation, async () => {
      const { supervise: executeSupervise } = await import('../ai/coordination.ts');
      return executeSupervise(operation.options);
    });
  }

  async #executeSubOperation(
    workflowId: string,
    operation: ContextOperationRequest,
    signal?: AbortSignal,
  ): Promise<unknown> {
    // Check for abort before starting any sub-operation so that losing race
    // branches are skipped if the winner has already settled.
    signal?.throwIfAborted();

    switch (operation.type) {
      case 'activity':
        signal?.throwIfAborted();
        return callActivityFunction(operation.fn, operation.args);
      case 'memo':
        signal?.throwIfAborted();
        return callMemoFunction(operation.fn);
      case 'agent': {
        const { executeAgentLoop } = await import('../ai/agent.ts');
        const {
          prompt,
          budget: budgetOptions,
          budgetNamespace,
          contextStrategy: _contextStrategy,
          ...rest
        } = operation.options;

        // Use the shared helper so agent sub-operations get the same
        // warning/exceeded event wiring as standalone `ctx.agent()` calls.
        const budgetTracker = await this.#createAgentBudgetTracker(
          workflowId,
          operation,
          budgetOptions,
        );

        // Enforce organization-level budget policy before starting the agent
        // loop so that agents embedded in ctx.all()/ctx.race() collectively
        // count against the shared namespace cap, matching the behavior of
        // #processAgentContextOperation.
        const resolvedBudgetNamespace = this.#resolveAgentBudgetNamespace(budgetNamespace);
        await this.#checkAgentBudgetPolicy(workflowId, budgetOptions, resolvedBudgetNamespace);

        const { ToolEffectLog } = await import('../ai/tool-effect-log.ts');
        const toolEffectLog = new ToolEffectLog(this.#storage, workflowId, operation.operationId);
        const agentResult = await executeAgentLoop(
          {
            ...rest,
            budget: budgetTracker,
            // Thread the abort signal so losing branches of `ctx.race()`
            // stop consuming budget after the race settles.
            signal,
            toolEffectLog,
          },
          prompt,
        );

        // Record against org budget so multiple agents in ctx.all()/ctx.race()
        // do not bypass the namespace cap.
        await this.#recordAgentBudgetCost(
          workflowId,
          operation.operationId,
          resolvedBudgetNamespace,
          agentResult.totalCost,
        );

        // Match `#processAgentContextOperation` which unwraps the result to
        // the content string. Without this, `ctx.all()`/`ctx.race()` with
        // agent sub-operations would return the full `AgentResult` object
        // while standalone `ctx.agent()` returns the content — breaking
        // type expectations for callers.
        return agentResult.content;
      }
      default:
        throw new Error(`Unsupported sub-operation type: ${operation.type}`);
    }
  }

  async #handleTimerFired(entry: { id: string; workflowId: string; kind: string }): Promise<void> {
    // Check if this timer is for a review escalation/timeout
    if (entry.id.startsWith('review-escalation:') || entry.id.startsWith('review-timeout:')) {
      // Extract reviewId from the timer ID
      const parts = entry.id.split(':');
      const reviewId = parts[1]!;
      const handler = this.#reviewEscalationHandlers.get(reviewId);
      if (handler) {
        // Guard: skip if the workflow is no longer running (e.g. cancelled/failed concurrently)
        const state = await this.#loadWorkflowState(entry.workflowId);
        if (!state || state.status !== 'running') return;
        await handler(entry);
      }
      return;
    }

    if (entry.kind === 'sleep') {
      // Extract the operation ID from the timer ID (format: "sleep:<operationId>")
      const operationId = entry.id.replace('sleep:', '');
      const resolverKey = `${entry.workflowId}:${operationId}`;
      const resolver = this.#sleepResolvers.get(resolverKey);
      if (resolver) {
        this.#sleepResolvers.delete(resolverKey);
        const workflowOps = this.#sleepResolversByWorkflow.get(entry.workflowId);
        if (workflowOps) {
          workflowOps.delete(operationId);
          if (workflowOps.size === 0) this.#sleepResolversByWorkflow.delete(entry.workflowId);
        }
        resolver();
      }
    } else if (entry.kind === 'execution-deadline') {
      await this.timeout(entry.workflowId);
    }
  }

  /** Remove all pending review entries from storage for a given workflow. */
  async #cleanupReviews(workflowId: string): Promise<void> {
    const prefix = `review:${workflowId}:`;
    const deleteOperations: import('../storage/interface.ts').BatchOperation[] = [];
    for await (const [key] of this.#storage.scan(prefix)) {
      deleteOperations.push({ type: 'delete', key });
    }
    if (deleteOperations.length > 0) {
      await this.#storage.batch(deleteOperations);
    }
  }

  /**
   * Remove durable records keyed by `workflowId` that otherwise leak after a
   * workflow reaches a terminal state.
   *
   * - When `includeOutputArtifacts` is `false` (used by `#completeWorkflow`
   *   and `#failWorkflow`), only internal bookkeeping is swept: pending
   *   signals. Output artifacts — offloaded values, blob stream chunks,
   *   shared state, and event history — are preserved so consumers can
   *   still read them via `getStreamChunks()`, `getOffload()`,
   *   `Engine.getEvents()`, etc. after `handle.result()` resolves.
   * - When `includeOutputArtifacts` is `true` (used by `#terminateWorkflow`),
   *   the workflow has been cancelled or timed out and no consumer is
   *   waiting on output artifacts, so everything except `ev:` (preserved
   *   for the events endpoint) is removed.
   *
   * Concurrency note: we assume all writers for a workflow's prefixed keys
   * originate from that workflow's own execution. By the time this runs, the
   * workflow is already terminal and cannot schedule new writes —
   * `#completeWorkflow`, `#failWorkflow`, and `#terminateWorkflow` all await
   * this method before returning. Any write that races the scan must have
   * come from a background task that itself holds a handle to the terminal
   * workflow, and those are caller-level bugs we don't try to paper over here.
   *
   * Scale note: deletes are flushed in batches of `CLEANUP_BATCH_SIZE` so
   * workflows with many blobs/signals do not allocate a single oversized
   * operation array.
   */
  async #cleanupWorkflowStorage(
    workflowId: string,
    includeOutputArtifacts: boolean,
  ): Promise<void> {
    // Always sweep internal state (signals are workflow-scoped scratch space).
    const prefixes: string[] = [`sig:${workflowId}:`];

    if (includeOutputArtifacts) {
      // Terminated workflows have no waiting consumers, so drop the output
      // artifacts too. Event history is still preserved via the omission of
      // the `ev:` prefix — callers that want it gone should use a storage
      // TTL or explicit pruning.
      prefixes.push(`offload:${workflowId}:`, `blob:${workflowId}:`, `shared:${workflowId}:`);
    }

    const CLEANUP_BATCH_SIZE = 500;
    let deleteOperations: import('../storage/interface.ts').BatchOperation[] = [];
    const flush = async (): Promise<void> => {
      if (deleteOperations.length === 0) return;
      await this.#storage.batch(deleteOperations);
      deleteOperations = [];
    };

    for (const prefix of prefixes) {
      for await (const [key] of this.#storage.scan(prefix)) {
        deleteOperations.push({ type: 'delete', key });
        if (deleteOperations.length >= CLEANUP_BATCH_SIZE) {
          await flush();
        }
      }
    }

    await flush();
  }

  /**
   * Shared cleanup invoked from every terminal-state transition (complete,
   * fail, cancel, timeout). Drops in-memory state (checkpoints, heartbeat
   * details, agent workflow membership, waiters) and deletes durable records
   * under workflow-keyed storage prefixes. Also releases the per-workflow
   * set of charged agent operation IDs so `#chargedAgentOperations` cannot
   * grow unbounded across the engine's lifetime.
   *
   * `includeOutputArtifacts` controls whether the caller has any consumers
   * still waiting to read streams/offload/shared state from the terminal
   * workflow. `#completeWorkflow` and `#failWorkflow` pass `false` so those
   * artifacts remain queryable after `handle.result()` resolves; only
   * `#terminateWorkflow` (cancel/timeout) passes `true`.
   */
  async #cleanupTerminalWorkflow(
    workflowId: string,
    includeOutputArtifacts: boolean,
  ): Promise<void> {
    // In-memory state
    this.#checkpoints.delete(workflowId);
    this.#heartbeatDetails.delete(workflowId);
    this.#agentWorkflowIds.delete(workflowId);
    this.#eventLogHeads.delete(workflowId);
    this.#cleanupWaiters(workflowId);

    // Release the workflow's agent operation dedup entries via the reverse
    // index. O(k) in this workflow's own agent operations rather than O(N)
    // in the engine-wide set — important for long-lived engines that run
    // many agents across many workflows.
    //
    // Also queue the per-operation `budget-charged:{operationId}` durable
    // keys for deletion. These are not workflow-scoped in storage, so we
    // have to build the batch from the reverse index before dropping it.
    const workflowOperations = this.#chargedAgentOperationsByWorkflow.get(workflowId);
    const budgetChargedDeletes: import('../storage/interface.ts').BatchOperation[] = [];
    if (workflowOperations) {
      for (const operationId of workflowOperations) {
        this.#chargedAgentOperations.delete(operationId);
        budgetChargedDeletes.push({ type: 'delete', key: KEYS.budgetCharged(operationId) });
      }
      this.#chargedAgentOperationsByWorkflow.delete(workflowId);
    }

    // Durable records
    await this.#cleanupReviews(workflowId);
    await this.#cleanupWorkflowStorage(workflowId, includeOutputArtifacts);
    if (budgetChargedDeletes.length > 0) {
      await this.#storage.batch(budgetChargedDeletes);
    }
  }

  /**
   * Handle a `wait-review` operation: create a durable review request,
   * dispatch events, fire webhooks, set up escalation timers, and block
   * until a decision arrives via `submitReview()`.
   */
  async #processReviewOperation(workflowId: string, options: HumanReviewOptions): Promise<void> {
    const now = this.#options.getNow();

    // Create a review request in storage
    const reviewOptions: import('../ai/human-review.ts').ReviewOptions = {
      artifact: options.artifact,
    };
    if (options.reviewType !== undefined) reviewOptions.reviewType = options.reviewType;
    if (options.reviewers !== undefined) reviewOptions.reviewers = options.reviewers;
    if (options.allowPartial !== undefined) reviewOptions.allowPartial = options.allowPartial;
    if (options.timeout !== undefined) reviewOptions.timeout = options.timeout;
    if (options.escalation !== undefined) reviewOptions.escalation = options.escalation;
    if (options.webhookUrl !== undefined) reviewOptions.webhookUrl = options.webhookUrl;

    const reviewRequest = await this.#reviewCoordinator.createReview(workflowId, reviewOptions);

    const reviewId = reviewRequest.reviewId;

    // Dispatch HumanReviewRequestedEvent
    this.dispatchEvent(
      new HumanReviewRequestedEvent(
        workflowId,
        reviewId,
        reviewRequest.reviewType,
        reviewRequest.reviewers,
      ),
    );

    // Fire webhook notification with cancellation support tied to engine lifecycle
    if (options.webhookUrl) {
      const webhookAbort = new AbortController();
      this.#pendingWebhooks.add(webhookAbort);
      void this.#sendReviewWebhook(workflowId, reviewRequest, options.webhookUrl, webhookAbort);
    }

    // Set up escalation timers and track their IDs for cleanup
    const timerIds: string[] = [];
    if (options.escalation && options.escalation.length > 0) {
      for (const step of options.escalation) {
        const fireAt = now + step.after;
        const timerId = `review-escalation:${reviewId}:${step.after}`;
        timerIds.push(timerId);
        await this.#scheduler.schedule({
          id: timerId,
          workflowId,
          fireAt,
          kind: 'sleep', // Reuse sleep kind — the timer handler checks the id prefix
        });
      }
    }

    // Set up timeout timer
    if (options.timeout !== undefined) {
      const timeoutFireAt = now + options.timeout;
      const timeoutTimerId = `review-timeout:${reviewId}`;
      timerIds.push(timeoutTimerId);
      await this.#scheduler.schedule({
        id: timeoutTimerId,
        workflowId,
        fireAt: timeoutFireAt,
        kind: 'sleep',
      });
    }

    // Wait for the review decision (blocks the workflow generator).
    // We use a result-or-error wrapper instead of rejection to avoid
    // unhandled rejection timing issues with bun:test.
    const { promise, resolve } = Promise.withResolvers<
      { ok: true; value: HumanReviewResult } | { ok: false; error: Error }
    >();
    const waiterKey = `${workflowId}:${reviewId}`;
    this.#reviewWaiters.set(waiterKey, this.#resolveReviewDecision.bind(this, resolve));

    // Register the escalation handler and track the reviewId → workflowId association
    this.#reviewEscalationHandlers.set(
      reviewId,
      this.#handleReviewEscalationTimer.bind(
        this,
        workflowId,
        reviewId,
        waiterKey,
        reviewRequest,
        options,
        resolve,
      ),
    );
    if (timerIds.length > 0) {
      this.#reviewTimerIds.set(reviewId, timerIds);
    }
    let reviewIdSet = this.#workflowReviewIds.get(workflowId);
    if (!reviewIdSet) {
      reviewIdSet = new Set();
      this.#workflowReviewIds.set(workflowId, reviewIdSet);
    }
    reviewIdSet.add(reviewId);

    const outcome = await promise;

    // Clean up escalation handler, timer IDs, and workflow-reviewId tracking
    this.#reviewEscalationHandlers.delete(reviewId);
    this.#reviewTimerIds.delete(reviewId);
    const trackedIds = this.#workflowReviewIds.get(workflowId);
    if (trackedIds) {
      trackedIds.delete(reviewId);
      if (trackedIds.size === 0) this.#workflowReviewIds.delete(workflowId);
    }

    // Cancel any remaining escalation/timeout timers
    if (options.escalation) {
      for (const step of options.escalation) {
        await this.#scheduler.cancel(`review-escalation:${reviewId}:${step.after}`, workflowId);
      }
    }
    if (options.timeout !== undefined) {
      await this.#scheduler.cancel(`review-timeout:${reviewId}`, workflowId);
    }

    if (!outcome.ok) {
      // The workflow was already failed directly (e.g., by the timeout handler).
      // Just return without feeding a result.
      return;
    }

    this.#feedOperationResult(workflowId, { status: 'completed', value: outcome.value });
  }

  async #consumeSignal(workflowId: string, signalName: string): Promise<ConsumedSignalResult> {
    const prefix = `sig:${workflowId}:${signalName}:`;
    for await (const [key, value] of this.#storage.scan(prefix, { limit: 1 })) {
      await this.#storage.delete(key);
      return { found: true, payload: decode(value) };
    }
    return { found: false };
  }

  /**
   * Remove any pending signal, update, and sleep waiters for a workflow. This
   * prevents memory leaks and ensures that cancelled/completed/failed workflows
   * cannot accept new signals, updates, or resolve orphaned sleep timers.
   */
  #cleanupWaiters(workflowId: string): void {
    const prefix = `${workflowId}:`;
    for (const key of this.#signalWaiters.keys()) {
      if (key.startsWith(prefix)) this.#signalWaiters.delete(key);
    }
    for (const key of this.#updateWaiters.keys()) {
      if (key.startsWith(prefix)) this.#updateWaiters.delete(key);
    }
    for (const key of this.#reviewWaiters.keys()) {
      if (key.startsWith(prefix)) this.#reviewWaiters.delete(key);
    }
    const sleepOps = this.#sleepResolversByWorkflow.get(workflowId);
    if (sleepOps) {
      for (const operationId of sleepOps) {
        const key = `${workflowId}:${operationId}`;
        const resolver = this.#sleepResolvers.get(key);
        if (resolver) resolver();
        this.#sleepResolvers.delete(key);
      }
      this.#sleepResolversByWorkflow.delete(workflowId);
    }
    // Clean up any review escalation handlers and their scheduled timers
    const reviewIds = this.#workflowReviewIds.get(workflowId);
    if (reviewIds) {
      for (const reviewId of reviewIds) {
        this.#reviewEscalationHandlers.delete(reviewId);
        const timers = this.#reviewTimerIds.get(reviewId);
        if (timers) {
          for (const timerId of timers) {
            void this.#swallowPromiseRejection(this.#scheduler.cancel(timerId, workflowId));
          }
          this.#reviewTimerIds.delete(reviewId);
        }
      }
      this.#workflowReviewIds.delete(workflowId);
    }

    this.#workflowNestingDepths.delete(workflowId);
    this.#workflowHeaders.delete(workflowId);
  }

  // -------------------------------------------------------------------------
  // Private: state management
  // -------------------------------------------------------------------------

  async #completeWorkflow(workflowId: string, result: unknown): Promise<void> {
    const state = await this.#loadWorkflowState(workflowId);
    if (!state || state.status !== 'running') return;

    const now = this.#options.getNow();
    const duration = now - state.createdAt;

    // Avoid re-reading the workflow state — we already have it from the
    // load above. Mutating in place + a single put cuts one storage round
    // trip per completion, which is the dominant cost in the activity-
    // completions throughput benchmark.
    const updatedState = {
      ...state,
      status: 'completed' as const,
      result,
      updatedAt: now,
    };
    await this.#storage.put(KEYS.workflow(workflowId), encode(updatedState));

    // Clean up attribute indexes and deadline timer
    await this.#cleanupAttributeIndex(workflowId);
    await this.#scheduler.cancel(`deadline:${workflowId}`, workflowId);

    // Drop in-memory state, release charged operations, and delete durable
    // workflow-keyed records (reviews, pending signals, per-workflow dedup).
    // Output artifacts (offload, blob, shared, events) are preserved so
    // consumers can still read them after `handle.result()` resolves.
    await this.#cleanupTerminalWorkflow(workflowId, false);

    const event = new WorkflowCompletedEvent(workflowId, result, duration);
    this.dispatchEvent(event);
    this.#forwardEventToHandle(workflowId, event);

    this.#broadcast({ type: 'workflow:completed', workflowId });

    const resolver = this.#resultResolvers.get(workflowId);
    if (resolver) {
      resolver.resolve(result);
      this.#resultResolvers.delete(workflowId);
    }
  }

  async #failWorkflow(workflowId: string, error: Error): Promise<void> {
    const stateUpdate: Partial<WorkflowState> = {
      status: 'failed',
      error: error.message,
    };
    if (error.stack !== undefined) {
      stateUpdate.errorStack = error.stack;
    }
    await this.#updateWorkflowState(workflowId, stateUpdate);

    // Clean up attribute indexes and deadline timer
    await this.#cleanupAttributeIndex(workflowId);
    await this.#scheduler.cancel(`deadline:${workflowId}`, workflowId);

    // Drop in-memory state, release charged operations, and delete durable
    // workflow-keyed records (reviews, pending signals, per-workflow dedup).
    // Output artifacts (offload, blob, shared, events) are preserved so
    // consumers can still read them after `handle.result()` rejects.
    await this.#cleanupTerminalWorkflow(workflowId, false);

    const event = new WorkflowFailedEvent(workflowId, error);
    this.dispatchEvent(event);
    this.#forwardEventToHandle(workflowId, event);

    const resolver = this.#resultResolvers.get(workflowId);
    if (resolver) {
      resolver.reject(error);
      this.#resultResolvers.delete(workflowId);
    }
  }

  async #updateWorkflowState(workflowId: string, updates: Partial<WorkflowState>): Promise<void> {
    const bytes = await this.#storage.get(KEYS.workflow(workflowId));
    if (!bytes) return;

    const state = decodeWorkflowState(bytes);
    const updated = {
      ...state,
      ...updates,
      updatedAt: this.#options.getNow(),
    };

    await this.#storage.put(KEYS.workflow(workflowId), encode(updated));
  }

  async #loadWorkflowState(workflowId: string): Promise<WorkflowState | null> {
    const bytes = await this.#storage.get(KEYS.workflow(workflowId));
    if (!bytes) return null;
    return decodeWorkflowState(bytes);
  }

  async #loadWorkflowResult(workflowId: string): Promise<unknown> {
    const state = await this.#loadWorkflowState(workflowId);
    if (!state) throw new Error(`Workflow "${workflowId}" not found`);
    if (state.status === 'completed') return state.result;
    if (state.status === 'failed') {
      const restoredError = new Error(state.error ?? 'Workflow failed');
      if (state.errorStack) restoredError.stack = state.errorStack;
      throw restoredError;
    }
    if (state.status === 'cancelled') throw new Error('Workflow cancelled');
    if (state.status === 'timed-out') {
      const elapsed = state.executionDeadline ? state.executionDeadline - state.createdAt : 0;
      throw new WorkflowTimeoutError(workflowId, 'execution', elapsed);
    }
    throw new Error(`Workflow "${workflowId}" is still ${state.status}`);
  }

  // -------------------------------------------------------------------------
  // Private: event forwarding to handles
  // -------------------------------------------------------------------------

  #forwardEventToHandle(workflowId: string, event: Event): void {
    const entry = this.#handleCache.get(workflowId);
    if (!entry) return;
    const handle = entry.ref.deref();
    if (!handle) return;
    // Re-dispatch the typed event so handle listeners receive the full event
    // with all custom properties (workflowId, timeoutType, error, etc.).
    handle.dispatchEvent(event);
  }

  // -------------------------------------------------------------------------
  // Private: activity execution through interceptors
  // -------------------------------------------------------------------------

  /**
   * Resolve the activity function for a given operation. Checks the activity
   * registry first (required for worker mode where `operation.fn` is undefined),
   * then falls back to `operation.fn` for inline mode.
   */
  #resolveActivityFunction(
    operation: Extract<ContextOperationRequest, { type: 'activity' }>,
  ): (...arguments_: unknown[]) => unknown {
    const registered = this.#activityRegistry.resolve(operation.activityName);
    if (registered) return registered;
    if (operation.fn) return operation.fn as (...arguments_: unknown[]) => unknown;
    throw new Error(
      `No activity registered with name "${operation.activityName}". ` +
        'In worker mode, activities must be registered via engine.registerActivity().',
    );
  }

  async #invokeWorkerActivity(
    operationId: string,
    activityName: string,
    args: unknown[],
  ): Promise<unknown> {
    const dispatcher = this.#activityWorkerDispatcher;
    if (!dispatcher) {
      throw new Error(`No activity worker dispatcher available for "${activityName}"`);
    }

    const result = await dispatcher.execute({
      operationId,
      activityName,
      input: args.length === 1 ? args[0] : args,
      attempt: 1,
    });
    if (result.status === 'failed') {
      throw new Error(result.error);
    }

    return result.value;
  }

  #invokeInlineActivity(
    operation: Extract<ContextOperationRequest, { type: 'activity' }>,
    activityContext: import('./types.ts').ActivityContext,
    _activityName: string,
    args: unknown[],
  ): unknown {
    const activityFunction = this.#resolveActivityFunction(operation);
    return callActivityFunction(activityFunction, [...args, activityContext]);
  }

  /**
   * Execute an activity function, dispatching to a Web Worker pool when
   * `activityExecution` is configured, or running inline on the main thread.
   */
  async #executeActivity(
    workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'activity' }>,
  ): Promise<unknown> {
    const activityArguments = operation.args ?? [];

    // Build an ActivityContext so the activity function can send heartbeats.
    const abortController = this.#inlineStrategy?.getAbortController(workflowId);
    const activityContext: import('./types.ts').ActivityContext = {
      signal: abortController?.signal ?? new AbortController().signal,
      heartbeat: (details?: unknown) => {
        this.#heartbeatDetails.set(workflowId, details);
      },
    };

    // Build the leaf executor: either dispatch to a worker or call inline.
    const invokeActivity = this.#activityWorkerDispatcher
      ? this.#invokeWorkerActivity.bind(this, operation.operationId)
      : this.#invokeInlineActivity.bind(this, operation, activityContext);

    // If there are activity interceptors, use cached composition
    const composedActivity = this.#getComposedActivityInterceptor();
    if (composedActivity) {
      const activityInterception = {
        workflowId,
        activityName: operation.activityName,
        input: activityArguments.length === 1 ? activityArguments[0] : activityArguments,
        attempt: 1,
        headers: new Map<string, string>(),
      };

      const result = await composedActivity.execute(activityInterception, async (interception) => {
        const args = Array.isArray(interception.input) ? interception.input : [interception.input];
        return invokeActivity(operation.activityName, args);
      });

      // Capture interceptor headers onto the operation for dispatch
      if (activityInterception.headers.size > 0) {
        (operation as Record<string, unknown>)['headers'] = [
          ...activityInterception.headers.entries(),
        ];
      }

      return result;
    }

    // If there are workflow interceptors with activity hooks, use cached composition
    const composedWorkflow = this.#getComposedWorkflowInterceptor();
    if (composedWorkflow) {
      const interception = {
        workflowId,
        activityName: operation.activityName,
        input: activityArguments.length === 1 ? activityArguments[0] : activityArguments,
        attempt: 1,
        headers: new Map<string, string>(),
      };

      function* execute(): Generator<unknown, unknown, unknown> {
        const result = invokeActivity(operation.activityName, activityArguments);
        yield result;
        return result;
      }

      const generator = composedWorkflow.activity(interception, execute);
      let current: IteratorResult<unknown, unknown> = generator.next();
      while (!current.done) {
        current = generator.next(current.value);
      }

      // Capture interceptor headers onto the operation for dispatch
      if (interception.headers.size > 0) {
        (operation as Record<string, unknown>)['headers'] = [...interception.headers.entries()];
      }

      return current.value;
    }

    return invokeActivity(operation.activityName, activityArguments);
  }

  // -------------------------------------------------------------------------
  // Private: development mode checkpoint validation
  // -------------------------------------------------------------------------

  #validateDevelopmentCheckpoint(workflowId: string): void {
    if (!this.#options.development) return;

    const context = this.#inlineStrategy?.getContext(workflowId);
    if (!context) return;

    const step = context.stepIndex;
    const current = this.#checkpoints.get(workflowId);
    if (!current) return;
    const result = validateCheckpointRoundTrip(current);

    if (!result.valid) {
      const fieldPaths = result.divergences.map((divergence) => divergence.path);
      const message = `Checkpoint at step ${step} has ${result.divergences.length} non-serializable field(s)`;
      this.dispatchEvent(new DevelopmentWarningEvent(workflowId, message, fieldPaths));
    }
  }

  /**
   * Invoke an update handler, checking that it does not return a generator.
   * Centralises the runtime generator guard for both the inline-handler path
   * in `update()` and the pending-drain path on resume.
   */
  async #invokeUpdateHandler(
    name: string,
    handler: (payload: unknown) => unknown,
    payload: unknown,
  ): Promise<unknown> {
    const result = handler(payload);
    if (isGeneratorResult(result)) {
      throw new TypeError(
        `Update handler "${name}" returned a generator. ` +
          'Update handlers must return a plain value or a Promise, not a generator.',
      );
    }
    return await result;
  }

  /**
   * Process pending coordinated updates that match registered inline handlers.
   * Called on resume to drain updates that arrived while the workflow was paused.
   */
  async #processPendingUpdatesForHandlers(workflowId: string): Promise<void> {
    const context = this.#inlineStrategy?.getContext(workflowId);
    if (!context) return;

    const handlers = context.updateHandlers;
    if (handlers.size === 0) return;

    // getPendingUpdates returns FIFO-sorted results.
    const pendingUpdates = await this.#updateCoordinator.getPendingUpdates(workflowId);
    if (pendingUpdates.length === 0) return;

    for (const update of pendingUpdates) {
      const handler = handlers.get(update.name);
      if (!handler) continue;

      this.dispatchEvent(
        new UpdateReceivedEvent(update.updateId, workflowId, update.name, update.payload),
      );

      let result: unknown;
      let error: string | undefined;
      try {
        result = await this.#invokeUpdateHandler(update.name, handler, update.payload);
      } catch (handlerError) {
        error = handlerError instanceof Error ? handlerError.message : String(handlerError);
      }

      const responseOperations = this.#updateCoordinator.buildResponseOperations(
        update.updateId,
        workflowId,
        result,
        error,
        update.idempotencyKey,
      );
      await this.#storage.batch(responseOperations);

      this.dispatchEvent(
        new UpdateCompletedEvent(update.updateId, workflowId, update.name, result, error),
      );
      this.#broadcast({ type: 'update:completed', workflowId, updateId: update.updateId });
    }
  }

  static readonly #TERMINAL_STATUSES: ReadonlySet<WorkflowStatus> = new Set<WorkflowStatus>([
    'completed',
    'failed',
    'cancelled',
    'timed-out',
  ]);

  /** Throw {@link WorkflowTerminalError} if the workflow is in a terminal state. */
  async #guardTerminalWorkflow(workflowId: string): Promise<void> {
    const stateBytes = await this.#storage.get(KEYS.workflow(workflowId));
    if (!stateBytes) return; // unknown workflow — let downstream handle it
    const state = decodeWorkflowState(stateBytes);
    if (Engine.#TERMINAL_STATUSES.has(state.status)) {
      throw new WorkflowTerminalError(workflowId, state.status);
    }
  }

  /**
   * Post a message to the BroadcastChannel for cross-worker coordination.
   * Only active when `broadcastEvents` is enabled. Lazily creates the channel
   * on first use to avoid overhead when unused.
   */
  #broadcast(message: Record<string, unknown>): void {
    if (!this.#options.broadcastEvents) return;

    if (this.#broadcastChannel === null) {
      try {
        this.#broadcastChannel = new BroadcastChannel('weft:events');
      } catch {
        return;
      }
    }
    this.#broadcastChannel.postMessage(message);
  }
}

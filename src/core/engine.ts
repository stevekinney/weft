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

import type { Storage as WeftStorage } from '../storage/interface.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { ActivityWorkerDispatcher } from '../workers/activity-worker-dispatcher.ts';
import { WorkerPool } from '../workers/pool.ts';
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
  AttributesChangedEvent,
  CheckpointSizeWarningEvent,
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
import { buildIndexOperations, encodeAttributeValue } from './search-attributes.ts';
import { compileStepWorkflow, isAsyncGeneratorFunction } from './step-context.ts';
import { WorkflowTimeoutError } from './timeouts.ts';
import type {
  AttributeFilter,
  Checkpoint,
  CoordinatedUpdateResult,
  EngineOptions,
  ListFilter,
  OperationOutcome,
  PaginatedResult,
  SearchAttributeValue,
  StartOptions,
  StepWorkflowFunction,
  SubmitReviewOptions,
  WorkerOutboundMessage,
  WorkflowEvent,
  WorkflowFunction,
  WorkflowRegistration,
  WorkflowState,
  WorkflowSummary,
} from './types.ts';
import { UpdateCoordinator } from './updates.ts';
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
}

interface ResolvedOptions {
  storage: WeftStorage;
  development: boolean;
  checkpointHistory: number;
  checkpointSizeWarningThreshold: number;
  maxNestingDepth: number;
  broadcastEvents: boolean;
  getNow: () => number;
}

interface WorkflowResultResolver {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

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

function decodeWorkflowState(bytes: Uint8Array): WorkflowState {
  return decode(bytes) as never;
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

  async *[Symbol.asyncIterator](): AsyncIterableIterator<Event> {
    let resolver: (() => void) | undefined;
    const events: Event[] = [];
    const state = { done: false };

    const listener = (event: Event) => {
      events.push(event);
      resolver?.();
    };

    const terminal = (event: Event) => {
      state.done = true;
      listener(event);
    };

    const types = [
      'workflow:completed',
      'workflow:failed',
      'workflow:cancelled',
      'workflow:timed-out',
      'activity:started',
      'activity:completed',
      'signal:received',
    ];

    for (const type of types) {
      this.addEventListener(type, listener);
    }

    // Terminal events override the listener to also set done
    const terminalTypes = [
      'workflow:completed',
      'workflow:failed',
      'workflow:cancelled',
      'workflow:timed-out',
    ];
    for (const type of terminalTypes) {
      this.addEventListener(type, terminal);
    }

    try {
      while (!state.done) {
        if (events.length === 0) {
          const { promise, resolve } = Promise.withResolvers<void>();
          resolver = resolve;
          await promise;
          resolver = undefined;
        }
        while (events.length > 0) {
          yield events.shift()!;
        }
      }
    } finally {
      for (const type of types) {
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
        const listener = (event: Event) => observer.next?.(event);

        const types = [
          'workflow:completed',
          'workflow:failed',
          'workflow:cancelled',
          'workflow:timed-out',
          'activity:started',
          'activity:completed',
        ];

        for (const type of types) {
          this.addEventListener(type, listener);
        }

        const completeListener = () => observer.complete?.();
        this.addEventListener('workflow:completed', completeListener);

        const errorHandler = (event: Event) => {
          if (event instanceof WorkflowFailedEvent) {
            observer.error?.(event.error);
          } else if (event instanceof WorkflowTimedOutEvent) {
            observer.error?.(
              new WorkflowTimeoutError(event.workflowId, event.timeoutType, event.elapsed),
            );
          }
        };
        this.addEventListener('workflow:failed', errorHandler);
        this.addEventListener('workflow:timed-out', errorHandler);

        return {
          unsubscribe: () => {
            for (const type of types) {
              this.removeEventListener(type, listener);
            }
            this.removeEventListener('workflow:completed', completeListener);
            this.removeEventListener('workflow:failed', errorHandler);
            this.removeEventListener('workflow:timed-out', errorHandler);
          },
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

export class Engine extends EventTarget implements Disposable, AsyncDisposable {
  #storage: WeftStorage;
  #registrations: Map<string, RegistrationEntry>;
  #abortController: AbortController;
  #scheduler: Scheduler;
  #options: ResolvedOptions;
  #strategy: ExecutionStrategy;
  #inlineStrategy: InlineExecutionStrategy | null;
  #handleCache: Map<string, WeakRef<WorkflowHandle>>;
  #finalizationRegistry: FinalizationRegistry<string>;
  #resultResolvers: Map<string, WorkflowResultResolver>;
  #signalWaiters: Map<string, (payload: unknown) => void>;
  #updateWaiters: Map<string, (payload: unknown) => void>;
  #sleepResolvers: Map<string, () => void>;
  #interceptors: WorkflowInterceptor[];
  #activityInterceptors: ActivityInterceptor[];
  #composedWorkflowInterceptor: ComposedWorkflowInterceptor | null;
  #composedActivityInterceptor: ComposedActivityInterceptor | null;
  #updateCoordinator: UpdateCoordinator;
  #activityRegistrations: Map<string, (...arguments_: unknown[]) => unknown>;
  #activityWorkerDispatcher: ActivityWorkerDispatcher | null;
  #checkpoints: Map<string, Checkpoint>;
  #broadcastChannel: BroadcastChannel | null;
  #pendingNestingDepth: number | undefined;
  #workflowNestingDepths: Map<string, number>;
  #budgetPolicyEnforcer: import('../ai/budget-policy.ts').BudgetPolicyEnforcer | null;

  constructor(options?: Partial<EngineOptions> & { getNow?: () => number }) {
    super();

    const storage = options?.storage ?? new MemoryStorage();
    const getNow = options?.getNow ?? Date.now;

    this.#storage = storage;
    this.#registrations = new Map();
    this.#abortController = new AbortController();
    this.#handleCache = new Map();
    this.#resultResolvers = new Map();
    this.#signalWaiters = new Map();
    this.#updateWaiters = new Map();
    this.#sleepResolvers = new Map();
    this.#interceptors = [];
    this.#activityInterceptors = [];
    this.#composedWorkflowInterceptor = null;
    this.#composedActivityInterceptor = null;
    this.#updateCoordinator = new UpdateCoordinator(storage);
    this.#activityRegistrations = new Map();
    this.#activityWorkerDispatcher = null;
    this.#checkpoints = new Map();
    this.#broadcastChannel = null;
    this.#pendingNestingDepth = undefined;
    this.#workflowNestingDepths = new Map();
    this.#finalizationRegistry = new FinalizationRegistry<string>((id) => {
      this.#handleCache.delete(id);
    });

    this.#options = {
      storage,
      development: options?.development ?? false,
      checkpointHistory: options?.checkpointHistory ?? 10,
      checkpointSizeWarningThreshold: options?.checkpointSizeWarningThreshold ?? 65_536,
      maxNestingDepth: options?.maxNestingDepth ?? 10,
      broadcastEvents: options?.broadcastEvents ?? false,
      getNow,
    };

    this.#scheduler = new Scheduler({
      storage,
      onTimerFired: (entry) => this.#handleTimerFired(entry),
      getNow,
    });

    // Create the execution strategy
    if (options?.workerExecution) {
      const pool = new WorkerPool({
        workerUrl: options.workerExecution.workerUrl,
        concurrency: options.workerExecution.concurrency ?? 4,
        smol: options.workerExecution.smol ?? false,
      });

      const workerStrategy = new WorkerExecutionStrategy(pool, {
        broadcastEvents: this.#options.broadcastEvents,
      });

      this.#strategy = workerStrategy;
      this.#inlineStrategy = null;
    } else {
      const inlineStrategy = new InlineExecutionStrategy({
        getRegistration: (workflowType: string) => this.#registrations.get(workflowType),
        getNow,
        maxNestingDepth: this.#options.maxNestingDepth,
        development: this.#options.development,
      });

      this.#strategy = inlineStrategy;
      this.#inlineStrategy = inlineStrategy;
    }

    this.#budgetPolicyEnforcer = null;

    // Create the activity worker pool (optional)
    if (options?.activityExecution) {
      const activityPool = new WorkerPool({
        workerUrl: options.activityExecution.workerUrl,
        concurrency: options.activityExecution.poolSize ?? 4,
        smol: options.activityExecution.smol ?? false,
      });
      this.#activityWorkerDispatcher = new ActivityWorkerDispatcher(activityPool);
    }

    // Wire up the strategy message handler
    this.#strategy.onMessage((message) => this.#handleStrategyMessage(message));
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  register(name: string, handler: WorkflowFunction | StepWorkflowFunction): void;
  register(name: string, registration: WorkflowRegistration): void;
  register(
    name: string,
    handlerOrRegistration: WorkflowFunction | StepWorkflowFunction | WorkflowRegistration,
  ): void {
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
   */
  registerActivity(name: string, fn: (...arguments_: unknown[]) => unknown): void {
    this.#activityRegistrations.set(name, fn);
  }

  // -------------------------------------------------------------------------
  // Start workflow
  // -------------------------------------------------------------------------

  async start(type: string, input: unknown, options?: StartOptions): Promise<WorkflowHandle> {
    const registration = this.#registrations.get(type);
    if (!registration) {
      throw new Error(`No workflow registered with name "${type}"`);
    }

    const workflowId = options?.id ?? crypto.randomUUID();

    // Check for duplicate
    const existingBytes = await this.#storage.get(KEYS.workflow(workflowId));
    if (existingBytes !== null) {
      throw new Error(`Workflow with id "${workflowId}" already exists`);
    }

    const now = this.#options.getNow();

    // Create workflow state
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

    // Create initial checkpoint
    const checkpoint = createCheckpoint(workflowId, registration.version, this.#options.getNow());

    // Apply initial search attributes if provided
    if (options?.searchAttributes) {
      checkpoint.searchAttributes = { ...options.searchAttributes };
    }

    this.#checkpoints.set(workflowId, checkpoint);

    // Write state and checkpoint to storage
    const batchOperations: import('../storage/interface.ts').BatchOperation[] = [
      { type: 'put', key: KEYS.workflow(workflowId), value: encode(state) },
      {
        type: 'put',
        key: KEYS.checkpoint(workflowId),
        value: serializeCheckpoint(checkpoint),
      },
    ];

    // Write attribute record and index entries for initial search attributes
    if (options?.searchAttributes && Object.keys(options.searchAttributes).length > 0) {
      batchOperations.push({
        type: 'put',
        key: KEYS.attribute(workflowId),
        value: encode(options.searchAttributes),
      });
      batchOperations.push(...buildIndexOperations(workflowId, {}, options.searchAttributes));
    }

    await this.#storage.batch(batchOperations);

    // Set up execution deadline if needed
    if (state.executionDeadline !== undefined) {
      await this.#scheduler.schedule({
        id: `deadline:${workflowId}`,
        workflowId,
        fireAt: state.executionDeadline,
        kind: 'execution-deadline',
      });
    }

    // Dispatch started event
    this.dispatchEvent(new WorkflowStartedEvent(workflowId, type, input));

    // Create result promise
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.#resultResolvers.set(workflowId, { resolve, reject });

    // Create handle
    const handle = new WorkflowHandle(workflowId, this, promise);
    this.#handleCache.set(workflowId, new WeakRef(handle));
    this.#finalizationRegistry.register(handle, workflowId);

    // Begin execution (non-blocking) via the strategy
    const nestingDepth = this.#pendingNestingDepth ?? 0;
    this.#pendingNestingDepth = undefined;
    this.#workflowNestingDepths.set(workflowId, nestingDepth);
    this.#strategy.startWorkflow({
      workflowId,
      workflowType: type,
      input,
      checkpoint: serializeCheckpoint(checkpoint),
      nestingDepth,
      ...(state.executionDeadline !== undefined && { deadline: state.executionDeadline }),
    });

    return handle;
  }

  // -------------------------------------------------------------------------
  // Handle retrieval
  // -------------------------------------------------------------------------

  getHandle(workflowId: string): WorkflowHandle {
    // Check cache
    const weakRef = this.#handleCache.get(workflowId);
    if (weakRef) {
      const existing = weakRef.deref();
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
      existingResolver.resolve = (value: unknown) => {
        originalResolve(value);
        resolve(value);
      };
      existingResolver.reject = (reason: unknown) => {
        originalReject(reason);
        reject(reason);
      };
      resultPromise = promise;
    } else {
      // Workflow may already be complete; load from storage
      resultPromise = this.#loadWorkflowResult(workflowId);
    }

    const handle = new WorkflowHandle(workflowId, this, resultPromise);
    this.#handleCache.set(workflowId, new WeakRef(handle));
    this.#finalizationRegistry.register(handle, workflowId);
    return handle;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async list(filter?: ListFilter): Promise<PaginatedResult<WorkflowSummary>> {
    // If attribute filters are present, query the index first to get matching IDs
    let constrainedIds: Set<string> | null = null;
    if (filter?.attributes && filter.attributes.length > 0) {
      const idSets = await Promise.all(
        filter.attributes.map((attributeFilter) => this.#queryAttributeIndex(attributeFilter)),
      );
      // Intersect all sets
      constrainedIds = idSets[0]!;
      for (let i = 1; i < idSets.length; i++) {
        const nextSet = idSets[i]!;
        for (const id of constrainedIds) {
          if (!nextSet.has(id)) constrainedIds.delete(id);
        }
      }
    }

    const items: WorkflowSummary[] = [];

    for await (const [key, value] of this.#storage.scan('wf:')) {
      // Only process top-level workflow state keys (wf:{id}).
      // Skip any sub-keys like wf:{id}:ckpt, wf:{id}:ckpt:0000000001, etc.
      const idPart = key.slice(3); // strip "wf:"
      if (idPart.includes(':')) continue;

      const state = decodeWorkflowState(value);

      // Constrain to attribute-matched IDs if present
      if (constrainedIds !== null && !constrainedIds.has(state.id)) continue;

      // Apply filters
      if (filter?.status !== undefined) {
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
        if (!statuses.includes(state.status)) continue;
      }

      if (filter?.type !== undefined && state.type !== filter.type) continue;

      items.push({
        id: state.id,
        type: state.type,
        status: state.status,
        version: state.version,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
      });
    }

    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? items.length;
    const paged = items.slice(offset, offset + limit);

    return {
      items: paged,
      total: items.length,
      offset,
      limit,
    };
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
      // Range scan with gte/lte boundaries
      const scanOptions: import('../storage/interface.ts').ScanOptions = {};
      if (filter.gte !== undefined) {
        scanOptions.gte = `idx:${filter.key}:${encodeAttributeValue(filter.gte)}:`;
      }
      if (filter.lte !== undefined) {
        // Use a boundary that includes all workflow IDs for the lte value
        const encodedLte = encodeAttributeValue(filter.lte);
        // Append a character after the last ':' to ensure we include all IDs under this value
        scanOptions.lte = `idx:${filter.key}:${encodedLte}:\xff`;
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
        await this.#storage.delete(signalKey);
        waiter(signalPayload);
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
    const timeout = options?.timeout ?? 5000;

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
          const result = handler(payload);
          this.dispatchEvent(new UpdateCompletedEvent(updateId, workflowId, name, result));
          return result;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.dispatchEvent(
            new UpdateCompletedEvent(updateId, workflowId, name, undefined, errorMessage),
          );
          throw error;
        }
      }
    }

    // Check if workflow is waiting for this update via waitForUpdate
    const waiterKey = `${workflowId}:${name}`;
    const updateWaiter = this.#updateWaiters.get(waiterKey);
    if (updateWaiter) {
      this.#updateWaiters.delete(waiterKey);
      const updateId = crypto.randomUUID();
      this.dispatchEvent(new UpdateReceivedEvent(updateId, workflowId, name, payload));
      updateWaiter(payload);
      this.dispatchEvent(new UpdateCompletedEvent(updateId, workflowId, name, payload));
      return payload;
    }

    // If no active handler, use the UpdateCoordinator with polling
    const updateId = await this.#updateCoordinator.createRequest(workflowId, name, payload);
    this.dispatchEvent(new UpdateReceivedEvent(updateId, workflowId, name, payload));

    const response = await this.#updateCoordinator.waitForResponse(updateId, timeout);

    if (response.error) {
      throw new Error(response.error);
    }

    return response.result;
  }

  async query(workflowId: string, name: string): Promise<unknown> {
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
    this.#handleCache.set(workflowId, new WeakRef(handle));
    this.#finalizationRegistry.register(handle, workflowId);

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
        sleepReferenceTime: resumeCheckpoint.createdAt,
        ...(state.executionDeadline !== undefined && { deadline: state.executionDeadline }),
      });

      if (this.#options.development) {
        context.explain(true);
      }

      const generator = registration.handler(context, state.input);
      this.#inlineStrategy.adoptWorkflow(workflowId, generator, context, workflowAbort);

      // Drive the generator (non-blocking) via the strategy
      this.#inlineStrategy.continueWorkflow(workflowId, undefined);
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

  async #terminateWorkflow(workflowId: string, status: 'cancelled' | 'timed-out'): Promise<void> {
    this.#strategy.cancelWorkflow(workflowId);

    const state = await this.#loadWorkflowState(workflowId);
    if (!state) return;
    const elapsed = this.#options.getNow() - state.createdAt;

    await this.#updateWorkflowState(workflowId, { status });
    await this.#cleanupAttributeIndex(workflowId);
    await this.#scheduler.cancel(`deadline:${workflowId}`, workflowId);
    this.#cleanupWaiters(workflowId);

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

  /** Submit a decision for a pending review. Stores the decision and removes the pending review. */
  async submitReview(reviewId: string, options: SubmitReviewOptions): Promise<void> {
    const { decision, reviewer, feedback, workflowId } = options;

    // Look up the review by direct key when workflowId is provided (O(1)),
    // otherwise fall back to scanning all review entries (O(n)).
    let reviewKey: string | null = null;

    if (workflowId !== undefined) {
      const directKey = KEYS.review(workflowId, reviewId);
      const existing = await this.#storage.get(directKey);
      if (existing !== null) {
        reviewKey = directKey;
      }
    } else {
      for await (const [key, value] of this.#storage.scan('review:')) {
        const review = decode(value) as Record<string, unknown>;
        if (review['reviewId'] === reviewId) {
          reviewKey = key;
          break;
        }
      }
    }

    if (reviewKey === null) {
      throw new Error(`Review "${reviewId}" not found`);
    }

    const decisionData = {
      reviewId,
      decision,
      reviewer,
      feedback,
      timestamp: Date.now(),
    };

    await this.#storage.batch([
      { type: 'put', key: `review-decision:${reviewId}`, value: encode(decisionData) },
      { type: 'delete', key: reviewKey },
    ]);
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

    // Check idempotency
    if (idempotencyKey !== undefined) {
      const existing = await this.#updateCoordinator.checkIdempotency(workflowId, idempotencyKey);
      if (existing !== null) {
        return { updateId: existing.updateId, result: existing.result };
      }
    }

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
    this.#abortController.abort();
    this.#scheduler[Symbol.dispose]();
    this.#strategy[Symbol.dispose]();
    this.#activityWorkerDispatcher?.[Symbol.dispose]();
    this.#activityWorkerDispatcher = null;
    this.#inlineStrategy = null;
    this.#handleCache.clear();
    this.#resultResolvers.clear();
    this.#signalWaiters.clear();
    this.#updateWaiters.clear();
    this.#sleepResolvers.clear();
    this.#checkpoints.clear();
    this.#workflowNestingDepths.clear();
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
        operations.push({
          type: 'put',
          key: KEYS.attribute(workflowId),
          value: encode(advanced.searchAttributes),
        });
        operations.push(
          ...buildIndexOperations(workflowId, previousAttributes, advanced.searchAttributes),
        );
      }

      await this.#storage.batch(operations);
      this.#checkpoints.set(workflowId, advanced);

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

      await this.#storage.batch(operations);
      this.#checkpoints.set(workflowId, checkpoint);
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
      return operation as unknown as ContextOperationRequest;
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

      return {
        ...operation,
        type,
        operationId: (operation['id'] as string) ?? crypto.randomUUID(),
        activityName: (operation['activityName'] as string) ?? '',
        args: operation['input'] !== undefined ? [operation['input']] : [],
      } as unknown as ContextOperationRequest;
    }

    throw new Error('Unsupported operation request shape received from execution strategy');
  }

  async #processOperation(workflowId: string, operation: ContextOperationRequest): Promise<void> {
    switch (operation.type) {
      case 'activity': {
        try {
          const result = await this.#executeActivity(workflowId, operation);
          this.#feedOperationResult(workflowId, { status: 'completed', value: result });
        } catch (error) {
          // Enrich error with workflow call site stack
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
        break;
      }

      case 'sleep': {
        // If the timer has already expired (e.g., resumed after crash), resolve immediately
        if (operation.scheduledFireAt <= this.#options.getNow()) {
          this.#feedOperationResult(workflowId, { status: 'completed', value: undefined });
          break;
        }

        const { promise, resolve } = Promise.withResolvers<void>();

        // Schedule via the scheduler's durable timer
        await this.#scheduler.schedule({
          id: `sleep:${operation.operationId}`,
          workflowId,
          fireAt: operation.scheduledFireAt,
          kind: 'sleep',
        });

        // Store the resolution function for when the timer fires
        this.#sleepResolvers.set(operation.operationId, resolve);

        await promise;
        this.#feedOperationResult(workflowId, { status: 'completed', value: undefined });
        break;
      }

      case 'wait-signal': {
        // Check if signal already exists in storage
        const existingPayload = await this.#consumeSignal(workflowId, operation.signalName);
        if (existingPayload !== undefined) {
          this.#feedOperationResult(workflowId, { status: 'completed', value: existingPayload });
          return;
        }

        // Wait for signal
        const { promise, resolve } = Promise.withResolvers<unknown>();
        const waiterKey = `${workflowId}:${operation.signalName}`;
        this.#signalWaiters.set(waiterKey, resolve);

        const payload = await promise;
        this.#feedOperationResult(workflowId, { status: 'completed', value: payload });
        break;
      }

      case 'wait-update': {
        // Check for pending update requests
        const pendingUpdates = await this.#updateCoordinator.getPendingUpdates(workflowId);
        const matchingUpdate = pendingUpdates.find(
          (update) => update.name === operation.updateName,
        );

        if (matchingUpdate) {
          // Consume the pending update immediately
          this.dispatchEvent(
            new UpdateReceivedEvent(
              matchingUpdate.updateId,
              workflowId,
              operation.updateName,
              matchingUpdate.payload,
            ),
          );

          // Build response operations to acknowledge the update
          const responseOperations = this.#updateCoordinator.buildResponseOperations(
            matchingUpdate.updateId,
            workflowId,
            matchingUpdate.payload,
            undefined,
            matchingUpdate.idempotencyKey,
          );
          await this.#storage.batch(responseOperations);

          this.dispatchEvent(
            new UpdateCompletedEvent(
              matchingUpdate.updateId,
              workflowId,
              operation.updateName,
              matchingUpdate.payload,
            ),
          );

          // Feed update payload back as the operation result
          this.#feedOperationResult(workflowId, {
            status: 'completed',
            value: matchingUpdate.payload,
          });
        } else {
          // Wait for update to arrive
          const { promise, resolve } = Promise.withResolvers<unknown>();
          const waiterKey = `${workflowId}:${operation.updateName}`;
          this.#updateWaiters.set(waiterKey, resolve);

          const updatePayload = await promise;
          this.#feedOperationResult(workflowId, { status: 'completed', value: updatePayload });
        }
        break;
      }

      case 'parallel': {
        try {
          const results = await Promise.all(
            operation.operations.map((subOperation) =>
              this.#executeSubOperation(workflowId, subOperation),
            ),
          );
          this.#feedOperationResult(workflowId, { status: 'completed', value: results });
        } catch (error) {
          const enrichedError = error instanceof Error ? error : new Error(String(error));
          this.#feedOperationResult(
            workflowId,
            { status: 'failed', error: enrichedError.message },
            enrichedError,
          );
        }
        break;
      }

      case 'race': {
        try {
          const result = await Promise.race(
            operation.operations.map((subOperation) =>
              this.#executeSubOperation(workflowId, subOperation),
            ),
          );
          this.#feedOperationResult(workflowId, { status: 'completed', value: result });
        } catch (error) {
          const enrichedError = error instanceof Error ? error : new Error(String(error));
          this.#feedOperationResult(
            workflowId,
            { status: 'failed', error: enrichedError.message },
            enrichedError,
          );
        }
        break;
      }

      case 'memo': {
        try {
          const result = await callMemoFunction(operation.fn);
          this.#feedOperationResult(workflowId, { status: 'completed', value: result });
        } catch (error) {
          const enrichedError = error instanceof Error ? error : new Error(String(error));
          this.#feedOperationResult(
            workflowId,
            { status: 'failed', error: enrichedError.message },
            enrichedError,
          );
        }
        break;
      }

      case 'offload': {
        try {
          const data = await (operation.fn as () => Promise<unknown>)();
          const encoded = encode(data);
          await this.#storage.put(KEYS.offload(workflowId, operation.key), encoded);
          const reference = {
            key: operation.key,
            workflowId,
            sizeBytes: encoded.byteLength,
          };
          this.#feedOperationResult(workflowId, { status: 'completed', value: reference });
        } catch (error) {
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
        break;
      }

      case 'load': {
        try {
          const reference = operation.reference;
          const raw = await this.#storage.get(KEYS.offload(reference.workflowId, reference.key));
          if (raw === null) {
            throw new Error(
              `Offloaded data not found for key "${reference.key}" in workflow "${reference.workflowId}"`,
            );
          }
          const data = decode(raw);
          this.#feedOperationResult(workflowId, { status: 'completed', value: data });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.#feedOperationResult(workflowId, { status: 'failed', error: errorMessage });
        }
        break;
      }

      case 'archive': {
        try {
          const encoded = encode(operation.data);
          await this.#storage.put(KEYS.archive(workflowId, operation.key), encoded);
          this.#feedOperationResult(workflowId, { status: 'completed', value: undefined });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.#feedOperationResult(workflowId, { status: 'failed', error: errorMessage });
        }
        break;
      }

      case 'stream': {
        const sink: StreamSink = {
          heartbeat(_details?: unknown) {
            // Future: emit heartbeat event for observability
          },
        };

        const asyncGenerator = operation.fn(sink);
        let chunkIndex = 0;
        let totalSizeBytes = 0;
        const writtenKeys: string[] = [];

        try {
          for await (const chunk of asyncGenerator) {
            const encoded = encode(chunk);
            const chunkKey = KEYS.streamChunk(workflowId, operation.key, chunkIndex);
            await this.#storage.put(chunkKey, encoded);
            writtenKeys.push(chunkKey);
            totalSizeBytes += encoded.byteLength;
            chunkIndex++;
          }

          const reference: StreamReference = {
            key: operation.key,
            workflowId,
            chunkCount: chunkIndex,
            totalSizeBytes,
          };

          const metadataKey = KEYS.streamMetadata(workflowId, operation.key);
          await this.#storage.put(metadataKey, encode(reference));

          this.#feedOperationResult(workflowId, { status: 'completed', value: reference });
        } catch (error) {
          // Clean up any partially written chunks (best-effort)
          if (writtenKeys.length > 0) {
            const deleteOperations = [
              ...writtenKeys.map((key) => ({ type: 'delete' as const, key })),
              { type: 'delete' as const, key: KEYS.streamMetadata(workflowId, operation.key) },
            ];
            await this.#storage.batch(deleteOperations).catch(() => {});
          }

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
        break;
      }

      case 'run-all': {
        try {
          const results: Record<string, unknown> = {};
          const entries = Object.entries(operation.branches);
          const promises = entries.map(async ([name, [fn, ...args]]) => {
            const result = await callActivityFunction(fn, args);
            results[name] = result;
          });
          await Promise.all(promises);
          this.#feedOperationResult(workflowId, { status: 'completed', value: results });
        } catch (error) {
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
        break;
      }

      case 'agent': {
        try {
          const { executeAgentLoop } = await import('../ai/agent.ts');
          const { BudgetTracker } = await import('../ai/budget.ts');
          const { AgentBudgetWarningEvent, AgentBudgetExceededEvent } =
            await import('../ai/events.ts');
          const {
            prompt,
            budget: budgetOptions,
            budgetNamespace,
            contextStrategy: _contextStrategy,
            ...rest
          } = operation.options;

          // Construct BudgetTracker from options, wiring events to engine
          let budgetTracker: InstanceType<typeof BudgetTracker> | undefined;
          if (budgetOptions) {
            budgetTracker = new BudgetTracker(budgetOptions, {
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

          // Resolve the organization budget namespace once for both check
          // and record. If budgetNamespace is specified, use it. If exactly
          // one policy exists, use its namespace. Otherwise skip enforcement.
          const resolvedBudgetNamespace = this.#budgetPolicyEnforcer
            ? (budgetNamespace ??
              (this.#budgetPolicyEnforcer.policies.size === 1
                ? this.#budgetPolicyEnforcer.policies.keys().next().value
                : undefined))
            : undefined;

          if (this.#budgetPolicyEnforcer && resolvedBudgetNamespace) {
            if (!budgetOptions) {
              // Org budget enforcement requires per-workflow budget options
              // with model pricing to compute cost. Without it, cost stays 0
              // and the org counter is never incremented. Dispatch a warning.
              this.dispatchEvent(
                new DevelopmentWarningEvent(
                  workflowId,
                  'Organization budget policy is active but ctx.agent() was called ' +
                    'without budget options. Provide budget with model pricing to ' +
                    'enable cost tracking and org budget enforcement.',
                  [],
                ),
              );
            }
            await this.#budgetPolicyEnforcer.checkBudget(resolvedBudgetNamespace);
          }

          // Expose tokenUsage query accessor that accumulates across
          // multiple ctx.agent() calls in the same workflow.
          const context = this.#inlineStrategy?.getContext(workflowId);
          if (context && budgetTracker) {
            const previousAccessor = context.exposedAccessors.get('tokenUsage');
            context.expose({
              tokenUsage: () => {
                const current = budgetTracker.budgetRemaining();
                if (!previousAccessor) return current;
                const previous = previousAccessor() as typeof current;

                // Merge per-model breakdowns
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
                  } else {
                    mergedBreakdown.set(entry.model, { ...entry });
                  }
                }

                const tokensUsed = current.tokensUsed + previous.tokensUsed;
                const costUsed = current.costUsed + previous.costUsed;

                return {
                  tokensUsed,
                  costUsed,
                  // Remaining values are only meaningful for the latest call's budget
                  tokensRemaining: current.tokensRemaining,
                  costRemaining: current.costRemaining,
                  breakdown: [...mergedBreakdown.values()],
                };
              },
            });
          }

          const agentResult = await executeAgentLoop(
            {
              ...rest,
              budget: budgetTracker,
              eventTarget: this,
              workflowId,
              agentId: operation.operationId,
            },
            prompt,
          );

          // Accumulate cost search attribute across multiple agent calls
          if (context && agentResult.totalCost > 0) {
            const previousCost = context.getAttribute<number>('weft:tokenCost') ?? 0;
            context.setAttribute('weft:tokenCost', previousCost + agentResult.totalCost);
          }

          // Record cost against the resolved organization budget namespace.
          // Note: org budget counter update and checkpoint are not in the same
          // batch() call because the checkpoint happens at the next generator
          // yield. If the process crashes after this write but before the next
          // checkpoint, the agent operation replays and double-charges the org
          // counter. Idempotent recording requires an operation-scoped marker,
          // which is deferred to a future iteration.
          if (this.#budgetPolicyEnforcer && resolvedBudgetNamespace && agentResult.totalCost > 0) {
            await this.#budgetPolicyEnforcer.recordCost(
              resolvedBudgetNamespace,
              agentResult.totalCost,
            );
          }

          this.#feedOperationResult(workflowId, {
            status: 'completed',
            value: agentResult.content,
          });
        } catch (error) {
          const enrichedError = error instanceof Error ? error : new Error(String(error));
          this.#feedOperationResult(
            workflowId,
            { status: 'failed', error: enrichedError.message },
            enrichedError,
          );
        }
        break;
      }

      case 'child-workflow': {
        // Check nesting depth from inline context first, fall back to the
        // engine-level tracking (needed for worker mode where there's no inline context).
        const currentContext = this.#inlineStrategy?.getContext(workflowId);
        const currentDepth =
          currentContext?.nestingDepth ?? this.#workflowNestingDepths.get(workflowId) ?? 0;

        if (currentDepth + 1 > this.#options.maxNestingDepth) {
          const errorMessage =
            `Child workflow nesting depth exceeded: ${currentDepth + 1} exceeds maximum of ${this.#options.maxNestingDepth}. ` +
            `Configure maxNestingDepth in engine options to increase the limit.`;
          this.#feedOperationResult(workflowId, { status: 'failed', error: errorMessage });
          break;
        }

        try {
          // Set pending nesting depth for the child workflow
          this.#pendingNestingDepth = currentDepth + 1;
          const childHandle = await this.start(operation.workflowType, operation.input);
          const childResult = await childHandle.result();
          this.#feedOperationResult(workflowId, { status: 'completed', value: childResult });
        } catch (error) {
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
        break;
      }

      default:
        throw new Error(`Unknown operation type: ${(operation as { type: string }).type}`);
    }
  }

  async #executeSubOperation(
    _workflowId: string,
    operation: ContextOperationRequest,
  ): Promise<unknown> {
    switch (operation.type) {
      case 'activity':
        return callActivityFunction(operation.fn, operation.args);
      case 'memo':
        return callMemoFunction(operation.fn);
      default:
        throw new Error(`Unsupported sub-operation type: ${operation.type}`);
    }
  }

  async #handleTimerFired(entry: { id: string; workflowId: string; kind: string }): Promise<void> {
    if (entry.kind === 'sleep') {
      // Extract the operation ID from the timer ID (format: "sleep:<operationId>")
      const operationId = entry.id.replace('sleep:', '');
      const resolver = this.#sleepResolvers.get(operationId);
      if (resolver) {
        this.#sleepResolvers.delete(operationId);
        resolver();
      }
    } else if (entry.kind === 'execution-deadline') {
      await this.timeout(entry.workflowId);
    }
  }

  async #consumeSignal(workflowId: string, signalName: string): Promise<unknown> {
    const prefix = `sig:${workflowId}:${signalName}:`;
    for await (const [key, value] of this.#storage.scan(prefix, { limit: 1 })) {
      await this.#storage.delete(key);
      return decode(value);
    }
    return undefined;
  }

  /**
   * Remove any pending signal and update waiters for a workflow. This prevents
   * memory leaks and ensures that cancelled/completed/failed workflows cannot
   * accept new signals or updates.
   */
  #cleanupWaiters(workflowId: string): void {
    const prefix = `${workflowId}:`;
    for (const key of this.#signalWaiters.keys()) {
      if (key.startsWith(prefix)) this.#signalWaiters.delete(key);
    }
    for (const key of this.#updateWaiters.keys()) {
      if (key.startsWith(prefix)) this.#updateWaiters.delete(key);
    }
    this.#workflowNestingDepths.delete(workflowId);
  }

  // -------------------------------------------------------------------------
  // Private: state management
  // -------------------------------------------------------------------------

  async #completeWorkflow(workflowId: string, result: unknown): Promise<void> {
    const state = await this.#loadWorkflowState(workflowId);
    if (!state || state.status !== 'running') return;

    const now = this.#options.getNow();
    const duration = now - state.createdAt;

    await this.#updateWorkflowState(workflowId, {
      status: 'completed',
      result,
    });

    // Clean up attribute indexes and deadline timer
    await this.#cleanupAttributeIndex(workflowId);
    await this.#scheduler.cancel(`deadline:${workflowId}`, workflowId);

    this.#checkpoints.delete(workflowId);
    this.#cleanupWaiters(workflowId);

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

    this.#checkpoints.delete(workflowId);
    this.#cleanupWaiters(workflowId);

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
    const weakRef = this.#handleCache.get(workflowId);
    if (!weakRef) return;
    const handle = weakRef.deref();
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
    const registered = this.#activityRegistrations.get(operation.activityName);
    if (registered) return registered;
    if (operation.fn) return operation.fn as (...arguments_: unknown[]) => unknown;
    throw new Error(
      `No activity registered with name "${operation.activityName}". ` +
        'In worker mode, activities must be registered via engine.registerActivity().',
    );
  }

  /**
   * Execute an activity function, dispatching to a Web Worker pool when
   * `activityExecution` is configured, or running inline on the main thread.
   */
  async #executeActivity(
    _workflowId: string,
    operation: Extract<ContextOperationRequest, { type: 'activity' }>,
  ): Promise<unknown> {
    const activityArguments = operation.args ?? [];

    // Build the leaf executor: either dispatch to a worker or call inline.
    const invokeActivity = this.#activityWorkerDispatcher
      ? async (name: string, args: unknown[]) => {
          const result = await this.#activityWorkerDispatcher!.execute({
            operationId: operation.operationId,
            activityName: name,
            input: args.length === 1 ? args[0] : args,
            attempt: 1,
          });
          if (result.status === 'failed') {
            throw new Error(result.error);
          }
          return result.value;
        }
      : (_name: string, args: unknown[]) => {
          const activityFunction = this.#resolveActivityFunction(operation);
          return callActivityFunction(activityFunction, args);
        };

    // If there are activity interceptors, use cached composition
    const composedActivity = this.#getComposedActivityInterceptor();
    if (composedActivity) {
      return composedActivity.execute(
        {
          activityName: operation.activityName,
          input: activityArguments.length === 1 ? activityArguments[0] : activityArguments,
          attempt: 1,
          headers: new Map(),
        },
        async (interception) => {
          const args = Array.isArray(interception.input)
            ? interception.input
            : [interception.input];
          return invokeActivity(operation.activityName, args);
        },
      );
    }

    // If there are workflow interceptors with activity hooks, use cached composition
    const composedWorkflow = this.#getComposedWorkflowInterceptor();
    if (composedWorkflow) {
      const interception = {
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

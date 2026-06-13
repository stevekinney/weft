/**
 * In-process client that wraps an {@link Engine} instance directly.
 * Use this when running Weft as an embedded library — no network hop.
 *
 * Implements the same {@link WeftClient} interface as {@link HttpClient},
 * so switching from library mode to server mode is a constructor change.
 *
 * @module client/local
 */

import {
  CATALOG_OPERATION_NAMES,
  type CatalogOperationName,
  type CatalogOperationTypes,
  type WeftClient as CatalogOperations,
} from '../cli/generated/operation-client.generated.ts';
import { createCatalogWeftClient } from '../cli/operation-client-runtime.ts';
import type { Engine, WorkflowHandle } from '../core/engine.ts';
import type { WeftEventMap } from '../core/events.ts';
import {
  runtimeWorkflowEngine,
  type RuntimeWorkflowEngine,
} from '../core/runtime-workflow-engine.ts';
import type {
  AttributeFilterKey,
  BulkCancelResult,
  BulkDeleteResult,
  BulkSignalResult,
  BulkTagResult,
  CoordinatedUpdateResult,
  ForkOptions,
  ListFilter,
  MessageName,
  PaginatedResult,
  PurgeResult,
  QueryDefinition,
  RetentionOverview,
  ReviewListEntry,
  ReviewListFilter,
  ScheduleFilter,
  ScheduleOptions,
  ScheduleSpec,
  ScheduleSummary,
  SearchAttributeValue,
  SignalDefinition,
  SignalDeliveryOptions,
  StartOptions,
  StartOrSignalSignal,
  SubmitReviewOptions,
  TypedListFilter,
  UpdateDefinition,
  WorkflowEvent,
  WorkflowInput,
  WorkflowOutput,
  WorkflowRegistry,
  WorkflowReplay,
  WorkflowState,
  WorkflowSummary,
  WorkflowTimelineEntry,
} from '../core/types.ts';
import { messageName } from '../core/types.ts';
import type { WorkflowEventTail } from './event-tail.ts';
import { ScheduleHandleDelegation, WorkflowHandleDelegation } from './handle-delegation.ts';
import { inProcessCatalogTransport } from './in-process-operations.ts';
import type {
  ClientHandle,
  ClientScheduleHandle,
  StartOrSignalOutcome,
  UpdateResult,
  WeftClient,
  WeftClientActivity,
} from './interface.ts';
import { createLocalWorkflowEventTail } from './local-event-tail.ts';
import type { KnownWorkflowName, UnknownNameWhenRegistryEmpty } from './workflow-name-typing.ts';

// ---------------------------------------------------------------------------
// LocalHandle — wraps Engine's WorkflowHandle
// ---------------------------------------------------------------------------

class LocalHandle extends WorkflowHandleDelegation<LocalClient> {
  readonly #handle: WorkflowHandle;

  constructor(handle: WorkflowHandle, client: LocalClient, outcome?: StartOrSignalOutcome) {
    super(handle.id, client, outcome);
    this.#handle = handle;
  }

  async result(): Promise<unknown> {
    return this.#handle.result();
  }

  addEventListener<K extends keyof WeftEventMap>(
    type: K,
    listener: (event: WeftEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    this.#handle.addEventListener(type, listener, options);
  }

  removeEventListener<K extends keyof WeftEventMap>(
    type: K,
    listener: (event: WeftEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void {
    this.#handle.removeEventListener(type, listener, options);
  }

  [Symbol.dispose](): void {
    // LocalHandle has no resources to clean up — events flow through
    // the engine's EventTarget which is managed by the engine lifecycle.
  }
}

class LocalScheduleHandle extends ScheduleHandleDelegation<LocalClient> {
  [Symbol.dispose](): void {
    // Local schedule handles do not hold long-lived resources.
  }
}

// ---------------------------------------------------------------------------
// LocalClient
// ---------------------------------------------------------------------------

/**
 * In-process Weft client backed by a local {@link Engine}.
 *
 * @example
 * ```ts
 * import { workflow, Engine, MemoryStorage, LocalClient, type WorkflowContext } from '@lostgradient/weft';
 *
 * await using engine = new Engine({ storage: new MemoryStorage() });
 * engine.register(
 *   workflow({ name: 'greet' }).execute(async function* (ctx: WorkflowContext, input: { name: string }) {
 *     return `Hello, ${input.name}!`;
 *   }),
 * );
 *
 * const client = new LocalClient(engine);
 * const handle = await client.start('greet', { name: 'World' });
 * console.log(await handle.result()); // 'Hello, World!'
 * ```
 */
export class LocalClient implements WeftClient {
  readonly #engine: RuntimeWorkflowEngine;
  /** The raw engine, kept for the in-process event feed used by {@link tail}. */
  readonly #rawEngine: Engine;
  /** Typed low-level accessor for every catalog operation, routed in-process. */
  readonly operations: CatalogOperations;

  /**
   * Out-of-band ("async") activity completion. An activity that called
   * `ActivityContext.completeAsync()` parks its workflow until an external
   * system resolves it by task token through these methods.
   *
   * @example
   * ```ts
   * import { Engine, LocalClient } from '@lostgradient/weft';
   *
   * const engine = new Engine();
   * const client = new LocalClient(engine);
   * // `token` came from the engine's `activity:async-pending` event.
   * // await client.activity.complete(token, { ok: true });
   * void client;
   * ```
   */
  readonly activity: WeftClientActivity;

  constructor(engine: Engine) {
    this.#engine = runtimeWorkflowEngine(engine);
    this.#rawEngine = engine;
    this.activity = {
      complete: (token, result) => this.#engine.completeAsyncActivity(token, result),
      completeExceptionally: (token, error) => this.#engine.failAsyncActivity(token, error),
    };
    this.operations = createCatalogWeftClient<CatalogOperationTypes>(
      CATALOG_OPERATION_NAMES,
      inProcessCatalogTransport(engine),
    );
  }

  // Duplicate intentionally retained: the call/start overload stacks mirror
  // `HttpClient`, but TypeScript requires each class implementing `WeftClient`
  // to declare these overloads locally to emit them into its `.d.ts` and
  // preserve call-site inference (the bodies differ — this returns a
  // `LocalHandle` over `#engine`, `HttpClient` issues an HTTP request and
  // returns an `HttpHandle`); rejected: a shared base class, which would drop
  // the per-class overload declarations from the emitted declarations.
  // jscpd:ignore-start
  call<Name extends CatalogOperationName>(
    name: Name,
    input: CatalogOperationTypes[Name]['input'],
  ): Promise<CatalogOperationTypes[Name]['output']> {
    return this.operations[name](input);
  }

  async start<TName extends KnownWorkflowName>(
    type: TName,
    input: WorkflowInput<WorkflowRegistry, TName>,
    options?: StartOptions,
  ): Promise<ClientHandle<WorkflowOutput<WorkflowRegistry, TName>>>;
  async start<TName extends string>(
    type: UnknownNameWhenRegistryEmpty<TName>,
    input: unknown,
    options?: StartOptions,
  ): Promise<ClientHandle>;
  async start(type: string, input: unknown, options?: StartOptions): Promise<ClientHandle> {
    const handle = await this.#engine.start(type, input, options);
    return new LocalHandle(handle, this);
  }

  async startOrSignal<TName extends KnownWorkflowName>(
    type: TName,
    input: WorkflowInput<WorkflowRegistry, TName>,
    signal: StartOrSignalSignal,
    options?: StartOptions,
  ): Promise<ClientHandle<WorkflowOutput<WorkflowRegistry, TName>>>;
  async startOrSignal<TName extends string>(
    type: UnknownNameWhenRegistryEmpty<TName>,
    input: unknown,
    signal: StartOrSignalSignal,
    options?: StartOptions,
  ): Promise<ClientHandle>;
  async startOrSignal(
    type: string,
    input: unknown,
    signal: StartOrSignalSignal,
    options?: StartOptions,
  ): Promise<ClientHandle> {
    const { handle, outcome } = await this.#engine.startOrSignal(type, input, signal, options);
    return new LocalHandle(handle, this, outcome);
  }
  // jscpd:ignore-end

  async schedule<TName extends KnownWorkflowName>(
    type: TName,
    input: WorkflowInput<WorkflowRegistry, TName>,
    spec: string | ScheduleSpec,
    options?: ScheduleOptions,
  ): Promise<ClientScheduleHandle>;
  async schedule<TName extends string>(
    type: UnknownNameWhenRegistryEmpty<TName>,
    input: unknown,
    spec: string | ScheduleSpec,
    options?: ScheduleOptions,
  ): Promise<ClientScheduleHandle>;
  async schedule(
    type: string,
    input: unknown,
    spec: string | ScheduleSpec,
    options?: ScheduleOptions,
  ): Promise<ClientScheduleHandle> {
    const handle = await this.#engine.schedule(type, input, spec, options);
    return new LocalScheduleHandle(handle.id, this);
  }

  async get(id: string): Promise<WorkflowState | null> {
    return this.#engine.get(id);
  }

  async getHandle(id: string): Promise<ClientHandle | null>;
  async getHandle<TName extends KnownWorkflowName>(
    id: string,
  ): Promise<ClientHandle<WorkflowOutput<WorkflowRegistry, TName>> | null>;
  async getHandle(id: string): Promise<ClientHandle | null> {
    // Probe persisted existence first: the engine's getHandle is non-nullable
    // (it mints a handle for any id), so the client must establish the run
    // actually exists before handing back observable ergonomics.
    const state = await this.#engine.get(id);
    if (state === null) return null;
    return new LocalHandle(this.#engine.getHandle(id), this);
  }

  async getSchedule(id: string): Promise<ScheduleSummary | null> {
    return this.#engine.getSchedule(id);
  }

  async list<
    const TAttributeKeys extends readonly AttributeFilterKey[] = readonly AttributeFilterKey[],
  >(filter?: TypedListFilter<TAttributeKeys>): Promise<PaginatedResult<WorkflowSummary>> {
    return this.#engine.list(filter);
  }

  async listSchedules(filter?: ScheduleFilter): Promise<PaginatedResult<ScheduleSummary>> {
    return this.#engine.listSchedules(filter);
  }

  async cancel(id: string): Promise<void> {
    return this.#engine.cancel(id);
  }

  async suspend(id: string): Promise<void> {
    return this.#engine.suspend(id);
  }

  async pauseSchedule(id: string): Promise<void> {
    return this.#engine.pauseSchedule(id);
  }

  async resumeSchedule(id: string): Promise<void> {
    return this.#engine.resumeSchedule(id);
  }

  async cancelSchedule(id: string): Promise<void> {
    return this.#engine.cancelSchedule(id);
  }

  async updateSchedule(id: string, newSpec: string | ScheduleSpec): Promise<void> {
    return this.#engine.updateSchedule(id, newSpec);
  }

  async signal(id: string, name: SignalDefinition): Promise<void>;
  async signal<TInput>(
    id: string,
    name: SignalDefinition<TInput>,
    payload: TInput,
    options?: SignalDeliveryOptions,
  ): Promise<void>;
  async signal(
    id: string,
    name: string,
    payload?: unknown,
    options?: SignalDeliveryOptions,
  ): Promise<void>;
  async signal(
    id: string,
    nameOrDefinition: MessageName,
    payload?: unknown,
    options?: SignalDeliveryOptions,
  ): Promise<void> {
    if (options === undefined) {
      return this.#engine.signal(id, messageName(nameOrDefinition), payload);
    }
    return this.#engine.signal(id, messageName(nameOrDefinition), payload, options);
  }

  async query<TOutput>(id: string, name: QueryDefinition<void, TOutput>): Promise<TOutput>;
  async query<TInput, TOutput>(
    id: string,
    name: QueryDefinition<TInput, TOutput>,
    input: TInput,
  ): Promise<TOutput>;
  async query(id: string, name: string, input?: unknown): Promise<unknown>;
  async query(id: string, nameOrDefinition: MessageName, input?: unknown): Promise<unknown> {
    return this.#engine.query(id, messageName(nameOrDefinition), input);
  }

  async update<TOutput>(
    id: string,
    name: UpdateDefinition<void, TOutput>,
    payload?: void,
    options?: { timeout?: number },
  ): Promise<TOutput>;
  async update<TInput, TOutput>(
    id: string,
    name: UpdateDefinition<TInput, TOutput>,
    payload: TInput,
    options?: { timeout?: number },
  ): Promise<TOutput>;
  async update(
    id: string,
    name: string,
    payload?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown>;
  async update(
    id: string,
    nameOrDefinition: MessageName,
    payload?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown> {
    return this.#engine.update(id, messageName(nameOrDefinition), payload, options);
  }

  async resume(id: string): Promise<ClientHandle> {
    const handle = await this.#engine.resume(id);
    return new LocalHandle(handle, this);
  }

  async recoverAll(): Promise<ClientHandle[]> {
    const handles = await this.#engine.recoverAll();
    return handles.map((handle) => new LocalHandle(handle, this));
  }

  async timeout(id: string): Promise<void> {
    return this.#engine.timeout(id);
  }

  async getAttributes(id: string): Promise<Record<string, SearchAttributeValue> | null> {
    return this.#engine.getAttributes(id);
  }

  async setAttributes(id: string, attributes: Record<string, SearchAttributeValue>): Promise<void> {
    return this.#engine.setAttributes(id, attributes);
  }

  async addTags(id: string, ...tags: string[]): Promise<void> {
    return this.#engine.addTags(id, ...tags);
  }

  async removeTags(id: string, ...tags: string[]): Promise<void> {
    return this.#engine.removeTags(id, ...tags);
  }

  async getEvents(id: string): Promise<WorkflowEvent[]> {
    return this.#engine.getEvents(id);
  }

  tail(id: string): WorkflowEventTail {
    return createLocalWorkflowEventTail(this.#rawEngine, id);
  }

  async getTimeline(id: string): Promise<WorkflowTimelineEntry[]> {
    return this.#engine.getTimeline(id);
  }

  async replayTo(id: string, step: number): Promise<WorkflowReplay | null> {
    return this.#engine.replayTo(id, step);
  }

  async listReviews(filter?: ReviewListFilter): Promise<ReviewListEntry[]> {
    return this.#engine.listReviews(filter);
  }

  async submitReview(reviewId: string, options: SubmitReviewOptions): Promise<void> {
    return this.#engine.submitReview(reviewId, options);
  }

  async getStreamChunks(
    workflowId: string,
    key: string,
    options?: { after?: number },
  ): ReturnType<Engine['getStreamChunks']> {
    return this.#engine.getStreamChunks(workflowId, key, options);
  }

  async fork(id: string, options?: ForkOptions): Promise<ClientHandle> {
    const handle = await this.#engine.fork(id, options);
    return new LocalHandle(handle, this);
  }

  async getRetentionOverview(): Promise<RetentionOverview> {
    return this.#engine.getRetentionOverview();
  }

  async purge(filter?: ListFilter): Promise<PurgeResult> {
    return this.#engine.purge(filter);
  }

  async cancelAll(filter: ListFilter): Promise<BulkCancelResult> {
    return this.#engine.cancelAll(filter);
  }

  async signalAll(filter: ListFilter, name: string, payload?: unknown): Promise<BulkSignalResult> {
    return this.#engine.signalAll(filter, name, payload);
  }

  async deleteAll(filter: ListFilter): Promise<BulkDeleteResult> {
    return this.#engine.deleteAll(filter);
  }

  async tagAll(filter: ListFilter, tags: string[]): Promise<BulkTagResult> {
    return this.#engine.tagAll(filter, tags);
  }

  async untagAll(filter: ListFilter, tags: string[]): Promise<BulkTagResult> {
    return this.#engine.untagAll(filter, tags);
  }

  async submitCoordinatedUpdate(
    id: string,
    name: string,
    payload?: unknown,
    options?: { timeout?: number; idempotencyKey?: string },
  ): Promise<CoordinatedUpdateResult> {
    return this.#engine.submitCoordinatedUpdate(id, name, payload, options);
  }

  async getUpdateResult(updateId: string): Promise<UpdateResult> {
    const response = await this.#engine.getUpdateResult(updateId);
    if (response === null) return null;
    const out: NonNullable<UpdateResult> = { updateId: response.updateId, result: response.result };
    if (response.error !== undefined) out.error = response.error;
    return out;
  }
}

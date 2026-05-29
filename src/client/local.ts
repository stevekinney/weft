/**
 * In-process client that wraps an {@link Engine} instance directly.
 * Use this when running Weft as an embedded library — no network hop.
 *
 * Implements the same {@link WeftClient} interface as {@link HttpClient},
 * so switching from library mode to server mode is a constructor change.
 *
 * @module client/local
 */

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
  SubmitReviewOptions,
  TypedListFilter,
  UpdateDefinition,
  WorkflowEvent,
  WorkflowReplay,
  WorkflowState,
  WorkflowSummary,
  WorkflowTimelineEntry,
} from '../core/types.ts';
import { messageName } from '../core/types.ts';
import { ScheduleHandleDelegation, WorkflowHandleDelegation } from './handle-delegation.ts';
import type { ClientHandle, ClientScheduleHandle, UpdateResult, WeftClient } from './interface.ts';

// ---------------------------------------------------------------------------
// LocalHandle — wraps Engine's WorkflowHandle
// ---------------------------------------------------------------------------

class LocalHandle extends WorkflowHandleDelegation<LocalClient> {
  readonly #handle: WorkflowHandle;

  constructor(handle: WorkflowHandle, client: LocalClient) {
    super(handle.id, client);
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
 * import { workflow, Engine, MemoryStorage, LocalClient, type WorkflowContext } from 'weft';
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

  constructor(engine: Engine) {
    this.#engine = runtimeWorkflowEngine(engine);
  }

  async start(type: string, input: unknown, options?: StartOptions): Promise<ClientHandle> {
    const handle = await this.#engine.start(type, input, options);
    return new LocalHandle(handle, this);
  }

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

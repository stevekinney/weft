/**
 * In-process client that wraps an {@link Engine} instance directly.
 * Use this when running Weft as an embedded library — no network hop.
 *
 * Implements the same {@link WeftClient} interface as {@link HttpClient},
 * so switching from library mode to server mode is a constructor change.
 *
 * @module client/local
 */

import type { BudgetPolicyOptions } from '../ai/budget-policy.ts';
import type { Engine, WorkflowHandle } from '../core/engine.ts';
import type {
  CoordinatedUpdateResult,
  ListFilter,
  PaginatedResult,
  SearchAttributeValue,
  StartOptions,
  SubmitReviewOptions,
  WorkflowEvent,
  WorkflowState,
  WorkflowSummary,
} from '../core/types.ts';
import type { ClientHandle, UpdateResult, WeftClient } from './interface.ts';

// ---------------------------------------------------------------------------
// LocalHandle — wraps Engine's WorkflowHandle
// ---------------------------------------------------------------------------

class LocalHandle implements ClientHandle {
  readonly id: string;
  readonly #handle: WorkflowHandle;
  readonly #client: LocalClient;

  constructor(handle: WorkflowHandle, client: LocalClient) {
    this.id = handle.id;
    this.#handle = handle;
    this.#client = client;
  }

  async result(): Promise<unknown> {
    return this.#handle.result();
  }

  async cancel(): Promise<void> {
    return this.#client.cancel(this.id);
  }

  async signal(name: string, payload?: unknown): Promise<void> {
    return this.#client.signal(this.id, name, payload);
  }

  async update(name: string, payload?: unknown, options?: { timeout?: number }): Promise<unknown> {
    return this.#client.update(this.id, name, payload, options);
  }

  async query(name: string): Promise<unknown> {
    return this.#client.query(this.id, name);
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    this.#handle.addEventListener(type, listener, options);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void {
    this.#handle.removeEventListener(type, listener, options);
  }
}

// ---------------------------------------------------------------------------
// LocalClient
// ---------------------------------------------------------------------------

/** In-process Weft client backed by a local {@link Engine}. */
export class LocalClient implements WeftClient {
  readonly #engine: Engine;

  constructor(engine: Engine) {
    this.#engine = engine;
  }

  async start(type: string, input: unknown, options?: StartOptions): Promise<ClientHandle> {
    const handle = await this.#engine.start(type, input, options);
    return new LocalHandle(handle, this);
  }

  async get(id: string): Promise<WorkflowState | null> {
    return this.#engine.get(id);
  }

  async list(filter?: ListFilter): Promise<PaginatedResult<WorkflowSummary>> {
    return this.#engine.list(filter);
  }

  async cancel(id: string): Promise<void> {
    return this.#engine.cancel(id);
  }

  async signal(id: string, name: string, payload?: unknown): Promise<void> {
    return this.#engine.signal(id, name, payload);
  }

  async query(id: string, name: string): Promise<unknown> {
    return this.#engine.query(id, name);
  }

  async update(
    id: string,
    name: string,
    payload?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown> {
    return this.#engine.update(id, name, payload, options);
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

  async getEvents(id: string): Promise<WorkflowEvent[]> {
    return this.#engine.getEvents(id);
  }

  async listReviews(): Promise<Array<Record<string, unknown>>> {
    return this.#engine.listReviews();
  }

  async submitReview(reviewId: string, options: SubmitReviewOptions): Promise<void> {
    return this.#engine.submitReview(reviewId, options);
  }

  async setBudgetPolicy(options: BudgetPolicyOptions): Promise<void> {
    return this.#engine.setBudgetPolicy(options);
  }

  async getBudgetPolicy(namespace: string): Promise<BudgetPolicyOptions | null> {
    return this.#engine.getBudgetPolicy(namespace);
  }

  async getStreamChunks(workflowId: string, key: string): Promise<unknown[]> {
    return this.#engine.getStreamChunks(workflowId, key);
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

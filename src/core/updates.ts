/**
 * Synchronous update request/response coordination.
 *
 * Manages the lifecycle of workflow updates with idempotency support,
 * timeout-based waiting, and automatic cleanup of expired responses.
 *
 * @module updates
 */

import { sleep } from '../runtime/portable.ts';
import type { BatchOperation, Storage } from '../storage/interface';
import { KEYS } from '../storage/interface';
import { decode, encode } from './codec';
import type { WorkflowStatus } from './types';
import { WeftError } from './weft-error.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpdateRequest {
  updateId: string;
  workflowId: string;
  name: string;
  payload: unknown;
  idempotencyKey?: string | undefined;
  createdAt: number;
}

export interface UpdateResponse {
  updateId: string;
  result?: unknown;
  error?: string | undefined;
  createdAt: number;
}

export interface UpdateRequestOptions {
  idempotencyKey?: string;
  timeout?: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by the engine when an update sent via `engine.update` or
 * `handle.update` does not receive a response within the configured timeout.
 * Read `updateId` to identify the stalled update.
 *
 * @example
 * ```ts
 * import { workflow, Engine, UpdateTimeoutError, update } from 'weft';
 *
 * const engine = new Engine();
 * engine.register(
 *   workflow({ name: 'paused' }).execute(async function* () {
 *     await new Promise(() => {}); // workflow never resolves on its own
 *   }),
 * );
 * const handle = await engine.start('paused', null);
 * const proceed = update<void, void>('proceed');
 * try {
 *   await handle.update(proceed, undefined, { timeout: 100 });
 * } catch (err) {
 *   if (err instanceof UpdateTimeoutError) {
 *     console.error('update timed out:', err.updateId);
 *   }
 * }
 * ```
 */
export class UpdateTimeoutError extends WeftError<'UpdateTimeoutError'> {
  readonly updateId: string;

  constructor(updateId: string, timeout: number) {
    super('UpdateTimeoutError', `Update ${updateId} timed out after ${timeout}ms`);
    this.updateId = updateId;
  }
}

/**
 * Thrown when an update is sent to a workflow that is already in a terminal
 * state (completed, failed, cancelled, or timed-out). Check `workflowId` and
 * `status` to understand which workflow rejected the update.
 *
 * @example
 * ```ts
 * import { workflow, Engine, WorkflowTerminalError, update } from 'weft';
 *
 * const engine = new Engine();
 * engine.register(workflow({ name: 'quick' }).execute(async function* () { return 'done'; }));
 *
 * const handle = await engine.start('quick', null);
 * await handle.result();
 * const anything = update<void, void>('anything');
 * try {
 *   await handle.update(anything);
 * } catch (err) {
 *   if (err instanceof WorkflowTerminalError) {
 *     console.error('workflow', err.workflowId, 'is', err.status);
 *   }
 * }
 * ```
 */
export class WorkflowTerminalError extends WeftError<'WorkflowTerminalError'> {
  readonly workflowId: string;
  readonly status: WorkflowStatus;

  constructor(workflowId: string, status: WorkflowStatus) {
    super(
      'WorkflowTerminalError',
      `Cannot send update to workflow "${workflowId}": workflow is in terminal state "${status}"`,
    );
    this.workflowId = workflowId;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 50;
const DEFAULT_CLEANUP_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Manages the lifecycle of synchronous workflow updates: persisting requests,
 * checking idempotency, building response batch operations, and polling for
 * results. Used internally by the {@link Engine}; callers interact through
 * `engine.update` or `handle.update` rather than the coordinator directly.
 *
 * @example
 * ```ts
 * import { UpdateCoordinator } from 'weft';
 * import { MemoryStorage } from 'weft/storage/memory';
 *
 * const storage = new MemoryStorage();
 * const coordinator = new UpdateCoordinator(storage);
 * const updateId = await coordinator.createRequest('wf-1', 'increment', { by: 1 });
 * console.log(updateId); // UUID string
 * ```
 */
export class UpdateCoordinator {
  #storage: Storage;

  constructor(storage: Storage) {
    this.#storage = storage;
  }

  /** Create and persist an update request. Returns the update ID. */
  async createRequest(
    workflowId: string,
    name: string,
    payload: unknown,
    options?: UpdateRequestOptions,
  ): Promise<string> {
    const updateId = crypto.randomUUID();

    const request: UpdateRequest = {
      updateId,
      workflowId,
      name,
      payload,
      createdAt: Date.now(),
    };

    if (options?.idempotencyKey !== undefined) {
      request.idempotencyKey = options.idempotencyKey;
    }

    const key = KEYS.update(workflowId, updateId);
    await this.#storage.put(key, encode(request));

    return updateId;
  }

  /** Check idempotency: if this key was already processed, return the existing response. */
  async checkIdempotency(
    workflowId: string,
    idempotencyKey: string,
  ): Promise<UpdateResponse | null> {
    const key = KEYS.updateIdempotency(workflowId, idempotencyKey);
    const raw = await this.#storage.get(key);
    if (!raw) return null;

    const mapping = decode(raw) as { updateId: string };
    return this.getResponse(mapping.updateId);
  }

  /** Get pending update requests for a workflow, sorted FIFO by creation time. */
  async getPendingUpdates(workflowId: string): Promise<UpdateRequest[]> {
    const prefix = KEYS.updatePrefix(workflowId);
    const results: UpdateRequest[] = [];

    for await (const [, value] of this.#storage.scan(prefix)) {
      results.push(decode(value) as UpdateRequest);
    }

    return results.toSorted(
      (a, b) =>
        a.createdAt - b.createdAt ||
        (a.updateId < b.updateId ? -1 : a.updateId > b.updateId ? 1 : 0),
    );
  }

  /** Build batch operations for persisting an update response (to be included in checkpoint batch). */
  buildResponseOperations(
    updateId: string,
    workflowId: string,
    result: unknown,
    error?: string,
    idempotencyKey?: string,
  ): BatchOperation[] {
    const response: UpdateResponse = {
      updateId,
      result,
      createdAt: Date.now(),
    };

    if (error !== undefined) {
      response.error = error;
    }

    const operations: BatchOperation[] = [
      { type: 'delete', key: KEYS.update(workflowId, updateId) },
      { type: 'put', key: KEYS.updateResponse(updateId), value: encode(response) },
    ];

    if (idempotencyKey !== undefined) {
      operations.push({
        type: 'put',
        key: KEYS.updateIdempotency(workflowId, idempotencyKey),
        value: encode({ updateId }),
      });
    }

    return operations;
  }

  /** Delete a pending update request that will never be observed. */
  async deleteRequest(workflowId: string, updateId: string): Promise<void> {
    await this.#storage.delete(KEYS.update(workflowId, updateId));
  }

  /**
   * Atomically check whether a response exists and conditionally delete the
   * request. Returns the response if the workflow already consumed this update,
   * or null if the request was deleted before a consumer won the race.
   */
  async deleteRequestIfUnconsumed(
    workflowId: string,
    updateId: string,
  ): Promise<UpdateResponse | null> {
    const existing = await this.getResponse(updateId);
    if (existing !== null) {
      return existing;
    }

    await this.deleteRequest(workflowId, updateId);

    return this.getResponse(updateId);
  }

  /** Retrieve a stored response by update ID. */
  async getResponse(updateId: string): Promise<UpdateResponse | null> {
    const key = KEYS.updateResponse(updateId);
    const raw = await this.#storage.get(key);
    if (!raw) return null;

    return decode(raw) as UpdateResponse;
  }

  /** Wait for an update response with timeout. Uses polling. */
  async waitForResponse(updateId: string, timeout: number): Promise<UpdateResponse> {
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const response = await this.getResponse(updateId);
      if (response) return response;

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      await sleep(Math.min(POLL_INTERVAL_MS, remaining));
    }

    throw new UpdateTimeoutError(updateId, timeout);
  }

  /** Clean up expired responses and their orphaned idempotency mappings. */
  async cleanupExpiredResponses(ttlMs?: number): Promise<number> {
    const effectiveTtl = ttlMs ?? DEFAULT_CLEANUP_TTL_MS;
    const cutoff = Date.now() - effectiveTtl;

    const expiredResponseKeys: string[] = [];
    const expiredUpdateIds = new Set<string>();

    for await (const [key, value] of this.#storage.scan('upr:')) {
      const response = decode(value) as UpdateResponse;
      if (response.createdAt < cutoff) {
        expiredResponseKeys.push(key);
        expiredUpdateIds.add(response.updateId);
      }
    }

    if (expiredResponseKeys.length === 0) return 0;

    // Find orphaned idempotency mappings that reference expired responses
    const orphanedIdempotencyKeys: string[] = [];
    for await (const [key, value] of this.#storage.scan('upk:')) {
      const mapping = decode(value) as { updateId: string };
      if (expiredUpdateIds.has(mapping.updateId)) {
        orphanedIdempotencyKeys.push(key);
      }
    }

    const operations: BatchOperation[] = [
      ...expiredResponseKeys.map((key) => ({ type: 'delete' as const, key })),
      ...orphanedIdempotencyKeys.map((key) => ({ type: 'delete' as const, key })),
    ];

    await this.#storage.batch(operations);

    return expiredResponseKeys.length;
  }
}

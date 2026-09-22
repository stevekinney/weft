/**
 * The engine-owned seam for dispatching a `ctx.run()` activity call to a
 * remote worker (COR-152) instead of running it on the main thread or a
 * local Worker pool.
 *
 * **Ownership.** The engine owns the durable task record and the pending
 * workflow-operation adoption: the default broker
 * (`core/engine/remote-activity-broker.ts`) writes the task's `queued`
 * ledger record directly on `Engine.storage` and returns — no server,
 * socket, or worker needs to exist for this call to succeed durably. A
 * `serve()`d server (or the periodic reconciliation scan inside one, once
 * attached) discovers and dispatches `queued` records to a connected
 * worker; the server owns the transport (sockets, HTTP long-poll, session
 * timers) as a set of indexes DERIVED from the durable ledger, never as its
 * own source of truth. This mirrors {@link ExecutionStrategy}
 * (`core/execution-strategy.ts`): the engine defines and drives the seam,
 * and a transport plugs into it.
 *
 * **Test doubles.** `RemoteActivityBroker` is a constructor-time seam
 * (`activityExecution: { mode: 'remote', broker }`), not a post-construction
 * setter — a recording or poison double is supplied the same way a
 * `workerExecution.workerUrl` is, so tests can assert exactly what reaches
 * the envelope without needing a real server or socket.
 *
 * This module holds only the interface and its request shape, so
 * `core/types/options.ts` can reference `RemoteActivityBroker` without
 * depending on the concrete, storage-touching implementation
 * (`core/engine/remote-activity-broker.ts`) — the same split
 * `execution-strategy.ts` / `worker-execution-strategy.ts` already use.
 *
 * @module core/remote-activity-broker
 */

import type { RetryPolicy } from './types.ts';

/**
 * One remote activity dispatch request, as `ctx.run()` builds it.
 *
 * Everything identifying is derived by the engine rather than taken from
 * caller input — `operationId` is the deterministic async-activity token, so
 * workflow replay reproduces it exactly, and `workflowType` comes from the
 * engine's own record of the workflow rather than anything the activity
 * passed in. That is what makes an enqueue safely idempotent across replays.
 *
 * You receive one of these when you implement {@link RemoteActivityBroker};
 * you do not construct them.
 *
 * @example
 * ```ts
 * import type { RemoteActivityTaskRequest } from '@lostgradient/weft';
 *
 * declare const request: RemoteActivityTaskRequest;
 *
 * console.log(
 *   'dispatch', request.workflowType + '.' + request.activityName,
 *   'as', request.operationId,
 * );
 * ```
 */
export type RemoteActivityTaskRequest = Readonly<{
  /** The durable async-activity token this task is keyed by — see
   * `deriveAsyncActivityToken`. Doubles as the task ledger's `operationId`. */
  operationId: string;
  workflowId: string;
  /** The workflow's canonical registered type — derived from
   * `EngineInternals.workflowTypeByWorkflowId`, never from caller input
   * (acceptance criterion 3). */
  workflowType: string;
  /** Bare activity name; the broker qualifies it as `${workflowType}.${activityName}`. */
  activityName: string;
  input: unknown;
  headers: Readonly<Record<string, string>>;
  queue?: string;
  visibilityTimeoutMilliseconds?: number;
  retryPolicy?: RetryPolicy;
  workflowExecutionToken?: string;
  workflowRevision?: string;
  scheduleToCloseDeadline?: number;
}>;

/**
 * The engine-owned broker interface a `mode: 'remote'` `ctx.run()` dispatches
 * through. `enqueue` must be durably idempotent for a given `operationId`
 * (workflow replay re-derives the same deterministic token and calls
 * `enqueue` again) and must never throw merely because no server or worker
 * capacity is currently available — "no capacity" is represented by the task
 * remaining `queued`, not by a rejected promise.
 *
 * Implement it to supply your own dispatch, or — far more often — to stand in
 * for one in a test, where a recording broker lets you assert exactly what
 * `ctx.run()` produced without a server or a socket anywhere in the picture.
 * Supply it at construction via `activityExecution: { mode: 'remote', broker }`.
 *
 * @example
 * ```ts
 * import type { RemoteActivityBroker, RemoteActivityTaskRequest } from '@lostgradient/weft';
 *
 * const dispatched: RemoteActivityTaskRequest[] = [];
 *
 * const recording: RemoteActivityBroker = {
 *   async enqueue(request) {
 *     dispatched.push(request);
 *   },
 * };
 *
 * await recording.enqueue({
 *   operationId: 'order-4417',
 *   workflowId: 'wf-1',
 *   workflowType: 'checkout',
 *   activityName: 'chargeCard',
 *   input: { amountCents: 2500 },
 *   headers: {},
 * });
 *
 * console.log(dispatched.length); // 1
 * ```
 */
export interface RemoteActivityBroker {
  enqueue(request: RemoteActivityTaskRequest): Promise<void>;
}

import {
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowTimedOutEvent,
} from '../events.ts';
import { WorkflowTimeoutError } from '../timeouts.ts';
import type {
  MessageName,
  QueryDefinition,
  ScheduleSpec,
  ScheduleSummary,
  SearchAttributeValue,
  SignalDefinition,
  SignalDeliveryOptions,
  UpdateDefinition,
  WorkflowState,
} from '../types.ts';
import { messageName } from '../types.ts';
import { createWorkflowHandleEventIterator } from './handle-iteration.ts';

export function getWorkflowExecutionStartedAt(
  state: Pick<WorkflowState, 'createdAt' | 'startedAt'>,
): number {
  return state.startedAt ?? state.createdAt;
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
      const duration = state.updatedAt - getWorkflowExecutionStartedAt(state);
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
      const elapsed = state.updatedAt - getWorkflowExecutionStartedAt(state);
      // Thread the persisted termination reason so consumers that attach after
      // termination (async iterator / observable replaying terminal state) see
      // the same circuit-breaker discriminator the live dispatch carried.
      return new WorkflowTimedOutEvent(state.id, 'execution', elapsed, state.terminationReason);
    }
    default:
      return null;
  }
}

export const HANDLE_RESULT_PROMISE = Symbol('handleResultPromise');

export interface WorkflowHandleEngine extends EventTarget {
  [HANDLE_RESULT_PROMISE](workflowId: string): Promise<unknown>;
  cancel(workflowId: string): Promise<void>;
  signal(
    workflowId: string,
    name: string,
    payload?: unknown,
    options?: SignalDeliveryOptions,
  ): Promise<void>;
  update(
    workflowId: string,
    name: string,
    payload?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown>;
  query(workflowId: string, name: string, input?: unknown): Promise<unknown>;
  getAttributes(workflowId: string): Promise<Record<string, SearchAttributeValue> | null>;
  setAttributes(
    workflowId: string,
    attributes: Record<string, SearchAttributeValue>,
  ): Promise<void>;
  addTags(workflowId: string, ...tags: string[]): Promise<void>;
  removeTags(workflowId: string, ...tags: string[]): Promise<void>;
  get(workflowId: string): Promise<WorkflowState | null>;
}

export interface ScheduleHandleEngine {
  pauseSchedule(scheduleId: string): Promise<void>;
  resumeSchedule(scheduleId: string): Promise<void>;
  cancelSchedule(scheduleId: string): Promise<void>;
  updateSchedule(scheduleId: string, newSpec: string | ScheduleSpec): Promise<void>;
  getSchedule(scheduleId: string): Promise<ScheduleSummary | null>;
}

/**
 * Handle to a running or completed workflow. Returned by {@link Engine.start}
 * and {@link Engine.getHandle}. Use `handle.result()` to await the final
 * value, `handle.cancel()` to stop execution, `handle.signal(name, payload)`
 * to send a signal, and `handle.update(name, payload)` to send a synchronous
 * update. Use `query()`, `getAttributes()`/`setAttributes()`, and
 * `addTags()`/`removeTags()` for read-only handlers, search metadata, and tag
 * management. Also an `AsyncIterable` of lifecycle events.
 *
 * @example
 * ```ts
 * import { workflow, Engine, WorkflowHandle, activity } from 'weft';
 * import type { WorkflowContext, Context } from 'weft';
 *
 * const greet = activity({ name: 'greet', execute: async (i: unknown) => `hi ${i}` });
 * const engine = new Engine();
 * engine.register(
 *   workflow({ name: 'wave' }).execute(async function* (ctx: WorkflowContext, input: unknown) {
 *     return yield* ctx.run(greet, input);
 *   }),
 * );
 *
 * const handle = await engine.start('wave', 'world');
 * const typedHandle: WorkflowHandle = handle;
 * const result = await handle.result();
 * void typedHandle;
 * console.log(result); // 'hi world'
 * ```
 *
 * @example Iterate workflow lifecycle events
 * ```ts
 * import { Engine, workflow, type WorkflowHandle } from 'weft';
 *
 * const engine = new Engine();
 * engine.register(workflow({ name: 'ping' }).execute(async function* () { return 'pong'; }));
 *
 * const handle = await engine.start('ping', null);
 * const typedHandle: WorkflowHandle = handle;
 * for await (const event of handle) {
 *   console.log(event.type);
 * }
 * void typedHandle;
 * ```
 */
export class WorkflowHandle<TResult = unknown> extends EventTarget implements AsyncDisposable {
  readonly id: string;
  readonly #engine: WorkflowHandleEngine;
  #resultPromise: Promise<TResult> | undefined;

  constructor(id: string, engine: WorkflowHandleEngine) {
    super();
    this.id = id;
    this.#engine = engine;
    this.#resultPromise = undefined;
  }

  async result(): Promise<TResult> {
    // The engine stores persisted workflow results as unknown. The typed
    // handle is created from the registry-backed `Engine.start` overload that
    // determines TResult at the call site.
    this.#resultPromise ??= this.#engine[HANDLE_RESULT_PROMISE](this.id) as Promise<TResult>;
    return this.#resultPromise;
  }

  async cancel(): Promise<void> {
    return this.#engine.cancel(this.id);
  }

  async signal(name: SignalDefinition): Promise<void>;
  async signal<TInput>(
    name: SignalDefinition<TInput>,
    payload: TInput,
    options?: SignalDeliveryOptions,
  ): Promise<void>;
  async signal(name: string, payload?: unknown, options?: SignalDeliveryOptions): Promise<void>;
  async signal(
    nameOrDefinition: MessageName,
    payload?: unknown,
    options?: SignalDeliveryOptions,
  ): Promise<void> {
    return this.#engine.signal(this.id, messageName(nameOrDefinition), payload, options);
  }

  async update<TOutput>(
    name: UpdateDefinition<void, TOutput>,
    payload?: void,
    options?: { timeout?: number },
  ): Promise<TOutput>;
  async update<TInput, TOutput>(
    name: UpdateDefinition<TInput, TOutput>,
    payload: TInput,
    options?: { timeout?: number },
  ): Promise<TOutput>;
  async update(name: string, payload?: unknown, options?: { timeout?: number }): Promise<unknown>;
  async update(
    nameOrDefinition: MessageName,
    payload?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown> {
    return this.#engine.update(this.id, messageName(nameOrDefinition), payload, options);
  }

  async query<TOutput>(name: QueryDefinition<void, TOutput>): Promise<TOutput>;
  async query<TInput, TOutput>(
    name: QueryDefinition<TInput, TOutput>,
    input: TInput,
  ): Promise<TOutput>;
  async query(name: string, input?: unknown): Promise<unknown>;
  async query(nameOrDefinition: MessageName, input?: unknown): Promise<unknown> {
    return this.#engine.query(this.id, messageName(nameOrDefinition), input);
  }

  async getAttributes(): Promise<Record<string, SearchAttributeValue> | null> {
    return this.#engine.getAttributes(this.id);
  }

  async setAttributes(attributes: Record<string, SearchAttributeValue>): Promise<void> {
    return this.#engine.setAttributes(this.id, attributes);
  }

  async addTags(...tags: string[]): Promise<void> {
    return this.#engine.addTags(this.id, ...tags);
  }

  async removeTags(...tags: string[]): Promise<void> {
    return this.#engine.removeTags(this.id, ...tags);
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<Event> {
    yield* createWorkflowHandleEventIterator(
      this,
      () => this.#engine.get(this.id),
      synthesizeTerminalEventFromState,
    );
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

/**
 * Handle to a recurring schedule created by {@link Engine.schedule}. Use
 * `handle.pause()`, `handle.resume()`, `handle.cancel()`, or
 * `handle.update(cronExpression)` to manage the schedule lifecycle.
 * `handle.describe()` returns the current {@link ScheduleSummary}.
 *
 * @example
 * ```ts
 * import { workflow, Engine, ScheduleHandle } from 'weft';
 *
 * const engine = new Engine();
 * engine.register(workflow({ name: 'daily-report' }).execute(async function* () { return 'ok'; }));
 *
 * const handle = await engine.schedule('daily-report', null, '0 9 * * *');
 * const typedHandle: ScheduleHandle = handle;
 * await handle.pause();
 * const summary = await handle.describe();
 * void typedHandle;
 * console.log(summary.status); // 'paused'
 * await handle.cancel();
 * ```
 */
export class ScheduleHandle {
  readonly id: string;
  readonly #engine: ScheduleHandleEngine;

  constructor(id: string, engine: ScheduleHandleEngine) {
    this.id = id;
    this.#engine = engine;
  }

  async pause(): Promise<void> {
    await this.#engine.pauseSchedule(this.id);
  }

  async resume(): Promise<void> {
    await this.#engine.resumeSchedule(this.id);
  }

  async cancel(): Promise<void> {
    await this.#engine.cancelSchedule(this.id);
  }

  async update(newSpec: string | ScheduleSpec): Promise<void> {
    await this.#engine.updateSchedule(this.id, newSpec);
  }

  async describe(): Promise<ScheduleSummary> {
    const schedule = await this.#engine.getSchedule(this.id);
    if (!schedule) {
      throw new Error(`Schedule "${this.id}" not found`);
    }
    return schedule;
  }
}

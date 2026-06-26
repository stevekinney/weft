import { hashString } from '../../runtime/portable.ts';
import type { ContextOperationRequest } from '../context.ts';
import {
  DurableActivityScopeError,
  DurableActivityUnsupportedError,
  runWithDurableActivityScope,
  type DurableActivityInvocation,
  type DurableActivityScope,
} from '../context/durable-activity.ts';
import type { Context } from '../context/index.ts';
import {
  readOrInitActivityRetrySleepFireAt,
  runActivityWithRetryAtStep,
  type ActivityOperationRequest,
} from '../context/run-operation.ts';
import { AsyncActivityDeferral } from './async-activity-completion.ts';
import type { EngineInternals } from './internals.ts';
import {
  executeActivityOperationResult,
  type ActivityOperationCallbacks,
} from './operations-activity.ts';
import { registerSleepResolver } from './operations-time.ts';
import { callMemoFunction } from './state-utilities.ts';

type MemoOperation = Extract<ContextOperationRequest, { type: 'memo' }>;
type SleepOperation = Extract<ContextOperationRequest, { type: 'sleep' }>;

export async function callMemoFunctionWithDurableActivityScope(
  internals: EngineInternals,
  workflowId: string,
  operation: MemoOperation,
  callbacks: {
    getActivityOperationCallbacks?: () => ActivityOperationCallbacks;
    persistCheckpoint: (workflowId: string, operation: ContextOperationRequest) => Promise<void>;
  },
): Promise<unknown> {
  const context = internals.inlineStrategy?.getContext(workflowId);
  if (
    context === undefined ||
    typeof operation.step !== 'number' ||
    !Number.isSafeInteger(operation.step) ||
    operation.step < 0 ||
    callbacks.getActivityOperationCallbacks === undefined
  ) {
    return callMemoFunction(operation.fn);
  }

  const memoOperation: MemoOperation & { step: number } = { ...operation, step: operation.step };
  const scope = new MemoDurableActivityScope(
    internals,
    workflowId,
    memoOperation,
    context,
    callbacks.getActivityOperationCallbacks(),
    callbacks.persistCheckpoint,
  );
  return scope.run(() => callMemoFunction(operation.fn));
}

class MemoDurableActivityScope implements DurableActivityScope {
  readonly #internals: EngineInternals;
  readonly #workflowId: string;
  readonly #operation: MemoOperation & { step: number };
  readonly #context: Context;
  readonly #activityCallbacks: ActivityOperationCallbacks;
  readonly #persistCheckpoint: (
    workflowId: string,
    operation: ContextOperationRequest,
  ) => Promise<void>;
  readonly #scopeAbortController = new AbortController();
  readonly #pendingPromises = new Set<Promise<unknown>>();
  readonly #identityPrefix: string;
  #activePromise: Promise<unknown> | undefined;
  #activeNonCancellableWriteCount = 0;
  #closed = false;
  #closeReason: Error | undefined;
  #nextOrdinal = 0;

  constructor(
    internals: EngineInternals,
    workflowId: string,
    operation: MemoOperation & { step: number },
    context: Context,
    activityCallbacks: ActivityOperationCallbacks,
    persistCheckpoint: (workflowId: string, operation: ContextOperationRequest) => Promise<void>,
  ) {
    this.#internals = internals;
    this.#workflowId = workflowId;
    this.#operation = operation;
    this.#context = context;
    this.#activityCallbacks = activityCallbacks;
    this.#persistCheckpoint = persistCheckpoint;
    this.#identityPrefix = `memo:${operation.step}:${hashString(operation.key)}`;
    // Recovery can replay a memo callback before lifecycle/start-exec has
    // repopulated the workflow-id lookup used by string activity resolution.
    this.#internals.workflowTypeByWorkflowId.set(workflowId, context.workflowType);
  }

  async run(execute: () => unknown): Promise<unknown> {
    const cleanupAbortForwarding = this.#forwardAbortSignals();
    try {
      const result = await runWithDurableActivityScope(this, execute);
      if (this.#pendingPromises.size > 0) {
        const error = new DurableActivityScopeError(
          'durableActivity() calls started inside ctx.memo() must be awaited before the memo callback returns.',
        );
        await this.#closeAndDrain(error);
        throw error;
      }
      this.#close();
      return result;
    } catch (error) {
      await this.#closeAndDrain(error);
      throw error;
    } finally {
      cleanupAbortForwarding();
    }
  }

  dispatch<TResult>(invocation: DurableActivityInvocation): Promise<TResult> {
    try {
      this.#throwIfClosed();
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#activePromise !== undefined) {
      return Promise.reject(
        new DurableActivityScopeError(
          'durableActivity() calls inside one ctx.memo() scope must be awaited sequentially. ' +
            'Start the next durableActivity() call after the previous promise settles.',
        ),
      );
    }

    const ordinal = this.#nextOrdinal;
    this.#nextOrdinal += 1;
    const execution = this.#executeInvocation<TResult>(invocation, ordinal);
    this.#activePromise = execution;
    this.#pendingPromises.add(execution);
    void execution
      .finally(() => {
        if (this.#activePromise === execution) {
          this.#activePromise = undefined;
        }
        this.#pendingPromises.delete(execution);
      })
      .catch(() => {});
    void execution.catch(() => {});
    return execution;
  }

  async #executeInvocation<TResult>(
    invocation: DurableActivityInvocation,
    ordinal: number,
  ): Promise<TResult> {
    const activityStateKey = this.#activityStateKey(ordinal);
    const generator = runActivityWithRetryAtStep<TResult>(
      this.#context,
      invocation.activity,
      invocation.arguments,
      this.#operation.step,
      {
        activityStateKey,
        cacheResultStep: false,
        retryStateKey: activityStateKey,
        retrySleep: (duration, nextAttempt) =>
          this.#retrySleepOperation(duration, ordinal, nextAttempt),
      },
    );

    let next = generator.next();
    while (!next.done) {
      try {
        const result = await this.#executeYieldedOperation(next.value, invocation, ordinal);
        next = generator.next(result);
      } catch (error) {
        if (error instanceof AsyncActivityDeferral) {
          throw new DurableActivityUnsupportedError(
            'ActivityContext.completeAsync() is not supported from durableActivity(). ' +
              'Use yield* ctx.run() for async-completion activities.',
          );
        }
        next = generator.throw(error);
      }
    }
    return next.value;
  }

  async #executeYieldedOperation(
    operation: ContextOperationRequest,
    invocation: DurableActivityInvocation,
    ordinal: number,
  ): Promise<unknown> {
    this.#throwIfClosed();
    if (operation.type === 'activity') {
      return this.#executeActivityOperation(operation, invocation.callerStack, ordinal);
    }
    if (operation.type === 'sleep') {
      await this.#raceWithScopeAbort(this.#executeDurableRetrySleepOperation(operation));
      this.#throwIfClosed();
      return undefined;
    }
    throw new DurableActivityScopeError(
      `durableActivity() retry driver yielded unsupported operation "${operation.type}".`,
    );
  }

  #executeActivityOperation(
    request: ActivityOperationRequest,
    callerStack: string,
    ordinal: number,
  ): Promise<unknown> {
    const attempt = typeof request.attempt === 'number' ? request.attempt : 1;
    const operation: ActivityOperationRequest = {
      ...request,
      operationId: this.#activityOperationId(ordinal, attempt),
      callerStack,
    };
    return this.#raceWithScopeAbort(
      executeActivityOperationResult(
        this.#internals,
        this.#workflowId,
        operation,
        this.#activityCallbacks,
        this.#scopeAbortController.signal,
        undefined,
        {
          reconciliationCompletion: 'immediate-fenced',
          beforeImmediateReconciliationCommit: () => this.#beginNonCancellableWrite(),
        },
      ),
    );
  }

  async #executeDurableRetrySleepOperation(operation: SleepOperation): Promise<void> {
    const finishCheckpointWrite = this.#beginNonCancellableWrite();
    try {
      await this.#persistCheckpoint(this.#workflowId, operation);
    } finally {
      finishCheckpointWrite();
    }
    this.#throwIfClosed();

    if (operation.scheduledFireAt <= this.#internals.options.getNow()) {
      return;
    }

    const { promise, resolve } = Promise.withResolvers<void>();
    const finishTimerWrite = this.#beginNonCancellableWrite();
    try {
      await this.#internals.scheduler.schedule({
        id: `sleep:${operation.operationId}`,
        workflowId: this.#workflowId,
        fireAt: operation.scheduledFireAt,
        kind: 'sleep',
      });
    } finally {
      finishTimerWrite();
    }
    this.#throwIfClosed();
    registerSleepResolver(
      this.#internals,
      this.#workflowId,
      operation.operationId,
      resolve,
      operation.scheduledFireAt,
    );
    await promise;
  }

  #activityOperationId(ordinal: number, attempt: number): string {
    return `${this.#activityStateKey(ordinal)}:activity:${attempt}`;
  }

  #retrySleepOperationId(ordinal: number, nextAttempt: number): string {
    return `${this.#activityStateKey(ordinal)}:retry-sleep:${nextAttempt}`;
  }

  *#retrySleepOperation(
    duration: number,
    ordinal: number,
    nextAttempt: number,
  ): Generator<ContextOperationRequest, void, unknown> {
    const operationId = this.#retrySleepOperationId(ordinal, nextAttempt);
    yield {
      type: 'sleep',
      operationId,
      duration,
      scheduledFireAt: this.#readOrInitRetrySleepFireAt(operationId, duration),
    };
  }

  #readOrInitRetrySleepFireAt(operationId: string, duration: number): number {
    return readOrInitActivityRetrySleepFireAt(this.#context, operationId, duration);
  }

  #activityStateKey(ordinal: number): string {
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
      throw new DurableActivityScopeError(
        `Invalid durableActivity() call ordinal ${String(ordinal)} for ctx.memo() step ${String(this.#operation.step)}.`,
      );
    }
    return `${this.#identityPrefix}:call:${String(ordinal)}`;
  }

  #raceWithScopeAbort<TResult>(operation: Promise<TResult>): Promise<TResult> {
    void operation.catch(() => {});
    this.#throwIfClosed();
    return new Promise<TResult>((resolve, reject) => {
      let settled = false;
      const signal = this.#scopeAbortController.signal;

      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
      };

      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };

      const onAbort = () => {
        if (this.#activeNonCancellableWriteCount > 0) {
          return;
        }
        settle(() => reject(this.#abortError()));
      };

      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }

      void operation
        .then((value) => {
          settle(() => {
            if (this.#closed || signal.aborted) {
              reject(this.#abortError());
              return;
            }
            resolve(value);
          });
        })
        .catch((error: unknown) => {
          settle(() => reject(error));
        });
    });
  }

  #beginNonCancellableWrite(): () => void {
    this.#throwIfClosed();
    this.#activeNonCancellableWriteCount += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.#activeNonCancellableWriteCount -= 1;
      if (
        this.#closed &&
        this.#activeNonCancellableWriteCount === 0 &&
        !this.#scopeAbortController.signal.aborted
      ) {
        this.#scopeAbortController.abort(this.#abortError());
      }
    };
  }

  #forwardAbortSignals(): () => void {
    const signals = [this.#context.signal, this.#internals.abortController.signal];
    const listeningSignals: AbortSignal[] = [];
    const onAbort = () => {
      this.#close(
        new DurableActivityScopeError('durableActivity() scope closed before completion.'),
      );
    };
    const cleanup = () => {
      for (const signal of listeningSignals) {
        signal.removeEventListener('abort', onAbort);
      }
    };
    for (const signal of signals) {
      if (signal.aborted) {
        onAbort();
        return cleanup;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      listeningSignals.push(signal);
    }
    return cleanup;
  }

  #close(reason?: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeReason = toScopeError(reason);
    if (this.#activeNonCancellableWriteCount === 0 && !this.#scopeAbortController.signal.aborted) {
      this.#scopeAbortController.abort(this.#closeReason);
    }
  }

  async #closeAndDrain(reason?: unknown): Promise<void> {
    this.#close(reason);
    if (this.#pendingPromises.size === 0) return;
    await Promise.allSettled(this.#pendingPromises);
  }

  #throwIfClosed(): void {
    if (this.#closed || this.#scopeAbortController.signal.aborted) {
      throw this.#abortError();
    }
  }

  #abortError(): Error {
    if (this.#closeReason !== undefined) {
      return this.#closeReason;
    }
    const reason = this.#scopeAbortController.signal.reason;
    return reason instanceof Error
      ? reason
      : new DurableActivityScopeError('durableActivity() scope closed before completion.');
  }
}

function toScopeError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  if (reason === undefined) {
    return new DurableActivityScopeError('durableActivity() scope closed before completion.');
  }
  return new DurableActivityScopeError(formatCloseReason(reason));
}

function formatCloseReason(reason: unknown): string {
  if (typeof reason === 'string') return reason;
  if (typeof reason === 'number' || typeof reason === 'boolean' || typeof reason === 'bigint') {
    return reason.toString();
  }
  return 'durableActivity() scope closed before completion.';
}

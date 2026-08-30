import {
  AtomicStateChangeEvent,
  AtomicStateConflictError,
  AtomicStateConflictEvent,
  atomicStateDataKey,
  AtomicStateExhaustedEvent,
  type AtomicStateCommitResult,
  type AtomicStateScope,
  type AtomicStateSnapshot,
} from '../atomic-state.ts';
import type {
  WorkflowAtomicState,
  WorkflowAtomicStateOptions,
  WorkflowSessionState,
  WorkflowSessionStateOptions,
  WorkflowStateNamespace,
} from '../types.ts';
import type { Context } from './index.ts';
import type { ContextInternals } from './internals.ts';
import type { ContextOperationRequest } from './operation-request.ts';
import * as stateSessionHelpers from './session-state.ts';
import { captureCallerStack } from './validation.ts';

interface WorkflowAtomicStateOperationCache {
  nextStep(): number;
  has(step: number): boolean;
  get<TResult>(step: number): TResult;
  set(step: number, value: unknown): void;
}

export function createStateNamespace(
  context: Context,
  internals: ContextInternals,
): WorkflowStateNamespace {
  const operationCache = createContextStateOperationCache(context, internals);

  return {
    session: <T>(key: string, options?: WorkflowSessionStateOptions<T>): WorkflowSessionState<T> =>
      stateSessionHelpers.stateSession(context, internals, key, options),
    execution: <T>(key: string, options?: WorkflowAtomicStateOptions<T>): WorkflowAtomicState<T> =>
      new WorkflowAtomicStateHandle<T>(
        { type: 'execution', ownerWorkflowId: internals.executionStateOwnerId },
        key,
        options,
        operationCache,
      ),
    workflow: <T>(key: string, options?: WorkflowAtomicStateOptions<T>): WorkflowAtomicState<T> =>
      new WorkflowAtomicStateHandle<T>(
        { type: 'workflow', workflowType: context.workflowType },
        key,
        options,
        operationCache,
      ),
  };
}

function createContextStateOperationCache(
  context: Context,
  internals: ContextInternals,
): WorkflowAtomicStateOperationCache {
  return {
    nextStep: () => internals.stepIndex++,
    has: (step) => internals.accumulatedResults?.has(step) ?? false,
    get: <TResult>(step: number) => internals.accumulatedResults?.get(step) as TResult,
    set: (step, value) => {
      context.accumulatedResults.set(step, value);
    },
  };
}

export class WorkflowAtomicStateHandle<T> extends EventTarget implements WorkflowAtomicState<T> {
  readonly #scope: AtomicStateScope;
  readonly #key: string;
  readonly #dataKey: string;
  readonly #maxRetries: number;
  readonly #options: Pick<WorkflowAtomicStateOptions<T>, 'initial'> | undefined;
  readonly #operationCache: WorkflowAtomicStateOperationCache | undefined;

  constructor(
    scope: AtomicStateScope,
    key: string,
    options?: WorkflowAtomicStateOptions<T>,
    operationCache?: WorkflowAtomicStateOperationCache,
  ) {
    super();
    this.#scope = scope;
    this.#key = key;
    this.#dataKey = atomicStateDataKey(scope, key);
    this.#maxRetries = options?.maxRetries ?? 10;
    this.#options = options && 'initial' in options ? { initial: options.initial } : undefined;
    this.#operationCache = operationCache;
  }

  *get(): Generator<ContextOperationRequest, T | undefined, unknown> {
    return (yield* this.#read()).value;
  }

  *set(value: T): Generator<ContextOperationRequest, T, unknown> {
    return yield* this.update(() => value);
  }

  *update(updater: (current: T | undefined) => T): Generator<ContextOperationRequest, T, unknown> {
    for (let attempt = 0; attempt < this.#maxRetries; attempt++) {
      const snapshot = yield* this.#read();
      const nextValue = updater(snapshot.value);
      const commit = yield* this.#commit(snapshot.version, 'set', nextValue);

      if (commit.applied) {
        this.dispatchEvent(
          new AtomicStateChangeEvent<T>(nextValue, snapshot.value, commit.version),
        );
        return nextValue;
      }

      this.dispatchEvent(new AtomicStateConflictEvent(this.#dataKey, attempt + 1));
    }

    this.dispatchEvent(new AtomicStateExhaustedEvent(this.#dataKey, this.#maxRetries));
    throw new AtomicStateConflictError(this.#dataKey, this.#maxRetries);
  }

  *delete(): Generator<ContextOperationRequest, void, unknown> {
    for (let attempt = 0; attempt < this.#maxRetries; attempt++) {
      const snapshot = yield* this.#read();
      const commit = yield* this.#commit(snapshot.version, 'delete');

      if (commit.applied) {
        this.dispatchEvent(
          new AtomicStateChangeEvent<T>(undefined, snapshot.value, commit.version),
        );
        return;
      }

      this.dispatchEvent(new AtomicStateConflictEvent(this.#dataKey, attempt + 1));
    }

    this.dispatchEvent(new AtomicStateExhaustedEvent(this.#dataKey, this.#maxRetries));
    throw new AtomicStateConflictError(this.#dataKey, this.#maxRetries);
  }

  *increment(this: WorkflowAtomicStateHandle<number>, amount: number = 1) {
    return yield* this.update((current) => (current ?? 0) + amount);
  }

  *decrement(this: WorkflowAtomicStateHandle<number>, amount: number = 1) {
    return yield* this.update((current) => (current ?? 0) - amount);
  }

  *merge<TObject extends Record<string, unknown>>(
    this: WorkflowAtomicStateHandle<TObject>,
    patch: Partial<TObject>,
  ) {
    return yield* this.update((current) => ({ ...(current ?? ({} as TObject)), ...patch }));
  }

  *append<TItem>(this: WorkflowAtomicStateHandle<TItem[]>, item: TItem) {
    return yield* this.update((current) => [...(current ?? []), item]);
  }

  *removeFirst<TItem>(this: WorkflowAtomicStateHandle<TItem[]>) {
    let removed: TItem | undefined;
    yield* this.update((current) => {
      const next = [...(current ?? [])];
      removed = next.shift();
      return next;
    });
    return removed;
  }

  *removeLast<TItem>(this: WorkflowAtomicStateHandle<TItem[]>) {
    let removed: TItem | undefined;
    yield* this.update((current) => {
      const next = [...(current ?? [])];
      removed = next.pop();
      return next;
    });
    return removed;
  }

  *#read(): Generator<ContextOperationRequest, AtomicStateSnapshot<T>, unknown> {
    return yield* this.#executeOperation<AtomicStateSnapshot<T>>({
      type: 'state-read',
      operationId: crypto.randomUUID(),
      scope: this.#scope,
      key: this.#key,
      ...(this.#options !== undefined ? { initial: this.#options.initial } : {}),
      callerStack: captureCallerStack(),
    });
  }

  *#commit(
    expectedVersion: number,
    mode: 'set' | 'delete',
    value?: T,
  ): Generator<ContextOperationRequest, AtomicStateCommitResult<T>, unknown> {
    return yield* this.#executeOperation<AtomicStateCommitResult<T>>({
      type: 'state-commit',
      operationId: crypto.randomUUID(),
      scope: this.#scope,
      key: this.#key,
      expectedVersion,
      mode,
      ...(mode === 'set' ? { value } : {}),
      callerStack: captureCallerStack(),
    });
  }

  *#executeOperation<TResult>(
    operation: ContextOperationRequest,
  ): Generator<ContextOperationRequest, TResult, unknown> {
    const operationCache = this.#operationCache;
    if (operationCache === undefined) {
      const result = yield operation;
      return result as TResult;
    }

    const step = operationCache.nextStep();
    if (operationCache.has(step)) {
      return operationCache.get<TResult>(step);
    }

    const result = yield operation;
    operationCache.set(step, result);
    return result as TResult;
  }
}

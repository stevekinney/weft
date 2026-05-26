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

export function createStateNamespace(
  context: Context,
  internals: ContextInternals,
): WorkflowStateNamespace {
  return {
    session: <T>(key: string, options?: WorkflowSessionStateOptions<T>): WorkflowSessionState<T> =>
      stateSessionHelpers.stateSession(context, internals, key, options),
    execution: <T>(key: string, options?: WorkflowAtomicStateOptions<T>): WorkflowAtomicState<T> =>
      new WorkflowAtomicStateHandle<T>(
        { type: 'execution', ownerWorkflowId: internals.executionStateOwnerId },
        key,
        options,
      ),
    workflow: <T>(key: string, options?: WorkflowAtomicStateOptions<T>): WorkflowAtomicState<T> =>
      new WorkflowAtomicStateHandle<T>(
        { type: 'workflow', workflowType: context.workflowType },
        key,
        options,
      ),
  };
}

export class WorkflowAtomicStateHandle<T> extends EventTarget implements WorkflowAtomicState<T> {
  readonly #scope: AtomicStateScope;
  readonly #key: string;
  readonly #dataKey: string;
  readonly #maxRetries: number;
  readonly #options: Pick<WorkflowAtomicStateOptions<T>, 'initial'> | undefined;

  constructor(scope: AtomicStateScope, key: string, options?: WorkflowAtomicStateOptions<T>) {
    super();
    this.#scope = scope;
    this.#key = key;
    this.#dataKey = atomicStateDataKey(scope, key);
    this.#maxRetries = options?.maxRetries ?? 10;
    this.#options = options && 'initial' in options ? { initial: options.initial } : undefined;
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
    const result = yield {
      type: 'state-read',
      operationId: crypto.randomUUID(),
      scope: this.#scope,
      key: this.#key,
      ...(this.#options !== undefined ? { initial: this.#options.initial } : {}),
      callerStack: captureCallerStack(),
    };
    return result as AtomicStateSnapshot<T>;
  }

  *#commit(
    expectedVersion: number,
    mode: 'set' | 'delete',
    value?: T,
  ): Generator<ContextOperationRequest, AtomicStateCommitResult<T>, unknown> {
    const result = yield {
      type: 'state-commit',
      operationId: crypto.randomUUID(),
      scope: this.#scope,
      key: this.#key,
      expectedVersion,
      mode,
      ...(mode === 'set' ? { value } : {}),
      callerStack: captureCallerStack(),
    };
    return result as AtomicStateCommitResult<T>;
  }
}

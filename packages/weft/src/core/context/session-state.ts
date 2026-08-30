import {
  assertValidSessionStateKey,
  cloneSessionStateStore,
  cloneSessionStateValue,
  createSessionStateStore,
  hasSessionStateKey,
  SESSION_STATE_LOCAL_KEY,
  validateSessionStateStore,
} from '../session-state.ts';
import type {
  ActivityCallOptions,
  WorkflowSessionState,
  WorkflowSessionStateOptions,
} from '../types.ts';
import type { Context } from './index.ts';
import type { ContextInternals } from './internals.ts';
import type { ContextOperationRequest } from './operation-request.ts';

const EMPTY_CHECKPOINT_LOCALS = Object.freeze({}) as Record<string, unknown>;
const RETIRED_SESSION_STATE_LOCAL_KEY = 'sessionState';

const ACTIVITY_CALL_OPTION_KEYS = new Set<string>([
  'timeout',
  'queue',
  'retry',
  'idempotencyKey',
  'sticky',
  'visibilityTimeout',
  'scheduleToCloseTimeout',
]);

const DISCRIMINATOR_KEYS = new Set<string>([
  'queue',
  'retry',
  'idempotencyKey',
  'sticky',
  'visibilityTimeout',
  'scheduleToCloseTimeout',
]);

/** Detect whether a value is an {@link ActivityCallOptions} object. */
export function isActivityCallOptions(value: unknown): value is ActivityCallOptions {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  for (const key of keys) {
    if (!ACTIVITY_CALL_OPTION_KEYS.has(key)) {
      return false;
    }
  }
  for (const key of keys) {
    if (DISCRIMINATOR_KEYS.has(key)) {
      return true;
    }
  }
  return false;
}

export function createCheckpointLocals(
  stateSessionStore: Record<string, unknown> | undefined,
  existingLocals: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const localEntries =
    existingLocals === undefined
      ? []
      : Object.entries(existingLocals).filter(
          ([key]) => key !== SESSION_STATE_LOCAL_KEY && key !== RETIRED_SESSION_STATE_LOCAL_KEY,
        );

  if (stateSessionStore === undefined) {
    if (localEntries.length === 0) {
      return EMPTY_CHECKPOINT_LOCALS;
    }

    return Object.fromEntries(localEntries);
  }

  return {
    ...Object.fromEntries(localEntries),
    [SESSION_STATE_LOCAL_KEY]: stateSessionStore,
  };
}

export function commitSessionStateStore(
  internals: ContextInternals,
  stateSessionStore: Record<string, unknown> | undefined,
): void {
  internals.stateSession = stateSessionStore;
  internals.checkpointLocals = createCheckpointLocals(
    stateSessionStore,
    internals.checkpointLocals,
  );
}

export function getSessionStateValue<T>(
  internals: ContextInternals,
  key: string,
  initialValue?: T,
): T | undefined {
  assertValidSessionStateKey(key);

  if (internals.stateSession && hasSessionStateKey(internals.stateSession, key)) {
    return cloneSessionStateValue(internals.stateSession[key] as T);
  }

  return initialValue === undefined ? undefined : cloneSessionStateValue(initialValue);
}

export function setSessionStateValue<T>(internals: ContextInternals, key: string, value: T): T {
  assertValidSessionStateKey(key);
  const candidate = cloneSessionStateStore(internals.stateSession) ?? createSessionStateStore();
  candidate[key] = cloneSessionStateValue(value);
  validateSessionStateStore(candidate);
  commitSessionStateStore(internals, candidate);
  return cloneSessionStateValue(candidate[key] as T);
}

export function updateSessionStateValue<T>(
  internals: ContextInternals,
  key: string,
  initialValue: T | undefined,
  updater: (current: T | undefined) => T,
): T {
  return setSessionStateValue(
    internals,
    key,
    updater(getSessionStateValue(internals, key, initialValue)),
  );
}

export function clearSessionStateValue(internals: ContextInternals, key: string): void {
  assertValidSessionStateKey(key);

  if (!internals.stateSession || !hasSessionStateKey(internals.stateSession, key)) {
    return;
  }

  const candidate = cloneSessionStateStore(internals.stateSession) ?? createSessionStateStore();
  delete candidate[key];
  commitSessionStateStore(internals, Object.keys(candidate).length === 0 ? undefined : candidate);
}

export type SessionStateRunArguments =
  | { readonly hasInput: false; readonly options: ActivityCallOptions }
  | { readonly hasInput: true; readonly input: unknown; readonly options: ActivityCallOptions };

export function mergeSessionStateRunOptions(rest: readonly unknown[]): SessionStateRunArguments {
  if (rest.length > 2) {
    throw new Error(
      'sessionState.run() accepts one activity input value plus optional ActivityCallOptions.',
    );
  }

  if (rest.length === 0) {
    return { hasInput: false, options: { sticky: true } };
  }

  if (rest.length === 1 && isActivityCallOptions(rest[0])) {
    return { hasInput: false, options: { ...rest[0], sticky: true } };
  }

  if (rest.length === 1) {
    return { hasInput: true, input: rest[0], options: { sticky: true } };
  }

  const options = rest[1];
  if (!isActivityCallOptions(options)) {
    throw new Error('sessionState.run() options must be ActivityCallOptions.');
  }

  return { hasInput: true, input: rest[0], options: { ...options, sticky: true } };
}

export function executeSessionStateOperation<TResult>(
  internals: ContextInternals,
  apply: () => TResult,
): TResult {
  const step = internals.stepIndex++;

  if (internals.accumulatedResults?.has(step)) {
    return internals.accumulatedResults.get(step) as TResult;
  }

  const result = apply();
  internals.accumulatedResults ??= new Map();
  internals.accumulatedResults.set(step, result);
  return result;
}

export function stateSession<T>(
  context: Context,
  internals: ContextInternals,
  key: string,
  options?: WorkflowSessionStateOptions<T>,
): WorkflowSessionState<T> {
  const hasInitialValue = options !== undefined && 'initial' in options;
  const stateSessionInitialValue = hasInitialValue
    ? cloneSessionStateValue(options.initial)
    : undefined;
  const get = (): T | undefined =>
    executeSessionStateOperation(internals, () =>
      getSessionStateValue(internals, key, hasInitialValue ? stateSessionInitialValue : undefined),
    );
  const set = (value: T): T =>
    executeSessionStateOperation(internals, () => setSessionStateValue(internals, key, value));
  const update = (updater: (current: T | undefined) => T): T =>
    executeSessionStateOperation(internals, () =>
      updateSessionStateValue(
        internals,
        key,
        hasInitialValue ? stateSessionInitialValue : undefined,
        updater,
      ),
    );
  const deleteValue = (): void => {
    executeSessionStateOperation(internals, () => {
      clearSessionStateValue(internals, key);
      return undefined;
    });
  };
  const run = <TResult>(
    fn: (input?: unknown) => Promise<TResult> | TResult,
    ...rest: unknown[]
  ): Generator<ContextOperationRequest, TResult, unknown> => {
    const merged = mergeSessionStateRunOptions(rest);
    if (!merged.hasInput) {
      return context.run(fn, merged.options);
    }

    return context.run(fn, merged.input, merged.options);
  };

  return {
    get,
    set,
    update,
    delete: deleteValue,
    increment(this: WorkflowSessionState<number>, amount: number = 1): number {
      return this.update((current) => (current ?? 0) + amount);
    },
    decrement(this: WorkflowSessionState<number>, amount: number = 1): number {
      return this.update((current) => (current ?? 0) - amount);
    },
    merge<TObject extends Record<string, unknown>>(
      this: WorkflowSessionState<TObject>,
      patch: Partial<TObject>,
    ): TObject {
      return this.update((current) => ({ ...(current ?? ({} as TObject)), ...patch }));
    },
    append<TItem>(this: WorkflowSessionState<TItem[]>, item: TItem): TItem[] {
      return this.update((current) => [...(current ?? []), item]);
    },
    removeFirst<TItem>(this: WorkflowSessionState<TItem[]>): TItem | undefined {
      let removed: TItem | undefined;
      this.update((current) => {
        const next = [...(current ?? [])];
        removed = next.shift();
        return next;
      });
      return removed;
    },
    removeLast<TItem>(this: WorkflowSessionState<TItem[]>): TItem | undefined {
      let removed: TItem | undefined;
      this.update((current) => {
        const next = [...(current ?? [])];
        removed = next.pop();
        return next;
      });
      return removed;
    },
    run,
  };
}

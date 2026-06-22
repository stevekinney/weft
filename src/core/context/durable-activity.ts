import type { ActivityCallable, ActivityCallOptions } from '../types.ts';
import { WeftError } from '../weft-error.ts';
import { captureCallerStack } from './validation.ts';

type BareActivityFunction<TInput, TResult> = ((input: TInput) => Promise<TResult> | TResult) & {
  execute?: never;
};

type BareNoInputActivityFunction<TResult> = (() => Promise<TResult> | TResult) & {
  execute?: never;
};

export type DurableActivityInput =
  | string
  | ActivityCallable<void, unknown>
  | BareNoInputActivityFunction<unknown>
  | ActivityCallable<unknown, unknown>
  | BareActivityFunction<unknown, unknown>;

export interface DurableActivityInvocation {
  activity: DurableActivityInput;
  arguments: readonly unknown[];
  callerStack: string;
}

export interface DurableActivityScope {
  dispatch<TResult>(invocation: DurableActivityInvocation): Promise<TResult>;
}

/**
 * Thrown when `durableActivity()` is called without an active inline `ctx.memo`
 * durable-activity scope, or after that scope has already closed.
 *
 * The error usually means helper code escaped the memo callback boundary, ran
 * under Worker execution mode, or started a helper activity without awaiting it
 * before the memo callback returned.
 *
 * @example
 * ```ts
 * import { durableActivity, DurableActivityScopeError } from '@lostgradient/weft';
 *
 * async function sendOutsideWorkflow(): Promise<void> {
 *   try {
 *     await durableActivity('sendEmail', { userId: 'user-1' });
 *   } catch (error) {
 *     if (error instanceof DurableActivityScopeError) {
 *       console.error(error.message);
 *     }
 *   }
 * }
 *
 * void sendOutsideWorkflow;
 * ```
 */
export class DurableActivityScopeError extends WeftError<'DurableActivityScopeError'> {
  constructor(message: string) {
    super('DurableActivityScopeError', message);
  }
}

/**
 * Thrown when helper-launched activity code reaches an activity feature that
 * cannot safely be represented inside a plain async memo callback.
 *
 * The first unsupported feature is `ActivityContext.completeAsync()`: async
 * activity completion must use `yield* ctx.run()` directly so the parked
 * completion token stays attached to a normal workflow operation.
 *
 * @example
 * ```ts
 * import { durableActivity, DurableActivityUnsupportedError } from '@lostgradient/weft';
 *
 * async function runHelperActivity(): Promise<void> {
 *   try {
 *     await durableActivity('manualCompletionActivity', undefined, {
 *       idempotencyKey: 'manual-completion:1',
 *     });
 *   } catch (error) {
 *     if (error instanceof DurableActivityUnsupportedError) {
 *       console.error(error.message);
 *     }
 *   }
 * }
 *
 * void runHelperActivity;
 * ```
 */
export class DurableActivityUnsupportedError extends WeftError<'DurableActivityUnsupportedError'> {
  constructor(message: string) {
    super('DurableActivityUnsupportedError', message);
  }
}

interface AsyncLocalStorageLike<TStore> {
  getStore(): TStore | undefined;
  run<TResult>(store: TStore, callback: () => TResult): TResult;
}

type AsyncLocalStorageConstructor = new <TStore>() => AsyncLocalStorageLike<TStore>;

type ProcessWithBuiltinModule = {
  getBuiltinModule?: (id: string) => unknown;
};

type AsyncHooksModule = {
  AsyncLocalStorage?: AsyncLocalStorageConstructor;
};

let durableActivityScopeStorage: AsyncLocalStorageLike<DurableActivityScope> | null | undefined;
const fallbackDurableActivityScopes: DurableActivityScope[] = [];
const AMBIGUOUS_FALLBACK_DURABLE_ACTIVITY_SCOPE = Symbol(
  'AMBIGUOUS_FALLBACK_DURABLE_ACTIVITY_SCOPE',
);

function loadAsyncLocalStorageConstructor(): AsyncLocalStorageConstructor | undefined {
  const processValue =
    'process' in globalThis
      ? (globalThis as { process?: ProcessWithBuiltinModule }).process
      : undefined;
  const getBuiltinModule = processValue?.getBuiltinModule;
  if (typeof getBuiltinModule !== 'function') {
    return undefined;
  }
  const asyncHooks = getBuiltinModule('node:async_hooks') as AsyncHooksModule | undefined;
  return asyncHooks?.AsyncLocalStorage;
}

function getDurableActivityScopeStorage(): AsyncLocalStorageLike<DurableActivityScope> | null {
  if (durableActivityScopeStorage !== undefined) {
    return durableActivityScopeStorage;
  }
  const AsyncLocalStorage = loadAsyncLocalStorageConstructor();
  durableActivityScopeStorage =
    AsyncLocalStorage === undefined ? null : new AsyncLocalStorage<DurableActivityScope>();
  return durableActivityScopeStorage;
}

function currentDurableActivityScope():
  | DurableActivityScope
  | typeof AMBIGUOUS_FALLBACK_DURABLE_ACTIVITY_SCOPE
  | undefined {
  const storage = getDurableActivityScopeStorage();
  if (storage !== null) {
    return storage.getStore();
  }
  if (fallbackDurableActivityScopes.length > 1) {
    return AMBIGUOUS_FALLBACK_DURABLE_ACTIVITY_SCOPE;
  }
  return fallbackDurableActivityScopes.at(-1);
}

export function runWithDurableActivityScope<TResult>(
  scope: DurableActivityScope,
  execute: () => TResult,
): TResult {
  const storage = getDurableActivityScopeStorage();
  if (storage === null) {
    return runWithFallbackDurableActivityScope(scope, execute);
  }
  return storage.run(scope, execute);
}

function runWithFallbackDurableActivityScope<TResult>(
  scope: DurableActivityScope,
  execute: () => TResult,
): TResult {
  fallbackDurableActivityScopes.push(scope);
  let result: TResult;
  try {
    result = execute();
  } catch (error) {
    removeFallbackDurableActivityScope(scope);
    throw error;
  }
  if (hasFinally(result)) {
    return result.finally(() => removeFallbackDurableActivityScope(scope));
  }
  removeFallbackDurableActivityScope(scope);
  return result;
}

function removeFallbackDurableActivityScope(scope: DurableActivityScope): void {
  const index = fallbackDurableActivityScopes.lastIndexOf(scope);
  if (index >= 0) {
    fallbackDurableActivityScopes.splice(index, 1);
  }
}

function hasFinally<TResult>(
  value: TResult,
): value is TResult & { finally(onFinally: () => void): TResult } {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return false;
  }
  return 'finally' in value && typeof value.finally === 'function';
}

/**
 * Run a durable activity from plain async helper code while an inline workflow
 * is executing a `ctx.memo()` callback.
 *
 * `durableActivity()` gives shared async helpers the same activity dispatch
 * machinery as `yield* ctx.run()` without converting the helper stack to
 * generators. It is intentionally scoped: call it only from code awaited by one
 * inline `ctx.memo()` callback, and await each helper activity sequentially
 * before the callback returns. Activities with `idempotencyKey` get immediate
 * lease-fenced result durability for the crash window between the activity
 * returning and the memo checkpoint commit; unkeyed helper activities keep the
 * normal at-least-once crash behavior.
 *
 * @example
 * ```ts
 * import { durableActivity, workflow } from '@lostgradient/weft';
 *
 * async function reserveInventory(input: { orderId: string }): Promise<{ reservationId: string }> {
 *   return { reservationId: input.orderId };
 * }
 *
 * export const checkout = workflow({ name: 'checkout' }).execute(async function* (
 *   ctx,
 *   input: { orderId: string },
 * ) {
 *   return yield* ctx.memo('reserve-inventory', async () =>
 *     durableActivity(reserveInventory, { orderId: input.orderId }, {
 *       idempotencyKey: `reserve:${input.orderId}`,
 *     }),
 *   );
 * });
 * ```
 */
export function durableActivity<TResult = unknown>(
  name: string,
  input?: unknown,
  options?: ActivityCallOptions,
): Promise<TResult>;
export function durableActivity<TResult>(
  fn: ActivityCallable<void, TResult>,
  options?: ActivityCallOptions,
): Promise<TResult>;
export function durableActivity<TResult>(
  fn: BareNoInputActivityFunction<TResult>,
  options?: ActivityCallOptions,
): Promise<TResult>;
export function durableActivity<TInput, TResult>(
  fn: ActivityCallable<TInput, TResult>,
  input: TInput,
  options?: ActivityCallOptions,
): Promise<TResult>;
export function durableActivity<TInput, TResult>(
  fn: BareActivityFunction<TInput, TResult>,
  input: TInput,
  options?: ActivityCallOptions,
): Promise<TResult>;
export function durableActivity<TResult>(
  activity: DurableActivityInput,
  ...activityArguments: unknown[]
): Promise<TResult> {
  const scope = currentDurableActivityScope();
  if (scope === AMBIGUOUS_FALLBACK_DURABLE_ACTIVITY_SCOPE) {
    return Promise.reject(
      new DurableActivityScopeError(
        'durableActivity() cannot resolve a unique ctx.memo() scope because AsyncLocalStorage is unavailable ' +
          'and multiple memo callbacks are active. Run this workflow in a runtime with AsyncLocalStorage support.',
      ),
    );
  }
  if (scope === undefined) {
    return Promise.reject(
      new DurableActivityScopeError(
        'durableActivity() can only be called from a ctx.memo() callback during inline workflow activation. ' +
          'Use yield* ctx.run() in generator workflow code outside that memo helper boundary.',
      ),
    );
  }
  return scope.dispatch<TResult>({
    activity,
    arguments: activityArguments,
    callerStack: captureCallerStack(),
  });
}

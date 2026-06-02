import { sleep as portableSleep } from '../runtime/portable.ts';
import type { Storage } from '../storage/interface.ts';
import { KEYS, requireStorageCapability, storageConditionalBatch } from '../storage/interface.ts';
import {
  AtomicStateChangeEvent,
  AtomicStateConflictEvent,
  AtomicStateExhaustedEvent,
  OBSERVABLE_SYMBOL,
  type AtomicStateCommitResult,
  type AtomicStateEvent,
  type AtomicStateObserver,
  type AtomicStateOptions,
  type AtomicStateScope,
  type AtomicStateSnapshot,
  type AtomicStateSubscription,
  type SleepFunction,
} from './atomic-state-events.ts';
import { decode, encode } from './codec.ts';
import { WeftError } from './weft-error.ts';

export {
  AtomicStateChangeEvent,
  AtomicStateConflictEvent,
  AtomicStateExhaustedEvent,
  OBSERVABLE_SYMBOL,
} from './atomic-state-events.ts';
export type {
  AtomicStateCommitResult,
  AtomicStateEvent,
  AtomicStateObserver,
  AtomicStateOptions,
  AtomicStateScope,
  AtomicStateSnapshot,
  AtomicStateSubscription,
  SleepFunction,
} from './atomic-state-events.ts';

const ATOMIC_STATE_BASE_DELAY_MS = 5;
const ATOMIC_STATE_MAX_DELAY_MS = 100;
const MAX_ATOMIC_STATE_KEY_LENGTH = 256;
const RESERVED_ATOMIC_STATE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Thrown by {@link AtomicState.update} when the CAS (compare-and-swap) loop
 * exhausts its retry budget without successfully committing.
 *
 * @example
 * ```ts
 * import { AtomicState, AtomicStateConflictError } from '@lostgradient/weft';
 * import { MemoryStorage } from '@lostgradient/weft/storage/memory';
 *
 * const storage = new MemoryStorage();
 * const state = new AtomicState<number>(storage, 'state:workflow-scope:default:counter', {
 *   initial: 0,
 *   maxRetries: 3,
 * });
 * try {
 *   await state.increment();
 * } catch (error) {
 *   if (error instanceof AtomicStateConflictError) {
 *     console.error('conflict on', error.stateKey, 'after', error.attempts, 'attempts');
 *   }
 * }
 * ```
 */
export class AtomicStateConflictError extends WeftError<'AtomicStateConflictError'> {
  readonly stateKey: string;
  readonly attempts: number;

  constructor(stateKey: string, attempts: number) {
    super(
      'AtomicStateConflictError',
      `AtomicState conflict: failed to update "${stateKey}" after ${String(attempts)} attempts`,
    );
    this.stateKey = stateKey;
    this.attempts = attempts;
  }
}

export function atomicStateDataKey(scope: AtomicStateScope, key: string): string {
  assertValidAtomicStateKey(key);

  switch (scope.type) {
    case 'execution':
      return KEYS.stateExecution(scope.ownerWorkflowId, key);
    case 'workflow':
      return KEYS.stateWorkflow(scope.workflowType, key);
  }
}

function assertValidAtomicStateKey(key: string): void {
  if (key.length === 0 || key.length > MAX_ATOMIC_STATE_KEY_LENGTH) {
    throw new Error(
      `AtomicState key must be 1-${String(MAX_ATOMIC_STATE_KEY_LENGTH)} characters long.`,
    );
  }

  if (RESERVED_ATOMIC_STATE_KEYS.has(key)) {
    throw new Error(`AtomicState key "${key}" is reserved.`);
  }
}

export function atomicStateVersionKey(dataKey: string): string {
  return `${dataKey}:version`;
}

export async function readAtomicStateSnapshot<T>(
  storage: Storage,
  dataKey: string,
  options?: Pick<AtomicStateOptions<T>, 'initial'>,
): Promise<AtomicStateSnapshot<T>> {
  const [rawValue, rawVersion] = await Promise.all([
    storage.get(dataKey),
    storage.get(atomicStateVersionKey(dataKey)),
  ]);

  const version = rawVersion ? decodeAtomicStateVersion(rawVersion, dataKey) : 0;

  if (rawValue !== null) {
    return { value: decode(rawValue) as T, version };
  }

  if (rawVersion === null && options && 'initial' in options) {
    return { value: cloneInitialValue(options.initial), version };
  }

  return { value: undefined, version };
}

export async function commitAtomicStateValue<T>(
  storage: Storage,
  dataKey: string,
  expectedVersion: number,
  value: T,
): Promise<AtomicStateCommitResult<T>> {
  requireStorageCapability(storage, 'conditionalBatch', 'AtomicState compare-and-swap');
  const nextVersion = expectedVersion + 1;
  const applied = await storageConditionalBatch(
    storage,
    [versionCondition(dataKey, expectedVersion)],
    [
      { type: 'put', key: dataKey, value: encode(value) },
      { type: 'put', key: atomicStateVersionKey(dataKey), value: encode(nextVersion) },
    ],
  );

  return { applied, value, version: applied ? nextVersion : expectedVersion };
}

export async function commitAtomicStateDelete(
  storage: Storage,
  dataKey: string,
  expectedVersion: number,
): Promise<AtomicStateCommitResult<never>> {
  requireStorageCapability(storage, 'conditionalBatch', 'AtomicState compare-and-swap');
  const nextVersion = expectedVersion + 1;
  const applied = await storageConditionalBatch(
    storage,
    [versionCondition(dataKey, expectedVersion)],
    [
      { type: 'delete', key: dataKey },
      { type: 'put', key: atomicStateVersionKey(dataKey), value: encode(nextVersion) },
    ],
  );

  return { applied, value: undefined, version: applied ? nextVersion : expectedVersion };
}

function versionCondition(dataKey: string, expectedVersion: number) {
  return {
    key: atomicStateVersionKey(dataKey),
    expectedValue: expectedVersion === 0 ? null : encode(expectedVersion),
  };
}

function decodeAtomicStateVersion(rawVersion: Uint8Array, dataKey: string): number {
  const decodedVersion = decode(rawVersion);
  if (
    typeof decodedVersion !== 'number' ||
    !Number.isInteger(decodedVersion) ||
    decodedVersion < 0
  ) {
    throw new Error(`AtomicState version for "${dataKey}" is corrupt.`);
  }
  return decodedVersion;
}

function cloneInitialValue<T>(value: T): T {
  return structuredClone(value);
}

function retryDelay(attempt: number): number {
  const exponential = Math.min(
    ATOMIC_STATE_MAX_DELAY_MS,
    ATOMIC_STATE_BASE_DELAY_MS * 2 ** attempt,
  );
  return Math.floor(Math.random() * exponential);
}

function dispatchAtomicStateEvent<T>(
  target: EventTarget,
  event: AtomicStateEvent<T>,
): AtomicStateEvent<T> {
  target.dispatchEvent(event);
  return event;
}

function notifyObserver<T>(observer: AtomicStateObserver<T>, event: AtomicStateEvent<T>): void {
  if (typeof observer === 'function') {
    observer(event);
    return;
  }

  observer.next?.(event);
}

/**
 * Storage-backed compare-and-swap state slot. `AtomicState` is scoped by the
 * storage key supplied to the constructor; use `engine.state.*` and
 * `ctx.state.*` for the built-in execution and workflow scopes.
 *
 * @example
 * ```ts
 * import { AtomicState } from '@lostgradient/weft';
 * import { MemoryStorage } from '@lostgradient/weft/storage/memory';
 *
 * const storage = new MemoryStorage();
 * const counter = new AtomicState<number>(storage, 'state:workflow-scope:default:count', { initial: 0 });
 * await counter.increment();
 * console.log(await counter.get()); // 1
 * ```
 */
export class AtomicState<T> extends EventTarget {
  readonly #storage: Storage;
  readonly #dataKey: string;
  readonly #stateKey: string;
  readonly #maxRetries: number;
  readonly #sleep: SleepFunction;
  readonly #options: Pick<AtomicStateOptions<T>, 'initial'> | undefined;

  constructor(storage: Storage, dataKey: string, options?: AtomicStateOptions<T>) {
    super();
    this.#storage = storage;
    this.#dataKey = dataKey;
    this.#stateKey = dataKey;
    this.#maxRetries = options?.maxRetries ?? 10;
    this.#sleep = options?.sleep ?? portableSleep;
    this.#options = options && 'initial' in options ? { initial: options.initial } : undefined;
  }

  /** Read the current value. */
  async get(): Promise<T | undefined> {
    const snapshot = await this.#read();
    return snapshot.value;
  }

  /** Update the state with optimistic concurrency and automatic retry. */
  async update(updater: (current: T | undefined) => T): Promise<T> {
    for (let attempt = 0; attempt < this.#maxRetries; attempt++) {
      const snapshot = await this.#read();
      const nextValue = updater(snapshot.value);
      const commit = await commitAtomicStateValue(
        this.#storage,
        this.#dataKey,
        snapshot.version,
        nextValue,
      );

      if (commit.applied) {
        dispatchAtomicStateEvent(
          this,
          new AtomicStateChangeEvent<T>(nextValue, snapshot.value, commit.version),
        );
        return nextValue;
      }

      dispatchAtomicStateEvent(this, new AtomicStateConflictEvent(this.#stateKey, attempt + 1));
      if (attempt < this.#maxRetries - 1) {
        await this.#sleep(retryDelay(attempt));
      }
    }

    dispatchAtomicStateEvent(this, new AtomicStateExhaustedEvent(this.#stateKey, this.#maxRetries));
    throw new AtomicStateConflictError(this.#stateKey, this.#maxRetries);
  }

  /** Replace the state value. */
  async set(value: T): Promise<T> {
    return this.update(() => value);
  }

  /**
   * Delete the state value while still advancing the version tombstone so
   * concurrent writers cannot silently overwrite a delete.
   */
  async delete(): Promise<void> {
    for (let attempt = 0; attempt < this.#maxRetries; attempt++) {
      const snapshot = await this.#read();
      const commit = await commitAtomicStateDelete(this.#storage, this.#dataKey, snapshot.version);

      if (commit.applied) {
        dispatchAtomicStateEvent(
          this,
          new AtomicStateChangeEvent<T>(undefined, snapshot.value, commit.version),
        );
        return;
      }

      dispatchAtomicStateEvent(this, new AtomicStateConflictEvent(this.#stateKey, attempt + 1));
      if (attempt < this.#maxRetries - 1) {
        await this.#sleep(retryDelay(attempt));
      }
    }

    dispatchAtomicStateEvent(this, new AtomicStateExhaustedEvent(this.#stateKey, this.#maxRetries));
    throw new AtomicStateConflictError(this.#stateKey, this.#maxRetries);
  }

  increment(this: AtomicState<number>, amount: number = 1): Promise<number> {
    return this.update((current) => (current ?? 0) + amount);
  }

  decrement(this: AtomicState<number>, amount: number = 1): Promise<number> {
    return this.update((current) => (current ?? 0) - amount);
  }

  merge<TObject extends Record<string, unknown>>(
    this: AtomicState<TObject>,
    patch: Partial<TObject>,
  ): Promise<TObject> {
    return this.update((current) => ({ ...(current ?? ({} as TObject)), ...patch }));
  }

  append<TItem>(this: AtomicState<TItem[]>, item: TItem): Promise<TItem[]> {
    return this.update((current) => [...(current ?? []), item]);
  }

  removeFirst<TItem>(this: AtomicState<TItem[]>): Promise<TItem | undefined> {
    let removed: TItem | undefined;
    return this.update((current) => {
      const next = [...(current ?? [])];
      removed = next.shift();
      return next;
    }).then(() => removed);
  }

  removeLast<TItem>(this: AtomicState<TItem[]>): Promise<TItem | undefined> {
    let removed: TItem | undefined;
    return this.update((current) => {
      const next = [...(current ?? [])];
      removed = next.pop();
      return next;
    }).then(() => removed);
  }

  [OBSERVABLE_SYMBOL](): {
    subscribe: (observer: AtomicStateObserver<T>) => AtomicStateSubscription;
  } {
    return {
      subscribe: (observer: AtomicStateObserver<T>) => {
        const listener = (event: Event): void => {
          notifyObserver(observer, event as AtomicStateEvent<T>);
        };
        this.addEventListener('change', listener);
        this.addEventListener('conflict', listener);
        this.addEventListener('exhausted', listener);
        return {
          unsubscribe: () => {
            this.removeEventListener('change', listener);
            this.removeEventListener('conflict', listener);
            this.removeEventListener('exhausted', listener);
          },
        };
      },
    };
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AtomicStateEvent<T>> {
    const queue: AtomicStateEvent<T>[] = [];
    let notify: (() => void) | undefined;
    const listener = (event: Event): void => {
      queue.push(event as AtomicStateEvent<T>);
      notify?.();
      notify = undefined;
    };

    this.addEventListener('change', listener);
    this.addEventListener('conflict', listener);
    this.addEventListener('exhausted', listener);

    try {
      while (true) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }
        const event = queue.shift();
        if (event) yield event;
      }
    } finally {
      this.removeEventListener('change', listener);
      this.removeEventListener('conflict', listener);
      this.removeEventListener('exhausted', listener);
    }
  }

  async #read(): Promise<AtomicStateSnapshot<T>> {
    return readAtomicStateSnapshot(this.#storage, this.#dataKey, this.#options);
  }
}

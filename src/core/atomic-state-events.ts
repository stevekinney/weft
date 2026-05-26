/**
 * Sleep function signature. Accepts a duration in milliseconds and returns
 * a promise that resolves after the delay. Injectable for tests.
 *
 * @example
 * ```ts
 * import type { SleepFunction } from 'weft';
 *
 * const sleep: SleepFunction = async (milliseconds) => {
 *   await Bun.sleep(milliseconds);
 * };
 * void sleep;
 * ```
 */
export type SleepFunction = (milliseconds: number) => Promise<void>;

/**
 * Options for a storage-backed {@link AtomicState} handle.
 *
 * @example
 * ```ts
 * import type { AtomicStateOptions } from 'weft';
 *
 * const options: AtomicStateOptions<number> = {
 *   initial: 0,
 *   maxRetries: 5,
 * };
 * ```
 */
export interface AtomicStateOptions<T = unknown> {
  /**
   * Value returned by `get()` before the slot has ever been written. Once a
   * write or delete creates a version tombstone, an absent value reads as
   * `undefined`.
   */
  initial?: T;
  /** Maximum number of CAS attempts before giving up. Defaults to 10. */
  maxRetries?: number;
  /**
   * Sleep function used between retry attempts. Defaults to portable `sleep`.
   * Injection point for tests that need to observe backoff without paying
   * real time costs.
   */
  sleep?: SleepFunction;
}

/**
 * Storage scope for a durable atomic state slot.
 *
 * @example
 * ```ts
 * import type { AtomicStateScope } from 'weft';
 *
 * const scope: AtomicStateScope = {
 *   type: 'workflow',
 *   workflowType: 'invoice',
 * };
 * ```
 */
export type AtomicStateScope =
  | { type: 'execution'; ownerWorkflowId: string }
  | { type: 'workflow'; workflowType: string };

/**
 * Point-in-time read result for an {@link AtomicState} slot.
 *
 * @example
 * ```ts
 * import type { AtomicStateSnapshot } from 'weft';
 *
 * const snapshot: AtomicStateSnapshot<number> = { value: 1, version: 2 };
 * console.log(snapshot.version);
 * ```
 */
export interface AtomicStateSnapshot<T = unknown> {
  value: T | undefined;
  version: number;
}

/**
 * Result returned by an atomic state commit attempt.
 *
 * @example
 * ```ts
 * import type { AtomicStateCommitResult } from 'weft';
 *
 * const result: AtomicStateCommitResult<string> = {
 *   applied: true,
 *   value: 'ready',
 *   version: 3,
 * };
 * console.log(result.applied);
 * ```
 */
export interface AtomicStateCommitResult<T = unknown> extends AtomicStateSnapshot<T> {
  applied: boolean;
}

/**
 * Local event emitted by an {@link AtomicState} handle.
 *
 * @example
 * ```ts
 * import { AtomicStateChangeEvent, type AtomicStateEvent } from 'weft';
 *
 * const event: AtomicStateEvent<number> = new AtomicStateChangeEvent(1, undefined, 1);
 * console.log(event.type);
 * ```
 */
export type AtomicStateEvent<T = unknown> =
  | AtomicStateChangeEvent<T>
  | AtomicStateConflictEvent
  | AtomicStateExhaustedEvent;

/**
 * Observer shape accepted by the {@link AtomicState} observable projection.
 *
 * @example
 * ```ts
 * import type { AtomicStateObserver } from 'weft';
 *
 * const observer: AtomicStateObserver<number> = {
 *   next(event) {
 *     console.log(event.type);
 *   },
 * };
 * ```
 */
export type AtomicStateObserver<T = unknown> =
  | ((event: AtomicStateEvent<T>) => void)
  | {
      next?: (event: AtomicStateEvent<T>) => void;
      error?: (error: unknown) => void;
      complete?: () => void;
    };

/**
 * Subscription returned by an {@link AtomicState} observable.
 *
 * @example
 * ```ts
 * import type { AtomicStateSubscription } from 'weft';
 *
 * const subscription: AtomicStateSubscription = {
 *   unsubscribe() {},
 * };
 * subscription.unsubscribe();
 * ```
 */
export interface AtomicStateSubscription {
  unsubscribe(): void;
}

declare global {
  interface SymbolConstructor {
    readonly observable: unique symbol;
  }
}

const symbolConstructor = Symbol as SymbolConstructor & { observable?: typeof Symbol.observable };
// The fallback becomes this runtime's `Symbol.observable` implementation when
// the platform does not provide one yet.
const fallbackObservableSymbol = Symbol.for('observable') as typeof Symbol.observable;
/**
 * Runtime symbol used by {@link AtomicState} to expose its observable
 * projection. This is `Symbol.observable` when the platform provides it and
 * `Symbol.for('observable')` otherwise.
 *
 * @example
 * ```ts
 * import { AtomicState, OBSERVABLE_SYMBOL } from 'weft';
 * import { MemoryStorage } from 'weft/storage/memory';
 *
 * const state = new AtomicState<number>(new MemoryStorage(), 'state:workflow-scope:default:count');
 * const observable = state[OBSERVABLE_SYMBOL]();
 * void observable;
 * ```
 */
export const OBSERVABLE_SYMBOL: typeof Symbol.observable =
  symbolConstructor.observable ?? fallbackObservableSymbol;

if (symbolConstructor.observable === undefined) {
  Object.defineProperty(Symbol, 'observable', {
    value: OBSERVABLE_SYMBOL,
    configurable: true,
  });
}

/**
 * Event emitted after an atomic state value changes.
 *
 * @example
 * ```ts
 * import { AtomicStateChangeEvent } from 'weft';
 *
 * const event = new AtomicStateChangeEvent('next', 'previous', 4);
 * console.log(event.value, event.previousValue, event.version);
 * ```
 */
export class AtomicStateChangeEvent<T> extends Event {
  readonly value: T | undefined;
  readonly previousValue: T | undefined;
  readonly version: number;

  constructor(value: T | undefined, previousValue: T | undefined, version: number) {
    super('change');
    this.value = value;
    this.previousValue = previousValue;
    this.version = version;
  }
}

/**
 * Event emitted when a CAS attempt observes a concurrent write.
 *
 * @example
 * ```ts
 * import { AtomicStateConflictEvent } from 'weft';
 *
 * const event = new AtomicStateConflictEvent('state:workflow-scope:default:count', 2);
 * console.log(event.stateKey, event.attempt);
 * ```
 */
export class AtomicStateConflictEvent extends Event {
  readonly stateKey: string;
  readonly attempt: number;

  constructor(stateKey: string, attempt: number) {
    super('conflict');
    this.stateKey = stateKey;
    this.attempt = attempt;
  }
}

/**
 * Event emitted when the CAS retry budget is exhausted.
 *
 * @example
 * ```ts
 * import { AtomicStateExhaustedEvent } from 'weft';
 *
 * const event = new AtomicStateExhaustedEvent('state:workflow-scope:default:count', 10);
 * console.log(event.stateKey, event.attempts);
 * ```
 */
export class AtomicStateExhaustedEvent extends Event {
  readonly stateKey: string;
  readonly attempts: number;

  constructor(stateKey: string, attempts: number) {
    super('exhausted');
    this.stateKey = stateKey;
    this.attempts = attempts;
  }
}

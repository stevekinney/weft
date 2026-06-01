/**
 * Type-safe activity mocking with call recording for testing.
 *
 * Provides an `ActivityMockRegistry` to register mock implementations
 * of activity functions, inspect call history, and configure per-call
 * overrides (one-shot return values, one-shot rejections).
 *
 * @module testing/mocks
 */

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/**
 * A single recorded call on a mock activity.
 *
 * @example
 * ```ts
 * import { TestEngine, type MockCall } from '@lostgradient/weft/testing';
 *
 * const engine = new TestEngine();
 * async function sendEmail(input: unknown): Promise<string> { return ''; }
 * const mockHandle = engine.mock(sendEmail, async (input: unknown) => 'sent');
 * await engine.start('notify', { to: 'user@example.com' });
 * const call: MockCall<unknown, string> = mockHandle.calls[0]!;
 * console.log(call.input); // { to: 'user@example.com' }
 * ```
 */
export interface MockCall<TInput, TResult> {
  readonly input: TInput;
  readonly result: TResult | undefined;
  readonly error: Error | undefined;
  readonly timestamp: number;
}

export type MockActivityFunction<TInput, TResult> = [TInput] extends [void]
  ? (input?: TInput) => TResult | Promise<TResult>
  : (input: TInput) => TResult | Promise<TResult>;

/**
 * Handle returned by {@link ActivityMockRegistry.mock} that lets tests inspect
 * call history and configure one-shot overrides.
 *
 * Call `mockReturnValueOnce` or `mockRejectionOnce` to inject a specific
 * outcome for the next invocation, then check `calls` to assert what arguments
 * were passed.  Use `restore()` to remove the mock and revert to the real
 * implementation.
 *
 * @example
 * ```ts
 * import { TestEngine, type MockHandle } from '@lostgradient/weft/testing';
 *
 * const engine = new TestEngine();
 * async function sendEmail(input: unknown): Promise<string> { return 'real'; }
 *
 * const handle: MockHandle<unknown, string> =
 *   engine.mock(sendEmail, async (input: unknown) => 'mocked');
 *
 * handle.mockReturnValueOnce('override');
 * console.log(handle.callCount); // 0
 * await engine.start('notify', { to: 'user@example.com' });
 * ```
 */
export interface MockHandle<TInput, TResult> {
  readonly calls: ReadonlyArray<MockCall<TInput, TResult>>;
  readonly callCount: number;
  readonly lastCall: MockCall<TInput, TResult> | undefined;
  /** The current base implementation (excludes one-time overrides). */
  readonly currentImplementation: MockActivityFunction<TInput, TResult>;
  mockImplementation(implementation: MockActivityFunction<TInput, TResult>): void;
  mockReturnValueOnce(value: TResult): MockHandle<TInput, TResult>;
  mockRejectionOnce(error: Error): MockHandle<TInput, TResult>;
  resetCalls(): void;
  restore(): void;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Internal record held by {@link ActivityMockRegistry} for each mocked
 * activity.
 *
 * Contains the current `implementation` function (which records calls and
 * applies one-time overrides) and the typed `handle` through which tests
 * inspect and configure the mock.  Most consumers interact with
 * {@link MockHandle} instead of `MockedActivity` directly.
 *
 * @example
 * ```ts
 * import { ActivityMockRegistry, type MockedActivity } from '@lostgradient/weft/testing';
 *
 * const registry = new ActivityMockRegistry();
 * async function fetchUser(id: unknown): Promise<string> { return String(id); }
 *
 * registry.mock(fetchUser, async (id: unknown) => 'user-mock');
 * const mocked: MockedActivity | undefined = registry.get(fetchUser);
 * console.log(typeof mocked?.implementation); // 'function'
 * ```
 */
export interface MockedActivity {
  implementation: (input?: unknown) => unknown;
  handle: MockHandle<unknown, unknown>;
}

type OneTimeOverride<TResult> =
  | { type: 'return'; value: TResult }
  | { type: 'reject'; error: Error };

// ---------------------------------------------------------------------------
// MockHandle implementation
// ---------------------------------------------------------------------------

class MockHandleImplementation<TInput, TResult> implements MockHandle<TInput, TResult> {
  #calls: Array<MockCall<TInput, TResult>> = [];
  #baseImplementation: MockActivityFunction<TInput, TResult>;
  #oneTimeOverrides: Array<OneTimeOverride<TResult>> = [];
  readonly #onRestore: () => void;

  constructor(baseImplementation: MockActivityFunction<TInput, TResult>, onRestore: () => void) {
    this.#baseImplementation = baseImplementation;
    this.#onRestore = onRestore;
  }

  get calls(): ReadonlyArray<MockCall<TInput, TResult>> {
    return this.#calls;
  }

  get callCount(): number {
    return this.#calls.length;
  }

  get lastCall(): MockCall<TInput, TResult> | undefined {
    return this.#calls[this.#calls.length - 1];
  }

  get currentImplementation(): MockActivityFunction<TInput, TResult> {
    return this.#baseImplementation;
  }

  mockImplementation(implementation: MockActivityFunction<TInput, TResult>): void {
    this.#baseImplementation = implementation;
  }

  mockReturnValueOnce(value: TResult): MockHandle<TInput, TResult> {
    this.#oneTimeOverrides.push({ type: 'return', value });
    return this;
  }

  mockRejectionOnce(error: Error): MockHandle<TInput, TResult> {
    this.#oneTimeOverrides.push({ type: 'reject', error });
    return this;
  }

  resetCalls(): void {
    this.#calls = [];
  }

  restore(): void {
    this.#onRestore();
  }

  /** Called internally to execute the mock and record the call. */
  async execute(input?: TInput): Promise<TResult> {
    const override = this.#oneTimeOverrides.shift();
    const recordedInput = input as TInput;

    if (override?.type === 'reject') {
      const call: MockCall<TInput, TResult> = {
        input: recordedInput,
        result: undefined,
        error: override.error,
        timestamp: Date.now(),
      };
      this.#calls.push(call);
      throw override.error;
    }

    if (override?.type === 'return') {
      const call: MockCall<TInput, TResult> = {
        input: recordedInput,
        result: override.value,
        error: undefined,
        timestamp: Date.now(),
      };
      this.#calls.push(call);
      return override.value;
    }

    try {
      const result = await this.#baseImplementation(recordedInput);
      const call: MockCall<TInput, TResult> = {
        input: recordedInput,
        result,
        error: undefined,
        timestamp: Date.now(),
      };
      this.#calls.push(call);
      return result;
    } catch (thrown) {
      const error = thrown instanceof Error ? thrown : new Error(String(thrown));
      const call: MockCall<TInput, TResult> = {
        input: recordedInput,
        result: undefined,
        error,
        timestamp: Date.now(),
      };
      this.#calls.push(call);
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// ActivityMockRegistry
// ---------------------------------------------------------------------------

/**
 * Registry for mocking activity functions in tests.
 *
 * Call `mock(activityFn, implementation)` to replace an activity with a test
 * double and receive a {@link MockHandle} for inspection and configuration.
 * Use `restoreAll()` in `afterEach` to clear all mocks between test cases.
 *
 * @example
 * ```ts
 * import { ActivityMockRegistry } from '@lostgradient/weft/testing';
 *
 * async function sendEmail(input: unknown): Promise<string> { return 'sent'; }
 *
 * const registry = new ActivityMockRegistry();
 * const handle = registry.mock(sendEmail, async (input: unknown) => 'mock-sent');
 *
 * console.log(registry.has(sendEmail)); // true
 * await (registry.get(sendEmail)!.implementation)({ to: 'a@b.com' });
 * console.log(handle.callCount); // 1
 * registry.restoreAll();
 * ```
 */
export class ActivityMockRegistry {
  #mocks: Map<Function, MockedActivity>;
  #cleanupHooks: Map<Function, () => void>;

  constructor() {
    this.#mocks = new Map();
    this.#cleanupHooks = new Map();
  }

  /**
   * Register a cleanup callback to run when `restore(activity)` or
   * `restoreAll()` removes the mock for `activity`. Used by {@link TestEngine}
   * to undo the surrogate activity registration it installs on the engine, so
   * `restoreAll()` does not leave stale registrations behind. The callback runs
   * at most once per registration and is then discarded.
   *
   * If a cleanup hook is already registered for `activity` (for example, when
   * the same activity is mocked twice without an intervening `restore()`), the
   * existing hook is kept and the new one is ignored. This preserves the
   * original-registration snapshot captured by the first mock, so re-mocking
   * never overwrites the restorer with one that points at a surrogate.
   */
  onRestore(activity: Function, cleanup: () => void): void {
    if (this.#cleanupHooks.has(activity)) return;
    this.#cleanupHooks.set(activity, cleanup);
  }

  /** Whether a cleanup hook is currently registered for `activity`. */
  hasRestoreHook(activity: Function): boolean {
    return this.#cleanupHooks.has(activity);
  }

  #runCleanupHook(activity: Function): void {
    const cleanup = this.#cleanupHooks.get(activity);
    if (!cleanup) return;
    this.#cleanupHooks.delete(activity);
    cleanup();
  }

  #runAllCleanupHooks(): void {
    const cleanups = Array.from(this.#cleanupHooks.values());
    this.#cleanupHooks.clear();
    for (const cleanup of cleanups) cleanup();
  }

  mock<TResult>(
    activity: () => Promise<TResult> | TResult,
    implementation: () => TResult | Promise<TResult>,
  ): MockHandle<void, TResult>;
  mock<TInput, TResult>(
    activity: (input: TInput) => Promise<TResult> | TResult,
    implementation: (input: TInput) => TResult | Promise<TResult>,
  ): MockHandle<TInput, TResult>;
  mock<TInput, TResult>(
    activity: (() => Promise<TResult> | TResult) | ((input: TInput) => Promise<TResult> | TResult),
    implementation: MockActivityFunction<TInput, TResult>,
  ): MockHandle<TInput, TResult> {
    const handle = new MockHandleImplementation<TInput, TResult>(
      implementation,
      this.restore.bind(this, activity),
    );

    const mocked: MockedActivity = {
      implementation: handle.execute.bind(handle) as (input?: unknown) => unknown,
      handle: handle as unknown as MockHandle<unknown, unknown>,
    };

    this.#mocks.set(activity, mocked);
    return handle;
  }

  has(activity: Function): boolean {
    return this.#mocks.has(activity);
  }

  get(activity: Function): MockedActivity | undefined {
    return this.#mocks.get(activity);
  }

  restore(activity: Function): void {
    this.#mocks.delete(activity);
    this.#runCleanupHook(activity);
  }

  restoreAll(): void {
    this.#mocks.clear();
    this.#runAllCleanupHooks();
  }

  /**
   * Iterate all registered mock entries as `[activityFn, MockedActivity]` pairs.
   * Used internally by `TestEngine.runN` to propagate mocks to per-run engines.
   */
  entries(): IterableIterator<[Function, MockedActivity]> {
    return this.#mocks.entries();
  }
}

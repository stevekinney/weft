/**
 * Test-oriented Engine subclass with virtual time control and activity mocking.
 *
 * Wraps Engine with a MemoryStorage, TimeControl, and ActivityMockRegistry
 * so tests can advance time deterministically and substitute activity
 * implementations without touching real infrastructure.
 *
 * @module testing/test-engine
 */

import { Engine } from '../core/engine.ts';
import { runtimeWorkflowEngine } from '../core/runtime-workflow-engine.ts';
import { parseDuration } from '../core/scheduler.ts';
import type { Duration } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import type { ChaosScenario, FailureCategory } from './chaos.ts';
import { withChaos } from './chaos.ts';
import { yieldToPortableEventLoop } from './event-loop.ts';
import type { MockActivityFunction, MockHandle } from './mocks.ts';
import { ActivityMockRegistry } from './mocks.ts';
import { TimeControl } from './time-control.ts';

// ---------------------------------------------------------------------------
// runN types
// ---------------------------------------------------------------------------

/**
 * Options for {@link TestEngine.runN}.
 *
 * @example
 * ```ts
 * import { TestEngine, type RunNOptions } from 'weft/testing';
 *
 * const options: RunNOptions = {
 *   runs: 50,
 *   chaos: { faultRate: 0.2, faults: ['transient'], seed: 7 },
 * };
 * const engine = new TestEngine();
 * // const result = await engine.runN('my-workflow', {}, options);
 * ```
 */
export interface RunNOptions {
  /** Number of independent runs to execute. */
  runs: number;
  /** Optional chaos scenario to apply across all runs. */
  chaos?: ChaosScenario;
}

/**
 * Aggregate reliability metrics returned by {@link TestEngine.runN}.
 *
 * @example
 * ```ts
 * import { TestEngine, type RunNResult } from 'weft/testing';
 *
 * const engine = new TestEngine();
 * engine.register('ping', async function* () { return 'pong'; });
 * const result: RunNResult = await engine.runN('ping', null, { runs: 10 });
 * console.log(result.passRate);    // 1 (all passed)
 * console.log(result.consistency); // 1 (all identical)
 * ```
 */
export interface RunNResult {
  /** Fraction of runs [0, 1] that completed successfully. */
  passRate: number;
  /**
   * Fraction of successful runs [0, 1] that returned the same output as the
   * first successful run. `1.0` means all successes were identical.
   * `NaN` if there were no successful runs.
   */
  consistency: number;
  /** Count of failures bucketed by failure category. */
  categories: Record<FailureCategory, number>;
}

// ---------------------------------------------------------------------------
// TestEngine
// ---------------------------------------------------------------------------

/**
 * Test-oriented {@link Engine} subclass with virtual time control and
 * activity mocking for deterministic, fast workflow tests.
 *
 * Wraps the engine with a {@link MemoryStorage}, a {@link TimeControl}
 * instance, and an {@link ActivityMockRegistry}.  Use `engine.mock(activityFn,
 * impl)` to replace real activities with stubs, and
 * `await engine.advanceTime('5m')` to advance virtual time without waiting on
 * real timers.
 *
 * @example
 * ```ts
 * import type { WorkflowContext } from 'weft';
 * import { TestEngine } from 'weft/testing';
 *
 * const engine = new TestEngine();
 *
 * async function fetchPrice(ticker: unknown): Promise<number> {
 *   return 0; // real implementation
 * }
 *
 * const mock = engine.mock(fetchPrice, async (_ticker: unknown) => 42);
 * engine.register('price-check', async function* (ctx: WorkflowContext, input: unknown) {
 *   return 42; // simplified test example
 * });
 *
 * const handle = await engine.start('price-check', 'ACME');
 * console.log(await handle.result()); // 42
 * console.log(mock.callCount); // 0
 * ```
 */
export class TestEngine extends Engine {
  #timeControl: TimeControl;
  #mocks: ActivityMockRegistry;
  #memoryStorage: MemoryStorage;

  constructor(options?: { startTime?: number }) {
    const storage = new MemoryStorage();
    const timeControl = new TimeControl(options?.startTime);

    super({
      storage,
      getNow: () => timeControl.now,
    });

    this.#timeControl = timeControl;
    this.#mocks = new ActivityMockRegistry();
    this.#memoryStorage = storage;
  }

  // ---------------------------------------------------------------------------
  // Time control
  // ---------------------------------------------------------------------------

  /**
   * Advance virtual time by the given duration. Fires any scheduler
   * timers that fall within the advanced window.
   */
  async advanceTime(duration: Duration): Promise<void> {
    const milliseconds = parseDuration(duration);
    const target = this.#timeControl.now + milliseconds;

    // Advance time control (fires TimeControl timers)
    await this.#timeControl.advance(duration);

    // Inline starts can be intentionally queued onto the next event-loop turn.
    // Let them schedule durable timers at the advanced virtual time before
    // the scheduler scans for due timers.
    await yieldToPortableEventLoop();

    // The queued inline start async chain (MessageChannel delivery →
    // loadWorkflowState → persistCheckpoint → evaluateConstraints →
    // parkInlineWorkflowAfterCheckpoint → processSleepOperation →
    // scheduler.schedule) is ~5 microtask hops deep. Drain enough turns
    // so the timer is in storage before scheduler.tick scans for due timers.
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
    }

    // Tick the scheduler at the new time to fire durable timers
    await this.scheduler.tick(target);

    // Allow microtasks to settle without spending wall-clock time.
    for (let i = 0; i < 3; i++) {
      await Promise.resolve();
    }

    // Some workflow continuations are queued onto the next event-loop turn.
    // Yield a few turns without using Bun.sleep so virtual-time tests still
    // avoid wall-clock sleeps while letting those continuations run.
    for (let i = 0; i < 3; i++) {
      await yieldToPortableEventLoop();
    }
  }

  /** Current virtual time in milliseconds since epoch. */
  get now(): number {
    return this.#timeControl.now;
  }

  // ---------------------------------------------------------------------------
  // Mocking
  // ---------------------------------------------------------------------------

  /**
   * Register a mock implementation for an activity function.
   * When the engine encounters this activity, it will call the mock instead.
   */
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
    return this.#mocks.mock(activity, implementation);
  }

  // ---------------------------------------------------------------------------
  // Recovery
  // ---------------------------------------------------------------------------

  /**
   * Create a new TestEngine backed by the same storage, simulating
   * engine recovery (like a process restart). The new engine sees all
   * persisted state but has fresh in-memory structures.
   */
  recover(): TestEngine {
    // We cannot directly share a MemoryStorage instance via the constructor
    // because the constructor always creates a new one. Instead we return
    // a plain Engine configured with the same storage and timeControl.
    // This is a simplified recovery for the testing layer.
    const recovered = new TestEngine({ startTime: this.#timeControl.now });
    // Copy storage contents from the current engine to the recovered one
    const snapshot = this.#memoryStorage.snapshot();
    for (const [key, value] of snapshot) {
      // We need to write synchronously-ish. Since MemoryStorage is sync
      // under the hood, we just fire-and-forget the put calls.
      void recovered.#memoryStorage.put(key, value);
    }
    return recovered;
  }

  // ---------------------------------------------------------------------------
  // Storage / mock accessors
  // ---------------------------------------------------------------------------

  /** Direct access to the underlying MemoryStorage for assertions. */
  override get storage(): MemoryStorage {
    return this.#memoryStorage;
  }

  /** Direct access to mock registry. */
  get mocks(): ActivityMockRegistry {
    return this.#mocks;
  }

  // ---------------------------------------------------------------------------
  // runN
  // ---------------------------------------------------------------------------

  /**
   * Run the named workflow N times and return aggregate reliability metrics.
   *
   * Runs are serial and independent. If a `chaos` scenario is provided, each
   * registered activity mock is temporarily wrapped with `withChaos` for the
   * duration of that run, then restored. This ensures that the workflow
   * functions — which close over `this` engine's mock registry — observe the
   * chaos-injected implementations during each run.
   *
   * Workflow state isolation is achieved by using unique per-run workflow IDs,
   * so previous results do not influence subsequent runs.
   *
   * @param type    The registered workflow type name.
   * @param input   Input passed to each run.
   * @param options `{ runs, chaos? }` — number of runs and optional scenario.
   * @returns       `{ passRate, consistency, categories }` aggregate metrics.
   */
  async runN(type: string, input: unknown, options: RunNOptions): Promise<RunNResult> {
    const { runs, chaos } = options;

    let passes = 0;
    const successOutputs: unknown[] = [];
    const categories: Record<FailureCategory, number> = {
      application: 0,
      timeout: 0,
      cancellation: 0,
      resource: 0,
      system: 0,
    };

    for (let i = 0; i < runs; i++) {
      const saved = wrapMocksWithChaos(this.#mocks, chaos, i);

      // Use a unique ID per run to keep workflow state isolated.
      const runId = `runN-${type}-${i}-${Date.now()}`;

      try {
        const handle = await runtimeWorkflowEngine(this).start(type, input, { id: runId });
        const output = await handle.result();
        passes++;
        successOutputs.push(output);
      } catch {
        const state = await this.get(runId);
        const category = state?.failureCategory ?? 'system';
        categories[category]++;
      } finally {
        restoreMocks(this.#mocks, saved);
      }
    }

    const passRate = runs > 0 ? passes / runs : 0;
    const consistency = computeConsistency(successOutputs);

    return { passRate, consistency, categories };
  }
}

// ---------------------------------------------------------------------------
// runN helpers (module-private)
// ---------------------------------------------------------------------------

/**
 * Wrap every mock in `registry` with a chaos-injecting shim for a single run.
 *
 * Returns a save-map of the original base implementations keyed by activity
 * function reference. The caller must pass this map to {@link restoreMocks}
 * in the run's `finally` block.
 *
 * When `chaos` is `undefined` no wrapping occurs and an empty map is returned,
 * so the caller's `finally` block is unconditionally safe.
 *
 * The per-run seed offset ensures each run receives a distinct fault sequence.
 * Reusing the same seed for every run would produce identical fault patterns
 * and collapse `passRate` to either 0 or 1, hiding real reliability variance.
 */
function wrapMocksWithChaos(
  registry: ActivityMockRegistry,
  chaos: ChaosScenario | undefined,
  runIndex: number,
): Map<Function, MockActivityFunction<unknown, unknown>> {
  const saved = new Map<Function, MockActivityFunction<unknown, unknown>>();

  if (!chaos) return saved;

  for (const [activity, mocked] of registry.entries()) {
    const original = mocked.handle.currentImplementation;
    saved.set(activity, original);

    // Derive a per-run seed so each run gets a different fault sequence.
    const perRunChaos = chaos.seed !== undefined ? { ...chaos, seed: chaos.seed + runIndex } : chaos;

    const chaosWrapped = withChaos(
      (activityInput: unknown) => original(activityInput),
      perRunChaos,
    );

    mocked.handle.mockImplementation((activityInput: unknown) => chaosWrapped(activityInput));
  }

  return saved;
}

/**
 * Restore every mock in `registry` to its saved base implementation.
 *
 * Entries absent from `saved` (because no chaos was active) are left
 * untouched. This is always safe to call even when `saved` is empty.
 */
function restoreMocks(
  registry: ActivityMockRegistry,
  saved: Map<Function, MockActivityFunction<unknown, unknown>>,
): void {
  for (const [activity, mocked] of registry.entries()) {
    const original = saved.get(activity);
    if (original !== undefined) {
      mocked.handle.mockImplementation(original);
    }
  }
}

/**
 * Compute the consistency score for a list of successful run outputs.
 *
 * Returns the fraction of outputs that are JSON-equal to the first output.
 * Returns `NaN` when `outputs` is empty (no successful runs).
 */
function computeConsistency(outputs: unknown[]): number {
  if (outputs.length === 0) return NaN;

  const firstOutput = JSON.stringify(outputs[0]);
  const identicalCount = outputs.filter((out) => JSON.stringify(out) === firstOutput).length;
  return identicalCount / outputs.length;
}

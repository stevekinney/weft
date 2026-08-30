/**
 * Chaos testing primitives for weft workflows.
 *
 * Provides `ChaosScenario` — a type describing fault probability distributions
 * per fault class — and `withChaos(mock, scenario)` — a combinator that wraps
 * any activity mock function with fault injection controlled by the scenario.
 *
 * @module testing/chaos
 */

import { timeoutFailureCategoryMarker } from '../core/failure-categories.ts';
import { sleep } from '../runtime/portable.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// FailureCategory is part of the testing/chaos type surface because chaos
// scenarios and summaries are grouped by the same execution taxonomy.
export type { FailureCategory } from '../core/types.ts';

/**
 * Fault classes that chaos injection can produce.
 *
 * @example
 * ```ts
 * import { withChaos, type FaultClass } from '@lostgradient/weft/testing';
 *
 * const faults: FaultClass[] = ['transient', 'error'];
 * const noisy = withChaos(
 *   async (x: number) => x * 2,
 *   { faultRate: 0.3, faults },
 * );
 * ```
 */
export type FaultClass = 'transient' | 'timeout' | 'error' | 'delay';

/**
 * Describes fault probability distributions for a chaos test run.
 *
 * Attach a `ChaosScenario` to `TestEngine.runN` options or pass it directly
 * to `withChaos` to control how and how often faults are injected.
 *
 * @example
 * ```ts
 * import { withChaos, type ChaosScenario } from '@lostgradient/weft/testing';
 *
 * const scenario: ChaosScenario = {
 *   faultRate: 0.2,
 *   faults: ['transient', 'delay'],
 *   seed: 42,
 * };
 * const noisyMock = withChaos(async (input: string) => input.toUpperCase(), scenario);
 * ```
 */
export interface ChaosScenario {
  /**
   * Probability [0, 1] that any given activity call will have a fault injected.
   * `0` means never inject; `1` means always inject.
   */
  faultRate: number;

  /**
   * Which fault classes to enable. If omitted, defaults to all classes.
   * When a fault fires, one class is chosen uniformly at random from this list.
   */
  faults?: FaultClass[];

  /**
   * Optional integer seed for a deterministic pseudo-random number generator.
   * When provided, two `withChaos` wrappers created from the same scenario
   * will produce identical fault patterns over the same number of calls.
   */
  seed?: number;
}

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32 — simple, fast, seedable)
// ---------------------------------------------------------------------------

function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return function next(): number {
    s += 0x6d2b79f5;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Fault error classes
// ---------------------------------------------------------------------------

/**
 * Transient chaos fault. Represents a retryable failure — the kind of error an
 * engine retry policy should re-attempt. Carries `retryable = true` so consumers
 * inspecting the error can make an informed retry decision without parsing
 * error messages.
 *
 * @example
 * ```ts
 * import { ChaosTransientError } from '@lostgradient/weft/testing';
 *
 * const err = new ChaosTransientError();
 * console.log(err.retryable); // true
 * console.log(err.name);      // 'ChaosTransientError'
 * ```
 */
export class ChaosTransientError extends Error {
  /** Discriminator for retry-policy consumers. Always `true` for this class. */
  readonly retryable = true as const;

  constructor(message = '[chaos] transient fault injected') {
    super(message);
    this.name = 'ChaosTransientError';
  }
}

/**
 * Non-retryable chaos fault. Represents a permanent failure — the kind of
 * error a retry policy should surface immediately without further attempts.
 * Carries `retryable = false` and a `.name` suitable for inclusion in a
 * {@link RetryPolicy.nonRetryableErrors} list.
 *
 * @example
 * ```ts
 * import { ChaosNonRetryableError } from '@lostgradient/weft/testing';
 *
 * const err = new ChaosNonRetryableError();
 * console.log(err.retryable); // false
 * console.log(err.name);      // 'ChaosNonRetryableError'
 * ```
 */
export class ChaosNonRetryableError extends Error {
  /** Discriminator for retry-policy consumers. Always `false` for this class. */
  readonly retryable = false as const;

  constructor(message = '[chaos] non-retryable fault injected') {
    super(message);
    this.name = 'ChaosNonRetryableError';
  }
}

/**
 * Timeout chaos fault. Thrown when the simulated activity runs long enough for
 * an `AbortSignal.timeout()` to fire. Unlike the other fault classes this is
 * emitted after the injected timeout actually elapses, so calling code
 * exercises the same async/abort shape it would see from a real slow dependency.
 *
 * @example
 * ```ts
 * import { ChaosTimeoutError } from '@lostgradient/weft/testing';
 *
 * const err = new ChaosTimeoutError(25);
 * console.log(err.timeoutMilliseconds); // 25
 * console.log(err.name);               // 'ChaosTimeoutError'
 * ```
 */
export class ChaosTimeoutError extends Error {
  /** Milliseconds the chaos wrapper waited before raising the timeout. */
  readonly timeoutMilliseconds: number;
  readonly [timeoutFailureCategoryMarker] = true;

  constructor(timeoutMilliseconds: number) {
    super(`[chaos] timeout fault fired after ${timeoutMilliseconds}ms`);
    this.name = 'ChaosTimeoutError';
    this.timeoutMilliseconds = timeoutMilliseconds;
  }
}

// ---------------------------------------------------------------------------
// withChaos combinator
// ---------------------------------------------------------------------------

/** Delay added when a 'delay' fault fires (milliseconds). */
const DELAY_FAULT_MS = 50;

/** Duration an injected 'timeout' fault waits before the AbortSignal fires. */
const TIMEOUT_FAULT_MS = 25;

/**
 * Wait for an `AbortSignal.timeout()` to fire, then throw a
 * {@link ChaosTimeoutError}. Modeled as a promise that never resolves on its
 * own — the abort is the only exit path — so callers with their own abort
 * signals still experience a genuine "hung then aborted" shape.
 */
async function raiseTimeoutFault(timeoutMilliseconds: number): Promise<never> {
  const signal = AbortSignal.timeout(timeoutMilliseconds);
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new ChaosTimeoutError(timeoutMilliseconds));
      return;
    }
    signal.addEventListener('abort', () => reject(new ChaosTimeoutError(timeoutMilliseconds)), {
      once: true,
    });
  });
}

/**
 * Wraps an activity mock function with fault injection driven by `scenario`.
 *
 * On each call the combinator consults the PRNG (seeded or `Math.random`) to
 * decide whether to inject a fault. If yes, it picks a fault class and produces
 * a behavior that is observably distinct from every other class:
 *
 * - `'transient'` throws {@link ChaosTransientError} (retryable).
 * - `'error'` throws {@link ChaosNonRetryableError} (non-retryable).
 * - `'timeout'` waits for an `AbortSignal.timeout()` to fire, then throws
 *   {@link ChaosTimeoutError}. This actually occupies the async timeline so
 *   that engine timeout-handling paths can run.
 * - `'delay'` calls the underlying mock after a short sleep.
 *
 * If no fault fires the underlying `mock` is called normally.
 *
 * @param mock     The activity mock implementation to wrap.
 * @param scenario The `ChaosScenario` controlling fault injection.
 * @returns        A new function with the same signature that may throw.
 *
 * @example
 * ```ts
 * import { TestEngine, withChaos } from '@lostgradient/weft/testing';
 *
 * const noisySendEmail = withChaos(
 *   async (input: unknown) => ({ sent: true }),
 *   { faultRate: 0.3, faults: ['transient'], seed: 1 },
 * );
 * const realSendEmail = async (i: unknown) => ({ sent: true });
 * const engine = new TestEngine();
 * engine.mock(realSendEmail, noisySendEmail);
 * ```
 */
export function withChaos<TInput, TOutput>(
  mock: (input: TInput) => Promise<TOutput> | TOutput,
  scenario: ChaosScenario,
): (input: TInput) => Promise<TOutput> {
  const random = scenario.seed !== undefined ? makePrng(scenario.seed) : () => Math.random();

  const enabledFaults: FaultClass[] =
    scenario.faults && scenario.faults.length > 0
      ? scenario.faults
      : ['transient', 'timeout', 'error', 'delay'];

  return async function chaosWrapped(input: TInput): Promise<TOutput> {
    const roll = random();

    if (roll < scenario.faultRate) {
      const faultClass = enabledFaults[Math.floor(random() * enabledFaults.length)]!;

      switch (faultClass) {
        case 'transient':
          throw new ChaosTransientError();

        case 'timeout':
          return raiseTimeoutFault(TIMEOUT_FAULT_MS);

        case 'error':
          throw new ChaosNonRetryableError();

        case 'delay':
          await sleep(DELAY_FAULT_MS);
          return mock(input);
      }
    }

    return mock(input);
  };
}

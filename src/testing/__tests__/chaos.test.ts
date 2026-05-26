/**
 * Tests for chaos testing primitives: ChaosScenario, withChaos, TestEngine.runN.
 *
 * @module testing/__tests__/chaos.test
 */

import { describe, expect, it } from 'bun:test';

import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types/workflow-function.ts';
import type { ChaosScenario, FailureCategory } from '../chaos.ts';
import {
  ChaosNonRetryableError,
  ChaosTimeoutError,
  ChaosTransientError,
  withChaos,
} from '../chaos.ts';
import type { RunNResult } from '../test-engine.ts';
import { TestEngine } from '../test-engine.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_FAILURE_CATEGORIES: FailureCategory[] = [
  'application',
  'timeout',
  'cancellation',
  'resource',
  'system',
];

function hasCorrectCategoriesShape(categories: Record<FailureCategory, number>): boolean {
  return ALL_FAILURE_CATEGORIES.every(
    (category) => category in categories && typeof categories[category] === 'number',
  );
}

// ---------------------------------------------------------------------------
// withChaos combinator
// ---------------------------------------------------------------------------

describe('withChaos', () => {
  it('passes through when faultRate is 0', async () => {
    const base = async (x: number) => x * 2;
    const scenario: ChaosScenario = { faultRate: 0 };
    const wrapped = withChaos(base, scenario);

    const result = await wrapped(5);
    expect(result).toBe(10);
  });

  it('always throws when faultRate is 1', async () => {
    const base = async (x: number) => x * 2;
    const scenario: ChaosScenario = { faultRate: 1, faults: ['error'] };
    const wrapped = withChaos(base, scenario);

    await expect(wrapped(5)).rejects.toThrow();
  });

  it('injects faults probabilistically', async () => {
    const base = async (_input: undefined) => 'ok';
    const scenario: ChaosScenario = { faultRate: 0.5, faults: ['error'] };
    const wrapped = withChaos(base, scenario);

    let failures = 0;
    const attempts = 100;
    for (let i = 0; i < attempts; i++) {
      try {
        await wrapped(undefined);
      } catch {
        failures++;
      }
    }

    // With faultRate=0.5 and 100 tries, statistically we expect 10-90 failures
    expect(failures).toBeGreaterThan(5);
    expect(failures).toBeLessThan(95);
  });

  it('injects delay fault', async () => {
    const base = async (_input: undefined) => 'ok';
    const scenario: ChaosScenario = { faultRate: 1, faults: ['delay'] };
    const wrapped = withChaos(base, scenario);

    const start = Date.now();
    await wrapped(undefined);
    const elapsed = Date.now() - start;

    // Delay fault must actually delay — DELAY_FAULT_MS in chaos.ts is 50ms.
    // Assert a substantial floor (not a trivially-true ≥0) so a broken no-delay
    // implementation still fails, but allow a small tolerance below the nominal 50ms:
    // `setTimeout` timers can fire a hair early and `Date.now()` can undershoot from
    // coarse resolution, so a real 50ms sleep occasionally measures ~48ms under load.
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  // -------------------------------------------------------------------------
  // Distinct fault class behaviors
  // -------------------------------------------------------------------------

  it("fault class 'transient' throws a retryable ChaosTransientError", async () => {
    const base = async (_input: undefined) => 'ok';
    const wrapped = withChaos(base, { faultRate: 1, faults: ['transient'] });

    let caught: unknown;
    try {
      await wrapped(undefined);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ChaosTransientError);
    expect(caught).toBeInstanceOf(Error);
    // Discriminates from ChaosNonRetryableError and ChaosTimeoutError
    expect(caught).not.toBeInstanceOf(ChaosNonRetryableError);
    expect(caught).not.toBeInstanceOf(ChaosTimeoutError);
    expect((caught as ChaosTransientError).name).toBe('ChaosTransientError');
    expect((caught as ChaosTransientError).retryable).toBe(true);
  });

  it("fault class 'error' throws a non-retryable ChaosNonRetryableError", async () => {
    const base = async (_input: undefined) => 'ok';
    const wrapped = withChaos(base, { faultRate: 1, faults: ['error'] });

    let caught: unknown;
    try {
      await wrapped(undefined);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ChaosNonRetryableError);
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(ChaosTransientError);
    expect(caught).not.toBeInstanceOf(ChaosTimeoutError);
    expect((caught as ChaosNonRetryableError).name).toBe('ChaosNonRetryableError');
    expect((caught as ChaosNonRetryableError).retryable).toBe(false);
  });

  it("fault class 'timeout' waits for AbortSignal.timeout() then throws ChaosTimeoutError", async () => {
    const base = async (_input: undefined) => 'ok';
    const wrapped = withChaos(base, { faultRate: 1, faults: ['timeout'] });

    const start = Date.now();
    let caught: unknown;
    try {
      await wrapped(undefined);
    } catch (error) {
      caught = error;
    }
    const elapsed = Date.now() - start;

    expect(caught).toBeInstanceOf(ChaosTimeoutError);
    expect(caught).not.toBeInstanceOf(ChaosTransientError);
    expect(caught).not.toBeInstanceOf(ChaosNonRetryableError);
    expect((caught as ChaosTimeoutError).name).toBe('ChaosTimeoutError');
    // The timeout fault must actually wait for the abort signal to fire —
    // a synchronous throw would return in ~0ms. TIMEOUT_FAULT_MS is 25ms;
    // assert a lower bound well below that to avoid timer-coalescing flakes
    // on slow CI while still falsifying the sync-throw regression.
    expect(elapsed).toBeGreaterThanOrEqual(5);
    expect((caught as ChaosTimeoutError).timeoutMilliseconds).toBeGreaterThan(0);
  });

  it('three fault classes are observably distinct — each produces its own error subclass', async () => {
    const base = async (_input: undefined) => 'ok';

    const transientWrapped = withChaos(base, { faultRate: 1, faults: ['transient'] });
    const errorWrapped = withChaos(base, { faultRate: 1, faults: ['error'] });
    const timeoutWrapped = withChaos(base, { faultRate: 1, faults: ['timeout'] });

    const errors: unknown[] = [];
    for (const fn of [transientWrapped, errorWrapped, timeoutWrapped]) {
      try {
        await fn(undefined);
      } catch (error) {
        errors.push(error);
      }
    }

    expect(errors).toHaveLength(3);
    const [transientErr, nonRetryableErr, timeoutErr] = errors;
    expect(transientErr).toBeInstanceOf(ChaosTransientError);
    expect(nonRetryableErr).toBeInstanceOf(ChaosNonRetryableError);
    expect(timeoutErr).toBeInstanceOf(ChaosTimeoutError);

    // All three names are distinct — confirms the bug fix where they
    // previously all threw plain `Error` and were indistinguishable.
    const names = new Set(errors.map((error) => (error as Error).name));
    expect(names.size).toBe(3);
  });

  it('uses seed for deterministic behavior', async () => {
    const base = async (_input: undefined) => 'ok';
    const scenario: ChaosScenario = { faultRate: 0.5, faults: ['error'], seed: 42 };

    // Two wrapped functions with the same seed should produce the same fault pattern
    const wrapped1 = withChaos(base, scenario);
    const wrapped2 = withChaos(base, scenario);

    const results1: boolean[] = [];
    const results2: boolean[] = [];

    for (let i = 0; i < 20; i++) {
      try {
        await wrapped1(undefined);
        results1.push(true);
      } catch {
        results1.push(false);
      }
    }

    for (let i = 0; i < 20; i++) {
      try {
        await wrapped2(undefined);
        results2.push(true);
      } catch {
        results2.push(false);
      }
    }

    expect(results1).toEqual(results2);
  });
});

// ---------------------------------------------------------------------------
// TestEngine.runN
// ---------------------------------------------------------------------------

describe('TestEngine.runN', () => {
  it('returns passRate=1 with no chaos on a reliable workflow', async () => {
    const engine = new TestEngine();

    const reliableActivity = async (x: number) => x + 1;

    const reliable = workflow({ name: 'reliable' }).execute(async function* (
      ctx: WorkflowContext,
      input: unknown,
    ) {
      const mockedActivity = engine.mocks.get(reliableActivity);
      const fn = mockedActivity ? mockedActivity.implementation : reliableActivity;
      return yield* (ctx as any).run(fn, input);
    });
    engine.register(reliable);

    engine.mock(reliableActivity, async (x: number) => x + 1);

    const result = await engine.runN('reliable', 1, { runs: 5 });

    expect(result.passRate).toBe(1.0);
    expect(result.consistency).toBe(1.0);
    expect(hasCorrectCategoriesShape(result.categories)).toBe(true);

    engine[Symbol.dispose]();
  });

  it('returns passRate < 1.0 on a known-flaky workflow under high faultRate chaos', async () => {
    const engine = new TestEngine();

    const flakeyActivity = async (x: number) => x * 2;

    const flakey = workflow({ name: 'flakey' }).execute(async function* (
      ctx: WorkflowContext,
      input: unknown,
    ) {
      const mockedActivity = engine.mocks.get(flakeyActivity);
      const fn = mockedActivity ? mockedActivity.implementation : flakeyActivity;
      return yield* (ctx as any).run(fn, input);
    });
    engine.register(flakey);

    engine.mock(flakeyActivity, async (x: number) => x * 2);

    const scenario: ChaosScenario = {
      faultRate: 0.8,
      faults: ['error'],
    };

    const result: RunNResult = await engine.runN('flakey', 5, {
      runs: 20,
      chaos: scenario,
    });

    // With 80% fault rate, some runs should fail
    expect(result.passRate).toBeLessThan(1.0);
    expect(result.passRate).toBeGreaterThanOrEqual(0);
    expect(result.passRate).toBeLessThanOrEqual(1.0);

    engine[Symbol.dispose]();
  });

  it('categories field has correct shape with all 5 keys as numbers', async () => {
    const engine = new TestEngine();

    const activity = async () => 'done';

    const shapeTest = workflow({ name: 'shape-test' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const mockedActivity = engine.mocks.get(activity);
      const fn = mockedActivity ? mockedActivity.implementation : activity;
      return yield* (ctx as any).run(fn, undefined);
    });
    engine.register(shapeTest);

    engine.mock(activity, async () => 'done');

    const scenario: ChaosScenario = { faultRate: 0.5, faults: ['error'] };
    const result = await engine.runN('shape-test', undefined, { runs: 10, chaos: scenario });

    expect(hasCorrectCategoriesShape(result.categories)).toBe(true);
    expect(ALL_FAILURE_CATEGORIES.every((c) => result.categories[c] >= 0)).toBe(true);

    engine[Symbol.dispose]();
  });

  it('counts stored application failures in RunNResult.categories', async () => {
    class ToolSchemaValidationError extends Error {
      constructor() {
        super('invalid planned operation');
        this.name = 'ToolSchemaValidationError';
      }
    }

    const engine = new TestEngine();
    const planningFailure = workflow({ name: 'planning-failure' }).execute(async function* () {
      throw new ToolSchemaValidationError();
    });
    engine.register(planningFailure);

    const result = await engine.runN('planning-failure', undefined, { runs: 1 });

    expect(result.passRate).toBe(0);
    expect(result.categories.application).toBe(1);
    expect(result.categories.system).toBe(0);

    engine[Symbol.dispose]();
  });

  it('consistency is 1.0 when all successful runs return the same value', async () => {
    const engine = new TestEngine();

    const deterministicActivity = async (x: number) => x + 100;

    const deterministic = workflow({ name: 'deterministic' }).execute(async function* (
      ctx: WorkflowContext,
      input: unknown,
    ) {
      const mockedActivity = engine.mocks.get(deterministicActivity);
      const fn = mockedActivity ? mockedActivity.implementation : deterministicActivity;
      return yield* (ctx as any).run(fn, input);
    });
    engine.register(deterministic);

    engine.mock(deterministicActivity, async (x: number) => x + 100);

    const result = await engine.runN('deterministic', 5, { runs: 5 });

    expect(result.passRate).toBe(1.0);
    expect(result.consistency).toBe(1.0);

    engine[Symbol.dispose]();
  });

  it('seeded chaos produces varied fault sequences across runs (not identical)', async () => {
    // Regression: using the same seed for every run produces identical fault sequences,
    // collapsing passRate to always 0.0 or 1.0. Per-run seed derivation (seed + i)
    // ensures each run sees a different fault pattern.
    const engine = new TestEngine();

    const activity = async () => 'ok';

    const seedVariety = workflow({ name: 'seed-variety' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const mockedActivity = engine.mocks.get(activity);
      const fn = mockedActivity ? mockedActivity.implementation : activity;
      return yield* (ctx as any).run(fn, undefined);
    });
    engine.register(seedVariety);

    engine.mock(activity, async () => 'ok');

    // With faultRate=0.5 and a seed, if all runs use the same seed they'd all
    // produce the same outcome. With per-run seed derivation the passRate should
    // be somewhere between 0.0 and 1.0 (not locked to either extreme) over
    // enough runs. We use a large run count and verify we see both outcomes.
    const scenario: ChaosScenario = { faultRate: 0.5, faults: ['error'], seed: 7 };
    const result = await engine.runN('seed-variety', undefined, { runs: 30, chaos: scenario });

    // Both passes and failures should occur — passRate should be strictly between extremes
    expect(result.passRate).toBeGreaterThan(0);
    expect(result.passRate).toBeLessThan(1);

    engine[Symbol.dispose]();
  });

  it('TestEngine has no register override — workflow registration uses base Engine.register', () => {
    // Regression: a dead register() override captured registrations into an unused
    // #capturedRegistrations field. Verify that TestEngine does not shadow Engine.register
    // by checking that Engine.prototype.register is the method resolved on a TestEngine instance.
    const engine = new TestEngine();

    // register should be inherited from Engine — not overridden on TestEngine
    expect(Object.prototype.hasOwnProperty.call(TestEngine.prototype, 'register')).toBe(false);

    engine[Symbol.dispose]();
  });

  it('failure counts sum to (1 - passRate) * runs', async () => {
    const engine = new TestEngine();

    const activity = async () => 'result';

    const counting = workflow({ name: 'counting' }).execute(async function* (ctx: WorkflowContext) {
      const mockedActivity = engine.mocks.get(activity);
      const fn = mockedActivity ? mockedActivity.implementation : activity;
      return yield* (ctx as any).run(fn, undefined);
    });
    engine.register(counting);

    engine.mock(activity, async () => 'result');

    const scenario: ChaosScenario = { faultRate: 0.7, faults: ['error'] };
    const runs = 20;
    const result = await engine.runN('counting', undefined, { runs, chaos: scenario });

    const failureCount = ALL_FAILURE_CATEGORIES.reduce((sum, c) => sum + result.categories[c], 0);
    const expectedFailures = Math.round((1 - result.passRate) * runs);
    expect(failureCount).toBe(expectedFailures);

    engine[Symbol.dispose]();
  });
});

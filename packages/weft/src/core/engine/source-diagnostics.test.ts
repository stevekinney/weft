/**
 * Bounded per-`(name, revision)` load-state diagnostics for dynamic
 * workflow sources (WFT-15/16): the `idle -> loading -> ready|failed`
 * state machine, the `loading -> cancelled` transition, and waiter-count
 * bookkeeping. The pure `record*`/`begin*`/`end*` functions are exercised
 * directly here; `dynamic-source-lifecycle.test.ts` and
 * `dynamic-source-execution.test.ts` cover the engine-level wiring.
 */
import { beforeAll, describe, expect, it, mock } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { ActivityRegistry } from '../activity-registry.ts';
import { buildWorkflowManifestFromDefinition } from '../registry-workflow-manifest.ts';
import { workflowSource } from '../source/index.ts';
import { workflow } from '../types.ts';
import type { FailureCategory } from '../types/identity.ts';
import { copyWorkflowDefinition } from './construction.ts';
import { Engine } from './index.ts';
import { getInternals, type EngineInternals } from './internals.ts';
import { buildRegistrationEntry } from './registration.ts';
import {
  beginSourceWaiter,
  endSourceWaiterAndCheckCancellation,
  readSourceLoadDiagnostics,
  readSourceWaiterCount,
  recordSourceLoadFailed,
  recordSourceLoadReady,
  recordSourceLoadStarted,
} from './source-diagnostics.ts';
import { createWorkflowSourceRuntimeState } from './source-runtime-state.ts';

function fakeInternals(): EngineInternals {
  return { sources: createWorkflowSourceRuntimeState() } as unknown as EngineInternals;
}

describe('source load-state diagnostics — pure state machine', () => {
  it('idle -> loading -> ready happy path', () => {
    const internals = fakeInternals();

    expect(readSourceLoadDiagnostics(internals, 'checkout', 'r1')).toBeUndefined();

    recordSourceLoadStarted(internals, 'checkout', 'r1', 'module', 1_000);
    let diagnostics = readSourceLoadDiagnostics(internals, 'checkout', 'r1');
    expect(diagnostics?.state).toBe('loading');
    expect(diagnostics?.kind).toBe('module');
    expect(diagnostics?.loadStartedAt).toBe(1_000);
    expect(diagnostics?.loadDurationMs).toBeUndefined();

    const dispatched = recordSourceLoadReady(internals, 'checkout', 'r1', 1_250);
    expect(dispatched).toBe(true);

    diagnostics = readSourceLoadDiagnostics(internals, 'checkout', 'r1');
    expect(diagnostics?.state).toBe('ready');
    expect(diagnostics?.loadDurationMs).toBe(250);
    expect(diagnostics?.lastFailureCategory).toBeUndefined();
  });

  it('idle -> loading -> failed populates lastFailureCategory for application/timeout/cancellation/system causes', () => {
    const cases: Array<{ error: unknown; expected: FailureCategory }> = [
      { error: new Error('boom'), expected: 'application' },
      {
        error: Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
        expected: 'timeout',
      },
      {
        error: Object.assign(new Error('aborted'), { name: 'AbortError' }),
        expected: 'cancellation',
      },
      { error: 'not an Error instance', expected: 'system' },
    ];

    for (const { error, expected } of cases) {
      const internals = fakeInternals();
      recordSourceLoadStarted(internals, 'checkout', 'r1', 'module', 0);
      const dispatched = recordSourceLoadFailed(internals, 'checkout', 'r1', 40, error);
      expect(dispatched).toBe(true);
      const diagnostics = readSourceLoadDiagnostics(internals, 'checkout', 'r1');
      expect(diagnostics?.state).toBe('failed');
      expect(diagnostics?.loadDurationMs).toBe(40);
      expect(diagnostics?.lastFailureCategory).toBe(expected);
    }
  });

  it('recordSourceLoadReady/Failed are no-ops (return false) when the key already moved on to cancelled', () => {
    const internals = fakeInternals();
    recordSourceLoadStarted(internals, 'checkout', 'r1', 'module', 0);
    beginSourceWaiter(internals, 'checkout', 'r1');
    const cancelled = endSourceWaiterAndCheckCancellation(internals, 'checkout', 'r1');
    expect(cancelled).toBe(true);
    expect(readSourceLoadDiagnostics(internals, 'checkout', 'r1')?.state).toBe('cancelled');

    // A late settle of the now-orphaned attempt must not overwrite `cancelled`.
    expect(recordSourceLoadReady(internals, 'checkout', 'r1', 100)).toBe(false);
    expect(readSourceLoadDiagnostics(internals, 'checkout', 'r1')?.state).toBe('cancelled');
    expect(recordSourceLoadFailed(internals, 'checkout', 'r1', 100, new Error('late'))).toBe(false);
    expect(readSourceLoadDiagnostics(internals, 'checkout', 'r1')?.state).toBe('cancelled');
  });

  it('a fresh attempt for the same key resets cleanly back to loading, and its own settle dispatches normally', () => {
    const internals = fakeInternals();
    recordSourceLoadStarted(internals, 'checkout', 'r1', 'module', 0);
    beginSourceWaiter(internals, 'checkout', 'r1');
    endSourceWaiterAndCheckCancellation(internals, 'checkout', 'r1');
    expect(readSourceLoadDiagnostics(internals, 'checkout', 'r1')?.state).toBe('cancelled');

    recordSourceLoadStarted(internals, 'checkout', 'r1', 'module', 200);
    expect(readSourceLoadDiagnostics(internals, 'checkout', 'r1')?.state).toBe('loading');
    expect(recordSourceLoadReady(internals, 'checkout', 'r1', 260)).toBe(true);
    expect(readSourceLoadDiagnostics(internals, 'checkout', 'r1')?.state).toBe('ready');
  });

  it('endSourceWaiterAndCheckCancellation transitions to cancelled only when the LAST waiter releases while still loading', () => {
    const internals = fakeInternals();
    recordSourceLoadStarted(internals, 'checkout', 'r1', 'module', 0);
    beginSourceWaiter(internals, 'checkout', 'r1');
    beginSourceWaiter(internals, 'checkout', 'r1');
    expect(readSourceWaiterCount(internals, 'checkout', 'r1')).toBe(2);

    // First of two releases: waiters remain — no cancellation.
    const firstRelease = endSourceWaiterAndCheckCancellation(internals, 'checkout', 'r1');
    expect(firstRelease).toBe(false);
    expect(readSourceLoadDiagnostics(internals, 'checkout', 'r1')?.state).toBe('loading');
    expect(readSourceWaiterCount(internals, 'checkout', 'r1')).toBe(1);

    // Last release: NOW it cancels.
    const lastRelease = endSourceWaiterAndCheckCancellation(internals, 'checkout', 'r1');
    expect(lastRelease).toBe(true);
    expect(readSourceLoadDiagnostics(internals, 'checkout', 'r1')?.state).toBe('cancelled');
    expect(readSourceWaiterCount(internals, 'checkout', 'r1')).toBe(0);
  });

  it('endSourceWaiterAndCheckCancellation does not cancel when the last waiter releases after the load already settled', () => {
    const internals = fakeInternals();
    recordSourceLoadStarted(internals, 'checkout', 'r1', 'module', 0);
    beginSourceWaiter(internals, 'checkout', 'r1');
    recordSourceLoadReady(internals, 'checkout', 'r1', 10);

    const cancelled = endSourceWaiterAndCheckCancellation(internals, 'checkout', 'r1');
    expect(cancelled).toBe(false);
    expect(readSourceLoadDiagnostics(internals, 'checkout', 'r1')?.state).toBe('ready');
  });
});

describe('source load-state diagnostics — engine-level integration', () => {
  const checkout = workflow({ name: 'checkout-diagnostics' }).execute(async function* () {
    return 'done';
  });

  let revision: string;

  beforeAll(async () => {
    const entry = buildRegistrationEntry('checkout-diagnostics', checkout);
    const registered = copyWorkflowDefinition('checkout-diagnostics', entry);
    const manifest = await buildWorkflowManifestFromDefinition(
      registered,
      new ActivityRegistry().listDefinitions(),
    );
    revision = manifest.revision;
  });

  it('measures loadDurationMs via the injected clock, not wall-clock', async () => {
    const storage = new MemoryStorage();
    let now = 5_000;
    const engine = new Engine({ storage, getNow: () => now });
    const deferred = Promise.withResolvers<Record<string, unknown>>();
    engine.registerSource(
      workflowSource(
        {
          name: 'checkout-diagnostics',
          location: './checkout.ts',
          exportName: 'checkout',
          revision,
        },
        () => deferred.promise,
      ),
    );

    const resolvePromise = engine.resolveWorkflowSource('checkout-diagnostics', revision);
    for (let iteration = 0; iteration < 50; iteration += 1) await Promise.resolve();

    now = 5_777;
    deferred.resolve({ checkout });
    const record = await resolvePromise;

    expect(record.manifest.revision).toBe(revision);
    const internals = getInternals(engine);
    const diagnostics = internals.sources.diagnostics.get('checkout-diagnostics')?.get(revision);
    expect(diagnostics?.state).toBe('ready');
    expect(diagnostics?.loadDurationMs).toBe(777);

    engine[Symbol.dispose]();
  });

  it('waiterCount reflects concurrent in-flight callers and drops to zero after every one settles', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const deferred = Promise.withResolvers<Record<string, unknown>>();
    const loader = mock(() => deferred.promise);
    engine.registerSource(
      workflowSource(
        {
          name: 'checkout-diagnostics',
          location: './checkout.ts',
          exportName: 'checkout',
          revision,
        },
        loader,
      ),
    );
    const internals = getInternals(engine);

    const calls = Array.from({ length: 4 }, () =>
      engine.resolveWorkflowSource('checkout-diagnostics', revision),
    );
    for (let iteration = 0; iteration < 50 && loader.mock.calls.length === 0; iteration += 1) {
      await Promise.resolve();
    }
    expect(readSourceWaiterCount(internals, 'checkout-diagnostics', revision)).toBe(4);

    deferred.resolve({ checkout });
    await Promise.all(calls);

    expect(readSourceWaiterCount(internals, 'checkout-diagnostics', revision)).toBe(0);
    expect(loader).toHaveBeenCalledTimes(1);

    engine[Symbol.dispose]();
  });
});

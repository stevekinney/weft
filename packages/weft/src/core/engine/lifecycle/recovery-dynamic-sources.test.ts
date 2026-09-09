/**
 * Direct unit tests for `preloadRecoverableDynamicSourceTypes()` — the
 * `recoverAll()` batch-wide dynamic-source preload barrier (WFT-15/16).
 * `dynamic-source-recovery.test.ts` covers the real engine-level wiring;
 * this file targets a defensive branch (a rejection that is neither
 * `EngineDisposedError` nor already `DynamicWorkflowSourceUnavailableError`)
 * that the real `resolveExecutableRegistration()` callback never actually
 * produces, so it needs a synthetic callback to reach at all.
 */
import { describe, expect, it, mock } from 'bun:test';

import { DynamicWorkflowSourceUnavailableError } from '../dynamic-source-errors.ts';
import { EngineDisposedError } from '../errors.ts';
import type { EngineInternals } from '../internals.ts';
import { preloadRecoverableDynamicSourceTypes } from './recovery-dynamic-sources.ts';
import type { LifecycleCallbacks } from './shared.ts';

function fakeInternals(registeredTypes: readonly string[] = []): EngineInternals {
  return {
    registrations: new Map(registeredTypes.map((type) => [type, {}])),
  } as unknown as EngineInternals;
}

function fakeCallbacks(
  resolveExecutableRegistration: (
    type: string,
  ) => Promise<{ entry: unknown; revision: string | undefined }>,
): LifecycleCallbacks {
  return { resolveExecutableRegistration } as unknown as LifecycleCallbacks;
}

describe('preloadRecoverableDynamicSourceTypes()', () => {
  it('returns an empty map and never calls the resolver when every type is eagerly registered', async () => {
    const internals = fakeInternals(['eager']);
    const resolve = mock(async () => ({ entry: {}, revision: undefined }));

    const failures = await preloadRecoverableDynamicSourceTypes(internals, fakeCallbacks(resolve), [
      'eager',
      'eager',
      'eager',
    ]);

    expect(failures.size).toBe(0);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('resolves each DISTINCT lazy type exactly once even when many runs share it', async () => {
    const internals = fakeInternals();
    const resolve = mock(async (type: string) => ({ entry: {}, revision: `${type}-r1` }));

    const failures = await preloadRecoverableDynamicSourceTypes(internals, fakeCallbacks(resolve), [
      'lazy-a',
      'lazy-a',
      'lazy-b',
      'lazy-a',
    ]);

    expect(failures.size).toBe(0);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('records a DynamicWorkflowSourceUnavailableError rejection verbatim, without re-wrapping it', async () => {
    const internals = fakeInternals();
    const original = new DynamicWorkflowSourceUnavailableError(
      'lazy-a',
      'r1',
      'ambiguous-revision',
    );
    const resolve = mock(async () => {
      throw original;
    });

    const failures = await preloadRecoverableDynamicSourceTypes(internals, fakeCallbacks(resolve), [
      'lazy-a',
    ]);

    expect(failures.get('lazy-a')).toBe(original);
  });

  it('wraps a non-DynamicWorkflowSourceUnavailableError rejection as one (defensive fallback)', async () => {
    const internals = fakeInternals();
    const original = new Error('a callback implementation that is not the real resolver');
    const resolve = mock(async () => {
      throw original;
    });

    const failures = await preloadRecoverableDynamicSourceTypes(internals, fakeCallbacks(resolve), [
      'lazy-a',
    ]);

    const wrapped = failures.get('lazy-a');
    expect(wrapped).toBeInstanceOf(DynamicWorkflowSourceUnavailableError);
    expect(wrapped).not.toBe(original);
    expect(wrapped?.reason).toBe('load-failed');
    expect(wrapped?.cause).toBe(original);
  });

  it('rethrows EngineDisposedError unwrapped, aborting the whole barrier', async () => {
    const internals = fakeInternals();
    const disposed = new EngineDisposedError();
    const resolve = mock(async () => {
      throw disposed;
    });

    await expect(
      preloadRecoverableDynamicSourceTypes(internals, fakeCallbacks(resolve), ['lazy-a']),
    ).rejects.toBe(disposed);
  });
});

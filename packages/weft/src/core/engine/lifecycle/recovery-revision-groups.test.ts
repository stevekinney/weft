import { describe, expect, it } from 'bun:test';

import { DynamicWorkflowSourceUnavailableError } from '../dynamic-source-errors.ts';
import { WorkflowRevisionUnavailableError } from '../revision-errors.ts';
import {
  buildRecoveryRevisionGroups,
  classifyRevisionGroups,
  createRecoveryScopedRevisionCallbacks,
  type RecoverableRevisionEntry,
} from './recovery-revision-groups.ts';
import type { LifecycleCallbacks } from './shared.ts';

/** Minimal fake `EngineInternals` — only `registrations` is read by this module. */
function fakeInternals(eagerTypes: readonly string[]): { registrations: Map<string, unknown> } {
  return {
    registrations: new Map(eagerTypes.map((type) => [type, { handler: () => {}, version: '1' }])),
  };
}

type ResolveOutcome = { ok: true } | { ok: false; error: Error };

/** Fake `LifecycleCallbacks` exposing only `resolveExecutableRegistrationForRevision`, keyed by `type\trevision`. */
function fakeCallbacks(
  outcomes: Map<string, ResolveOutcome>,
  onCall?: (type: string, revision: string | undefined) => void,
): LifecycleCallbacks {
  return {
    resolveExecutableRegistrationForRevision: async (
      type: string,
      revision: string | undefined,
    ) => {
      onCall?.(type, revision);
      const outcome = outcomes.get(`${type}\t${String(revision)}`);
      if (outcome === undefined) {
        throw new Error(`unexpected resolve call for ${type}/${String(revision)}`);
      }
      if (!outcome.ok) throw outcome.error;
      return { entry: { handler: () => {}, version: '1' } as never, revision };
    },
  } as unknown as LifecycleCallbacks;
}

describe('buildRecoveryRevisionGroups', () => {
  it('groups entries by exact (type, revision), preserving multiple workflow ids per group', () => {
    const entries: RecoverableRevisionEntry[] = [
      { workflowId: 'wf-1', type: 'checkout', revision: 'rev-a' },
      { workflowId: 'wf-2', type: 'checkout', revision: 'rev-a' },
      { workflowId: 'wf-3', type: 'checkout', revision: 'rev-b' },
      { workflowId: 'wf-4', type: 'checkout', revision: undefined },
      { workflowId: 'wf-5', type: 'other', revision: 'rev-a' },
    ];

    const groups = buildRecoveryRevisionGroups(entries);

    expect(groups.get('checkout')?.get('rev-a')?.workflowIds).toEqual(['wf-1', 'wf-2']);
    expect(groups.get('checkout')?.get('rev-b')?.workflowIds).toEqual(['wf-3']);
    expect(groups.get('checkout')?.get(undefined)?.workflowIds).toEqual(['wf-4']);
    expect(groups.get('other')?.get('rev-a')?.workflowIds).toEqual(['wf-5']);
  });

  it('returns an empty map for no entries', () => {
    expect(buildRecoveryRevisionGroups([]).size).toBe(0);
  });
});

describe('classifyRevisionGroups', () => {
  it('eager type: always ready, with no resolve call at all', async () => {
    const internals = fakeInternals(['eager-type']);
    let calls = 0;
    const callbacks = fakeCallbacks(new Map(), () => {
      calls += 1;
    });
    const groups = buildRecoveryRevisionGroups([
      { workflowId: 'wf-1', type: 'eager-type', revision: 'rev-a' },
    ]);

    const classifications = await classifyRevisionGroups(internals as never, callbacks, groups);

    expect(classifications.size).toBe(0);
    expect(calls).toBe(0);
  });

  it('dynamic single-candidate, legacy (undefined) pin: ready regardless of the legacy pin', async () => {
    const internals = fakeInternals([]);
    const callbacks = fakeCallbacks(new Map([['dynamic-type\tundefined', { ok: true }]]));
    const groups = buildRecoveryRevisionGroups([
      { workflowId: 'wf-1', type: 'dynamic-type', revision: undefined },
    ]);

    const classifications = await classifyRevisionGroups(internals as never, callbacks, groups);

    expect(classifications.get('dynamic-type')?.get(undefined)).toEqual({ status: 'ready' });
  });

  it("dynamic single-candidate, pin mismatch: unavailable (today's bug — sole candidate no longer matches)", async () => {
    const internals = fakeInternals([]);
    const error = new WorkflowRevisionUnavailableError(
      'dynamic-type',
      'rev-stale',
      'not-registered',
    );
    const callbacks = fakeCallbacks(new Map([['dynamic-type\trev-stale', { ok: false, error }]]));
    const groups = buildRecoveryRevisionGroups([
      { workflowId: 'wf-1', type: 'dynamic-type', revision: 'rev-stale' },
    ]);

    const classifications = await classifyRevisionGroups(internals as never, callbacks, groups);

    expect(classifications.get('dynamic-type')?.get('rev-stale')).toEqual({
      status: 'unavailable',
      error,
    });
  });

  it('dynamic multi-candidate, exact pin registered: ready', async () => {
    const internals = fakeInternals([]);
    const callbacks = fakeCallbacks(new Map([['dynamic-type\trev-a', { ok: true }]]));
    const groups = buildRecoveryRevisionGroups([
      { workflowId: 'wf-1', type: 'dynamic-type', revision: 'rev-a' },
    ]);

    const classifications = await classifyRevisionGroups(internals as never, callbacks, groups);

    expect(classifications.get('dynamic-type')?.get('rev-a')).toEqual({ status: 'ready' });
  });

  it('dynamic multi-candidate, no pin (legacy-ambiguous): unavailable', async () => {
    const internals = fakeInternals([]);
    const error = new WorkflowRevisionUnavailableError(
      'dynamic-type',
      undefined,
      'legacy-ambiguous',
    );
    const callbacks = fakeCallbacks(new Map([['dynamic-type\tundefined', { ok: false, error }]]));
    const groups = buildRecoveryRevisionGroups([
      { workflowId: 'wf-1', type: 'dynamic-type', revision: undefined },
    ]);

    const classifications = await classifyRevisionGroups(internals as never, callbacks, groups);

    const result = classifications.get('dynamic-type')?.get(undefined);
    expect(result?.status).toBe('unavailable');
    expect(result?.status === 'unavailable' && result.error.reason).toBe('legacy-ambiguous');
  });

  it('dynamic multi-candidate, unregistered pin: unavailable', async () => {
    const internals = fakeInternals([]);
    const error = new WorkflowRevisionUnavailableError(
      'dynamic-type',
      'rev-ghost',
      'not-registered',
    );
    const callbacks = fakeCallbacks(new Map([['dynamic-type\trev-ghost', { ok: false, error }]]));
    const groups = buildRecoveryRevisionGroups([
      { workflowId: 'wf-1', type: 'dynamic-type', revision: 'rev-ghost' },
    ]);

    const classifications = await classifyRevisionGroups(internals as never, callbacks, groups);

    expect(classifications.get('dynamic-type')?.get('rev-ghost')).toEqual({
      status: 'unavailable',
      error,
    });
  });

  it('classifies one group per (type, revision) even with several non-terminal runs sharing it', async () => {
    const internals = fakeInternals([]);
    let calls = 0;
    const callbacks = fakeCallbacks(new Map([['dynamic-type\trev-a', { ok: true }]]), () => {
      calls += 1;
    });
    const groups = buildRecoveryRevisionGroups([
      { workflowId: 'wf-1', type: 'dynamic-type', revision: 'rev-a' },
      { workflowId: 'wf-2', type: 'dynamic-type', revision: 'rev-a' },
      { workflowId: 'wf-3', type: 'dynamic-type', revision: 'rev-a' },
    ]);

    await classifyRevisionGroups(internals as never, callbacks, groups);

    expect(calls).toBe(1);
  });

  it('a load-failure reason not already a WorkflowRevisionUnavailableError/DynamicWorkflowSourceUnavailableError is wrapped', async () => {
    const internals = fakeInternals([]);
    const rawError = new Error('boom');
    const callbacks = fakeCallbacks(
      new Map([['dynamic-type\trev-a', { ok: false, error: rawError }]]),
    );
    const groups = buildRecoveryRevisionGroups([
      { workflowId: 'wf-1', type: 'dynamic-type', revision: 'rev-a' },
    ]);

    const classifications = await classifyRevisionGroups(internals as never, callbacks, groups);

    const result = classifications.get('dynamic-type')?.get('rev-a');
    expect(result?.status).toBe('unavailable');
    expect(
      result?.status === 'unavailable' &&
        result.error instanceof DynamicWorkflowSourceUnavailableError,
    ).toBe(true);
  });
});

describe('createRecoveryScopedRevisionCallbacks', () => {
  it('short-circuits with the cached error for an unavailable group, without calling the real resolver', async () => {
    let realCalls = 0;
    const error = new WorkflowRevisionUnavailableError('dynamic-type', 'rev-a', 'not-registered');
    const callbacks: LifecycleCallbacks = {
      resolveExecutableRegistrationForRevision: async () => {
        realCalls += 1;
        throw new Error('must not be called for a cached-unavailable group');
      },
    } as unknown as LifecycleCallbacks;
    const classifications = new Map([
      ['dynamic-type', new Map([['rev-a', { status: 'unavailable' as const, error }]])],
    ]);

    const scoped = createRecoveryScopedRevisionCallbacks(callbacks, classifications);

    await expect(
      scoped.resolveExecutableRegistrationForRevision('dynamic-type', 'rev-a'),
    ).rejects.toBe(error);
    expect(realCalls).toBe(0);
  });

  it('falls through to the real resolver for a group with no cached failure', async () => {
    let realCalls = 0;
    const callbacks: LifecycleCallbacks = {
      resolveExecutableRegistrationForRevision: async () => {
        realCalls += 1;
        return { entry: { handler: () => {}, version: '1' } as never, revision: 'rev-a' };
      },
    } as unknown as LifecycleCallbacks;
    const scoped = createRecoveryScopedRevisionCallbacks(callbacks, new Map());

    await scoped.resolveExecutableRegistrationForRevision('eager-type', 'rev-a');

    expect(realCalls).toBe(1);
  });
});

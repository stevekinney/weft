/**
 * Direct unit coverage of `activity-resolution.ts`'s `resolveActivityViaRegistries()`
 * (via its two exported callers), independent of a running `Engine`. Pins
 * the WFT-19 per-instance revision branch: eager map first (regardless of a
 * defined `revision` pin — an eager type has no ambiguity to pin against),
 * then the exact `(type, revision)`-keyed per-workflow registry
 * (`internals.sources.resolved`), then the global registry; an unknown
 * `workflowId` (no cached identity) falls back to the global registry only,
 * unchanged from before WFT-19.
 */
import { describe, expect, it } from 'bun:test';

import { ActivityRegistry } from '../activity-registry.ts';
import type { ContextOperationRequest } from '../context.ts';
import { getActivityFunctionWithMetadata, resolveActivityFunction } from './activity-resolution.ts';
import { ActivityResolutionError } from './errors.ts';
import type { EngineInternals } from './internals.ts';

type ActivityOperation = Extract<ContextOperationRequest, { type: 'activity' }>;

function operation(
  activityName: string,
  fn?: (...arguments_: unknown[]) => unknown,
): ActivityOperation {
  return {
    type: 'activity',
    operationId: 'op-1',
    activityName,
    input: undefined,
    ...(fn !== undefined && { fn }),
  };
}

function makeInternals(overrides: {
  workflowTypeByWorkflowId?: EngineInternals['workflowTypeByWorkflowId'];
  activityRegistriesByWorkflow?: EngineInternals['activityRegistriesByWorkflow'];
  activityRegistry?: EngineInternals['activityRegistry'];
  sourcesResolved?: EngineInternals['sources']['resolved'];
}): EngineInternals {
  return {
    workflowTypeByWorkflowId: overrides.workflowTypeByWorkflowId ?? new Map(),
    activityRegistriesByWorkflow: overrides.activityRegistriesByWorkflow ?? new Map(),
    activityRegistry: overrides.activityRegistry ?? new ActivityRegistry(),
    sources: {
      resolved: overrides.sourcesResolved ?? new Map(),
    },
  } as unknown as EngineInternals;
}

describe('resolveActivityViaRegistries() via getActivityFunctionWithMetadata()/resolveActivityFunction() (WFT-19)', () => {
  it('a workflow with a defined revision resolves its activity via the exact (type, revision)-keyed per-workflow registry', () => {
    const revisionRegistry = new ActivityRegistry();
    const revisionFn = () => 'from-revision';
    revisionRegistry.register('whoami', revisionFn);

    const internals = makeInternals({
      workflowTypeByWorkflowId: new Map([['wf-1', { type: 'dyn', revision: 'rev-a' }]]),
      sourcesResolved: new Map([
        [
          'dyn',
          new Map([['rev-a', { definition: {} as never, activityRegistry: revisionRegistry }]]),
        ],
      ]),
    });

    const fn = resolveActivityFunction(internals, 'wf-1', operation('whoami'));
    expect(fn()).toBe('from-revision');
  });

  it('a workflow with revision: undefined (legacy or eager) resolves via the eager per-workflow map, unchanged', () => {
    const eagerRegistry = new ActivityRegistry();
    const eagerFn = () => 'from-eager';
    eagerRegistry.register('whoami', eagerFn);

    const internals = makeInternals({
      workflowTypeByWorkflowId: new Map([['wf-1', { type: 'eager-type', revision: undefined }]]),
      activityRegistriesByWorkflow: new Map([['eager-type', eagerRegistry]]),
    });

    const fn = resolveActivityFunction(internals, 'wf-1', operation('whoami'));
    expect(fn()).toBe('from-eager');
  });

  it('an eager per-workflow registration wins over a same-named per-revision one, even when the instance carries a defined revision', () => {
    // A dynamic-source type later re-registered eagerly (or an eager type
    // whose identity happens to carry a stale non-undefined revision) must
    // still resolve eager-first — mirroring
    // `resolveExecutableRegistrationForRevision()`'s "eager always wins
    // regardless of revision" rule.
    const eagerRegistry = new ActivityRegistry();
    eagerRegistry.register('whoami', () => 'from-eager');
    const revisionRegistry = new ActivityRegistry();
    revisionRegistry.register('whoami', () => 'from-revision');

    const internals = makeInternals({
      workflowTypeByWorkflowId: new Map([['wf-1', { type: 'both', revision: 'rev-a' }]]),
      activityRegistriesByWorkflow: new Map([['both', eagerRegistry]]),
      sourcesResolved: new Map([
        [
          'both',
          new Map([['rev-a', { definition: {} as never, activityRegistry: revisionRegistry }]]),
        ],
      ]),
    });

    const fn = resolveActivityFunction(internals, 'wf-1', operation('whoami'));
    expect(fn()).toBe('from-eager');
  });

  it('falls back to the global registry when neither the eager nor the exact-revision per-workflow registry resolves the name', () => {
    const globalRegistry = new ActivityRegistry();
    globalRegistry.register('shared', () => 'from-global');

    const internals = makeInternals({
      workflowTypeByWorkflowId: new Map([['wf-1', { type: 'dyn', revision: 'rev-a' }]]),
      activityRegistry: globalRegistry,
      sourcesResolved: new Map([
        [
          'dyn',
          new Map([
            ['rev-a', { definition: {} as never, activityRegistry: new ActivityRegistry() }],
          ]),
        ],
      ]),
    });

    const fn = resolveActivityFunction(internals, 'wf-1', operation('shared'));
    expect(fn()).toBe('from-global');
  });

  it('falls back to the global registry only, for an unknown workflowId (no cached identity) — unchanged from before WFT-19', () => {
    const globalRegistry = new ActivityRegistry();
    globalRegistry.register('shared', () => 'from-global');
    const internals = makeInternals({ activityRegistry: globalRegistry });

    const fn = resolveActivityFunction(internals, 'never-started', operation('shared'));
    expect(fn()).toBe('from-global');
  });

  it('resolveActivityFunction() falls back to operation.fn, then throws ActivityResolutionError naming "<unknown>" for a workflowId with no cached identity and no operation.fn', () => {
    const internals = makeInternals({});

    const withFn = operation('missing', () => 'from-operation-fn');
    expect(resolveActivityFunction(internals, 'never-started', withFn)()).toBe('from-operation-fn');

    expect(() => resolveActivityFunction(internals, 'never-started', operation('missing'))).toThrow(
      ActivityResolutionError,
    );
    try {
      resolveActivityFunction(internals, 'never-started', operation('missing'));
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ActivityResolutionError);
      expect((error as ActivityResolutionError).message).toContain('<unknown>');
    }
  });

  it('getActivityFunctionWithMetadata() resolves the same per-workflow-first, revision-exact, then global order, returning undefined (not throwing) on a miss with no operation.fn', () => {
    const revisionRegistry = new ActivityRegistry();
    revisionRegistry.register('whoami', () => 'from-revision');
    const internals = makeInternals({
      workflowTypeByWorkflowId: new Map([['wf-1', { type: 'dyn', revision: 'rev-a' }]]),
      sourcesResolved: new Map([
        [
          'dyn',
          new Map([['rev-a', { definition: {} as never, activityRegistry: revisionRegistry }]]),
        ],
      ]),
    });

    expect(getActivityFunctionWithMetadata(internals, 'wf-1', operation('whoami'))?.()).toBe(
      'from-revision',
    );
    expect(
      getActivityFunctionWithMetadata(internals, 'wf-1', operation('missing')),
    ).toBeUndefined();
  });

  it('a defined revision not locally resolved (miss in sources.resolved) falls through to the global registry, never a different revision', () => {
    const globalRegistry = new ActivityRegistry();
    globalRegistry.register('shared', () => 'from-global');
    const internals = makeInternals({
      workflowTypeByWorkflowId: new Map([['wf-1', { type: 'dyn', revision: 'rev-not-resolved' }]]),
      activityRegistry: globalRegistry,
      // No entry for 'dyn' at all in sources.resolved.
    });

    const fn = resolveActivityFunction(internals, 'wf-1', operation('shared'));
    expect(fn()).toBe('from-global');
  });
});

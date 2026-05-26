import { describe, expect, it } from 'bun:test';

import type { ContextOperationRequest } from '../context.ts';
import type { ScheduleState, WorkflowState } from '../types.ts';
import {
  createTerminalCleanupTimerId,
  encodedValuesEqual,
  getTimelineBasicInputSummary,
  getTimelineInputSummary,
  getTimelineOperationLabel,
  getTimelineReviewArtifactType,
  intersectIdentifierSets,
  matchesListFilter,
  matchesScheduleFilter,
  normalizeForkStep,
  normalizeValueForEncodedComparison,
  parseTerminalCleanupTimerId,
  sanitizeCheckpointSearchAttributes,
  sanitizeTimelineSummary,
} from './state-utilities.ts';

function createWorkflowState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    createdAt: 1,
    id: 'workflow-state',
    input: null,
    startedAt: 1,
    status: 'running',
    type: 'workflow',
    updatedAt: 1,
    version: '1',
    ...overrides,
  };
}

function createScheduleState(overrides: Partial<ScheduleState> = {}): ScheduleState {
  return {
    backfills: [],
    catchupWindow: 0,
    createdAt: 1,
    cronExpression: '* * * * *',
    id: 'schedule-state',
    input: null,
    nextFireAt: 60_000,
    status: 'active',
    updatedAt: 1,
    workflowType: 'workflow',
    ...overrides,
  } as ScheduleState;
}

describe('engine state utilities', () => {
  it('returns undefined for review artifacts without a type field', () => {
    expect(getTimelineReviewArtifactType(null)).toBeUndefined();
    expect(getTimelineReviewArtifactType({ value: 'missing type' })).toBeUndefined();
    expect(getTimelineReviewArtifactType({ type: 'text' })).toBe('text');
  });

  it('sanitizes non-record checkpoint search attributes to an empty object', () => {
    expect(sanitizeCheckpointSearchAttributes('not-a-record')).toEqual({});
  });

  it('passes through undefined timeline summaries and normalizes JSON summaries', () => {
    expect(sanitizeTimelineSummary(undefined)).toBeUndefined();
    expect(sanitizeTimelineSummary('{"b":2,"a":1}')).toBe('{"b":2,"a":1}');
    expect(sanitizeTimelineSummary('not json')).toBe('not json');
  });

  it('rejects invalid fork steps', () => {
    expect(() => normalizeForkStep(-1)).toThrow(
      'options.fromStep must be a non-negative safe integer',
    );
    expect(() => normalizeForkStep(1.5)).toThrow(
      'options.fromStep must be a non-negative safe integer',
    );
  });

  it('intersects identifier sets and returns null for an empty set list', () => {
    expect(intersectIdentifierSets([])).toBeNull();
    expect(
      intersectIdentifierSets([new Set(['a', 'b', 'c']), new Set(['b', 'c']), new Set(['c'])]),
    ).toEqual(new Set(['c']));
  });

  it('applies constrained identifier, status, tag, and type list filters', () => {
    const state = createWorkflowState({ tags: ['critical'] });

    expect(matchesListFilter(state, undefined, new Set(['other-workflow']), undefined)).toBe(false);
    expect(matchesListFilter(state, { status: 'completed' }, null, undefined)).toBe(false);
    expect(matchesListFilter(state, undefined, null, ['missing'])).toBe(false);
    expect(matchesListFilter(state, { type: 'other' }, null, undefined)).toBe(false);
    expect(
      matchesListFilter(state, { status: ['running'] }, new Set(['workflow-state']), ['critical']),
    ).toBe(true);
  });

  it('normalizes arrays and object keys for encoded comparison', () => {
    expect(normalizeValueForEncodedComparison([{ b: 2, a: 1 }])).toEqual([{ a: 1, b: 2 }]);
    expect(encodedValuesEqual({ b: 2, a: 1 }, { a: 1, b: 2 })).toBe(true);
    expect(encodedValuesEqual([1], [1, 2])).toBe(false);
    expect(encodedValuesEqual({ value: 1 }, { value: 2 })).toBe(false);
  });

  it('applies status and workflow type schedule filters', () => {
    const schedule = createScheduleState();

    expect(matchesScheduleFilter(schedule, { status: 'paused' })).toBe(false);
    expect(matchesScheduleFilter(schedule, { workflowType: 'other' })).toBe(false);
    expect(matchesScheduleFilter(schedule, { status: ['active'] })).toBe(true);
  });

  it('rejects every indexed list-filter dimension independently', () => {
    const base = createWorkflowState({
      createdAt: 100,
      updatedAt: 200,
      executionDeadline: 300,
      failureCategory: 'application',
      tags: ['critical'],
    });

    // status (single + array variants)
    expect(matchesListFilter(base, { status: 'completed' }, null, undefined)).toBe(false);
    expect(matchesListFilter(base, { status: ['completed', 'failed'] }, null, undefined)).toBe(
      false,
    );

    // type
    expect(matchesListFilter(base, { type: 'other-workflow' }, null, undefined)).toBe(false);

    // idPrefix
    expect(matchesListFilter(base, { idPrefix: 'zzz' }, null, undefined)).toBe(false);

    // createdAt range
    expect(matchesListFilter(base, { createdAt: { gt: 100 } }, null, undefined)).toBe(false);
    expect(matchesListFilter(base, { createdAt: { lt: 100 } }, null, undefined)).toBe(false);

    // updatedAt range (all four operators)
    expect(matchesListFilter(base, { updatedAt: { gt: 200 } }, null, undefined)).toBe(false);
    expect(matchesListFilter(base, { updatedAt: { lt: 200 } }, null, undefined)).toBe(false);

    // executionDeadline range (all four operators)
    expect(matchesListFilter(base, { executionDeadline: { gt: 300 } }, null, undefined)).toBe(
      false,
    );
    expect(matchesListFilter(base, { executionDeadline: { lt: 300 } }, null, undefined)).toBe(
      false,
    );
    // missing executionDeadline on state rejects executionDeadline filter
    expect(
      matchesListFilter(createWorkflowState(), { executionDeadline: { gte: 0 } }, null, undefined),
    ).toBe(false);

    // failureCategory (single + array + null on state)
    expect(matchesListFilter(base, { failureCategory: 'system' }, null, undefined)).toBe(false);
    expect(
      matchesListFilter(base, { failureCategory: ['system', 'timeout'] }, null, undefined),
    ).toBe(false);
    // state with null failureCategory rejects a failureCategory filter
    expect(
      matchesListFilter(
        createWorkflowState({ failureCategory: null }),
        { failureCategory: 'application' },
        null,
        undefined,
      ),
    ).toBe(false);

    // tag filter (normalized tag filters argument)
    expect(matchesListFilter(base, undefined, null, ['missing'])).toBe(false);

    // constrained id set
    expect(matchesListFilter(base, undefined, new Set(['other-id']), undefined)).toBe(false);

    // passes when every dimension matches
    expect(
      matchesListFilter(
        base,
        {
          status: ['running'],
          type: 'workflow',
          idPrefix: 'workflow',
          createdAt: { gte: 100, lte: 100 },
          updatedAt: { gte: 200, lte: 200 },
          executionDeadline: { gte: 300, lte: 300 },
          failureCategory: 'application',
        },
        new Set([base.id]),
        ['critical'],
      ),
    ).toBe(true);
  });

  it('rejects every indexed schedule-filter dimension independently', () => {
    const schedule = createScheduleState();

    // status (single + array)
    expect(matchesScheduleFilter(schedule, { status: 'paused' })).toBe(false);
    expect(matchesScheduleFilter(schedule, { status: ['paused', 'cancelled'] })).toBe(false);

    // workflowType
    expect(matchesScheduleFilter(schedule, { workflowType: 'other' })).toBe(false);

    // passes when every dimension matches
    expect(
      matchesScheduleFilter(schedule, {
        status: ['active'],
        workflowType: 'workflow',
      }),
    ).toBe(true);
    expect(matchesScheduleFilter(schedule, { status: 'active' })).toBe(true);
  });

  it('getTimelineOperationLabel returns the correct label for every ContextOperationRequest kind', () => {
    // Per CLAUDE.md test-file conventions, cast minimal fixtures with the
    // double-cast: we only exercise the field each function reads.
    const op = (value: Record<string, unknown>): ContextOperationRequest =>
      value as unknown as ContextOperationRequest;

    const cases: Array<[ContextOperationRequest, string]> = [
      [op({ type: 'activity', activityName: 'my-activity' }), 'my-activity'],
      [op({ type: 'sleep', duration: 1000 }), 'sleep'],
      [op({ type: 'wait-signal', signalName: 'release' }), 'release'],
      [op({ type: 'wait-update', updateName: 'patch' }), 'patch'],
      [op({ type: 'parallel', operations: [] }), 'parallel'],
      [op({ type: 'race', operations: [] }), 'race'],
      [op({ type: 'memo', key: 'memo-key' }), 'memo-key'],
      [op({ type: 'child-workflow', workflowType: 'child-wf', input: null }), 'child-wf'],
      [op({ type: 'offload', key: 'offload-key' }), 'offload-key'],
      [op({ type: 'load', reference: { key: 'load-key' } }), 'load-key'],
      [op({ type: 'archive', key: 'archive-key', data: null }), 'archive-key'],
      [op({ type: 'state-read', key: 'state-key', scope: 'workflow' }), 'state-key'],
      [
        op({ type: 'state-commit', key: 'commit-key', scope: 'workflow', mode: 'set' }),
        'commit-key',
      ],
      [op({ type: 'run-all', branches: {} }), 'run-all'],
      [op({ type: 'speculate', operations: [] }), 'speculate'],
      [op({ type: 'stream', key: 'stream-key' }), 'stream-key'],
      [op({ type: 'wait-review', reviewOptions: { reviewers: [] } }), 'wait-review'],
    ];

    for (const [operation, expected] of cases) {
      expect(getTimelineOperationLabel(operation)).toBe(expected);
    }
  });

  it('getTimelineBasicInputSummary returns a summary for every ContextOperationRequest kind', () => {
    // All these should return a non-empty string (not throw).
    const operations: ContextOperationRequest[] = [
      { type: 'activity', activityName: 'a', fn: () => {} } as unknown as ContextOperationRequest,
      { type: 'sleep', duration: 500 } as unknown as ContextOperationRequest,
      { type: 'wait-signal', signalName: 's' } as unknown as ContextOperationRequest,
      { type: 'wait-update', updateName: 'u' } as unknown as ContextOperationRequest,
      { type: 'parallel', operations: [] } as unknown as ContextOperationRequest,
      { type: 'race', operations: [] } as unknown as ContextOperationRequest,
      { type: 'memo', key: 'k', fn: () => {} } as unknown as ContextOperationRequest,
      {
        type: 'child-workflow',
        workflowType: 'cw',
        input: null,
      } as unknown as ContextOperationRequest,
      { type: 'offload', key: 'ok', fn: () => {} } as unknown as ContextOperationRequest,
      { type: 'load', reference: { key: 'lk' } } as unknown as ContextOperationRequest,
      { type: 'archive', key: 'ak', data: { x: 1 } } as unknown as ContextOperationRequest,
      { type: 'state-read', key: 'sk', scope: 'workflow' } as unknown as ContextOperationRequest,
      {
        type: 'state-commit',
        key: 'ck',
        scope: 'workflow',
        mode: 'set',
      } as unknown as ContextOperationRequest,
      { type: 'run-all', branches: {} } as unknown as ContextOperationRequest,
      { type: 'speculate', operations: [] } as unknown as ContextOperationRequest,
      { type: 'stream', key: 'stk' } as unknown as ContextOperationRequest,
      {
        type: 'wait-review',
        reviewOptions: { reviewers: [] },
      } as unknown as ContextOperationRequest,
    ];

    for (const op of operations) {
      expect(() => getTimelineBasicInputSummary(op)).not.toThrow();
      expect(typeof getTimelineBasicInputSummary(op)).toBe('string');
    }

    // Spot-check specific return values
    expect(
      getTimelineBasicInputSummary({
        type: 'sleep',
        duration: 42,
      } as unknown as ContextOperationRequest),
    ).toContain('42');
    expect(
      getTimelineBasicInputSummary({
        type: 'wait-signal',
        signalName: 'x',
      } as unknown as ContextOperationRequest),
    ).toContain('x');
    expect(
      getTimelineBasicInputSummary({
        type: 'memo',
        key: 'my-key',
        fn: () => {},
      } as unknown as ContextOperationRequest),
    ).toContain('my-key');
  });

  it('getTimelineInputSummary handles the four direct-handling cases and delegates the rest', () => {
    // activity — includes input
    const activityOp = {
      type: 'activity',
      activityName: 'a',
      fn: () => {},
      input: { payload: 1 },
    } as unknown as ContextOperationRequest;
    expect(getTimelineInputSummary(activityOp)).toContain('payload');

    // child-workflow — includes workflowType and input
    const childOp = {
      type: 'child-workflow',
      workflowType: 'cw',
      input: 42,
    } as unknown as ContextOperationRequest;
    expect(getTimelineInputSummary(childOp)).toContain('cw');

    // run-all — includes branch count
    const runAllOp = {
      type: 'run-all',
      branches: { a: [() => {}], b: [() => {}] },
    } as unknown as ContextOperationRequest;
    expect(getTimelineInputSummary(runAllOp)).toContain('a');

    // wait-review — includes reviewers
    const reviewOp = {
      type: 'wait-review',
      reviewOptions: { reviewers: ['alice'] },
    } as unknown as ContextOperationRequest;
    expect(getTimelineInputSummary(reviewOp)).toContain('alice');

    // default path — delegates to getTimelineBasicInputSummary (e.g. sleep)
    const sleepOp = { type: 'sleep', duration: 999 } as unknown as ContextOperationRequest;
    expect(getTimelineInputSummary(sleepOp)).toContain('999');
  });

  it('parses terminal cleanup timer identifiers', () => {
    const fullTimerId = createTerminalCleanupTimerId(true, 'token-1');
    const preserveTimerId = createTerminalCleanupTimerId(false, 'token-2');

    expect(parseTerminalCleanupTimerId(fullTimerId)).toEqual({
      includeOutputArtifacts: true,
      terminalCleanupToken: 'token-1',
    });
    expect(parseTerminalCleanupTimerId(preserveTimerId)).toEqual({
      includeOutputArtifacts: false,
      terminalCleanupToken: 'token-2',
    });
    expect(parseTerminalCleanupTimerId('terminal-cleanup:full:')).toBeNull();
    expect(parseTerminalCleanupTimerId('not-a-cleanup-timer')).toBeNull();
  });
});

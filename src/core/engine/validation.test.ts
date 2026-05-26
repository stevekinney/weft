import { describe, expect, it, mock } from 'bun:test';

import { encode } from '../codec.ts';
import type { ScheduleState, WorkflowState } from '../types.ts';
import {
  decodeWorkflowState,
  isSanitizedSearchAttributeValue,
  isWorkflowTimelineEntry,
  isWorkflowVersionTuple,
  normalizeBulkFilterNumber,
} from './validation.ts';
import {
  decodeScheduleIdentityFields,
  decodeScheduleRuntimeFields,
  isValidScheduleIdentifier,
  normalizeScheduleFilter,
  normalizeScheduleOptions,
} from './validation/schedule.ts';

function createWorkflowState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    createdAt: 1,
    id: 'workflow-id',
    input: null,
    startedAt: 1,
    status: 'running',
    type: 'workflow',
    updatedAt: 1,
    version: '1',
    ...overrides,
  };
}

function createScheduleRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'schedule-id',
    workflowType: 'demo-workflow',
    cronExpression: '0 * * * *',
    status: 'active',
    overlap: 'skip',
    backfill: false,
    createdAt: 1,
    updatedAt: 2,
    nextFireAt: 3,
    queuedRuns: 0,
    ...overrides,
  };
}

describe('engine validation helpers', () => {
  it('validates search attribute values', () => {
    expect(isSanitizedSearchAttributeValue('ready')).toBe(true);
    expect(isSanitizedSearchAttributeValue(1)).toBe(true);
    expect(isSanitizedSearchAttributeValue(false)).toBe(true);
    expect(isSanitizedSearchAttributeValue(['a', 'b'])).toBe(true);
    expect(isSanitizedSearchAttributeValue(['a', 1])).toBe(false);
  });

  it('validates workflow version tuples', () => {
    expect(isWorkflowVersionTuple(null)).toBe(false);
    expect(isWorkflowVersionTuple({ workflowVersion: '1', agentVersion: 2 })).toBe(false);
    expect(isWorkflowVersionTuple({ workflowVersion: '1', toolVersions: ['a', 2] })).toBe(false);
    expect(
      isWorkflowVersionTuple({
        workflowVersion: '1',
        agentVersion: 'agent',
        toolVersions: ['tool-a'],
      }),
    ).toBe(true);
  });

  it('validates workflow timeline entries', () => {
    expect(isWorkflowTimelineEntry(null)).toBe(false);
    expect(
      isWorkflowTimelineEntry({
        step: 0,
        operationType: 'activity',
        operationLabel: 'demo',
        inputSummary: 'input',
        timestamp: 1,
        status: 'running',
      }),
    ).toBe(false);
    expect(
      isWorkflowTimelineEntry({
        step: 1,
        operationType: 'activity',
        operationLabel: 'demo',
        inputSummary: 'input',
        timestamp: 1,
        status: 'running',
        outputSummary: 'output',
        duration: 10,
        versionTuple: { workflowVersion: '1', toolVersions: ['tool-a'] },
      }),
    ).toBe(true);
  });

  it('normalizes legacy workflow failure categories while decoding persisted state', () => {
    expect(
      decodeWorkflowState(encode(createWorkflowState({ failureCategory: 'planning' as never })))
        .failureCategory,
    ).toBe('application');
    expect(
      decodeWorkflowState(encode(createWorkflowState({ failureCategory: 'action' as never })))
        .failureCategory,
    ).toBe('application');
    expect(
      decodeWorkflowState(encode(createWorkflowState({ failureCategory: 'reflection' as never })))
        .failureCategory,
    ).toBe('application');
    expect(
      decodeWorkflowState(encode(createWorkflowState({ failureCategory: 'memory' as never })))
        .failureCategory,
    ).toBe('resource');
    expect(
      decodeWorkflowState(encode(createWorkflowState({ failureCategory: 'system' })))
        .failureCategory,
    ).toBe('system');
  });

  it('validates schedule identifiers and bulk filter numbers', () => {
    expect(isValidScheduleIdentifier(42)).toBe(false);
    expect(isValidScheduleIdentifier('')).toBe(false);
    expect(isValidScheduleIdentifier('schedule-id')).toBe(true);

    expect(normalizeBulkFilterNumber(undefined, 'limit')).toBeUndefined();
    expect(normalizeBulkFilterNumber(2.9, 'offset')).toBe(2);
    expect(() => normalizeBulkFilterNumber(-1, 'limit')).toThrow(
      'filter.limit must be a non-negative number when provided',
    );
  });

  it('normalizes schedule options', () => {
    expect(normalizeScheduleOptions(undefined)).toEqual({ overlap: 'skip', backfill: false });
    expect(() => normalizeScheduleOptions(null as never)).toThrow(
      'options must be an object when provided',
    );
    expect(() => normalizeScheduleOptions({ overlap: 'bad' } as never)).toThrow(
      'options.overlap must be one of skip, queue, cancel-running, allow',
    );
    expect(() => normalizeScheduleOptions({ backfill: 'yes' } as never)).toThrow(
      'options.backfill must be a boolean when provided',
    );
    expect(
      normalizeScheduleOptions({ id: 'schedule-id', overlap: 'queue', backfill: true }),
    ).toEqual({
      id: 'schedule-id',
      overlap: 'queue',
      backfill: true,
    });
  });

  it('normalizes schedule filters and rejects invalid shapes', () => {
    expect(normalizeScheduleFilter(undefined)).toBeUndefined();
    expect(() => normalizeScheduleFilter(null as never)).toThrow(
      'filter must be an object when provided',
    );
    expect(() => normalizeScheduleFilter({ status: 'bad' } as never)).toThrow(
      'filter.status must be one of active, paused, cancelled',
    );
    expect(() => normalizeScheduleFilter({ workflowType: '' })).toThrow(
      'filter.workflowType must be a non-empty string when provided',
    );
    expect(() => normalizeScheduleFilter({ limit: 1.5 })).toThrow(
      'filter.limit must be a non-negative safe integer when provided',
    );
    expect(() => normalizeScheduleFilter({ offset: -1 })).toThrow(
      'filter.offset must be a non-negative safe integer when provided',
    );
    expect(
      normalizeScheduleFilter({
        status: ['active', 'paused'],
        workflowType: 'demo-workflow',
        limit: 5,
        offset: 1,
      }),
    ).toEqual({
      status: ['active', 'paused'],
      workflowType: 'demo-workflow',
      limit: 5,
      offset: 1,
    });
  });

  it('tolerate-and-drops a legacy tenant field on a decoded workflow state', () => {
    const legacyState = {
      id: 'wf-legacy',
      type: 'checkout',
      status: 'running',
      createdAt: 1,
      updatedAt: 2,
      tenant: { id: 'acme', attributes: { region: 'us' } },
    };
    const decoded = decodeWorkflowState(encode(legacyState));
    expect('tenant' in decoded).toBe(false);
    expect(decoded.id).toBe('wf-legacy');
  });

  it('drops malformed decoded tags while preserving the rest of workflow state', () => {
    const warning = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warning;

    try {
      const decoded = decodeWorkflowState(
        encode(
          createWorkflowState({
            tags: ['ok', 1] as never,
          }),
        ),
      );

      expect(decoded.tags).toBeUndefined();
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('decodes schedule identity fields and rejects malformed records', () => {
    const warning = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warning;

    try {
      expect(decodeScheduleIdentityFields(createScheduleRecord({ id: '' }))).toBeNull();
      expect(decodeScheduleIdentityFields(createScheduleRecord({ workflowType: '' }))).toBeNull();
      expect(decodeScheduleIdentityFields(createScheduleRecord({ cronExpression: 42 }))).toBeNull();
      expect(
        decodeScheduleIdentityFields(createScheduleRecord({ cronExpression: 'not a cron' })),
      ).toBeNull();
      expect(decodeScheduleIdentityFields(createScheduleRecord({ status: 'bad' }))).toBeNull();
      expect(decodeScheduleIdentityFields(createScheduleRecord({ overlap: 'bad' }))).toBeNull();
      expect(decodeScheduleIdentityFields(createScheduleRecord())).toEqual({
        id: 'schedule-id',
        workflowType: 'demo-workflow',
        cronExpression: '0 * * * *',
        status: 'active',
        overlap: 'skip',
      });
      expect(warning).toHaveBeenCalled();
    } finally {
      console.warn = originalWarn;
    }
  });

  it('decodes schedule runtime fields and rejects malformed records', () => {
    const warning = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warning;

    try {
      expect(
        decodeScheduleRuntimeFields(createScheduleRecord({ backfill: 'yes' }), 'schedule-id'),
      ).toBeNull();
      expect(
        decodeScheduleRuntimeFields(createScheduleRecord({ createdAt: -1 }), 'schedule-id'),
      ).toBeNull();
      expect(
        decodeScheduleRuntimeFields(createScheduleRecord({ lastFireAt: -1 }), 'schedule-id'),
      ).toBeNull();
      expect(
        decodeScheduleRuntimeFields(createScheduleRecord({ nextFireAt: undefined }), 'schedule-id'),
      ).toBeNull();
      expect(
        decodeScheduleRuntimeFields(createScheduleRecord({ nextFireAt: -1 }), 'schedule-id'),
      ).toBeNull();
      expect(
        decodeScheduleRuntimeFields(createScheduleRecord({ currentWorkflowId: '' }), 'schedule-id'),
      ).toBeNull();
      expect(
        decodeScheduleRuntimeFields(createScheduleRecord({ queuedRuns: -1 }), 'schedule-id'),
      ).toBeNull();
      expect(
        decodeScheduleRuntimeFields(
          createScheduleRecord({
            lastFireAt: 2,
            currentWorkflowId: 'child-workflow',
          }),
          'schedule-id',
        ),
      ).toEqual({
        backfill: false,
        createdAt: 1,
        updatedAt: 2,
        lastFireAt: 2,
        nextFireAt: 3,
        currentWorkflowId: 'child-workflow',
        queuedRuns: 0,
      } satisfies Pick<
        ScheduleState,
        | 'backfill'
        | 'createdAt'
        | 'updatedAt'
        | 'lastFireAt'
        | 'nextFireAt'
        | 'currentWorkflowId'
        | 'queuedRuns'
      >);
      expect(warning).toHaveBeenCalled();
    } finally {
      console.warn = originalWarn;
    }
  });
});

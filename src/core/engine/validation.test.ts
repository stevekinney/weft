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
    versionTuple: { workflowVersion: '1' },
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

  it('drops previous workflow failure category names while decoding persisted state', () => {
    for (const category of ['planning', 'action', 'reflection', 'memory']) {
      expect(
        decodeWorkflowState(encode(createWorkflowState({ failureCategory: category as never })))
          .failureCategory,
      ).toBeUndefined();
    }

    expect(
      decodeWorkflowState(encode(createWorkflowState({ failureCategory: 'system' })))
        .failureCategory,
    ).toBe('system');
  });

  it('drops an unrecognized non-null failure category while decoding persisted state', () => {
    expect(
      decodeWorkflowState(encode(createWorkflowState({ failureCategory: 'bogus' as never })))
        .failureCategory,
    ).toBeUndefined();
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
    expect(() => normalizeScheduleOptions({ jitter: false } as never)).toThrow(
      'options.jitter must be a duration string or a number of milliseconds',
    );
    expect(() => normalizeScheduleOptions({ jitter: 0 })).toThrow(
      'options.jitter must resolve to a positive number of milliseconds',
    );
    expect(
      normalizeScheduleOptions({
        id: 'schedule-id',
        overlap: 'queue',
        backfill: true,
        jitter: '30s',
      }),
    ).toEqual({
      id: 'schedule-id',
      overlap: 'queue',
      backfill: true,
      jitterMs: 30_000,
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

  it('drops unknown persisted fields from decoded workflow state records', () => {
    const stateWithUnknownField = {
      id: 'wf-extra-field',
      type: 'checkout',
      status: 'running',
      createdAt: 1,
      updatedAt: 2,
      tenant: { id: 'acme', attributes: { region: 'us' } },
    };
    const decoded = decodeWorkflowState(encode(stateWithUnknownField));
    expect('tenant' in decoded).toBe(false);
    expect(decoded.id).toBe('wf-extra-field');
  });

  it('lifts a pre-unification flat version tuple into versionTuple on decode', () => {
    const flatState = {
      id: 'wf-flat',
      type: 'checkout',
      status: 'running',
      input: null,
      createdAt: 1,
      updatedAt: 2,
      version: '3.1.0',
      agentVersion: 'agent-9',
      toolVersions: ['search@2', 'database@4'],
    };

    const decoded = decodeWorkflowState(encode(flatState));

    expect(decoded.versionTuple).toEqual({
      workflowVersion: '3.1.0',
      agentVersion: 'agent-9',
      toolVersions: ['search@2', 'database@4'],
    });
    // The flat keys are dropped so the rest of the engine sees one shape.
    expect('version' in decoded).toBe(false);
    expect('agentVersion' in decoded).toBe(false);
    expect('toolVersions' in decoded).toBe(false);
  });

  it('lifts a flat record that carries only the workflow version', () => {
    const flatState = {
      id: 'wf-flat-minimal',
      type: 'checkout',
      status: 'running',
      input: null,
      createdAt: 1,
      updatedAt: 2,
      version: '1.0.0',
    };

    const decoded = decodeWorkflowState(encode(flatState));

    expect(decoded.versionTuple).toEqual({ workflowVersion: '1.0.0' });
    expect('version' in decoded).toBe(false);
  });

  it('falls back to DEFAULT_WORKFLOW_VERSION when a record has neither version nor versionTuple', () => {
    // A corrupt record missing both shapes degrades to the default workflow
    // version rather than producing an undefined workflowVersion. For a
    // versioned workflow this default then drives the normal drift/mismatch path
    // on recovery; for an unversioned (0.0.0) workflow it matches and is inert.
    const corruptState = {
      id: 'wf-corrupt-version',
      type: 'checkout',
      status: 'running',
      input: null,
      createdAt: 1,
      updatedAt: 2,
    };

    const decoded = decodeWorkflowState(encode(corruptState));

    expect(decoded.versionTuple).toEqual({ workflowVersion: '0.0.0' });
    expect('version' in decoded).toBe(false);
  });

  it('leaves a current versionTuple record untouched on decode', () => {
    const currentState = {
      id: 'wf-current',
      type: 'checkout',
      status: 'running',
      input: null,
      createdAt: 1,
      updatedAt: 2,
      versionTuple: { workflowVersion: '2.0.0', agentVersion: 'agent-1' },
    };

    const decoded = decodeWorkflowState(encode(currentState));

    expect(decoded.versionTuple).toEqual({ workflowVersion: '2.0.0', agentVersion: 'agent-1' });
    expect('version' in decoded).toBe(false);
  });

  it('drops stray flat version keys when a versionTuple is already present', () => {
    // An intermediate build could have written both shapes; the nested tuple wins
    // and the stray flat keys are cleaned up.
    const mixedState = {
      id: 'wf-mixed',
      type: 'checkout',
      status: 'running',
      input: null,
      createdAt: 1,
      updatedAt: 2,
      version: 'stale',
      agentVersion: 'stale-agent',
      versionTuple: { workflowVersion: '5.0.0' },
    };

    const decoded = decodeWorkflowState(encode(mixedState));

    expect(decoded.versionTuple).toEqual({ workflowVersion: '5.0.0' });
    expect('version' in decoded).toBe(false);
    expect('agentVersion' in decoded).toBe(false);
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
        decodeScheduleRuntimeFields(createScheduleRecord({ lastMissedFireAt: -1 }), 'schedule-id'),
      ).toBeNull();
      expect(
        decodeScheduleRuntimeFields(createScheduleRecord({ missedFireCount: -1 }), 'schedule-id'),
      ).toBeNull();
      expect(
        decodeScheduleRuntimeFields(createScheduleRecord({ jitterMs: 0 }), 'schedule-id'),
      ).toBeNull();
      expect(
        decodeScheduleRuntimeFields(
          createScheduleRecord({
            lastFireAt: 2,
            lastMissedFireAt: 1,
            currentWorkflowId: 'child-workflow',
            missedFireCount: 4,
            jitterMs: 30_000,
          }),
          'schedule-id',
        ),
      ).toEqual({
        backfill: false,
        createdAt: 1,
        updatedAt: 2,
        lastFireAt: 2,
        lastMissedFireAt: 1,
        nextFireAt: 3,
        currentWorkflowId: 'child-workflow',
        missedFireCount: 4,
        queuedRuns: 0,
        jitterMs: 30_000,
      } satisfies Pick<
        ScheduleState,
        | 'backfill'
        | 'createdAt'
        | 'updatedAt'
        | 'lastFireAt'
        | 'lastMissedFireAt'
        | 'nextFireAt'
        | 'currentWorkflowId'
        | 'missedFireCount'
        | 'queuedRuns'
        | 'jitterMs'
      >);
      expect(decodeScheduleRuntimeFields(createScheduleRecord(), 'schedule-id')).toMatchObject({
        missedFireCount: 0,
      });
      expect(warning).toHaveBeenCalled();
    } finally {
      console.warn = originalWarn;
    }
  });
});

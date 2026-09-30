import { describe, expect, it } from 'bun:test';

import { DynamicWorkflowSourceUnavailableError } from '../../core/engine/dynamic-source-errors.ts';
import { WorkflowRevisionUnavailableError } from '../../core/engine/revision-errors.ts';
import { mapScheduleErrorToFault } from './schedule-faults.ts';

const SENSITIVE_CAUSE = '/etc/secrets/token=abc123 unreadable';

describe('mapScheduleErrorToFault', () => {
  it('maps an ambiguous-revision DynamicWorkflowSourceUnavailableError to Conflict', () => {
    const error = new DynamicWorkflowSourceUnavailableError(
      'checkout',
      undefined,
      'ambiguous-revision',
    );
    const fault = mapScheduleErrorToFault('schedule-id', error);

    expect(fault.code).toBe('Conflict');
    expect(fault.message).toBe(error.message);
    expect(fault.data).toEqual({
      reason: 'ambiguous-revision',
      weftCode: 'DynamicWorkflowSourceUnavailableError',
    });
  });

  it('bounds a load-failed message with a revision and never leaks the cause', () => {
    const error = new DynamicWorkflowSourceUnavailableError(
      'checkout',
      'r1',
      'load-failed',
      new Error(SENSITIVE_CAUSE),
    );
    const fault = mapScheduleErrorToFault('schedule-id', error);

    expect(fault.code).toBe('Conflict');
    expect(fault.message).toBe('Dynamic workflow source "checkout" revision "r1" failed to load.');
    expect(fault.message).not.toContain('/etc/secrets/token=abc123');
    expect(fault.data).toEqual({
      reason: 'load-failed',
      weftCode: 'DynamicWorkflowSourceUnavailableError',
    });
  });

  it('bounds a load-failed message without a revision', () => {
    const error = new DynamicWorkflowSourceUnavailableError(
      'checkout',
      undefined,
      'load-failed',
      new Error(SENSITIVE_CAUSE),
    );
    const fault = mapScheduleErrorToFault('schedule-id', error);

    expect(fault.code).toBe('Conflict');
    expect(fault.message).toBe('Dynamic workflow source "checkout" failed to load.');
  });

  it('still maps WorkflowRevisionUnavailableError to Conflict', () => {
    const error = new WorkflowRevisionUnavailableError('checkout', 'rev-a', 'not-registered');
    expect(mapScheduleErrorToFault('schedule-id', error)).toEqual({
      code: 'Conflict',
      message: error.message,
      data: { reason: 'not-registered', weftCode: 'WorkflowRevisionUnavailableError' },
    });
  });

  it('still maps an unrelated error to EngineFailure', () => {
    expect(mapScheduleErrorToFault('schedule-id', new Error('boom')).code).toBe('EngineFailure');
  });
});

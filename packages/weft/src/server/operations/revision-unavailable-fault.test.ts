import { describe, expect, it } from 'bun:test';

import { WorkflowRevisionUnavailableError } from '../../core/engine/revision-errors.ts';
import { mapRevisionUnavailableToFault } from './revision-unavailable-fault.ts';

describe('mapRevisionUnavailableToFault', () => {
  it('returns undefined for a non-WorkflowRevisionUnavailableError', () => {
    expect(mapRevisionUnavailableToFault(new Error('boom'))).toBeUndefined();
    expect(mapRevisionUnavailableToFault('boom')).toBeUndefined();
    expect(mapRevisionUnavailableToFault(undefined)).toBeUndefined();
  });

  it("maps a 'not-registered' error to a Conflict fault carrying data.reason", () => {
    const error = new WorkflowRevisionUnavailableError('checkout', 'rev-a', 'not-registered');
    const fault = mapRevisionUnavailableToFault(error);
    expect(fault).toEqual({
      code: 'Conflict',
      message: error.message,
      data: { reason: 'not-registered', weftCode: 'WorkflowRevisionUnavailableError' },
    });
  });

  it("maps a 'legacy-ambiguous' error to a Conflict fault carrying data.reason", () => {
    const error = new WorkflowRevisionUnavailableError('checkout', undefined, 'legacy-ambiguous');
    const fault = mapRevisionUnavailableToFault(error);
    expect(fault?.code).toBe('Conflict');
    expect(fault?.data).toEqual({
      reason: 'legacy-ambiguous',
      weftCode: 'WorkflowRevisionUnavailableError',
    });
  });

  it("maps a 'not-installed' error to a Conflict fault carrying data.reason", () => {
    const error = new WorkflowRevisionUnavailableError('checkout', 'rev-a', 'not-installed');
    const fault = mapRevisionUnavailableToFault(error);
    expect(fault?.code).toBe('Conflict');
    expect(fault?.data).toEqual({
      reason: 'not-installed',
      weftCode: 'WorkflowRevisionUnavailableError',
    });
  });
});

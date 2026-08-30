import { describe, expect, it } from 'bun:test';

import {
  extractRouteParameters,
  getRequiredRouteParameter,
  isOperationFaultLike,
} from './handler.ts';

describe('handler internals', () => {
  it('extracts and decodes route parameters', () => {
    expect(
      extractRouteParameters(
        ['workflowId', 'step'],
        ['/v1/workflows/alpha%2Fbeta/replay/2', 'alpha%2Fbeta', '2'],
      ),
    ).toEqual({
      workflowId: 'alpha/beta',
      step: '2',
    });
  });

  it('throws a malformed-route error when decoding fails', () => {
    expect(() =>
      extractRouteParameters(['workflowId'], ['/v1/workflows/%E0%A4%A', '%E0%A4%A']),
    ).toThrow('Malformed route parameter encoding');
  });

  it('returns required route parameters and throws when one is missing', () => {
    expect(getRequiredRouteParameter({ workflowId: 'wf-123' }, 'workflowId', 'GET /example')).toBe(
      'wf-123',
    );
    expect(() => getRequiredRouteParameter({}, 'workflowId', 'GET /example')).toThrow(
      'Missing route parameter "workflowId" for GET /example',
    );
  });

  it('recognizes valid operation faults and rejects invalid shapes', () => {
    expect(
      isOperationFaultLike({
        code: 'Conflict',
        message: 'conflict',
        data: { reason: 'duplicate' },
      }),
    ).toBe(true);
    expect(isOperationFaultLike(null)).toBe(false);
    expect(
      isOperationFaultLike({
        code: 'Conflict',
        message: 'conflict',
        data: null,
      }),
    ).toBe(false);
    expect(
      isOperationFaultLike({
        __proto__: { code: 'Conflict' },
        message: 'conflict',
        data: { reason: 'duplicate' },
      }),
    ).toBe(false);
    expect(
      isOperationFaultLike({
        code: 'InvalidParams',
        message: 'bad input',
        data: [],
      }),
    ).toBe(false);
    const throwingGetter = {
      code: 'Conflict',
      message: 'conflict',
      get data() {
        throw new Error('should not escape');
      },
    };
    expect(isOperationFaultLike(throwingGetter)).toBe(false);
  });
});

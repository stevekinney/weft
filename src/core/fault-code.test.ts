import { describe, expect, it } from 'bun:test';

import {
  FAULT_CODE_TO_FAILURE_CATEGORY,
  failureCategoryForFaultCode,
  isFaultCode,
  type FaultCode,
} from './fault-code.ts';

const ALL_FAULT_CODES: readonly FaultCode[] = [
  'Unauthorized',
  'Forbidden',
  'NotFound',
  'Conflict',
  'Unprocessable',
  'Timeout',
  'RateLimited',
  'NotImplemented',
  'UnsupportedTransport',
  'SubscriptionOverflow',
  'InvalidParams',
  'MethodNotFound',
  'EngineFailure',
];

describe('isFaultCode', () => {
  it('accepts every known fault code', () => {
    for (const code of ALL_FAULT_CODES) {
      expect(isFaultCode(code)).toBe(true);
    }
  });

  it('rejects unknown strings', () => {
    expect(isFaultCode('Teapot')).toBe(false);
    expect(isFaultCode('')).toBe(false);
    expect(isFaultCode('notfound')).toBe(false); // case sensitive
  });

  it('rejects non-string values', () => {
    expect(isFaultCode(undefined)).toBe(false);
    expect(isFaultCode(null)).toBe(false);
    expect(isFaultCode(404)).toBe(false);
    expect(isFaultCode({ code: 'NotFound' })).toBe(false);
  });
});

describe('FAULT_CODE_TO_FAILURE_CATEGORY', () => {
  it('maps each code to its documented category', () => {
    const expected = {
      Unauthorized: 'application',
      Forbidden: 'application',
      NotFound: 'application',
      Conflict: 'application',
      Unprocessable: 'application',
      InvalidParams: 'application',
      MethodNotFound: 'application',
      Timeout: 'timeout',
      RateLimited: 'resource',
      SubscriptionOverflow: 'resource',
      NotImplemented: 'system',
      UnsupportedTransport: 'system',
      EngineFailure: 'system',
    } as const;
    expect(FAULT_CODE_TO_FAILURE_CATEGORY).toEqual(expected);
  });

  it('covers exactly the known fault codes', () => {
    expect(Object.keys(FAULT_CODE_TO_FAILURE_CATEGORY).toSorted()).toEqual(
      [...ALL_FAULT_CODES].toSorted(),
    );
  });

  it('is frozen', () => {
    expect(Object.isFrozen(FAULT_CODE_TO_FAILURE_CATEGORY)).toBe(true);
  });

  it('never maps to cancellation (not on the REST wire)', () => {
    for (const code of ALL_FAULT_CODES) {
      expect(FAULT_CODE_TO_FAILURE_CATEGORY[code]).not.toBe('cancellation');
    }
  });
});

describe('failureCategoryForFaultCode', () => {
  it('returns the mapped category for every code', () => {
    for (const code of ALL_FAULT_CODES) {
      expect(failureCategoryForFaultCode(code)).toBe(FAULT_CODE_TO_FAILURE_CATEGORY[code]);
    }
  });
});

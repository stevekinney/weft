import { describe, expect, test } from 'bun:test';

import { narrowRegistryWorkflows } from './registry-types.ts';

describe('narrowRegistryWorkflows', () => {
  test('returns {} for non-object input', () => {
    expect(narrowRegistryWorkflows(undefined)).toEqual({});
    expect(narrowRegistryWorkflows(null)).toEqual({});
    expect(narrowRegistryWorkflows('nope')).toEqual({});
  });

  test('keeps entries that are plain objects', () => {
    const result = narrowRegistryWorkflows({
      'order-processing': { inputSchema: { type: 'object' } },
      'no-schema': {},
    });
    expect(result).toEqual({
      'order-processing': { inputSchema: { type: 'object' } },
      'no-schema': {},
    });
  });

  test('drops entries that are not plain objects', () => {
    const result = narrowRegistryWorkflows({
      valid: { description: 'ok' },
      invalid: 'not an object',
      alsoInvalid: null,
    });
    expect(result).toEqual({ valid: { description: 'ok' } });
  });
});

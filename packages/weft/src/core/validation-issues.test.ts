import { describe, expect, it } from 'bun:test';
import type { ZodIssue } from 'zod';

import { flattenZodIssue } from './validation-issues.ts';

describe('flattenZodIssue', () => {
  it('preserves mixed path segments, message, code, and order', () => {
    const issue = {
      path: ['items', 2, { toString: () => 'metadata' }],
      message: 'Expected a string',
      code: 'invalid_type',
    } as unknown as ZodIssue;

    expect(flattenZodIssue(issue)).toEqual({
      path: ['items', 2, 'metadata'],
      message: 'Expected a string',
      code: 'invalid_type',
    });
  });
});

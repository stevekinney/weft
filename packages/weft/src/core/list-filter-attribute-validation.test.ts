/**
 * Unit tests for `normalizeAttributeFilter`'s defensive validation branches.
 *
 * Every branch here is also structurally guarded by `attributeFilterSchema`
 * at `normalizeListFilter`'s public entry point (`list-filter-validation.ts`'s
 * `listFilterObjectSchema.safeParse`), so none of these shapes can actually
 * reach `normalizeAttributeFilter` through that path today. The function is
 * exported in its own right, though, and its parameter type
 * (`z.infer<typeof attributeFilterSchema>`) is a compile-time contract only
 * — nothing stops a future caller (or a schema change upstream) from handing
 * it a runtime value that doesn't conform. These tests call it directly with
 * deliberately malformed input (the same TypeScript-cast technique used
 * elsewhere in this suite for runtime guards behind a narrower static type)
 * to prove the function's own validation actually rejects what its type
 * signature merely assumes.
 */
import { describe, expect, it } from 'bun:test';

import type { z } from 'zod';
import type { attributeFilterSchema } from './list-filter-attribute-validation.ts';
import { normalizeAttributeFilter } from './list-filter-attribute-validation.ts';
import { ListFilterValidationError } from './list-filter-validation-error.ts';

type RawAttributeFilter = z.infer<typeof attributeFilterSchema>;

function normalizeAndCaptureError(attribute: unknown, index: number): ListFilterValidationError {
  try {
    normalizeAttributeFilter(attribute as RawAttributeFilter, index);
  } catch (error) {
    expect(error).toBeInstanceOf(ListFilterValidationError);
    return error as ListFilterValidationError;
  }
  throw new Error('expected normalizeAttributeFilter to throw');
}

describe('normalizeAttributeFilter — defensive runtime validation', () => {
  it('rejects a key that is neither a string nor a search attribute handle', () => {
    const error = normalizeAndCaptureError({ key: 42 }, 3);
    expect(error.issues).toEqual([
      { path: ['attributes', 3, 'key'], message: 'Invalid search attribute key', code: 'custom' },
    ]);
  });

  it('rejects a string-keyed value that is not a scalar or scalar array', () => {
    const error = normalizeAndCaptureError({ key: 'customerId', value: { nested: true } }, 0);
    expect(error.issues).toEqual([
      {
        path: ['attributes', 0, 'value'],
        message: 'Invalid search attribute value',
        code: 'custom',
      },
    ]);
  });

  it('rejects a string-keyed range value that is an array instead of a scalar', () => {
    const error = normalizeAndCaptureError({ key: 'customerId', gt: ['a', 'b'] }, 1);
    expect(error.issues).toEqual([
      {
        path: ['attributes', 1, 'gt'],
        message: 'Invalid search attribute range value',
        code: 'custom',
      },
    ]);
  });

  it('rejects a handle-keyed range value that is not a number or Date', () => {
    const handle = { name: 'amount', type: 'number' };
    const error = normalizeAndCaptureError({ key: handle, lte: 'not-a-number' }, 2);
    expect(error.issues).toEqual([
      {
        path: ['attributes', 2, 'lte'],
        message: 'Invalid search attribute handle range value',
        code: 'custom',
      },
    ]);
  });

  it('rejects a handle-keyed value that fails the handle type check', () => {
    const handle = { name: 'amount', type: 'number' };
    const error = normalizeAndCaptureError({ key: handle, value: 'not-a-number' }, 4);
    expect(error.issues).toEqual([
      {
        path: ['attributes', 4, 'value'],
        message: 'Invalid value for search attribute handle',
        code: 'custom',
      },
    ]);
  });
});

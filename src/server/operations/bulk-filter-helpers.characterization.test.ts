/**
 * Characterization tests for `parseBulkListFilterFromBody`.
 *
 * Field-processing order in source (lines 231–290):
 *   1. status
 *   2. type
 *   3. tags
 *   4. attributes
 *   5. limit
 *   6. offset
 *   7. idPrefix
 *   8. tenantId
 *   9. failureCategory
 *  10. createdAt
 *  11. updatedAt
 *  12. executionDeadline
 *
 * Adjacent-pair tests assert that when two consecutive fields are invalid, the
 * error for the earlier-listed field surfaces first. The all-bad test passes
 * all validatable fields with invalid values and asserts the first error wins.
 */

import { describe, expect, it } from 'bun:test';

import { parseBulkListFilterFromBody } from './bulk-filter-helpers.ts';

function wrap(filter: unknown): unknown {
  return { filter };
}

describe('parseBulkListFilterFromBody — validation precedence', () => {
  // --- adjacent pair: status before type ---
  it('reports status error before type error when both are invalid', () => {
    expect(() =>
      parseBulkListFilterFromBody(wrap({ status: 42, type: 99 })),
    ).toThrow('Field "filter.status" must be a string or an array of strings');
  });

  // --- adjacent pair: type before tags ---
  it('reports type error before tags error when both are invalid', () => {
    expect(() =>
      parseBulkListFilterFromBody(wrap({ type: 99, tags: 'not-an-array' })),
    ).toThrow('Field "filter.type" must be a string');
  });

  // --- adjacent pair: tags before attributes ---
  it('reports tags error before attributes error when both are invalid', () => {
    expect(() =>
      parseBulkListFilterFromBody(wrap({ tags: 42, attributes: 'not-an-array' })),
    ).toThrow('Field "filter.tags"');
  });

  // --- adjacent pair: attributes before limit ---
  it('reports attributes error before limit error when both are invalid', () => {
    expect(() =>
      parseBulkListFilterFromBody(wrap({ attributes: 'not-an-array', limit: -1 })),
    ).toThrow('Field "filter.attributes" must be an array');
  });

  // --- adjacent pair: limit before offset ---
  it('reports limit error before offset error when both are invalid', () => {
    expect(() =>
      parseBulkListFilterFromBody(wrap({ limit: -1, offset: -1 })),
    ).toThrow('Field "filter.limit" must be a non-negative number');
  });

  // --- adjacent pair: offset before tenantId ---
  // idPrefix is not validated (any string accepted), so skip to tenantId
  it('reports offset error before tenantId error when both are invalid', () => {
    expect(() =>
      parseBulkListFilterFromBody(wrap({ offset: -1, tenantId: 42 })),
    ).toThrow('Field "filter.offset" must be a non-negative number');
  });

  // --- adjacent pair: tenantId before failureCategory ---
  it('reports tenantId error before failureCategory error when both are invalid', () => {
    expect(() =>
      parseBulkListFilterFromBody(wrap({ tenantId: 42, failureCategory: 'not-a-category' })),
    ).toThrow('Field "filter.tenantId" must be a string or an array of strings');
  });

  // --- adjacent pair: createdAt before updatedAt ---
  it('reports createdAt error before updatedAt error when both are invalid', () => {
    expect(() =>
      parseBulkListFilterFromBody(wrap({ createdAt: 'bad', updatedAt: 'bad' })),
    ).toThrow('Time-range filter must be an object with gte/gt/lte/lt numeric bounds');
  });

  // --- adjacent pair: updatedAt before executionDeadline ---
  it('reports updatedAt error before executionDeadline error when both are invalid', () => {
    expect(() =>
      parseBulkListFilterFromBody(wrap({ updatedAt: 'bad', executionDeadline: 'bad' })),
    ).toThrow('Time-range filter must be an object with gte/gt/lte/lt numeric bounds');
  });

  // --- all-bad: first validatable field (status) wins ---
  it('reports the status error when all validatable fields are invalid', () => {
    expect(() =>
      parseBulkListFilterFromBody(
        wrap({
          status: 42,
          type: 99,
          tags: 42,
          attributes: 'not-an-array',
          limit: -1,
          offset: -1,
          tenantId: 42,
          createdAt: 'bad',
          updatedAt: 'bad',
          executionDeadline: 'bad',
        }),
      ),
    ).toThrow('Field "filter.status" must be a string or an array of strings');
  });
});

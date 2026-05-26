import { describe, expect, it } from 'bun:test';

import {
  AGGREGATE_DEFAULT_LIMIT,
  AGGREGATE_MAX_LIMIT,
  AggregateOptionsValidationError,
  aggregateOptionsObjectSchema,
  normalizeAggregateOptions,
} from './aggregate-validation.ts';

describe('normalizeAggregateOptions', () => {
  it('accepts each fixed groupBy literal', () => {
    for (const groupBy of ['status', 'type', 'failureCategory'] as const) {
      expect(normalizeAggregateOptions({ groupBy }).groupBy).toBe(groupBy);
    }
  });

  it('accepts an attribute groupBy', () => {
    expect(normalizeAggregateOptions({ groupBy: { attribute: 'customerTier' } }).groupBy).toEqual({
      attribute: 'customerTier',
    });
  });

  it('rejects an empty attribute name', () => {
    expect(() => normalizeAggregateOptions({ groupBy: { attribute: '' } })).toThrow(
      AggregateOptionsValidationError,
    );
  });

  it('rejects extra keys on the attribute object', () => {
    expect(() => normalizeAggregateOptions({ groupBy: { attribute: 'tier', extra: 1 } })).toThrow(
      AggregateOptionsValidationError,
    );
  });

  it('rejects an unknown groupBy literal', () => {
    expect(() => normalizeAggregateOptions({ groupBy: 'bogus' })).toThrow(
      AggregateOptionsValidationError,
    );
  });

  it('accepts a limit within bounds', () => {
    expect(normalizeAggregateOptions({ groupBy: 'status', limit: 10 }).limit).toBe(10);
  });

  it('rejects limit below 1', () => {
    expect(() => normalizeAggregateOptions({ groupBy: 'status', limit: 0 })).toThrow(
      AggregateOptionsValidationError,
    );
  });

  it('rejects limit above the maximum', () => {
    expect(() =>
      normalizeAggregateOptions({ groupBy: 'status', limit: AGGREGATE_MAX_LIMIT + 1 }),
    ).toThrow(AggregateOptionsValidationError);
  });

  it('rejects unknown top-level keys', () => {
    expect(() => normalizeAggregateOptions({ groupBy: 'status', extra: 1 })).toThrow(
      AggregateOptionsValidationError,
    );
  });
});

describe('aggregateOptionsObjectSchema', () => {
  it('exposes the concrete ZodObject for server-side composition', () => {
    const result = aggregateOptionsObjectSchema.safeParse({ groupBy: 'type' });
    expect(result.success).toBe(true);
  });
});

describe('aggregate constants', () => {
  it('has sensible defaults', () => {
    expect(AGGREGATE_DEFAULT_LIMIT).toBeGreaterThan(0);
    expect(AGGREGATE_DEFAULT_LIMIT).toBeLessThanOrEqual(AGGREGATE_MAX_LIMIT);
  });
});

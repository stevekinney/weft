import { describe, expect, it } from 'bun:test';

import type { ListFilter } from './types/options.ts';

import {
  ListFilterValidationError,
  listFilterObjectSchema,
  normalizeListFilter,
} from './list-filter-validation.ts';

describe('normalizeListFilter', () => {
  describe('existing fields', () => {
    it('accepts an empty filter', () => {
      expect(normalizeListFilter({})).toEqual({});
      expect(normalizeListFilter(undefined)).toEqual({});
    });

    it('accepts the full filter shape (status/type/tags/attributes/limit/offset)', () => {
      const filter: ListFilter = {
        status: ['running', 'pending'],
        type: 'order',
        tags: ['nightly'],
        attributes: [{ key: 'customerId', value: 'acme' }],
        limit: 20,
        offset: 40,
      };
      expect(normalizeListFilter(filter)).toEqual(filter);
    });

    it('rejects unknown top-level keys', () => {
      expect(() => normalizeListFilter({ unknown: 1 })).toThrow(ListFilterValidationError);
    });
  });

  describe('idPrefix', () => {
    it('accepts safe-subset prefixes', () => {
      expect(normalizeListFilter({ idPrefix: 'order-' }).idPrefix).toBe('order-');
      expect(normalizeListFilter({ idPrefix: 'A_b-2' }).idPrefix).toBe('A_b-2');
    });

    it('rejects empty idPrefix', () => {
      expect(() => normalizeListFilter({ idPrefix: '' })).toThrow(ListFilterValidationError);
    });

    it('rejects idPrefix containing ":"', () => {
      expect(() => normalizeListFilter({ idPrefix: 'a:b' })).toThrow(ListFilterValidationError);
    });

    it('rejects idPrefix with unicode or whitespace', () => {
      expect(() => normalizeListFilter({ idPrefix: 'a b' })).toThrow(ListFilterValidationError);
      expect(() => normalizeListFilter({ idPrefix: 'café' })).toThrow(ListFilterValidationError);
    });
  });

  describe('TimeRange filters', () => {
    it('accepts each individual bound', () => {
      expect(normalizeListFilter({ createdAt: { gte: 1 } }).createdAt).toEqual({ gte: 1 });
      expect(normalizeListFilter({ updatedAt: { lt: 2 } }).updatedAt).toEqual({ lt: 2 });
      expect(
        normalizeListFilter({ executionDeadline: { gt: 1, lte: 2 } }).executionDeadline,
      ).toEqual({
        gt: 1,
        lte: 2,
      });
    });

    it('rejects empty range objects', () => {
      expect(() => normalizeListFilter({ createdAt: {} })).toThrow(ListFilterValidationError);
    });

    it('rejects conflicting bounds (gt + gte)', () => {
      expect(() => normalizeListFilter({ createdAt: { gt: 1, gte: 2 } })).toThrow(
        ListFilterValidationError,
      );
    });

    it('rejects conflicting bounds (lt + lte)', () => {
      expect(() => normalizeListFilter({ createdAt: { lt: 1, lte: 2 } })).toThrow(
        ListFilterValidationError,
      );
    });

    it('rejects unknown range keys', () => {
      expect(() => normalizeListFilter({ createdAt: { gte: 1, foo: 2 } })).toThrow(
        ListFilterValidationError,
      );
    });
  });

  describe('failureCategory', () => {
    it('accepts a single value from the enum', () => {
      expect(normalizeListFilter({ failureCategory: 'resource' }).failureCategory).toBe('resource');
    });

    it('accepts an array of enum values', () => {
      expect(
        normalizeListFilter({ failureCategory: ['application', 'system'] }).failureCategory,
      ).toEqual(['application', 'system']);
    });

    it('rejects unknown enum values', () => {
      expect(() => normalizeListFilter({ failureCategory: 'bogus' })).toThrow(
        ListFilterValidationError,
      );
    });

    it('rejects legacy AI-ontology enum values', () => {
      expect(() => normalizeListFilter({ failureCategory: 'planning' })).toThrow(
        ListFilterValidationError,
      );
    });
  });

  describe('error issues', () => {
    it('flattens multiple validation issues with paths', () => {
      try {
        normalizeListFilter({ idPrefix: '', type: '' });
        expect.unreachable('expected throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ListFilterValidationError);
        const issues = (error as ListFilterValidationError).issues;
        expect(issues.length).toBeGreaterThanOrEqual(2);
        const paths = issues.map((issue) => issue.path.join('.'));
        expect(paths).toContain('idPrefix');
        expect(paths).toContain('type');
      }
    });
  });
});

describe('listFilterObjectSchema', () => {
  it('supports .omit() for aggregate composition', () => {
    // .omit() is unavailable on the structural ZodType alias; this property
    // is what unblocks aggregate-workflows.ts composing the schema. Catch
    // any regression here at compile time as well as at runtime.
    const omitted = listFilterObjectSchema.omit({ limit: true, offset: true });
    const parsed = omitted.safeParse({ status: 'running' });
    expect(parsed.success).toBe(true);
  });
});

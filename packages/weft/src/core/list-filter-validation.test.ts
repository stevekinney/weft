import { describe, expect, it } from 'bun:test';

import type { ListFilter } from './types/list-options.ts';
import {
  searchAttribute,
  type SearchAttributeHandle,
  type SearchAttributeValue,
} from './types/search-attributes.ts';

import { ListFilterValidationError } from './list-filter-validation-error.ts';
import { listFilterObjectSchema, normalizeListFilter } from './list-filter-validation.ts';

describe('normalizeListFilter', () => {
  describe('existing fields', () => {
    it('accepts an empty filter', () => {
      expect(normalizeListFilter({})).toEqual({});
      expect(normalizeListFilter(undefined)).toEqual({});
    });

    it('accepts the full filter shape', () => {
      const filter: ListFilter = {
        status: ['running', 'pending'],
        type: 'order',
        scheduleId: 'daily-report',
        parentWorkflowId: 'order-parent',
        parentWorkflowExecutionToken: 'parent-run-token',
        tags: ['nightly'],
        attributes: [{ key: 'customerId', value: 'acme' }],
        limit: 20,
        offset: 40,
      };
      expect(normalizeListFilter(filter)).toEqual(filter);
    });

    it('preserves typed search attribute handles and explicit undefined keys', () => {
      const customerId = searchAttribute('customerId', 'string');
      const normalized = normalizeListFilter({
        type: undefined,
        attributes: [{ key: customerId, value: 'acme' }],
      });

      expect(Object.keys(normalized)).toEqual(['type', 'attributes']);
      expect(normalized.type).toBeUndefined();
      expect(normalized.attributes?.[0]?.key).toBe(customerId);
    });

    it('preserves every typed handle scalar and any-of value', () => {
      const first = new Date(0);
      const second = new Date(1_000);
      type ExpectedHandleValue = SearchAttributeValue | number[] | boolean[] | Date[];
      const cases: Array<{
        key: SearchAttributeHandle;
        scalar: ExpectedHandleValue;
        anyOf: ExpectedHandleValue;
      }> = [
        { key: searchAttribute('text', 'string'), scalar: 'one', anyOf: ['one', 'two'] },
        { key: searchAttribute('amount', 'number'), scalar: 1, anyOf: [1, 2] },
        { key: searchAttribute('count', 'integer'), scalar: 1, anyOf: [1, 2] },
        { key: searchAttribute('enabled', 'boolean'), scalar: true, anyOf: [true, false] },
        {
          key: searchAttribute('labels', { type: 'array', items: { type: 'string' } }),
          scalar: 'one',
          anyOf: ['one', 'two'],
        },
        {
          key: searchAttribute('createdAt', { type: 'string', format: 'date-time' }),
          scalar: first,
          anyOf: [first, second],
        },
      ];

      for (const { key, scalar, anyOf } of cases) {
        expect(normalizeListFilter({ attributes: [{ key, value: scalar }] }).attributes).toEqual([
          { key, value: scalar },
        ]);
        expect(normalizeListFilter({ attributes: [{ key, value: anyOf }] }).attributes).toEqual([
          { key, value: anyOf },
        ]);
      }
    });

    it('preserves explicit undefined attribute fields', () => {
      const normalized = normalizeListFilter({
        attributes: [{ key: 'customerId', value: undefined, gte: undefined }],
      });

      expect(Object.keys(normalized.attributes![0]!)).toEqual(['key', 'value', 'gte']);
      expect(normalized.attributes).toEqual([
        { key: 'customerId', value: undefined, gte: undefined },
      ]);
    });

    it('rejects unknown top-level keys', () => {
      expect(() => normalizeListFilter({ unknown: 1 })).toThrow(ListFilterValidationError);
    });

    it('rejects an empty schedule id', () => {
      expect(() => normalizeListFilter({ scheduleId: '' })).toThrow(ListFilterValidationError);
    });

    it('requires a parent workflow id when filtering by parent execution token', () => {
      expect(() =>
        normalizeListFilter({ parentWorkflowExecutionToken: 'parent-run-token' }),
      ).toThrow(ListFilterValidationError);
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

    it('rejects a retired failureCategory value not in the current enum', () => {
      // `planning` is a previously-used failureCategory value that is no longer
      // part of the current FailureCategory enum; the filter rejects it like any
      // other value outside the enum.
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
        if (!(error instanceof ListFilterValidationError)) throw error;
        const issues = error.issues;
        expect(issues.length).toBeGreaterThanOrEqual(2);
        const paths = issues.map((issue) => issue.path.join('.'));
        expect(paths).toContain('idPrefix');
        expect(paths).toContain('type');
      }
    });

    it('preserves nested array paths, issue codes, order, and the rendered message', () => {
      try {
        normalizeListFilter({ status: ['running', 'bogus'] });
        expect.unreachable('expected throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ListFilterValidationError);
        if (!(error instanceof ListFilterValidationError)) throw error;
        expect(error.issues).toEqual([
          {
            path: ['status'],
            message: 'Invalid input',
            code: 'invalid_union',
          },
        ]);
        expect(error.message).toBe('status: Invalid input');
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

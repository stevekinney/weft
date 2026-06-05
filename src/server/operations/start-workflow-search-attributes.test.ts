import { describe, expect, it } from 'bun:test';

import { StartWorkflowValidationError } from '../../core/start-workflow-validation.ts';
import type { SearchAttributeSchema } from '../../core/types.ts';
import { coerceStartWorkflowSearchAttributes } from './start-workflow-search-attributes.ts';

const FIELD = 'Field "searchAttributes"';

describe('coerceStartWorkflowSearchAttributes', () => {
  it('rejects a non-object value', () => {
    expect(() => coerceStartWorkflowSearchAttributes('nope', FIELD, undefined)).toThrow(
      new StartWorkflowValidationError(`${FIELD} must be an object`),
    );
  });

  it('rejects an array (arrays are typeof object but not a record of attributes)', () => {
    expect(() => coerceStartWorkflowSearchAttributes(['a'], FIELD, undefined)).toThrow(
      `${FIELD} must be an object`,
    );
  });

  it('rejects null', () => {
    expect(() => coerceStartWorkflowSearchAttributes(null, FIELD, undefined)).toThrow(
      `${FIELD} must be an object`,
    );
  });

  it('rejects a value that is not a string, number, boolean, Date, or string array', () => {
    expect(() =>
      coerceStartWorkflowSearchAttributes({ bad: { nested: true } }, FIELD, undefined),
    ).toThrow(`${FIELD}.bad must be a string, number, boolean, Date, or string array`);
  });

  it('passes values through unchanged when no schema is supplied', () => {
    const result = coerceStartWorkflowSearchAttributes(
      { name: 'acme', attempt: 3, active: true, labels: ['x', 'y'] },
      FIELD,
      undefined,
    );

    expect(result).toEqual({ name: 'acme', attempt: 3, active: true, labels: ['x', 'y'] });
  });

  it('uses a null-prototype record so untrusted keys cannot reach Object.prototype', () => {
    const result = coerceStartWorkflowSearchAttributes({ customerId: 'acme' }, FIELD, undefined);

    expect(Object.getPrototypeOf(result)).toBeNull();
  });

  it('rejects an attribute key not present in the registered schema', () => {
    const schema: SearchAttributeSchema = { customerId: { type: 'string' } };

    expect(() =>
      coerceStartWorkflowSearchAttributes({ unknownKey: 'value' }, FIELD, schema),
    ).toThrow('Unknown search attribute "unknownKey". Registered attributes: customerId');
  });

  it('normalizes a date-time string attribute into a Date', () => {
    const schema: SearchAttributeSchema = {
      createdAt: { type: 'string', format: 'date-time' },
    };

    const result = coerceStartWorkflowSearchAttributes(
      { createdAt: '2026-01-02T03:04:05.000Z' },
      FIELD,
      schema,
    );

    expect(result['createdAt']).toEqual(new Date('2026-01-02T03:04:05.000Z'));
  });

  it('rejects an unparseable date-time string', () => {
    const schema: SearchAttributeSchema = {
      createdAt: { type: 'string', format: 'date-time' },
    };

    expect(() =>
      coerceStartWorkflowSearchAttributes({ createdAt: 'not-a-date' }, FIELD, schema),
    ).toThrow(`${FIELD}.createdAt must be a valid date-time string`);
  });

  it('wraps a schema type-mismatch from validateAttributeType as a validation error', () => {
    const schema: SearchAttributeSchema = { attempt: { type: 'number' } };

    expect(() => coerceStartWorkflowSearchAttributes({ attempt: 'three' }, FIELD, schema)).toThrow(
      StartWorkflowValidationError,
    );
  });

  it('accepts a value that matches the registered schema type', () => {
    const schema: SearchAttributeSchema = { attempt: { type: 'number' } };

    const result = coerceStartWorkflowSearchAttributes({ attempt: 5 }, FIELD, schema);

    expect(result).toEqual({ attempt: 5 });
  });
});

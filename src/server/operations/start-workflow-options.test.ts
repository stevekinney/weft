import { describe, expect, it } from 'bun:test';

import { StartWorkflowValidationError } from '../../core/start-workflow-validation.ts';
import type { SearchAttributeSchema } from '../../core/types.ts';
import {
  buildSharedStartWorkflowOptions,
  buildStartOrSignalWorkflowOptions,
  coerceStartWorkflowSearchAttributes,
} from './start-workflow-options.ts';

const FIELD = 'Field "searchAttributes"';

describe('buildSharedStartWorkflowOptions', () => {
  it('returns an empty options object when no fields are supplied', () => {
    expect(buildSharedStartWorkflowOptions({}, undefined)).toEqual({});
  });

  it('coerces every supported field in one pass', () => {
    const startAt = Date.UTC(2999, 0, 1);
    const options = buildSharedStartWorkflowOptions(
      {
        id: 'wf-1',
        executionTimeout: '30s',
        startAt,
        tags: ['alpha', 'beta'],
        idempotencyKey: 'key-1',
      },
      undefined,
    );

    expect(options.id).toBe('wf-1');
    expect(options.startAt).toBe(startAt);
    expect(options.tags).toEqual(['alpha', 'beta']);
    expect(options.idempotencyKey).toBe('key-1');
    expect(options.executionTimeout).toBeDefined();
  });

  it('rejects supplying both startAt and startAfter', () => {
    expect(() =>
      buildSharedStartWorkflowOptions(
        { startAt: Date.UTC(2999, 0, 1), startAfter: '1s' },
        undefined,
      ),
    ).toThrow(new StartWorkflowValidationError('Provide only one of startAt or startAfter'));
  });

  it('coerces searchAttributes against the supplied schema', () => {
    const schema: SearchAttributeSchema = { customerId: { type: 'string' } };
    const options = buildSharedStartWorkflowOptions(
      { searchAttributes: { customerId: 'acme' } },
      schema,
    );

    expect(options.searchAttributes).toEqual({ customerId: 'acme' });
  });

  it('ignores onTerminalConflict — it is not part of the shared transport surface', () => {
    // The shared builder feeds the transport start operation, which stays
    // non-restart-capable. startOrSignal has its own narrower option builder.
    const options = buildSharedStartWorkflowOptions(
      { id: 'wf-restart', onTerminalConflict: 'start-new' } as Record<string, unknown>,
      undefined,
    );
    expect('onTerminalConflict' in options).toBe(false);
  });

  it('propagates a malformed-field validation error (e.g. a non-string id)', () => {
    expect(() => buildSharedStartWorkflowOptions({ id: 42 }, undefined)).toThrow(
      StartWorkflowValidationError,
    );
  });
});

describe('buildStartOrSignalWorkflowOptions', () => {
  it('rejects an invalid onTerminalConflict value', () => {
    expect(() =>
      buildStartOrSignalWorkflowOptions({ onTerminalConflict: 'restart-later' }, undefined),
    ).toThrow(
      new StartWorkflowValidationError('Field "onTerminalConflict" must be "error" or "start-new"'),
    );
  });
});

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

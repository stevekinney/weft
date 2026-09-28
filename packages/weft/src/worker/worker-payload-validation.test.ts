import { describe, expect, it } from 'bun:test';

import { normalizeWorkerJsonValue } from './activity-table.ts';
import { parseWorkerToServerMessage } from './protocol.ts';
import { encodeStrictWorkerJsonValue, WorkerJsonValidationError } from './strict-json.ts';

function expectStrictJsonRejection(value: unknown, text: string): void {
  expect(() => encodeStrictWorkerJsonValue(value)).toThrow(WorkerJsonValidationError);
  expect(() => encodeStrictWorkerJsonValue(value)).toThrow(text);
}

describe('strict worker JSON validation', () => {
  it('accepts plain JSON values without changing them', () => {
    expect(encodeStrictWorkerJsonValue({ ok: [true, 1, 'yes', null] })).toEqual({
      ok: [true, 1, 'yes', null],
    });
  });

  it.each([
    ['undefined', undefined, 'undefined'],
    ['function', () => null, 'function'],
    ['symbol', Symbol('bad'), 'symbol'],
    ['BigInt', 1n, 'BigInt'],
    ['NaN', Number.NaN, 'finite'],
    ['infinity', Number.POSITIVE_INFINITY, 'finite'],
    ['negative zero', -0, 'negative zero'],
    ['Date', new Date(0), 'Date is not a plain JSON object'],
    ['Map', new Map([['a', 1]]), 'Map is not a plain JSON object'],
  ])('rejects %s instead of normalizing it', (_label, value, message) => {
    expectStrictJsonRejection(value, message);
  });

  it('rejects nested unsupported values with an actionable path', () => {
    expectStrictJsonRejection({ nested: { value: undefined } }, 'value.nested.value');
  });

  it('rejects sparse arrays before JSON can coerce the hole to null', () => {
    const sparse: number[] = [];
    sparse.length = 3;
    sparse[0] = 1;
    sparse[2] = 3;
    expectStrictJsonRejection(sparse, 'value[1]');
  });

  it('rejects cycles before JSON.stringify can throw an unclassified error', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expectStrictJsonRejection(cyclic, 'cycle');
  });

  it('keeps the legacy normalizeWorkerJsonValue name as strict validation', () => {
    expect(() => normalizeWorkerJsonValue(undefined)).toThrow('undefined');
    expect(normalizeWorkerJsonValue({ ok: true })).toEqual({ ok: true });
  });

  it('rejects malformed completed task results at the protocol boundary', () => {
    const parsed = parseWorkerToServerMessage({
      type: 'taskResult',
      operationId: 'op-1',
      status: 'completed',
      value: Number.NaN,
      attemptToken: 'attempt-1',
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe('invalid_message');
    expect(parsed.error.message).toBe('completed taskResult.value must be valid JSON');
  });
});

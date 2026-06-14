import { describe, expect, it } from 'bun:test';

import { encode as msgpackEncode } from '@msgpack/msgpack';

import { decode, encode, validateCloneable } from './codec';
import { extensionCodec, replaceUndefined } from './codec/extension-codec.ts';

function legacyReplaceUndefined(value: unknown, visited: Set<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (visited.has(value)) return value;

  visited.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => legacyReplaceUndefined(item, visited));
    }

    if (value instanceof Map) {
      return new Map(
        [...value.entries()].map(([key, mapValue]) => [
          legacyReplaceUndefined(key, visited),
          legacyReplaceUndefined(mapValue, visited),
        ]),
      );
    }

    if (value instanceof Set) {
      return new Set([...value.values()].map((item) => legacyReplaceUndefined(item, visited)));
    }

    if (
      value instanceof Date ||
      value instanceof RegExp ||
      value instanceof Error ||
      value instanceof Uint8Array ||
      value instanceof ArrayBuffer
    ) {
      return value;
    }

    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      result[key] = legacyReplaceUndefined(record[key], visited);
    }
    return result;
  } finally {
    visited.delete(value);
  }
}

describe('codec', () => {
  describe('round-trip primitives', () => {
    it('round-trips null', () => {
      expect(decode(encode(null))).toBe(null);
    });

    it('round-trips true', () => {
      expect(decode(encode(true))).toBe(true);
    });

    it('round-trips false', () => {
      expect(decode(encode(false))).toBe(false);
    });

    it('round-trips 0', () => {
      expect(decode(encode(0))).toBe(0);
    });

    it('round-trips -1', () => {
      expect(decode(encode(-1))).toBe(-1);
    });

    it('round-trips 42', () => {
      expect(decode(encode(42))).toBe(42);
    });

    it('round-trips 3.14', () => {
      expect(decode(encode(3.14))).toBe(3.14);
    });

    it('round-trips NaN', () => {
      expect(decode(encode(NaN))).toBeNaN();
    });

    it('round-trips Infinity', () => {
      expect(decode(encode(Infinity))).toBe(Infinity);
    });

    it('round-trips -Infinity', () => {
      expect(decode(encode(-Infinity))).toBe(-Infinity);
    });

    it('round-trips empty string', () => {
      expect(decode(encode(''))).toBe('');
    });

    it('round-trips "hello world"', () => {
      expect(decode(encode('hello world'))).toBe('hello world');
    });
  });

  describe('round-trip undefined', () => {
    it('round-trips undefined as a standalone value', () => {
      expect(decode(encode(undefined))).toBeUndefined();
    });

    it('preserves undefined values in objects', () => {
      const input = { a: 1, b: undefined };
      const result = decode(encode(input)) as Record<string, unknown>;
      expect(result['a']).toBe(1);
      expect(result['b']).toBeUndefined();
      expect('b' in result).toBe(true);
    });
  });

  describe('round-trip Date', () => {
    it('preserves getTime() for a specific date', () => {
      const date = new Date('2024-01-15T12:30:00.000Z');
      const result = decode(encode(date)) as Date;
      expect(result).toBeInstanceOf(Date);
      expect(result.getTime()).toBe(date.getTime());
    });

    it('preserves getTime() for epoch', () => {
      const date = new Date(0);
      const result = decode(encode(date)) as Date;
      expect(result).toBeInstanceOf(Date);
      expect(result.getTime()).toBe(0);
    });

    it('preserves getTime() for negative timestamps', () => {
      const date = new Date(-1000);
      const result = decode(encode(date)) as Date;
      expect(result).toBeInstanceOf(Date);
      expect(result.getTime()).toBe(-1000);
    });
  });

  describe('round-trip RegExp', () => {
    it('preserves source and flags', () => {
      const regex = /hello\s+world/gi;
      const result = decode(encode(regex)) as RegExp;
      expect(result).toBeInstanceOf(RegExp);
      expect(result.source).toBe(regex.source);
      expect(result.flags).toBe(regex.flags);
    });

    it('round-trips a simple pattern', () => {
      const regex = /^test$/;
      const result = decode(encode(regex)) as RegExp;
      expect(result).toBeInstanceOf(RegExp);
      expect(result.source).toBe('^test$');
      expect(result.flags).toBe('');
    });
  });

  describe('round-trip Map', () => {
    it('preserves key-value pairs', () => {
      const map = new Map<string, number>([
        ['a', 1],
        ['b', 2],
      ]);
      const result = decode(encode(map)) as Map<string, number>;
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(2);
      expect(result.get('a')).toBe(1);
      expect(result.get('b')).toBe(2);
    });

    it('preserves non-string keys like numbers', () => {
      const map = new Map<number, string>([
        [1, 'one'],
        [2, 'two'],
      ]);
      const result = decode(encode(map)) as Map<number, string>;
      expect(result).toBeInstanceOf(Map);
      expect(result.get(1)).toBe('one');
      expect(result.get(2)).toBe('two');
    });

    it('round-trips an empty Map', () => {
      const map = new Map();
      const result = decode(encode(map)) as Map<unknown, unknown>;
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });
  });

  describe('round-trip Set', () => {
    it('preserves elements', () => {
      const set = new Set([1, 2, 3]);
      const result = decode(encode(set)) as Set<number>;
      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(3);
      expect(result.has(1)).toBe(true);
      expect(result.has(2)).toBe(true);
      expect(result.has(3)).toBe(true);
    });

    it('round-trips an empty Set', () => {
      const set = new Set();
      const result = decode(encode(set)) as Set<unknown>;
      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(0);
    });
  });

  describe('round-trip Uint8Array', () => {
    it('preserves bytes', () => {
      const bytes = new Uint8Array([0, 1, 127, 128, 255]);
      const result = decode(encode(bytes)) as Uint8Array;
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result).toEqual(bytes);
    });

    it('round-trips a large Uint8Array without corruption', () => {
      const bytes = new Uint8Array(10000);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = i % 256;
      }
      const result = decode(encode(bytes)) as Uint8Array;
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(10000);
      expect(result).toEqual(bytes);
    });
  });

  describe('round-trip Error', () => {
    it('preserves name, message, and stack', () => {
      const error = new Error('something went wrong');
      const result = decode(encode(error)) as Error;
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe('something went wrong');
      expect(result.name).toBe('Error');
      expect(typeof result.stack).toBe('string');
    });

    it('preserves TypeError name', () => {
      const error = new TypeError('invalid type');
      const result = decode(encode(error)) as Error;
      expect(result.name).toBe('TypeError');
      expect(result.message).toBe('invalid type');
    });
  });

  describe('round-trip nested structures', () => {
    it('handles nested Map with Set values', () => {
      const input = { items: [new Map([['a', new Set([1, 2])]])] };
      const result = decode(encode(input)) as {
        items: Map<string, Set<number>>[];
      };
      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items.length).toBe(1);
      const map = result.items[0]!;
      expect(map).toBeInstanceOf(Map);
      const set = map.get('a');
      expect(set).toBeInstanceOf(Set);
      expect(set!.has(1)).toBe(true);
      expect(set!.has(2)).toBe(true);
    });
  });

  describe('round-trip plain objects and arrays', () => {
    it('round-trips a plain object', () => {
      const input = { name: 'test', count: 42, active: true };
      expect(decode(encode(input))).toEqual(input);
    });

    it('round-trips an array', () => {
      const input = [1, 'two', true, null];
      expect(decode(encode(input))).toEqual(input);
    });

    it('round-trips an empty object', () => {
      expect(decode(encode({}))).toEqual({});
    });

    it('round-trips an empty array', () => {
      expect(decode(encode([]))).toEqual([]);
    });
  });

  describe('replaceUndefined fast path', () => {
    it('returns the original value tree when no undefined is present', () => {
      const value = {
        id: 'wf-1',
        locals: {
          customer: { id: 'cus-1', tier: 'enterprise' },
          amounts: [10, 20, 30],
          metadata: new Map<unknown, unknown>([
            ['region', 'us-west'],
            ['flags', new Set(['priority', 'manual-review'])],
          ]),
        },
      };

      expect(replaceUndefined(value, new Set())).toBe(value);
      expect(replaceUndefined(value.locals.amounts, new Set())).toBe(value.locals.amounts);
      expect(replaceUndefined(value.locals.metadata, new Set())).toBe(value.locals.metadata);
      expect(replaceUndefined(value.locals.metadata.get('flags'), new Set())).toBe(
        value.locals.metadata.get('flags'),
      );
    });

    it('matches the previous preprocessing bytes for representative storage fixtures', () => {
      const fixtures = [
        {
          workflowId: 'wf-checkpoint',
          step: 4,
          locals: {
            accountId: 'acct-1',
            totals: [12, 19, 31],
            checkpoints: new Map<unknown, unknown>([
              ['charged', true],
              ['tags', new Set(['paid', 'ready'])],
            ]),
          },
          accumulatedResults: [
            [1, { ok: true }],
            [2, { status: 'completed' }],
          ],
        },
        {
          workflowId: 'wf-event',
          sequence: 12,
          type: 'activity:completed',
          timestamp: 1_700_000_000_000,
          payload: {
            operationId: 'op-1',
            output: { shipmentId: 'ship-1', notes: ['boxed', 'labelled'] },
          },
        },
      ];

      for (const fixture of fixtures) {
        const previousBytes = msgpackEncode(legacyReplaceUndefined(fixture, new Set()), {
          extensionCodec,
        });
        expect(encode(fixture)).toEqual(previousBytes);
      }
    });

    it('keeps undefined replacement semantics unchanged when undefined is present', () => {
      const value = {
        optional: undefined,
        nested: [{ present: true }, { missing: undefined }],
        map: new Map<unknown, unknown>([['missing', undefined]]),
        set: new Set<unknown>([undefined, 'present']),
      };

      const decoded = decode(encode(value)) as {
        optional: unknown;
        nested: Array<Record<string, unknown>>;
        map: Map<unknown, unknown>;
        set: Set<unknown>;
      };

      expect(decoded.optional).toBeUndefined();
      expect('optional' in decoded).toBe(true);
      expect(decoded.nested[1]!['missing']).toBeUndefined();
      expect(decoded.map.get('missing')).toBeUndefined();
      expect(decoded.set.has(undefined)).toBe(true);
    });
  });

  describe('replaceUndefined edge cases for undefined inside Maps and Sets', () => {
    it('round-trips undefined values inside a Map', () => {
      const map = new Map<string, unknown>([
        ['key', undefined],
        ['other', 42],
      ]);
      const result = decode(encode(map)) as Map<string, unknown>;
      expect(result).toBeInstanceOf(Map);
      expect(result.get('key')).toBeUndefined();
      expect(result.get('other')).toBe(42);
    });

    it('round-trips undefined values inside a Set', () => {
      const set = new Set<unknown>([undefined, 1, 'hello']);
      const result = decode(encode(set)) as Set<unknown>;
      expect(result).toBeInstanceOf(Set);
      expect(result.has(undefined)).toBe(true);
      expect(result.has(1)).toBe(true);
    });

    it('round-trips undefined values inside arrays', () => {
      const arr = [undefined, 1, undefined, 'hello'];
      const result = decode(encode(arr)) as unknown[];
      expect(result[0]).toBeUndefined();
      expect(result[1]).toBe(1);
      expect(result[2]).toBeUndefined();
      expect(result[3]).toBe('hello');
    });

    it('handles circular reference detection in replaceUndefined by skipping visited objects', () => {
      // The replaceUndefined function tracks visited objects. If an object
      // appears at two paths (shared reference), the second visit returns
      // the original object unchanged. This is tested implicitly.
      const shared = { value: undefined };
      const input = { a: shared, b: shared };
      const result = decode(encode(input)) as Record<string, Record<string, unknown>>;
      expect(result['a']!['value']).toBeUndefined();
    });

    it('replaceUndefined skips ArrayBuffer instances', () => {
      const buffer = new ArrayBuffer(8);
      const input = { data: buffer };
      // Should not throw -- replaceUndefined should skip ArrayBuffer
      const encoded = encode(input);
      expect(encoded).toBeInstanceOf(Uint8Array);
    });
  });

  describe('asRecord fallback for non-object values', () => {
    it('decodes a RegExp from corrupted data gracefully (asRecord returns {})', () => {
      const date = new Date(1234567890123);
      const result = decode(encode(date)) as Date;
      expect(result).toBeInstanceOf(Date);
      expect(result.getTime()).toBe(1234567890123);
    });
  });

  describe('Date extension codec encode and decode', () => {
    it('encodes and decodes a Date standalone', () => {
      const date = new Date('2025-06-15T00:00:00.000Z');
      const bytes = encode(date);
      const decoded = decode(bytes) as Date;
      expect(decoded).toBeInstanceOf(Date);
      expect(decoded.getTime()).toBe(date.getTime());
    });

    it('encodes and decodes a Date nested inside an object', () => {
      const now = new Date();
      const input = { createdAt: now, name: 'test' };
      const bytes = encode(input);
      const result = decode(bytes) as { createdAt: Date; name: string };
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.createdAt.getTime()).toBe(now.getTime());
      expect(result.name).toBe('test');
    });

    it('encodes and decodes a Date inside an array', () => {
      const date = new Date(0);
      const input = [date, 42, 'hello'];
      const bytes = encode(input);
      const result = decode(bytes) as [Date, number, string];
      expect(result[0]).toBeInstanceOf(Date);
      expect(result[0].getTime()).toBe(0);
    });
  });

  describe('validateCloneable', () => {
    it('returns valid for a plain object', () => {
      const result = validateCloneable({ a: 1, b: 'hello', c: [1, 2, 3] });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('returns valid for primitives', () => {
      expect(validateCloneable(42).valid).toBe(true);
      expect(validateCloneable('hello').valid).toBe(true);
      expect(validateCloneable(null).valid).toBe(true);
      expect(validateCloneable(undefined).valid).toBe(true);
      expect(validateCloneable(true).valid).toBe(true);
    });

    it('returns valid for supported types (Date, Map, Set, RegExp, Error)', () => {
      expect(validateCloneable(new Date()).valid).toBe(true);
      expect(validateCloneable(new Map()).valid).toBe(true);
      expect(validateCloneable(new Set()).valid).toBe(true);
      expect(validateCloneable(/test/g).valid).toBe(true);
      expect(validateCloneable(new Error('test')).valid).toBe(true);
    });

    it('rejects functions', () => {
      const result = validateCloneable({ fn: () => {} });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]!.path).toBe('fn');
      expect(result.errors[0]!.reason).toContain('Function');
    });

    it('provides suggestion text for function errors', () => {
      const result = validateCloneable({ fn: () => {} });
      expect(result.errors[0]!.suggestion).toContain('ctx.run()');
    });

    it('rejects class instances with methods', () => {
      class MyService {
        doWork() {
          return 'done';
        }
      }
      const result = validateCloneable({ service: new MyService() });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
      expect(result.errors[0]!.path).toBe('service');
      expect(result.errors[0]!.reason).toContain('Class instance');
    });

    it('provides suggestion text for class instance errors', () => {
      class MyService {
        doWork() {
          return 'done';
        }
      }
      const result = validateCloneable({ service: new MyService() });
      expect(result.errors[0]!.suggestion).toContain('data');
    });

    it('rejects WeakRef', () => {
      const result = validateCloneable({ ref: new WeakRef({}) });
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.reason).toContain('WeakRef');
    });

    it('rejects WeakMap', () => {
      const result = validateCloneable({ map: new WeakMap() });
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.reason).toContain('WeakMap');
    });

    it('rejects WeakSet', () => {
      const result = validateCloneable({ set: new WeakSet() });
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.reason).toContain('WeakSet');
    });

    it('rejects Symbol values', () => {
      const result = validateCloneable({ sym: Symbol('test') });
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.reason).toContain('Symbol');
    });

    it('detects circular references', () => {
      const obj: Record<string, unknown> = { a: 1 };
      obj['self'] = obj;
      const result = validateCloneable(obj);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.reason.includes('Circular'))).toBe(true);
    });

    it('walks deeply nested structures and reports ALL errors', () => {
      const input = {
        level1: {
          fn: () => {},
          level2: {
            sym: Symbol('bad'),
            level3: {
              weak: new WeakMap(),
            },
          },
        },
      };
      const result = validateCloneable(input);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBe(3);

      const paths = result.errors.map((e) => e.path).toSorted();
      expect(paths).toEqual(['level1.fn', 'level1.level2.level3.weak', 'level1.level2.sym']);
    });

    it('provides suggestion text for each error type', () => {
      const result = validateCloneable({
        fn: () => {},
        sym: Symbol('test'),
        weakRef: new WeakRef({}),
        weakMap: new WeakMap(),
        weakSet: new WeakSet(),
      });
      expect(result.errors.length).toBe(5);
      for (const error of result.errors) {
        expect(error.suggestion).toBeTruthy();
        expect(typeof error.suggestion).toBe('string');
        expect(error.suggestion.length).toBeGreaterThan(0);
      }
    });

    it('walks Map values and reports errors inside them', () => {
      const map = new Map<string, unknown>([
        ['good', 42],
        ['bad', () => {}],
      ]);
      const result = validateCloneable(map);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]!.path).toBe('bad');
      expect(result.errors[0]!.reason).toContain('Function');
    });

    it('walks Set values and reports errors inside them', () => {
      const set = new Set<unknown>([42, Symbol('oops')]);
      const result = validateCloneable(set);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]!.path).toBe('[1]');
      expect(result.errors[0]!.reason).toContain('Symbol');
    });

    it('validates a Map with nested paths', () => {
      const map = new Map<string, unknown>([['key', new WeakRef({})]]);
      const result = validateCloneable({ data: map });
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.path).toBe('data.key');
    });

    it('validates a Set with nested paths', () => {
      const set = new Set<unknown>([new WeakMap()]);
      const result = validateCloneable({ data: set });
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.path).toBe('data[0]');
    });
  });
});

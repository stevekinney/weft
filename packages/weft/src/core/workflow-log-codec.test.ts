import { describe, expect, it } from 'bun:test';

import { serializeAttributes } from './workflow-log-codec.ts';

describe('serializeAttributes', () => {
  it('serializes attributes that fit and reports none for absent attributes', () => {
    expect(serializeAttributes({ count: 1 }, 100)).toEqual({ json: '{"count":1}', dropped: false });
    expect(serializeAttributes(undefined, 100)).toEqual({ json: undefined, dropped: false });
  });

  it('drops attributes that exceed the byte budget', () => {
    expect(serializeAttributes({ blob: 'z'.repeat(50) }, 10)).toEqual({
      json: undefined,
      dropped: true,
    });
  });

  it('drops attributes JSON cannot represent, which the store no longer hands it after redaction', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;

    expect(serializeAttributes(cyclic, 100)).toEqual({ json: undefined, dropped: true });
    expect(serializeAttributes({ big: 1n }, 100)).toEqual({ json: undefined, dropped: true });
  });
});

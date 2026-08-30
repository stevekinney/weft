import { describe, expect, it } from 'bun:test';

import { clonePlain } from './clone-plain.ts';

describe('clonePlain', () => {
  it('clones nested plain objects', () => {
    const source = { a: { b: { c: 1 } } };
    const cloned = clonePlain(source);
    expect(cloned).toEqual(source);
    expect(cloned.a).not.toBe(source.a);
    expect(cloned.a.b).not.toBe(source.a.b);
  });

  it('preserves function references', () => {
    const handler = () => 1;
    const cloned = clonePlain({ execute: handler });
    expect(cloned.execute).toBe(handler);
  });

  it('passes class instances through by reference', () => {
    class Marker {
      kind = 'marker';
    }
    const marker = new Marker();
    const cloned = clonePlain({ marker });
    expect(cloned.marker).toBe(marker);
  });

  it('does not stack-overflow on a direct self-cycle', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => clonePlain(cyclic)).not.toThrow();
    const cloned = clonePlain(cyclic);
    expect(cloned.self).toBe(cloned);
  });

  it('does not stack-overflow on an indirect cycle', () => {
    const a: { b?: unknown } = {};
    const b: { a?: unknown } = { a };
    a.b = b;
    expect(() => clonePlain(a)).not.toThrow();
  });
});

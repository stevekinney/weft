import { describe, expect, it } from 'bun:test';

import { parseMcpListFilter } from './list-filter.ts';

describe('MCP list filter parsing', () => {
  it('accepts valid workflow status arrays', () => {
    expect(parseMcpListFilter({ status: ['pending', 'running'] })).toEqual({
      ok: true,
      filter: { status: ['pending', 'running'] },
    });
  });

  it('accepts valid string arrays for tags', () => {
    expect(parseMcpListFilter({ tags: ['alpha', 'beta'] })).toEqual({
      ok: true,
      filter: { tags: ['alpha', 'beta'] },
    });
  });

  it('rejects non-string tag values', () => {
    expect(parseMcpListFilter({ tags: ['alpha', 2] })).toEqual({
      ok: false,
      message: 'List filter tags must contain only strings',
    });
  });

  it('accepts non-negative integer pagination values', () => {
    expect(parseMcpListFilter({ limit: 0, offset: 3 })).toEqual({
      ok: true,
      filter: { limit: 0, offset: 3 },
    });
  });

  it('rejects non-integer pagination values', () => {
    expect(parseMcpListFilter({ limit: 1.5 })).toEqual({
      ok: false,
      message: 'List filter limit must be a non-negative integer',
    });
    expect(parseMcpListFilter({ offset: -1 })).toEqual({
      ok: false,
      message: 'List filter offset must be a non-negative integer',
    });
  });
});

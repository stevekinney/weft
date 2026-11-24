import { describe, expect, it } from 'bun:test';

import { parseMcpListFilter, parseMcpListFilterFromSearchParams } from './list-filter.ts';

describe('MCP list filter parsing', () => {
  it('accepts valid workflow status arrays', () => {
    expect(parseMcpListFilter({ status: ['pending', 'running'] })).toEqual({
      ok: true,
      filter: { status: ['pending', 'running'] },
    });
  });

  it('rejects invalid scalar, shape, and array-member status values', () => {
    expect(parseMcpListFilter({ status: 'unknown' })).toEqual({
      ok: false,
      message: 'Invalid workflow status: unknown',
    });
    expect(parseMcpListFilter({ status: 1 })).toEqual({
      ok: false,
      message: 'List filter status must be a workflow status or array',
    });
    expect(parseMcpListFilter({ status: ['running', 1] })).toEqual({
      ok: false,
      message: 'List filter status array contains an invalid workflow status',
    });
  });

  it('rejects a type that is not a string', () => {
    expect(parseMcpListFilter({ type: 7 })).toEqual({
      ok: false,
      message: 'List filter type must be a string',
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

  it('carries failedStep and retrying, as every other transport does (COR-2530)', () => {
    expect(parseMcpListFilter({ failedStep: 'charge', retrying: false })).toEqual({
      ok: true,
      filter: { failedStep: 'charge', retrying: false },
    });
    expect(
      parseMcpListFilterFromSearchParams(new URLSearchParams('failed_step=charge&retrying=true')),
    ).toEqual({ ok: true, filter: { failedStep: 'charge', retrying: true } });
    expect(parseMcpListFilter({ failedStep: '' })).toEqual({
      ok: false,
      message: 'List filter failedStep must be a non-empty string',
    });
    expect(parseMcpListFilter({ retrying: 'yes' })).toEqual({
      ok: false,
      message: 'List filter retrying must be true or false',
    });
  });
});

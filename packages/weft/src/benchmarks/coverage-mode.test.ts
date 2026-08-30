import { afterEach, describe, expect, it } from 'bun:test';

import { isCoverageInstrumentationEnabled } from './coverage-mode.ts';

const originalCoverageMode = Bun.env['WEFT_COVERAGE_MODE'];
const originalNodeV8Coverage = Bun.env['NODE_V8_COVERAGE'];
const originalExecArgv = [...process.execArgv];

afterEach(() => {
  if (originalCoverageMode === undefined) {
    delete Bun.env['WEFT_COVERAGE_MODE'];
  } else {
    Bun.env['WEFT_COVERAGE_MODE'] = originalCoverageMode;
  }

  if (originalNodeV8Coverage === undefined) {
    delete Bun.env['NODE_V8_COVERAGE'];
  } else {
    Bun.env['NODE_V8_COVERAGE'] = originalNodeV8Coverage;
  }

  process.execArgv = [...originalExecArgv];
});

describe('isCoverageInstrumentationEnabled', () => {
  it('returns true when explicit coverage mode is enabled', () => {
    Bun.env['WEFT_COVERAGE_MODE'] = '1';
    delete Bun.env['NODE_V8_COVERAGE'];
    process.execArgv = [];

    expect(isCoverageInstrumentationEnabled()).toBe(true);
  });

  it('returns true when Bun was started with --coverage', () => {
    delete Bun.env['WEFT_COVERAGE_MODE'];
    delete Bun.env['NODE_V8_COVERAGE'];
    process.execArgv = ['--coverage'];

    expect(isCoverageInstrumentationEnabled()).toBe(true);
  });

  it('returns true when NODE_V8_COVERAGE is configured', () => {
    delete Bun.env['WEFT_COVERAGE_MODE'];
    Bun.env['NODE_V8_COVERAGE'] = '/tmp/weft-coverage';
    process.execArgv = [];

    expect(isCoverageInstrumentationEnabled()).toBe(true);
  });

  it('returns false when no coverage signal is present', () => {
    delete Bun.env['WEFT_COVERAGE_MODE'];
    delete Bun.env['NODE_V8_COVERAGE'];
    process.execArgv = [];

    expect(isCoverageInstrumentationEnabled()).toBe(false);
  });
});

import { describe, expect, it } from 'bun:test';

import {
  buildTestCommand,
  extractJunitFailureExcerpts,
  formatFailingTests,
  ISOLATION_SKIP_FILE_THRESHOLD,
  parseJunitFailures,
  renderTestOutcome,
  runTestSuite,
  tailBound,
  TEST_TIMEOUT_MS,
  type RunTestSuiteDependencies,
} from './run-tests.ts';

function testcase(attributes: Record<string, string>, child?: string): string {
  const attrs = Object.entries(attributes)
    .map(([key, value]) => `${key}="${value}"`)
    .join(' ');
  return child ? `<testcase ${attrs}>${child}</testcase>` : `<testcase ${attrs} />`;
}

function suite(...cases: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n<testsuite name="s">\n${cases.join('\n')}\n</testsuite>\n</testsuites>`;
}

describe('parseJunitFailures', () => {
  it('extracts a single failing testcase', () => {
    const xml = suite(
      testcase(
        { name: 'adds numbers', file: 'src/math.test.ts', line: '12' },
        '<failure type="AssertionError" />',
      ),
    );
    expect(parseJunitFailures(xml)).toEqual([
      { file: 'src/math.test.ts', name: 'adds numbers', line: '12' },
    ]);
  });

  it('excludes passing (self-closing) testcases', () => {
    const xml = suite(
      testcase({ name: 'passes', file: 'src/a.test.ts', line: '1' }),
      testcase({ name: 'fails', file: 'src/a.test.ts', line: '2' }, '<failure />'),
    );
    expect(parseJunitFailures(xml)).toEqual([{ file: 'src/a.test.ts', name: 'fails', line: '2' }]);
  });

  it('returns multiple failures across files in document order', () => {
    const xml = suite(
      testcase({ name: 'one', file: 'src/a.test.ts', line: '1' }, '<failure />'),
      testcase({ name: 'two', file: 'src/b.test.ts', line: '9' }, '<failure />'),
    );
    expect(parseJunitFailures(xml)).toEqual([
      { file: 'src/a.test.ts', name: 'one', line: '1' },
      { file: 'src/b.test.ts', name: 'two', line: '9' },
    ]);
  });

  it('decodes named entities in attribute values', () => {
    const xml = suite(
      testcase(
        { name: 'handles a &lt; b &amp; c &quot;q&quot;', file: 'src/a.test.ts' },
        '<failure />',
      ),
    );
    expect(parseJunitFailures(xml)[0].name).toBe('handles a < b & c "q"');
  });

  it('decodes numeric decimal and hex character references', () => {
    const xml = suite(
      testcase({ name: 'apos &#39; and hex &#x27;', file: 'src/a.test.ts' }, '<failure />'),
    );
    expect(parseJunitFailures(xml)[0].name).toBe("apos ' and hex '");
  });

  it('treats <error> the same as <failure>', () => {
    const xml = suite(
      testcase({ name: 'boom', file: 'src/a.test.ts' }, '<error type="TimeoutError" />'),
    );
    expect(parseJunitFailures(xml)).toEqual([{ file: 'src/a.test.ts', name: 'boom' }]);
  });

  it('omits line when absent', () => {
    const xml = suite(testcase({ name: 'no line', file: 'src/a.test.ts' }, '<failure />'));
    expect(parseJunitFailures(xml)).toEqual([{ file: 'src/a.test.ts', name: 'no line' }]);
  });

  it('returns [] for empty XML', () => {
    expect(parseJunitFailures('')).toEqual([]);
    expect(parseJunitFailures('<testsuites></testsuites>')).toEqual([]);
  });

  it('does not throw on truncated XML (best-effort)', () => {
    const xml = '<testsuites><testsuite><testcase name="x" file="src/a.test.ts"><fail';
    expect(() => parseJunitFailures(xml)).not.toThrow();
  });

  it('parses regardless of attribute order', () => {
    const xml = suite(
      testcase({ file: 'src/a.test.ts', line: '3', name: 'ordered' }, '<failure />'),
    );
    expect(parseJunitFailures(xml)).toEqual([
      { file: 'src/a.test.ts', name: 'ordered', line: '3' },
    ]);
  });

  it('dedupes on file+name+line', () => {
    const xml = suite(
      testcase({ name: 'dup', file: 'src/a.test.ts', line: '5' }, '<failure />'),
      testcase({ name: 'dup', file: 'src/a.test.ts', line: '5' }, '<failure />'),
      testcase({ name: 'dup', file: 'src/a.test.ts', line: '6' }, '<failure />'),
    );
    expect(parseJunitFailures(xml)).toEqual([
      { file: 'src/a.test.ts', name: 'dup', line: '5' },
      { file: 'src/a.test.ts', name: 'dup', line: '6' },
    ]);
  });
});

describe('formatFailingTests', () => {
  it('formats file > name', () => {
    expect(formatFailingTests([{ file: 'src/a.test.ts', name: 'works' }])).toEqual([
      'src/a.test.ts > works',
    ]);
  });

  it('falls back for empty file and name', () => {
    expect(formatFailingTests([{ file: '', name: '' }])).toEqual([
      '(unknown file) > (unknown test)',
    ]);
  });
});

describe('extractJunitFailureExcerpts', () => {
  it('extracts a <failure> with type, message, and text', () => {
    const xml = suite(
      testcase(
        { name: 'x', file: 'src/a.test.ts' },
        '<failure type="AssertionError" message="expected 1">stack here</failure>',
      ),
    );
    const [excerpt] = extractJunitFailureExcerpts(xml);
    expect(excerpt).toMatchObject({ file: 'src/a.test.ts', name: 'x', kind: 'failure' });
    expect(excerpt.detail).toContain('AssertionError');
    expect(excerpt.detail).toContain('expected 1');
    expect(excerpt.detail).toContain('stack here');
  });

  it('handles <error>', () => {
    const xml = suite(testcase({ name: 'x', file: 'a' }, '<error type="TimeoutError" />'));
    expect(extractJunitFailureExcerpts(xml)[0]).toMatchObject({ kind: 'error' });
  });

  it('decodes escaped text', () => {
    const xml = suite(testcase({ name: 'x', file: 'a' }, '<failure message="a &lt; b" />'));
    expect(extractJunitFailureExcerpts(xml)[0].detail).toContain('a < b');
  });

  it('handles missing/empty text', () => {
    const xml = suite(testcase({ name: 'x', file: 'a' }, '<failure />'));
    expect(extractJunitFailureExcerpts(xml)[0].detail).toBe('');
  });

  it('truncates oversized excerpts with a marker', () => {
    const big = 'y'.repeat(2000);
    const xml = suite(testcase({ name: 'x', file: 'a' }, `<failure>${big}</failure>`));
    const detail = extractJunitFailureExcerpts(xml)[0].detail;
    expect(detail.length).toBeLessThan(big.length);
    expect(detail).toContain('truncated');
  });

  it('does not throw on truncated XML', () => {
    expect(() => extractJunitFailureExcerpts('<testcase name="x"><failure mess')).not.toThrow();
  });
});

describe('tailBound', () => {
  it('returns short text unchanged', () => {
    expect(tailBound('short', 100)).toBe('short');
  });

  it('keeps the tail and notes omission', () => {
    const result = tailBound('abcdefghij', 4);
    expect(result).toContain('ghij');
    expect(result).toContain('omitted');
  });
});

describe('buildTestCommand', () => {
  it('shares one shape between full and isolation runs', () => {
    const args = buildTestCommand(['src/a.test.ts'], '/tmp/run/out.xml');
    expect(args).toEqual([
      'test',
      '--timeout',
      String(TEST_TIMEOUT_MS),
      '--reporter=junit',
      '--reporter-outfile=/tmp/run/out.xml',
      'src/a.test.ts',
    ]);
  });
});

describe('renderTestOutcome', () => {
  it('passes through a passed outcome', () => {
    expect(renderTestOutcome({ kind: 'passed' })).toEqual({ ok: true, lines: ['test passed'] });
  });

  it('fails closed on failed', () => {
    const result = renderTestOutcome({
      kind: 'failed',
      failures: [{ file: 'src/a.test.ts', name: 'x' }],
      output: { stdout: '', stderr: '' },
    });
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('src/a.test.ts > x');
  });

  it('fails closed on failedButPassedInIsolation', () => {
    const result = renderTestOutcome({
      kind: 'failedButPassedInIsolation',
      failures: [{ file: 'src/a.test.ts', name: 'x' }],
      output: { stdout: '', stderr: '' },
    });
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('PASSED when rerun alone');
  });

  it('reports the no-JUnit case', () => {
    const result = renderTestOutcome({
      kind: 'failed',
      failures: [],
      output: { stdout: '', stderr: '' },
      junitError: 'could not read JUnit report at /tmp/x',
    });
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('no JUnit test-case failures');
    expect(result.lines.join('\n')).toContain('could not read JUnit report');
  });
});

describe('runTestSuite (injected dependencies)', () => {
  function makeDependencies(
    overrides: Partial<RunTestSuiteDependencies> & {
      runResults?: Array<{ exitCode: number; stdout?: string; stderr?: string }>;
      reports?: Record<string, string>;
    } = {},
  ): { dependencies: RunTestSuiteDependencies; commands: string[][]; removed: string[] } {
    const commands: string[][] = [];
    const removed: string[] = [];
    const runResults = overrides.runResults ?? [];
    const reports = overrides.reports ?? {};
    let runIndex = 0;
    const dependencies: RunTestSuiteDependencies = {
      runCommand: async (args) => {
        commands.push(args);
        const result = runResults[runIndex++] ?? { exitCode: 0 };
        return {
          exitCode: result.exitCode,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
        };
      },
      makeRunDirectory: async () => '/tmp/run',
      readReport: async (path) => {
        const name = path.endsWith('full.junit.xml') ? 'full' : 'isolation';
        return reports[name];
      },
      removeDirectory: async (path) => {
        removed.push(path);
      },
      sweepStaleDirectories: async () => {},
      ...overrides,
    };
    return { dependencies, commands, removed };
  }

  it('returns passed without spawning when there are no files', async () => {
    const { dependencies, commands } = makeDependencies();
    expect(await runTestSuite([], dependencies)).toEqual({ kind: 'passed' });
    expect(commands).toHaveLength(0);
  });

  it('returns passed and removes the run dir on a clean run', async () => {
    const { dependencies, removed } = makeDependencies({ runResults: [{ exitCode: 0 }] });
    expect(await runTestSuite(['src/a.test.ts'], dependencies)).toEqual({ kind: 'passed' });
    expect(removed).toEqual(['/tmp/run']);
  });

  it('classifies a load-sensitive failure as failedButPassedInIsolation', async () => {
    const report = suite(
      testcase({ name: 'slow', file: 'src/a.test.ts' }, '<error type="TimeoutError" />'),
    );
    const { dependencies, removed } = makeDependencies({
      runResults: [{ exitCode: 1 }, { exitCode: 0 }],
      reports: { full: report },
    });
    const outcome = await runTestSuite(['src/a.test.ts', 'src/b.test.ts'], dependencies);
    expect(outcome.kind).toBe('failedButPassedInIsolation');
    // retained on failure (not removed)
    expect(removed).toEqual([]);
  });

  it('classifies a real break as failed using the isolation report', async () => {
    const fullReport = suite(testcase({ name: 'real', file: 'src/a.test.ts' }, '<failure />'));
    const isolationReport = suite(
      testcase({ name: 'real', file: 'src/a.test.ts', line: '4' }, '<failure />'),
    );
    const { dependencies } = makeDependencies({
      runResults: [{ exitCode: 1 }, { exitCode: 1 }],
      reports: { full: fullReport, isolation: isolationReport },
    });
    const outcome = await runTestSuite(['src/a.test.ts'], dependencies);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.failures).toEqual([{ file: 'src/a.test.ts', name: 'real', line: '4' }]);
    }
  });

  it('reports a missing full JUnit report as failed with junitError', async () => {
    const { dependencies } = makeDependencies({ runResults: [{ exitCode: 1, stderr: 'crash' }] });
    const outcome = await runTestSuite(['src/a.test.ts'], dependencies);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.failures).toEqual([]);
      expect(outcome.junitError).toContain('could not read JUnit report');
      expect(outcome.output.stderr).toBe('crash');
    }
  });

  it('flags isolation JUnit unavailable when isolation fails without a report', async () => {
    const fullReport = suite(testcase({ name: 'x', file: 'src/a.test.ts' }, '<failure />'));
    const { dependencies } = makeDependencies({
      runResults: [{ exitCode: 1 }, { exitCode: 1 }],
      reports: { full: fullReport },
    });
    const outcome = await runTestSuite(['src/a.test.ts'], dependencies);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.isolationJunitUnavailable).toBe(true);
      expect(outcome.failures).toEqual([{ file: 'src/a.test.ts', name: 'x' }]);
    }
  });

  it('skips isolation when failures span many files', async () => {
    const cases = Array.from({ length: ISOLATION_SKIP_FILE_THRESHOLD }, (_, index) =>
      testcase({ name: 'x', file: `src/file-${index}.test.ts` }, '<failure />'),
    );
    const { dependencies, commands } = makeDependencies({
      runResults: [{ exitCode: 1 }],
      reports: { full: suite(...cases) },
    });
    const outcome = await runTestSuite(
      Array.from(
        { length: ISOLATION_SKIP_FILE_THRESHOLD },
        (_, index) => `src/file-${index}.test.ts`,
      ),
      dependencies,
    );
    expect(outcome.kind).toBe('failed');
    // Only the full run, no isolation run.
    expect(commands).toHaveLength(1);
  });
});

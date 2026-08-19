import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BROWSER_SMOKE_TEST_PATHS,
  buildTestCommand,
  createRealDependencies,
  discoverTestFiles,
  extractJunitFailureExcerpts,
  formatFailingTests,
  FULL_SUITE_TIMEOUT_MS,
  ISOLATION_SKIP_FILE_THRESHOLD,
  LOAD_SENSITIVE_TEST_PATHS,
  parseJunitFailures,
  renderTestOutcome,
  runTestSuite,
  STALE_DIRECTORY_AGE_MS,
  sweepStalePrecommitDirectories,
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

  it('does not throw on an out-of-range numeric character reference', () => {
    // String.fromCodePoint throws RangeError above 0x10FFFF; a corrupted report
    // must not crash the parser. The bogus entity is left as-is.
    const xml = suite(
      testcase({ name: 'bad &#999999999999;', file: 'src/a.test.ts' }, '<failure />'),
    );
    expect(() => parseJunitFailures(xml)).not.toThrow();
    expect(parseJunitFailures(xml)[0].name).toContain('&#999999999999;');
  });

  it('reads single-quoted attribute values', () => {
    const xml = `<testcase name='single quoted' file='src/a.test.ts'><failure /></testcase>`;
    expect(parseJunitFailures(xml)).toEqual([{ file: 'src/a.test.ts', name: 'single quoted' }]);
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

  it('reports the isolationJunitUnavailable case', () => {
    const result = renderTestOutcome({
      kind: 'failed',
      failures: [{ file: 'src/a.test.ts', name: 'x' }],
      output: { stdout: '', stderr: '' },
      isolationJunitUnavailable: true,
    });
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('Isolation run failed but its JUnit was unavailable');
  });

  it('reports a wall-clock timeout with incomplete files and the retained report directory', () => {
    const result = renderTestOutcome({
      kind: 'timedOut',
      phase: 'full',
      timeoutMs: FULL_SUITE_TIMEOUT_MS,
      incompleteTestFiles: ['src/b.test.ts'],
      output: { stdout: '', stderr: '' },
      retainedDirectory: '/tmp/run',
    });
    const rendered = result.lines.join('\n');
    expect(result.ok).toBe(false);
    expect(rendered).toContain(`${FULL_SUITE_TIMEOUT_MS}ms`);
    expect(rendered).toContain('src/b.test.ts');
    expect(rendered).toContain('/tmp/run');
  });
});

describe('discoverTestFiles', () => {
  it('excludes benchmark and load-sensitive files', async () => {
    const files = await discoverTestFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((file) => file.includes('/benchmarks/'))).toBe(false);
    for (const excluded of LOAD_SENSITIVE_TEST_PATHS) {
      expect(files).not.toContain(excluded);
    }
  });

  it('excludes the browser-smoke files omitted by the main CI test job', async () => {
    const files = await discoverTestFiles();
    for (const excluded of BROWSER_SMOKE_TEST_PATHS) {
      expect(files).not.toContain(excluded);
    }
  });

  it('returns only .test.ts files', async () => {
    const files = await discoverTestFiles();
    expect(files.every((file) => file.endsWith('.test.ts'))).toBe(true);
  });

  it('keeps the load-sensitive exclusion list bounded', () => {
    // The policy (see the JSDoc on LOAD_SENSITIVE_TEST_PATHS) is fix-first:
    // a test joins this list only when it genuinely cannot be made
    // load-insensitive. This ceiling forces every addition to be a deliberate,
    // reviewed bump rather than silent list creep that erodes pre-commit signal.
    // Reduced back to 5 after the heartbeat-reclaim parity test gained a
    // deterministic manual visibility-scan seam.
    expect(LOAD_SENSITIVE_TEST_PATHS.length).toBeLessThanOrEqual(5);
  });
});

describe('runTestSuite (injected dependencies)', () => {
  function makeDependencies(
    overrides: Partial<RunTestSuiteDependencies> & {
      runResults?: Array<{
        exitCode: number;
        stdout?: string;
        stderr?: string;
        timedOut?: boolean;
      }>;
      reports?: Record<string, string>;
    } = {},
  ): {
    dependencies: RunTestSuiteDependencies;
    commands: string[][];
    removed: string[];
    timeouts: number[];
  } {
    const commands: string[][] = [];
    const removed: string[] = [];
    const timeouts: number[] = [];
    const runResults = overrides.runResults ?? [];
    const reports = overrides.reports ?? {};
    let runIndex = 0;
    const dependencies: RunTestSuiteDependencies = {
      runCommand: async (args, timeoutMs) => {
        commands.push(args);
        timeouts.push(timeoutMs);
        const result = runResults[runIndex++] ?? { exitCode: 0 };
        return {
          exitCode: result.exitCode,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
          timedOut: result.timedOut ?? false,
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
    return { dependencies, commands, removed, timeouts };
  }

  it('returns passed without spawning when there are no files', async () => {
    const { dependencies, commands } = makeDependencies();
    expect(await runTestSuite([], dependencies)).toEqual({ kind: 'passed' });
    expect(commands).toHaveLength(0);
  });

  it('returns passed and removes the run dir on a clean run', async () => {
    const { dependencies, removed, timeouts } = makeDependencies({
      runResults: [{ exitCode: 0 }],
    });
    expect(await runTestSuite(['src/a.test.ts'], dependencies)).toEqual({ kind: 'passed' });
    expect(removed).toEqual(['/tmp/run']);
    expect(timeouts).toEqual([FULL_SUITE_TIMEOUT_MS]);
  });

  it('kills a timed-out full run and attributes incomplete files from the partial report', async () => {
    const partialReport = suite(
      testcase({ name: 'completed', file: 'src/a.test.ts' }),
      testcase({ name: 'also completed', file: 'src/c.test.ts' }),
    );
    const { dependencies, commands, removed } = makeDependencies({
      runResults: [{ exitCode: 143, timedOut: true, stderr: 'terminated' }],
      reports: { full: partialReport },
    });

    const outcome = await runTestSuite(
      ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts'],
      dependencies,
    );

    expect(outcome).toEqual({
      kind: 'timedOut',
      phase: 'full',
      timeoutMs: FULL_SUITE_TIMEOUT_MS,
      incompleteTestFiles: ['src/b.test.ts'],
      output: { stdout: '', stderr: 'terminated' },
      reportContent: partialReport,
      retainedDirectory: '/tmp/run',
    });
    expect(commands).toHaveLength(1);
    expect(removed).toEqual([]);
  });

  it('passes --parallel=1 when a serial run is requested', async () => {
    const { dependencies, commands } = makeDependencies({ runResults: [{ exitCode: 0 }] });
    expect(await runTestSuite(['src/a.test.ts'], dependencies, { parallel: false })).toEqual({
      kind: 'passed',
    });
    expect(commands[0]).toContain('--parallel=1');
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
    if (outcome.kind === 'failedButPassedInIsolation') {
      // carries the report it already read + the isolation run's output
      expect(outcome.reportContent).toBe(report);
      expect(outcome.isolationOutput).toBeDefined();
      expect(outcome.retainedDirectory).toBe('/tmp/run');
    }
  });

  it('classifies a timed-out isolation run before considering its exit code', async () => {
    const fullReport = suite(
      testcase({ name: 'slow', file: 'src/a.test.ts' }, '<failure type="TimeoutError" />'),
      testcase({ name: 'slow', file: 'src/b.test.ts' }, '<failure type="TimeoutError" />'),
    );
    const isolationReport = suite(testcase({ name: 'completed', file: 'src/a.test.ts' }));
    const { dependencies } = makeDependencies({
      runResults: [{ exitCode: 1 }, { exitCode: 0, timedOut: true, stderr: 'terminated' }],
      reports: { full: fullReport, isolation: isolationReport },
    });

    expect(await runTestSuite(['src/a.test.ts', 'src/b.test.ts'], dependencies)).toEqual({
      kind: 'timedOut',
      phase: 'isolation',
      timeoutMs: FULL_SUITE_TIMEOUT_MS,
      incompleteTestFiles: ['src/b.test.ts'],
      output: { stdout: '', stderr: '' },
      reportContent: fullReport,
      isolationOutput: { stdout: '', stderr: 'terminated' },
      retainedDirectory: '/tmp/run',
    });
  });

  it('skips isolation when failures have no parseable file attribute', async () => {
    // A failing testcase with a name but no file → failingFiles is empty.
    const report = suite(testcase({ name: 'nameless file' }, '<failure />'));
    const { dependencies, commands } = makeDependencies({
      runResults: [{ exitCode: 1 }],
      reports: { full: report },
    });
    const outcome = await runTestSuite(['src/a.test.ts'], dependencies);
    expect(outcome.kind).toBe('failed');
    expect(commands).toHaveLength(1); // no isolation run
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

describe('real dependency helpers', () => {
  const cleanupPaths = new Set<string>();

  afterEach(async () => {
    for (const path of cleanupPaths) {
      await rm(path, { recursive: true, force: true });
    }
    cleanupPaths.clear();
  });

  it('runCommand captures stdout, stderr, and exit code while flushing the heartbeat newline', async () => {
    const dependencies = createRealDependencies();
    const stderrWrite = mock((_chunk: string) => true);
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = stderrWrite as typeof process.stderr.write;

    try {
      const result = await dependencies.runCommand(
        ['-e', 'console.log("stdout-line"); console.error("stderr-line"); process.exit(7);'],
        1_000,
      );

      expect(result).toEqual({
        exitCode: 7,
        stdout: 'stdout-line\n',
        stderr: 'stderr-line\n',
        timedOut: false,
      });
      expect(stderrWrite).toHaveBeenCalledWith('\n');
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  it('runCommand terminates a subprocess at its wall-clock deadline', async () => {
    const dependencies = createRealDependencies();
    const stderrWrite = mock((_chunk: string) => true);
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = stderrWrite as typeof process.stderr.write;

    try {
      // fixed delay: hang guard on a real subprocess
      const result = await dependencies.runCommand(['-e', 'await new Promise(() => {})'], 50);
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).not.toBe(0);
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  it('runCommand force-kills a subprocess that ignores graceful termination', async () => {
    const dependencies = createRealDependencies();
    const stderrWrite = mock((_chunk: string) => true);
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = stderrWrite as typeof process.stderr.write;

    try {
      // fixed delay: hang guard on a real subprocess that deliberately ignores SIGTERM
      const result = await dependencies.runCommand(
        ['-e', 'process.on("SIGTERM", () => {}); await new Promise(() => {})'],
        50,
      );
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).not.toBe(0);
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  it('runCommand returns when descendants keep inherited output pipes open', async () => {
    const dependencies = createRealDependencies();
    const stderrWrite = mock((_chunk: string) => true);
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = stderrWrite as typeof process.stderr.write;

    try {
      const result = await dependencies.runCommand(
        [
          '-e',
          'Bun.spawn(["bun", "-e", "process.on(\\"SIGTERM\\", () => {}); await new Promise(() => {})"], { stdout: "inherit", stderr: "inherit" }); process.on("SIGTERM", () => {}); await new Promise(() => {})',
        ],
        50,
      );
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).not.toBe(0);
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  for (const [signal, expectedExitCode] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const) {
    it(`runCommand forwards ${signal} to its detached subprocess group`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'weft-run-tests-signal-'));
      cleanupPaths.add(directory);
      const processIdsPath = join(directory, 'process-ids.txt');
      const fixturePath = join(directory, 'fixture.ts');
      const runTestsPath = fileURLToPath(new URL('./run-tests.ts', import.meta.url));
      await writeFile(
        fixturePath,
        `import { createRealDependencies } from ${JSON.stringify(runTestsPath)};
await createRealDependencies().runCommand([
  '-e',
  ${JSON.stringify(`const child = Bun.spawn(['bun', '-e', 'process.on("${signal}", () => {}); await new Promise(() => {})'], { stdout: 'inherit', stderr: 'inherit' }); await Bun.write(${JSON.stringify(processIdsPath)}, process.pid + '\\n' + child.pid + '\\n'); process.on('${signal}', () => {}); await new Promise(() => {})`)},
], 60_000);
`,
        'utf8',
      );
      const fixture = Bun.spawn(['bun', fixturePath], { stdout: 'ignore', stderr: 'ignore' });
      const deadline = Date.now() + 2_000;
      while (!(await Bun.file(processIdsPath).exists())) {
        if (Date.now() >= deadline) throw new Error('Signal-forwarding fixture did not start');
        await Bun.sleep(10);
      }
      const processIdsText = await Bun.file(processIdsPath).text();
      const processIds = processIdsText
        .trim()
        .split('\n')
        .map((value) => Number.parseInt(value, 10));

      fixture.kill(signal);
      const exitCode = await fixture.exited;

      expect(exitCode).toBe(expectedExitCode);
      for (const processId of processIds) {
        expect(() => process.kill(processId, 0)).toThrow();
      }
    });
  }

  it('readReport returns file text and undefined for missing files', async () => {
    const dependencies = createRealDependencies();
    const directory = await mkdtemp(join(tmpdir(), 'weft-run-tests-read-'));
    cleanupPaths.add(directory);
    const reportPath = join(directory, 'report.xml');
    await writeFile(reportPath, '<testsuites />', 'utf8');

    await expect(dependencies.readReport(reportPath)).resolves.toBe('<testsuites />');
    await expect(dependencies.readReport(join(directory, 'missing.xml'))).resolves.toBeUndefined();
  });

  it('removeDirectory deletes a directory tree', async () => {
    const dependencies = createRealDependencies();
    const directory = await mkdtemp(join(tmpdir(), 'weft-run-tests-remove-'));
    const nested = join(directory, 'nested');
    await mkdir(nested);
    await writeFile(join(nested, 'report.xml'), '<testsuites />', 'utf8');

    await dependencies.removeDirectory(directory);

    cleanupPaths.delete(directory);
    await expect(Bun.file(join(nested, 'report.xml')).exists()).resolves.toBe(false);
  });

  it('sweepStalePrecommitDirectories deletes only old matching directories', async () => {
    const freshDirectory = await mkdtemp(join(tmpdir(), 'weft-precommit-'));
    const staleDirectory = await mkdtemp(join(tmpdir(), 'weft-precommit-'));
    const unrelatedDirectory = await mkdtemp(join(tmpdir(), 'weft-not-precommit-'));
    cleanupPaths.add(freshDirectory);
    cleanupPaths.add(staleDirectory);
    cleanupPaths.add(unrelatedDirectory);

    const staleTimestamp = new Date(Date.now() - STALE_DIRECTORY_AGE_MS - 60_000);
    await utimes(staleDirectory, staleTimestamp, staleTimestamp);

    await sweepStalePrecommitDirectories();

    await expect(stat(staleDirectory)).rejects.toThrow();
    await expect(stat(freshDirectory)).resolves.toBeDefined();
    await expect(stat(unrelatedDirectory)).resolves.toBeDefined();

    cleanupPaths.delete(staleDirectory);
  });

  it('sweepStalePrecommitDirectories ignores unreadable base directories', async () => {
    const missingDirectory = join(tmpdir(), `weft-precommit-missing-${crypto.randomUUID()}`);
    await expect(sweepStalePrecommitDirectories(missingDirectory)).resolves.toBeUndefined();
  });
});

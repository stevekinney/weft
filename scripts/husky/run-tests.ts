/**
 * Diagnosable, flake-aware test runner for the pre-commit hook.
 *
 * The pre-commit hook runs the whole suite in one `bun test` invocation. When a
 * single load-sensitive test fails under parallel CPU pressure, the old hook
 * only printed "test failed" — never *which* test. This module captures the run
 * with Bun's JUnit reporter, names the failing `file > name`, and re-runs the
 * failing files once in isolation to tell a load-sensitive failure apart from a
 * real break.
 *
 * The risky orchestration ({@link runTestSuite}) is kept thin and takes
 * injectable dependencies so the classification logic can be unit-tested without
 * spawning Bun. The parsing/formatting/decision helpers are pure.
 */
import { $ } from 'bun';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A single failing test case, identified from the JUnit report. */
export type FailingTest = {
  file: string;
  name: string;
  line?: string;
};

/** A bounded excerpt of a `<failure>`/`<error>` body, for the diagnostic surface. */
export type FailureExcerpt = {
  file: string;
  name: string;
  /** `failure` or `error` — which child element produced this excerpt. */
  kind: 'failure' | 'error';
  /** The `type`/`message` attributes plus inner text, HTML-unescaped and bounded. */
  detail: string;
};

/** Captured process output from a `bun test` invocation. */
export type CapturedOutput = { stdout: string; stderr: string };

/**
 * The outcome of running the suite.
 *
 * `failedButPassedInIsolation` is named honestly: passing when rerun alone only
 * proves context-sensitivity (load, leaked timers, shared state, port reuse, or
 * test-order dependence), not a benign flake. It still fails the hook.
 */
export type TestRunOutcome =
  | { kind: 'passed' }
  | {
      kind: 'failed';
      failures: FailingTest[];
      output: CapturedOutput;
      /** The full-run JUnit report text, so callers don't re-read it from disk. */
      reportContent?: string;
      /** Absolute path of the retained per-run directory (present only on failure). */
      retainedDirectory?: string;
      /** Set when the JUnit report could not be read/parsed after a non-zero exit. */
      junitError?: string;
      /** Set when isolation ran but its own JUnit report was unavailable. */
      isolationJunitUnavailable?: boolean;
      /** Isolation output, present when an isolation run happened. */
      isolationOutput?: CapturedOutput;
    }
  | {
      kind: 'failedButPassedInIsolation';
      failures: FailingTest[];
      output: CapturedOutput;
      /** The full-run JUnit report text, so callers don't re-read it from disk. */
      reportContent?: string;
      /** Absolute path of the retained per-run directory (present only on failure). */
      retainedDirectory?: string;
      /** Isolation output — the run that proved the failure was context-sensitive. */
      isolationOutput?: CapturedOutput;
    };

/**
 * Test files that are excluded from the pre-commit full-suite step.
 *
 * Performance benchmarks under `src/benchmarks/` are skipped wholesale (see
 * {@link discoverTestFiles}). These two benchmark-shaped suites live outside that
 * directory for historical reasons and exhibit the same load sensitivity: one
 * asserts raw throughput numbers (`bun-sql-benchmark.test.ts`), the other depends
 * on tight timing windows (`bulk-operations.test.ts`). CI runs them in isolation;
 * pre-commit excludes them so a throughput regression doesn't masquerade as a
 * failed local commit.
 *
 * Before adding a new entry: prefer fixing the timing dependency. When
 * {@link runTestSuite} reports a file as `failedButPassedInIsolation` and the
 * cause is throughput/timing that genuinely cannot be made load-insensitive,
 * split that case into its own file and add its path here with a rationale
 * mirroring these two entries — never blanket-skip a real correctness test.
 */
export const LOAD_SENSITIVE_TEST_PATHS = [
  'src/storage/bun-sql-benchmark.test.ts',
  'src/core/bulk-operations.test.ts',
] as const;

/**
 * Dashboard compiler/JSDOM suites that must run serially.
 *
 * These tests import Svelte's compiler through jsdom/css-tree. Running them in
 * the same high-parallel Bun process as the whole repository can trigger
 * css-tree's lazy dictionary patching before its patch table is initialized.
 * They remain part of pre-commit, but run in a separate `--parallel=1` step.
 */
export const SERIAL_TEST_PATHS = [
  'src/dashboard/dashboard-serving.test.ts',
  'src/dashboard/svelte-test-harness.test-support.test.ts',
  'src/dashboard/fragments/workflow-execution-timeline.svelte.test.ts',
  'src/dashboard/fragments/schedule-list.test.ts',
  'src/dashboard/components/date-range-picker.svelte.test.ts',
  'src/dashboard/views/workflow-list.svelte.test.ts',
] as const;

function normalizedTestPath(file: string): string {
  return file.replace(/^\.\//, '').replace(/\/+/g, '/');
}

/**
 * Discover the test files the pre-commit full-suite step runs: every
 * `{src,tests}/**\/*.test.ts` except `/benchmarks/` files and the
 * {@link LOAD_SENSITIVE_TEST_PATHS} and {@link SERIAL_TEST_PATHS} entries.
 * Shared by the hook and its verification so the two cannot drift.
 */
export async function discoverTestFiles(): Promise<string[]> {
  const glob = new Bun.Glob('{src,tests}/**/*.test.ts');
  const testFiles: string[] = [];
  for await (const file of glob.scan('.')) {
    // Normalize before any allow-list comparison: strip a leading `./` and
    // collapse repeated slashes so a load-sensitive path can't slip through.
    const normalized = normalizedTestPath(file);
    if (normalized.includes('/benchmarks/')) continue;
    if (
      LOAD_SENSITIVE_TEST_PATHS.includes(normalized as (typeof LOAD_SENSITIVE_TEST_PATHS)[number])
    )
      continue;
    if (SERIAL_TEST_PATHS.includes(normalized as (typeof SERIAL_TEST_PATHS)[number])) continue;
    testFiles.push(file);
  }
  return testFiles;
}

/** Return only the serial dashboard suites that exist in the checkout. */
export async function discoverSerialTestFiles(): Promise<string[]> {
  const glob = new Bun.Glob('{src,tests}/**/*.test.ts');
  const discovered = new Set<string>();
  for await (const file of glob.scan('.')) {
    discovered.add(normalizedTestPath(file));
  }
  return SERIAL_TEST_PATHS.filter((file) => discovered.has(file));
}

/** Per-test timeout (ms) for the full and isolation runs. Matches the hook's historical value. */
export const TEST_TIMEOUT_MS = 15_000;

/**
 * If failures span at least this many distinct files, skip the isolation re-run:
 * a broad break is almost certainly real, not a single load-sensitive test, and
 * a second heavy run would only add cost.
 */
export const ISOLATION_SKIP_FILE_THRESHOLD = 4;

/** Max characters kept per failure excerpt before truncation. */
const MAX_EXCERPT_LENGTH = 500;

/** Max characters of captured stderr printed by the hook (tail). */
export const MAX_CAPTURED_TAIL_LENGTH = 16_000;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** A valid Unicode code point; out-of-range numeric references decode to nothing. */
function codePointFromEntity(code: number): string | undefined {
  // `String.fromCodePoint` throws RangeError outside [0, 0x10FFFF]; a corrupted
  // report like `&#999999999999;` must not crash the best-effort parser.
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return undefined;
  return String.fromCodePoint(code);
}

/** Decode the XML entities Bun's JUnit reporter emits: named plus numeric (dec/hex). */
function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return codePointFromEntity(Number.parseInt(entity.slice(2), 16)) ?? match;
    }
    if (entity.startsWith('#')) {
      return codePointFromEntity(Number.parseInt(entity.slice(1), 10)) ?? match;
    }
    const named = NAMED_ENTITIES[entity];
    return named ?? match;
  });
}

/**
 * Read an attribute value from a `<testcase …>` opening tag, decoded. Accepts
 * double- or single-quoted values (XML permits both); returns '' when absent.
 */
function readAttribute(openingTag: string, attribute: string): string {
  const match = openingTag.match(new RegExp(`\\b${attribute}=(?:"([^"]*)"|'([^']*)')`));
  if (!match) return '';
  return decodeXmlEntities(match[1] ?? match[2] ?? '');
}

/**
 * Iterate `<testcase …>…</testcase>` and self-closing `<testcase … />` blocks,
 * yielding the opening tag and the inner body (empty for self-closing).
 *
 * Best-effort: a `<failure>` body containing literal `</testcase>` text can
 * confuse the split, which is why the hook always prints raw captured output as
 * the authoritative diagnostic and treats this parse as a convenience summary.
 */
function* iterateTestcases(xml: string): Generator<{ openingTag: string; body: string }> {
  const openTagPattern = /<testcase\b([^>]*?)(\/?)>/g;
  let match: RegExpExecArray | null;
  while ((match = openTagPattern.exec(xml)) !== null) {
    const attributes = match[1] ?? '';
    const selfClosing = match[2] === '/';
    const openingTag = `<testcase${attributes}>`;
    if (selfClosing) {
      yield { openingTag, body: '' };
      continue;
    }
    const closeIndex = xml.indexOf('</testcase>', openTagPattern.lastIndex);
    const body =
      closeIndex === -1
        ? xml.slice(openTagPattern.lastIndex)
        : xml.slice(openTagPattern.lastIndex, closeIndex);
    yield { openingTag, body };
    if (closeIndex !== -1) {
      openTagPattern.lastIndex = closeIndex + '</testcase>'.length;
    }
  }
}

/**
 * Parse a Bun JUnit reporter XML string into the list of failing test cases.
 *
 * Pure and best-effort: never throws on malformed/truncated input. Failing cases
 * are those whose body contains a `<failure` or `<error` child. Deduped on
 * `file+name+line` (falling back to `file+name` when `line` is absent),
 * preserving document order.
 */
export function parseJunitFailures(xml: string): FailingTest[] {
  const failures: FailingTest[] = [];
  const seen = new Set<string>();
  for (const { openingTag, body } of iterateTestcases(xml)) {
    if (!/<failure\b|<error\b/.test(body)) continue;
    const name = readAttribute(openingTag, 'name');
    const file = readAttribute(openingTag, 'file');
    const line = readAttribute(openingTag, 'line');
    const key = line ? `${file} ${name} ${line}` : `${file} ${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    failures.push(line ? { file, name, line } : { file, name });
  }
  return failures;
}

/** Format failing tests as `file > name` lines, with fallbacks for missing fields. */
export function formatFailingTests(failures: FailingTest[]): string[] {
  return failures.map((failure) => {
    const file = failure.file || '(unknown file)';
    const name = failure.name || '(unknown test)';
    return `${file} > ${name}`;
  });
}

/**
 * Extract bounded `<failure>`/`<error>` excerpts from a JUnit report — the
 * second diagnostic layer after the `file > name` summary. Pure, best-effort,
 * never throws.
 */
export function extractJunitFailureExcerpts(xml: string): FailureExcerpt[] {
  const excerpts: FailureExcerpt[] = [];
  for (const { openingTag, body } of iterateTestcases(xml)) {
    const childMatch = body.match(/<(failure|error)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/);
    if (!childMatch) continue;
    const kind = childMatch[1] === 'error' ? 'error' : 'failure';
    const attributes = childMatch[2] ?? '';
    const innerText = childMatch[4] ?? '';
    const type = attributes.match(/\btype="([^"]*)"/)?.[1] ?? '';
    const message = attributes.match(/\bmessage="([^"]*)"/)?.[1] ?? '';
    const pieces = [type, message, innerText.trim()].map(decodeXmlEntities).filter(Boolean);
    const detail = boundExcerpt(pieces.join(' — '));
    excerpts.push({
      file: readAttribute(openingTag, 'file'),
      name: readAttribute(openingTag, 'name'),
      kind,
      detail,
    });
  }
  return excerpts;
}

/** Truncate an excerpt to {@link MAX_EXCERPT_LENGTH} with an ellipsis marker. */
function boundExcerpt(text: string): string {
  if (text.length <= MAX_EXCERPT_LENGTH) return text;
  return `${text.slice(0, MAX_EXCERPT_LENGTH)}… (truncated)`;
}

/** Keep the last {@link MAX_CAPTURED_TAIL_LENGTH} characters of captured output. */
export function tailBound(text: string, limit = MAX_CAPTURED_TAIL_LENGTH): string {
  if (text.length <= limit) return text;
  return `…(${text.length - limit} earlier characters omitted)\n${text.slice(-limit)}`;
}

/**
 * Build the exact `bun test` argument list shared by the full and isolation runs
 * so the two can never drift. The JUnit report is written to `junitPath`; Bun's
 * normal console reporter still emits to stderr alongside it.
 */
export function buildTestCommand(
  testFiles: string[],
  junitPath: string,
  options: { parallel?: boolean } = {},
): string[] {
  const parallelArguments = options.parallel === false ? ['--parallel=1'] : [];
  return [
    'test',
    '--timeout',
    String(TEST_TIMEOUT_MS),
    '--reporter=junit',
    `--reporter-outfile=${junitPath}`,
    ...parallelArguments,
    ...testFiles,
  ];
}

/** Fold a {@link TestRunOutcome} into the hook's pass/fail decision plus printable lines. */
export function renderTestOutcome(outcome: TestRunOutcome): { ok: boolean; lines: string[] } {
  if (outcome.kind === 'passed') {
    return { ok: true, lines: ['test passed'] };
  }

  const lines: string[] = [];
  const summary = formatFailingTests(outcome.failures);
  if (summary.length > 0) {
    lines.push('Failing tests:');
    for (const entry of summary) lines.push(`  ${entry}`);
  } else {
    lines.push('test failed — no JUnit test-case failures found; see captured output below.');
  }

  if (outcome.kind === 'failedButPassedInIsolation') {
    lines.push(
      'These tests failed in the full run but PASSED when rerun alone. This needs',
      'investigation: load sensitivity, leaked timers/state, or test-order dependence.',
      'Fix the root cause — do not ignore this.',
    );
    return { ok: false, lines };
  }

  if (outcome.junitError) {
    lines.push(`JUnit report unavailable: ${outcome.junitError}`);
  }
  if (outcome.isolationJunitUnavailable) {
    lines.push('Isolation run failed but its JUnit was unavailable; showing full-run failures.');
  }
  return { ok: false, lines };
}

/**
 * Dependencies the orchestration needs from the outside world. Injectable so
 * {@link runTestSuite} can be unit-tested with synthetic exit codes and JUnit
 * strings instead of a real Bun spawn.
 */
export type RunTestSuiteDependencies = {
  /** Run `bun <args>` and capture output without throwing on non-zero exit. */
  runCommand: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Create a fresh per-run directory and return its absolute path. */
  makeRunDirectory: () => Promise<string>;
  /** Read a file as text, or return undefined when it does not exist / cannot be read. */
  readReport: (path: string) => Promise<string | undefined>;
  /** Remove a directory tree, ignoring missing paths. */
  removeDirectory: (path: string) => Promise<void>;
  /** Remove stale per-run directories left behind by earlier failed runs. */
  sweepStaleDirectories: () => Promise<void>;
};

export function createRealDependencies(): RunTestSuiteDependencies {
  return {
    runCommand: async (args) => {
      // The run is captured (`.quiet()`), so output appears only on failure. Emit
      // a heartbeat dot every few seconds so the longest hook step doesn't look
      // like a hung process while it runs.
      const heartbeat = setInterval(() => process.stderr.write('.'), 3000);
      try {
        const result = await $`bun ${args}`.quiet().nothrow();
        return {
          exitCode: result.exitCode,
          stdout: result.stdout.toString(),
          stderr: result.stderr.toString(),
        };
      } finally {
        clearInterval(heartbeat);
        process.stderr.write('\n');
      }
    },
    makeRunDirectory: () => mkdtemp(join(tmpdir(), 'weft-precommit-')),
    readReport: async (path) => {
      try {
        return await Bun.file(path).text();
      } catch {
        return undefined;
      }
    },
    removeDirectory: (path) => rm(path, { recursive: true, force: true }),
    sweepStaleDirectories: () => sweepStalePrecommitDirectories(),
  };
}

const realDependencies: RunTestSuiteDependencies = createRealDependencies();

export const STALE_DIRECTORY_AGE_MS = 24 * 60 * 60 * 1000;

/** Remove `weft-precommit-*` dirs in tmpdir older than a day; ignore all errors. */
export async function sweepStalePrecommitDirectories(base = tmpdir()): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_DIRECTORY_AGE_MS;
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith('weft-precommit-'))
      .map(async (entry) => {
        const path = join(base, entry);
        try {
          const info = await stat(path);
          if (info.mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
        } catch {
          // best-effort cleanup; ignore
        }
      }),
  );
}

/** The per-run JUnit report filenames inside the run directory. */
const FULL_REPORT = 'full.junit.xml';
const ISOLATION_REPORT = 'isolation.junit.xml';

/**
 * Run the full suite, then — on failure — re-run the failing files once in
 * isolation to classify the result. Captures output and writes JUnit reports
 * into a per-run directory that is removed on success and retained (with its
 * path surfaced via the returned outcome) on failure.
 */
export async function runTestSuite(
  testFiles: string[],
  dependencies: RunTestSuiteDependencies = realDependencies,
  options: { parallel?: boolean } = {},
): Promise<TestRunOutcome> {
  // A bare `bun test` with no files runs the entire default set — never do that.
  if (testFiles.length === 0) return { kind: 'passed' };

  await dependencies.sweepStaleDirectories();
  const runDirectory = await dependencies.makeRunDirectory();
  let succeeded = false;
  try {
    const fullReportPath = join(runDirectory, FULL_REPORT);
    const full = await dependencies.runCommand(
      buildTestCommand(testFiles, fullReportPath, options),
    );
    const output: CapturedOutput = { stdout: full.stdout, stderr: full.stderr };
    if (full.exitCode === 0) {
      succeeded = true;
      return { kind: 'passed' };
    }

    const fullReport = await dependencies.readReport(fullReportPath);
    if (fullReport === undefined) {
      return {
        kind: 'failed',
        failures: [],
        output,
        junitError: `could not read JUnit report at ${fullReportPath}`,
        retainedDirectory: runDirectory,
      };
    }

    const failures = parseJunitFailures(fullReport);
    const failingFiles = [...new Set(failures.map((failure) => failure.file).filter(Boolean))];

    // No parseable failing files, or a broad break spanning many files: don't
    // bother with isolation — surface the failure as-is.
    if (failingFiles.length === 0 || failingFiles.length >= ISOLATION_SKIP_FILE_THRESHOLD) {
      return {
        kind: 'failed',
        failures,
        output,
        reportContent: fullReport,
        retainedDirectory: runDirectory,
      };
    }

    const isolationReportPath = join(runDirectory, ISOLATION_REPORT);
    const isolation = await dependencies.runCommand(
      buildTestCommand(failingFiles, isolationReportPath, options),
    );
    const isolationOutput: CapturedOutput = {
      stdout: isolation.stdout,
      stderr: isolation.stderr,
    };

    if (isolation.exitCode === 0) {
      return {
        kind: 'failedButPassedInIsolation',
        failures,
        output,
        reportContent: fullReport,
        isolationOutput,
        retainedDirectory: runDirectory,
      };
    }

    const isolationReport = await dependencies.readReport(isolationReportPath);
    if (isolationReport === undefined) {
      return {
        kind: 'failed',
        failures,
        output,
        reportContent: fullReport,
        isolationJunitUnavailable: true,
        isolationOutput,
        retainedDirectory: runDirectory,
      };
    }
    const stillFailing = parseJunitFailures(isolationReport);
    return {
      kind: 'failed',
      failures: stillFailing.length > 0 ? stillFailing : failures,
      output,
      reportContent: fullReport,
      isolationOutput,
      retainedDirectory: runDirectory,
    };
  } finally {
    // Delete the run directory on success; retain it on failure so a contributor
    // can inspect the full + isolation reports at the path surfaced above.
    if (succeeded) await dependencies.removeDirectory(runDirectory);
  }
}

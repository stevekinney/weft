/**
 * Deterministic coverage gate for `bun run check:coverage` (plan §11.7, T0.1
 * leftovers). Runs one `bun run test:coverage` pass (the repo's `bun test
 * --coverage` invocation, with the same `--conditions browser --conditions
 * svelte` flags `bun run test` uses), parses the LCOV report it writes to
 * `coverage/lcov.info`, prints per-area line/function coverage, and fails
 * when either the run itself failed or adjusted coverage drops below the
 * floor recorded in `scripts/coverage-baseline.ts`.
 *
 * This is a RATCHET, not a 100%-coverage gate. `docs/implementation-plan.md`
 * §11 targets 100% adjusted coverage with an explicit reviewed allowance
 * file, weft-style, once the console's surfaces stabilize — that is the
 * aspirational end state, not what this script enforces today. See
 * `scripts/coverage-baseline.ts` for how to move the floor forward.
 *
 * Deliberately NOT a clone of weft's `scripts/check-coverage.ts`: no
 * per-file line-keyed allowance layers, no refresh-layer partitioning. That
 * machinery was earned over dozens of PRs restoring coverage on a mature
 * codebase; a bootstrapping console gates on area-level totals instead.
 *
 * @module
 */
import { $ } from 'bun';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  COVERAGE_BASELINES,
  coverageMeasurementPlatform,
  type AreaCoverage,
  type CoverageBaseline,
} from './coverage-baseline.ts';
import {
  DARWIN_BASELINE_COVERAGE_TEST_ORDER,
  LINUX_BASELINE_COVERAGE_TEST_ORDER,
} from './coverage-test-order.ts';

const REPO_ROOT = join(import.meta.dir, '..');
const COVERAGE_DIRECTORY = join(REPO_ROOT, 'coverage');
const LCOV_PATH = join(COVERAGE_DIRECTORY, 'lcov.info');
const COVERAGE_TEST_ROOTS = ['scripts', 'src', 'tests'] as const;
const BUN_TEST_FILE_PATTERN = /(?:\.test|_test|\.spec|_spec)\.(?:[cm]?[jt]s|[jt]sx)$/;
function baselineCoverageTestRank(platform: NodeJS.Platform): ReadonlyMap<string, number> {
  const order =
    platform === 'darwin'
      ? DARWIN_BASELINE_COVERAGE_TEST_ORDER
      : platform === 'linux'
        ? LINUX_BASELINE_COVERAGE_TEST_ORDER
        : [];
  return new Map<string, number>(order.map((path, index) => [path, index]));
}

function compareCoverageTestFiles(
  left: string,
  right: string,
  rank: ReadonlyMap<string, number>,
): number {
  const leftRank = rank.get(left);
  const rightRank = rank.get(right);
  if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
  if (leftRank !== undefined) return -1;
  if (rightRank !== undefined) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Keep repository tests in the versioned baseline order, then append new files lexically. */
export function selectCoverageTestFiles(
  paths: Iterable<string>,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const rank = baselineCoverageTestRank(platform);
  return [...paths]
    .filter(
      (path) =>
        /^(?:scripts|src|tests)\//.test(path) &&
        !path.startsWith('tests/e2e/') &&
        BUN_TEST_FILE_PATTERN.test(path),
    )
    .toSorted((left, right) => compareCoverageTestFiles(left, right, rank));
}

/** Convert selected files to exact Bun test paths so Bun preserves the supplied order. */
export function coverageTestArguments(
  paths: Iterable<string>,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return selectCoverageTestFiles(paths, platform).map((path) => `./${path}`);
}

/** Discover every coverage test explicitly so filesystem enumeration cannot reorder the suite. */
export function discoverCoverageTestFiles(
  repositoryRoot = REPO_ROOT,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const testGlob = new Bun.Glob('**/*.{cjs,mjs,js,jsx,cts,mts,ts,tsx}');
  const candidates = COVERAGE_TEST_ROOTS.flatMap((root) =>
    [...testGlob.scanSync({ cwd: join(repositoryRoot, root), onlyFiles: true })].map(
      (path) => `${root}/${path}`,
    ),
  );
  return selectCoverageTestFiles(candidates, platform);
}

/** One file's coverage counts, straight off an LCOV `end_of_record` block. */
export type FileCoverage = {
  file: string;
  linesFound: number;
  linesHit: number;
  functionsFound: number;
  functionsHit: number;
};

function isFiniteNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

type MutableRecord = {
  file?: string;
  linesFound: number;
  linesHit: number;
  functionsFound: number;
  functionsHit: number;
};

function freshRecord(): MutableRecord {
  return { linesFound: 0, linesHit: 0, functionsFound: 0, functionsHit: 0 };
}

function isCompleteRecord(record: MutableRecord): record is FileCoverage {
  return (
    record.file !== undefined &&
    isFiniteNonNegativeInteger(record.linesFound) &&
    isFiniteNonNegativeInteger(record.linesHit) &&
    isFiniteNonNegativeInteger(record.functionsFound) &&
    isFiniteNonNegativeInteger(record.functionsHit)
  );
}

type NumericField = 'linesFound' | 'linesHit' | 'functionsFound' | 'functionsHit';

// Bun's LCOV writer emits no `FN:`/`FNDA:` per-function detail, only these
// four file-level totals plus `SF:` and `end_of_record` — see parseLcov.
const NUMERIC_FIELD_PREFIXES: ReadonlyArray<readonly [prefix: string, field: NumericField]> = [
  ['FNF:', 'functionsFound'],
  ['FNH:', 'functionsHit'],
  ['LF:', 'linesFound'],
  ['LH:', 'linesHit'],
];

/** Apply a `PREFIX:<number>` line to `record` in place, if it matches a known field. */
function applyNumericField(record: MutableRecord, line: string): void {
  for (const [prefix, field] of NUMERIC_FIELD_PREFIXES) {
    if (line.startsWith(prefix)) {
      record[field] = Number(line.slice(prefix.length));
      return;
    }
  }
}

/**
 * Parse a Bun-generated LCOV report into per-file coverage counts.
 *
 * Best-effort and forgiving of the fields Bun's LCOV writer omits — any line
 * that isn't `SF:`, one of the four {@link NUMERIC_FIELD_PREFIXES}, or
 * `end_of_record` is ignored. A record missing `SF:` or carrying a
 * non-integer count is dropped rather than throwing, since a
 * partial/truncated report should still yield whatever it can for the
 * summary rather than crash the gate on unrelated line noise.
 */
export function parseLcov(content: string): FileCoverage[] {
  const records: FileCoverage[] = [];
  let record = freshRecord();

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('SF:')) {
      record.file = line.slice('SF:'.length);
      continue;
    }
    if (line === 'end_of_record') {
      if (isCompleteRecord(record)) records.push(record);
      record = freshRecord();
      continue;
    }
    applyNumericField(record, line);
  }

  return records;
}

/**
 * Bucket a repo-relative file path into a coverage "area" for the summary
 * table. Generic by directory depth instead of a hardcoded surface list, so
 * a new `src/routes/<domain>` a track adds shows up automatically: direct
 * children of `src/` (`src/app`, `src/lib`, …), one level deeper for
 * `src/routes/<domain>`, and the top-level directory name (`fixtures`,
 * `scripts`, `tests`) for everything outside `src/`.
 */
export function areaForFile(file: string): string {
  const parts = file.split('/');
  const top = parts[0];
  if (top !== 'src') return top === undefined || top === '' ? 'other' : top;
  if (parts.length <= 2) return 'src';
  if (parts[1] === 'routes' && parts.length >= 3) return `src/routes/${parts[2]}`;
  return `src/${parts[1]}`;
}

function emptyTotals(): AreaCoverage {
  return { linesFound: 0, linesHit: 0, functionsFound: 0, functionsHit: 0 };
}

function addTotals(totals: AreaCoverage, record: FileCoverage): AreaCoverage {
  return {
    linesFound: totals.linesFound + record.linesFound,
    linesHit: totals.linesHit + record.linesHit,
    functionsFound: totals.functionsFound + record.functionsFound,
    functionsHit: totals.functionsHit + record.functionsHit,
  };
}

/**
 * Whether an LCOV record's path stays inside this package. Coverage runs in
 * the monorepo can attribute hits to workspace siblings (`../weft/…`) or
 * absolute paths; those files are gated by their own package, not here.
 */
export function isPackageLocalFile(record: FileCoverage): boolean {
  return (
    !record.file.startsWith('..') &&
    !record.file.startsWith('/') &&
    !record.file.split('/').includes('node_modules')
  );
}

/** Sum per-file records into per-area totals (see {@link areaForFile}). */
export function aggregateByArea(records: FileCoverage[]): Map<string, AreaCoverage> {
  const areas = new Map<string, AreaCoverage>();
  for (const record of records) {
    const area = areaForFile(record.file);
    areas.set(area, addTotals(areas.get(area) ?? emptyTotals(), record));
  }
  return areas;
}

/** Sum every file's record into one repo-wide total. */
export function overallTotals(records: FileCoverage[]): AreaCoverage {
  return records.reduce(addTotals, emptyTotals());
}

/** A file with zero found lines/functions is vacuously fully covered. */
export function percentage(hit: number, found: number): number {
  if (found === 0) return 100;
  return (hit / found) * 100;
}

function formatPercentage(value: number): string {
  return `${value.toFixed(2)}%`;
}

export type Regression = {
  area: string;
  metric: 'lines' | 'functions';
  currentPercentage: number;
  baselinePercentage: number;
};

// Two runs of the exact same command over the exact same source produce
// identical hit/found counts (LCOV counts are exact integers), so this only
// needs to absorb floating-point rounding in the percentage division, not
// day-to-day measurement noise. A real regression is never this small.
const REGRESSION_EPSILON = 1e-9;

/**
 * Compare current per-area totals against the recorded baseline and report
 * every area whose line or function coverage dropped. An area present in the
 * baseline but absent from the current run (e.g. a directory rename) is
 * skipped here — {@link main} warns about it separately instead of gating on
 * a shape change this function can't distinguish from "coverage went to
 * zero."
 */
export function findRegressions(
  current: ReadonlyMap<string, AreaCoverage>,
  baseline: ReadonlyMap<string, AreaCoverage>,
): Regression[] {
  const regressions: Regression[] = [];
  for (const [area, baselineTotals] of baseline) {
    const currentTotals = current.get(area);
    if (currentTotals === undefined) continue;

    const currentLines = percentage(currentTotals.linesHit, currentTotals.linesFound);
    const baselineLines = percentage(baselineTotals.linesHit, baselineTotals.linesFound);
    if (currentLines < baselineLines - REGRESSION_EPSILON) {
      regressions.push({
        area,
        metric: 'lines',
        currentPercentage: currentLines,
        baselinePercentage: baselineLines,
      });
    }

    const currentFunctions = percentage(currentTotals.functionsHit, currentTotals.functionsFound);
    const baselineFunctions = percentage(
      baselineTotals.functionsHit,
      baselineTotals.functionsFound,
    );
    if (currentFunctions < baselineFunctions - REGRESSION_EPSILON) {
      regressions.push({
        area,
        metric: 'functions',
        currentPercentage: currentFunctions,
        baselinePercentage: baselineFunctions,
      });
    }
  }
  return regressions;
}

/** Render the per-area (plus `OVERALL`) current-vs-baseline table as printable lines. */
export function renderAreaTable(
  current: ReadonlyMap<string, AreaCoverage>,
  baseline: ReadonlyMap<string, AreaCoverage>,
): string[] {
  const areas = [...new Set([...current.keys(), ...baseline.keys()])].toSorted();
  const lines = ['area | lines | functions | baseline lines | baseline functions'];
  for (const area of areas) {
    const totals = current.get(area);
    const base = baseline.get(area);
    const linesCell = totals
      ? formatPercentage(percentage(totals.linesHit, totals.linesFound))
      : '(missing)';
    const functionsCell = totals
      ? formatPercentage(percentage(totals.functionsHit, totals.functionsFound))
      : '(missing)';
    const baseLinesCell = base
      ? formatPercentage(percentage(base.linesHit, base.linesFound))
      : '(new)';
    const baseFunctionsCell = base
      ? formatPercentage(percentage(base.functionsHit, base.functionsFound))
      : '(new)';
    lines.push(
      `${area} | ${linesCell} | ${functionsCell} | ${baseLinesCell} | ${baseFunctionsCell}`,
    );
  }
  return lines;
}

/**
 * Resolve the baseline the current platform gates against. Returns a `null`
 * baseline (after printing why) for the two ungated cases: an unrecognized
 * platform, and a recognized platform with no recorded baseline yet — the
 * latter prints a paste-ready bootstrap object so the first measurement on
 * a new platform (e.g. the first CI run after the darwin/linux split)
 * supplies the numbers a follow-up commit records.
 */
export function resolveBaselineForPlatform(
  currentAreas: ReadonlyMap<string, AreaCoverage>,
  platform: ReturnType<typeof coverageMeasurementPlatform> = coverageMeasurementPlatform(),
  baselines: typeof COVERAGE_BASELINES = COVERAGE_BASELINES,
): {
  baseline: CoverageBaseline | null;
  platform: string;
} {
  if (platform === null) {
    console.log(
      `\nNo coverage baseline vocabulary for platform "${process.platform}" — measurement ran clean but is not gated here. Record a baseline in scripts/coverage-baseline.ts to gate this platform.`,
    );
    return { baseline: null, platform: process.platform };
  }

  const baseline = baselines[platform];
  if (baseline === null) {
    const bootstrap: CoverageBaseline = {
      measuredAt: new Date().toISOString(),
      overall: currentAreas.get('OVERALL') ?? emptyTotals(),
      areas: Object.fromEntries(
        [...currentAreas.entries()].filter(([area]) => area !== 'OVERALL').toSorted(),
      ),
    };
    console.log(
      `\nNo ${platform} baseline recorded yet — bootstrap mode: measurement ran clean and is NOT gated this run.`,
    );
    console.log(
      `Record it by pasting this into scripts/coverage-baseline.ts as the ${platform} entry:\n`,
    );
    console.log(JSON.stringify(bootstrap, null, 2));
    return { baseline: null, platform };
  }

  return { baseline, platform };
}

async function main(): Promise<boolean> {
  await rm(COVERAGE_DIRECTORY, { recursive: true, force: true });

  console.log('Running `bun run test:coverage`…');
  const run = await $`bun run test:coverage`.cwd(REPO_ROOT).nothrow();
  if (run.exitCode !== 0) {
    console.error(
      `\n\`bun run test:coverage\` exited with code ${run.exitCode} — the coverage gate does not run against a failing or crashed test process.`,
    );
    console.error('Fix the failing/crashing tests first, then re-run `bun run check:coverage`.');
    return false;
  }

  let lcovContent: string;
  try {
    lcovContent = await Bun.file(LCOV_PATH).text();
  } catch {
    console.error(
      `\nExpected an LCOV report at ${LCOV_PATH} but found none — coverage cannot be gated. Was \`test:coverage\` changed to drop \`--coverage-reporter=lcov\`?`,
    );
    return false;
  }

  // In the monorepo, Bun's coverage instrumentation also reports files it
  // reached through the @lostgradient/weft workspace symlink as `../weft/…`
  // records. Those belong to the weft package's own coverage gate, not this
  // one, so keep only package-local files.
  const records = parseLcov(lcovContent).filter(isPackageLocalFile);
  const currentAreas = aggregateByArea(records);
  currentAreas.set('OVERALL', overallTotals(records));

  const gate = resolveBaselineForPlatform(currentAreas);
  if (gate.baseline === null) return true;
  const { baseline, platform } = gate;

  const baselineAreas = new Map<string, AreaCoverage>(Object.entries(baseline.areas));
  baselineAreas.set('OVERALL', baseline.overall);

  console.log(
    `\nCoverage by area (${platform}), current vs. the baseline recorded ${baseline.measuredAt}:`,
  );
  for (const line of renderAreaTable(currentAreas, baselineAreas)) {
    console.log(`  ${line}`);
  }

  const newAreas = [...currentAreas.keys()].filter((area) => !baselineAreas.has(area));
  if (newAreas.length > 0) {
    console.log(`\nNew area(s) with no recorded baseline yet (not gated): ${newAreas.join(', ')}`);
  }
  const droppedAreas = [...baselineAreas.keys()].filter(
    (area) => area !== 'OVERALL' && !currentAreas.has(area),
  );
  if (droppedAreas.length > 0) {
    console.log(
      `\nBaselined area(s) with no files in this run (rename/removal? not gated): ${droppedAreas.join(', ')}`,
    );
  }

  const regressions = findRegressions(currentAreas, baselineAreas);
  if (regressions.length > 0) {
    console.error(`\n${regressions.length} coverage regression(s) vs. the recorded baseline:`);
    for (const regression of regressions) {
      console.error(
        `  ${regression.area} ${regression.metric}: ${formatPercentage(regression.currentPercentage)} < baseline ${formatPercentage(regression.baselinePercentage)}`,
      );
    }
    console.error(
      '\nCoverage dropped below the recorded floor in scripts/coverage-baseline.ts. Add tests to restore it, or — if the drop is an intentional, reviewed tradeoff — raise it in the PR description and update the baseline in the same PR.',
    );
    return false;
  }

  console.log('\nCoverage gate passed — no area dropped below its recorded baseline.');
  return true;
}

if (import.meta.main) {
  const ok = await main();
  process.exit(ok ? 0 : 1);
}

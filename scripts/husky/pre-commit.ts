#!/usr/bin/env bun
import { $ } from 'bun';

import {
  discoverTestFiles,
  extractJunitFailureExcerpts,
  renderTestOutcome,
  runTestSuite,
  tailBound,
} from './run-tests.ts';
import {
  error,
  getStagedFiles,
  header,
  info,
  isContinuousIntegration,
  success,
  warning,
} from './utilities.ts';

if (isContinuousIntegration()) {
  info('Skipping hook in CI');
  process.exit(0);
}

header('Pre-commit checks');
let ok = true;

// 1) package/lock checks
const staged = await getStagedFiles();
if (staged.includes('package.json')) {
  info('package.json is staged');
  if (!staged.includes('bun.lock')) {
    const bunLockStatus = await $`git status --porcelain -- bun.lock`.text();
    if (bunLockStatus.trim().length > 0) {
      warning('bun.lock has unstaged changes');
      info('Run bun install and stage bun.lock');
      ok = false;
    } else {
      info('bun.lock unchanged; continuing');
    }
  } else {
    info('Dependencies changed, installing…');
    try {
      await $`bun install`;
      success('Dependencies installed');
    } catch {
      warning('bun install failed; run it manually');
    }
  }
}

// 2) lint:fix
info('Running lint:fix…');
try {
  await $`bun run lint:fix`;
  success('lint:fix passed');
} catch {
  error('lint:fix failed');
  ok = false;
}

// 3) definition vocabulary check
info('Running definition vocabulary check…');
try {
  await $`bun run scripts/check-definition-vocabulary.ts`;
  success('definition vocabulary check passed');
} catch {
  error('definition vocabulary check failed');
  ok = false;
}

// 4) catalog generation checks
info('Running catalog generation checks…');
try {
  await $`bun run scripts/check-catalog-completeness.ts`;
  await $`bun run scripts/check-catalog-drift.ts`;
  success('catalog generation checks passed');
} catch {
  error('catalog generation checks failed');
  ok = false;
}

// 5) typecheck
info('Running typecheck…');
try {
  await $`bun run typecheck`;
  success('typecheck passed');
} catch {
  error('typecheck failed');
  ok = false;
}

function reportTestOutcome(outcome: Awaited<ReturnType<typeof runTestSuite>>): boolean {
  const { ok: testsOk, lines } = renderTestOutcome(outcome);
  if (testsOk) {
    success('test passed');
    return true;
  }

  error('test failed');
  for (const line of lines) error(line);

  // Diagnostic surface, most-useful-first. The parsed summary above is
  // best-effort; the JUnit excerpts and captured stderr are authoritative.
  if (outcome.kind !== 'passed') {
    // `reportContent` is the full-run JUnit the runner already read — no
    // second disk read (which could race cleanup and silently yield nothing).
    for (const excerpt of extractJunitFailureExcerpts(outcome.reportContent ?? '')) {
      info(`\n${excerpt.file} > ${excerpt.name} [${excerpt.kind}]`);
      console.error(excerpt.detail);
    }
    const stderrTail = tailBound(outcome.output.stderr);
    if (stderrTail.trim().length > 0) {
      info('\nCaptured test output (stderr tail):');
      console.error(stderrTail);
    }
    if (outcome.isolationOutput) {
      const isolationTail = tailBound(outcome.isolationOutput.stderr);
      if (isolationTail.trim().length > 0) {
        info('\nIsolation re-run output (stderr tail):');
        console.error(isolationTail);
      }
    }
    // The retained reports help diagnose a *real* failure's stack traces; for
    // a context-sensitive pass-in-isolation result the summary is the action.
    if (outcome.kind === 'failed' && outcome.retainedDirectory) {
      warning(`\nFull reports retained at: ${outcome.retainedDirectory}`);
    }
  }

  return false;
}

// 6) test
// Run the full suite (benchmarks and the two load-sensitive suites excluded by
// `discoverTestFiles`). The runner captures Bun's JUnit report so a failure
// names the offending `file > name`, and re-runs failing files once in
// isolation to distinguish a load-sensitive failure from a real break. See
// scripts/husky/run-tests.ts.
{
  const testFiles = await discoverTestFiles();
  // The full run is captured (output appears on failure), so the terminal would
  // otherwise go silent through the longest hook step. Say so up front.
  info(`Running test… (${testFiles.length} files; output shown on failure)`);
  const outcome = await runTestSuite(testFiles);
  if (!reportTestOutcome(outcome)) {
    ok = false;
  }
}

// 7) oxlint-disable ceiling + rationale check (mirrors the gate in `bun run lint`)
info('Running oxlint-disable check…');
try {
  await $`bun scripts/check-lint-disables.ts`;
  success('oxlint-disable check passed');
} catch {
  error(
    'oxlint-disable check failed — see scripts/check-lint-disables.ts and the Lint suppression policy in CLAUDE.md.',
  );
  ok = false;
}

// 8) JSDoc manifest audit (only when source/scripts/package.json changed)
const stagedTouchesPublicSurface = staged.some(
  (file) =>
    file.startsWith('src/') ||
    file === 'package.json' ||
    file.startsWith('scripts/lib/jsdoc-manifest') ||
    file.startsWith('scripts/audit-jsdoc-manifest') ||
    file.startsWith('scripts/build-jsdoc-manifest') ||
    file.startsWith('scripts/check-declaration-jsdoc') ||
    file.startsWith('scripts/extract-doctests') ||
    file.startsWith('scripts/extract-markdown-doctests'),
);
if (stagedTouchesPublicSurface) {
  info('Running JSDoc audit…');
  try {
    await $`bun run scripts/audit-jsdoc-manifest.ts`;
    success('JSDoc audit passed');
  } catch {
    error(
      'JSDoc audit failed — see hint above. The manifest is built in-memory; failures usually mean a new public export needs JSDoc + @example, or `dist/` is stale (run `bun run build`), or scripts/lib/jsdoc-manifest.ts cannot reach the symbol.',
    );
    ok = false;
  }
} else {
  info('Skipping JSDoc audit (no public surface changes staged)');
}

// 9) lint-staged (format staged files; always last)
info('Running lint-staged…');
try {
  await $`bunx lint-staged`;
  success('Lint-staged passed');
} catch {
  error('Lint-staged failed');
  ok = false;
}

if (!ok) {
  error('Pre-commit checks failed');
  process.exit(1);
}

success('All pre-commit checks passed');

process.exit(0);

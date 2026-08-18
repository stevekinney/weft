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

export const RATCHET_STASH_MESSAGE = 'pre-commit-markdown-doctest-ratchet';

export type RatchetStash = {
  marker: string;
  sha: string;
};

class RatchetStashRestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RatchetStashRestoreError';
  }
}

type GitResult = { exitCode: number; stdout: string; stderr: string };

async function runGit(repositoryRoot: string, arguments_: string[]): Promise<GitResult> {
  const subprocess = Bun.spawn(['git', '-C', repositoryRoot, ...arguments_], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function describeGitFailure(arguments_: string[], result: GitResult): string {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
  return `git ${arguments_.join(' ')} failed: ${detail}`;
}

/** Stash unstaged and untracked files, returning only this invocation's identity. */
export async function createRatchetStash(
  repositoryRoot: string,
): Promise<RatchetStash | undefined> {
  const marker = `${RATCHET_STASH_MESSAGE}:${crypto.randomUUID()}`;
  const pushArguments = ['stash', 'push', '--keep-index', '-u', '-m', marker];
  const pushed = await runGit(repositoryRoot, pushArguments);
  if (pushed.exitCode !== 0) throw new Error(describeGitFailure(pushArguments, pushed));

  const listArguments = ['stash', 'list', '--format=%H %gs'];
  const listed = await runGit(repositoryRoot, listArguments);
  if (listed.exitCode !== 0) throw new Error(describeGitFailure(listArguments, listed));

  for (const line of listed.stdout.split('\n')) {
    const separator = line.indexOf(' ');
    if (separator === -1) continue;
    const sha = line.slice(0, separator);
    const subject = line.slice(separator + 1);
    if (subject.endsWith(marker)) return { marker, sha };
  }
  return undefined;
}

/** Restore and remove one exact stash entry without consulting stack position. */
export async function restoreRatchetStash(
  repositoryRoot: string,
  stash: RatchetStash,
): Promise<void> {
  const applyArguments = ['stash', 'apply', stash.sha];
  const applied = await runGit(repositoryRoot, applyArguments);
  if (applied.exitCode !== 0) {
    throw new RatchetStashRestoreError(
      `Restoring your unstaged changes from stash ${stash.sha} failed. The exact entry remains available with marker ${stash.marker}. ${describeGitFailure(applyArguments, applied)}`,
    );
  }

  // `git stash drop` rejects a raw commit SHA. Resolve the selector from the
  // captured identity immediately before dropping; the selector is never
  // chosen by stack position alone.
  const listArguments = ['stash', 'list', '--format=%gd %H'];
  const listed = await runGit(repositoryRoot, listArguments);
  if (listed.exitCode !== 0) {
    throw new RatchetStashRestoreError(describeGitFailure(listArguments, listed));
  }
  const selector = listed.stdout
    .split('\n')
    .map((line) => line.split(' '))
    .find(([, sha]) => sha === stash.sha)?.[0];
  if (selector === undefined) {
    throw new RatchetStashRestoreError(
      `Your unstaged changes were restored, but stash ${stash.sha} could not be found for removal.`,
    );
  }

  const dropArguments = ['stash', 'drop', selector];
  const dropped = await runGit(repositoryRoot, dropArguments);
  if (dropped.exitCode !== 0) {
    throw new RatchetStashRestoreError(
      `Your unstaged changes were restored, but dropping stash ${stash.sha} failed. The exact entry remains available with marker ${stash.marker}. ${describeGitFailure(dropArguments, dropped)}`,
    );
  }
}

function signalExitCode(signal: 'SIGINT' | 'SIGTERM'): number {
  return signal === 'SIGINT' ? 130 : 143;
}

/** Run the ratchet with one identity-bound stash that signals also restore. */
export async function withRatchetStash<T>(
  repositoryRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const stashPromise = createRatchetStash(repositoryRoot);
  let cleanupPromise: Promise<void> | undefined;
  let interrupted = false;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= stashPromise.then((stash) =>
      stash === undefined ? Promise.resolve() : restoreRatchetStash(repositoryRoot, stash),
    );
    return cleanupPromise;
  };

  const terminate = (signal: 'SIGINT' | 'SIGTERM'): void => {
    interrupted = true;
    void cleanup().then(
      () => process.exit(signalExitCode(signal)),
      (cause: unknown) => {
        error(cause instanceof Error ? cause.message : String(cause));
        process.exit(1);
      },
    );
  };
  const onInterrupt = (): void => terminate('SIGINT');
  const onTerminate = (): void => terminate('SIGTERM');
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);

  try {
    await stashPromise;
    if (interrupted) return await new Promise<T>(() => {});
    return await operation();
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    await cleanup();
  }
}

export async function main(): Promise<void> {
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
  // Run the full suite (benchmarks plus load-sensitive and browser-smoke suites
  // excluded by `discoverTestFiles`). The runner captures Bun's JUnit report so a failure
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

  // 9) markdown doctest skip-count ratchet (only when documentation or one of
  // the ratchet's own inputs changed). This is the fast half of
  // `verify:markdown-doctests` — classification and the skip-count ceiling
  // only, no doctest extraction/typecheck — so it stays cheap enough for every
  // commit. The full doctest compile still runs in CI's verify-jsdoc workflow.
  const stagedTouchesMarkdownDoctestRatchetInputs = staged.some(
    (file) =>
      (file.startsWith('documentation/') && file.endsWith('.md')) ||
      file === 'scripts/markdown-doctest-skip-counts.json' ||
      file === 'scripts/markdown-doctest-skip-reasons.txt',
  );
  if (stagedTouchesMarkdownDoctestRatchetInputs) {
    info('Running markdown doctest skip-count check…');
    // The ratchet reads documentation/ and the skip-counts JSON straight off
    // disk, so unstaged edits (e.g. a skip-count bump the developer forgot to
    // `git add`) would leak into the result and pass a commit CI then rejects.
    // Stash unstaged/untracked changes (keeping the index intact) so the check
    // runs against exactly what will be committed.
    try {
      await withRatchetStash(process.cwd(), async () => {
        await $`bun run verify:markdown-doctests:ratchet`;
      });
      success('Markdown doctest skip-count check passed');
    } catch (cause) {
      error(
        cause instanceof RatchetStashRestoreError
          ? cause.message
          : 'Markdown doctest skip-count check failed — see hint above. Update scripts/markdown-doctest-skip-counts.json to match the new counts and stage it in this commit.',
      );
      ok = false;
    }
  } else {
    info('Skipping markdown doctest skip-count check (no ratchet inputs staged)');
  }

  // 10) lint-staged (format staged files; always last)
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
}

if (import.meta.main) await main();

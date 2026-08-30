#!/usr/bin/env bun
/**
 * Pre-commit gate: format + lint the staged files, typecheck the project, then
 * run the fast test path. Mirrors the weft repo's Bun-hook architecture (thin
 * `.husky/pre-commit` shell wrapper + this script) without cloning its full
 * pipeline — weft-console has no catalog/JSDoc/doctest surfaces to gate yet.
 *
 * Every step runs even if an earlier one fails, so a contributor sees the
 * full picture in one pass instead of fixing issues one at a time.
 */
import { $ } from 'bun';

import { failure, header, info, isContinuousIntegration, success } from './utilities.ts';

if (isContinuousIntegration()) {
  info('Skipping pre-commit hook in CI');
  process.exit(0);
}

header('Pre-commit checks');
let ok = true;

// 1) format + lint on staged files
info('Running lint-staged (format + lint on staged files)…');
try {
  await $`bunx lint-staged`;
  success('lint-staged passed');
} catch {
  failure('lint-staged failed');
  ok = false;
}

// 2) typecheck
info('Running typecheck…');
try {
  await $`bun run typecheck`;
  success('typecheck passed');
} catch {
  failure('typecheck failed');
  ok = false;
}

// 3) fast test path — the same command CI runs, so a green hook means a green
// `bun run test` (no separate subset/allowlist to drift from CI).
info('Running tests…');
try {
  await $`bun run test`;
  success('tests passed');
} catch {
  failure('tests failed');
  ok = false;
}

if (!ok) {
  failure('\nPre-commit checks failed.');
  process.exit(1);
}

success('\nAll pre-commit checks passed.');
process.exit(0);

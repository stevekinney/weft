#!/usr/bin/env bun
/**
 * Enforce the oxlint suppression policy for `src/`.
 *
 * Scans every `oxlint-disable*` directive in source files matched by
 * {@link SOURCE_FILE_GLOB} (excluding {@link TEST_FILE_EXCLUSION_GLOBS}) and
 * enforces two invariants:
 *
 * 1. **Ceiling.** The total number of directives must not exceed the
 *    effective max (default {@link MAX_DISABLES}; overridable via `--max <n>`
 *    for capstone-style strict-zero checks).
 * 2. **Rationale.** Every directive must carry an inline rationale after `--`
 *    that is at least {@link MIN_RATIONALE_LENGTH} characters long, after
 *    stripping any leading `ID:<token>`. The structural convention
 *    `<reason>; rejected: <alternative>` is enforced in PR review, not by
 *    regex.
 *
 * `--emit-snapshot <path>` writes a tab-separated audit artifact of every
 * directive in enforcement scope. The flag is scan-only: it never enforces a
 * ceiling or rationale length, regardless of `--max`. Use it to capture
 * pre-/post-refactor inventories without blocking the audit on the current state.
 *
 * `--root <path>` sets the directory the scanner walks. Defaults to the
 * repository root. Used by the script's own tests to point at fixture trees
 * instead of the live repo.
 */

import { Glob, file, write } from 'bun';
import { join } from 'node:path';

export const MAX_DISABLES = 5;
export const MIN_RATIONALE_LENGTH = 40;

/** Inclusion glob for files in enforcement scope. */
export const SOURCE_FILE_GLOB = 'src/**/*.{ts,tsx,mts,cts}';

/** Path patterns excluded from enforcement scope (test and spec files). */
export const TEST_FILE_EXCLUSION_GLOBS = [
  '*.test.{ts,tsx,mts,cts}',
  '*.spec.{ts,tsx,mts,cts}',
  '**/test/**',
  '**/__tests__/**',
] as const;

type Directive = {
  file: string;
  line: number;
  rationale: string;
  rawId: string | null;
};

type CliArguments = {
  root: string;
  max: number | null;
  emitSnapshot: string | null;
};

/**
 * Matches any `oxlint-disable*` directive (block or line, with or without
 * specific rules). Used by the scanner to find every directive regardless of
 * rule list, and to extract the rationale text.
 */
const oxlintDirectiveRegex =
  /(\/\*|\/\/)\s*oxlint-disable(?:-(?:next-)?line)?\b([^*\n]*?)(?:\*\/|$)/g;

function parseArguments(argv: readonly string[]): CliArguments {
  let root: string | null = null;
  let max: number | null = null;
  let emitSnapshot: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      root = argv[index + 1] ?? null;
      index += 1;
    } else if (arg === '--max') {
      const value = argv[index + 1];
      if (value === undefined || !/^\d+$/.test(value)) {
        throw new Error(`--max expects a non-negative integer, got: ${value ?? '<missing>'}`);
      }
      max = Number.parseInt(value, 10);
      index += 1;
    } else if (arg === '--emit-snapshot') {
      emitSnapshot = argv[index + 1] ?? null;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    root: root ?? join(import.meta.dir, '..'),
    max,
    emitSnapshot,
  };
}

function printUsage(): void {
  console.log(
    [
      'Usage: bun scripts/check-lint-disables.ts [--root <path>] [--max <n>] [--emit-snapshot <path>]',
      '',
      'Default: enforce ceiling (≤ MAX_DISABLES) and inline-rationale length (≥ MIN_RATIONALE_LENGTH).',
      '',
      'Flags:',
      '  --root <path>         scan a directory other than the repo root (used in tests)',
      '  --max <n>             override the ceiling (default = MAX_DISABLES = 5)',
      '  --emit-snapshot <p>   write a TSV audit artifact (scan only, no enforcement)',
      '',
      'Defaults:',
      `  MAX_DISABLES         = ${MAX_DISABLES}`,
      `  MIN_RATIONALE_LENGTH = ${MIN_RATIONALE_LENGTH}`,
    ].join('\n'),
  );
}

function isExcludedTestPath(relativePath: string): boolean {
  return (
    /\.test\.(ts|tsx|mts|cts)$/.test(relativePath) ||
    /\.spec\.(ts|tsx|mts|cts)$/.test(relativePath) ||
    relativePath.includes('/test/') ||
    relativePath.includes('/__tests__/')
  );
}

/**
 * Strip a leading `ID:<token>` and trailing comment-close from a rationale
 * candidate so its measured length reflects the actual prose explanation.
 */
function normalizeRationale(rawRationale: string): { rationale: string; rawId: string | null } {
  const withoutTrailingClose = rawRationale.replace(/\s*\*\/\s*$/, '');
  const trimmed = withoutTrailingClose.trim();
  const idMatch = /^ID:([a-zA-Z0-9_-]+)\s*(.*)$/s.exec(trimmed);
  if (idMatch) {
    return { rationale: idMatch[2].trim(), rawId: idMatch[1] };
  }
  return { rationale: trimmed, rawId: null };
}

async function* iterateSourceFiles(root: string): AsyncGenerator<string> {
  const glob = new Glob(SOURCE_FILE_GLOB);
  for await (const relativePath of glob.scan({ cwd: root })) {
    if (isExcludedTestPath(relativePath)) continue;
    yield relativePath;
  }
}

async function scanDirectives(root: string): Promise<Directive[]> {
  const directives: Directive[] = [];
  for await (const relativePath of iterateSourceFiles(root)) {
    const absolutePath = join(root, relativePath);
    const source = await file(absolutePath).text();
    const lines = source.split('\n');
    for (const [index, lineText] of lines.entries()) {
      oxlintDirectiveRegex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = oxlintDirectiveRegex.exec(lineText)) !== null) {
        const rawRationaleSegment = match[2] ?? '';
        const dashIndex = rawRationaleSegment.indexOf('--');
        const rationaleCandidate = dashIndex >= 0 ? rawRationaleSegment.slice(dashIndex + 2) : '';
        const normalized = normalizeRationale(rationaleCandidate);
        directives.push({
          file: relativePath,
          line: index + 1,
          rationale: normalized.rationale,
          rawId: normalized.rawId,
        });
      }
    }
  }
  return directives;
}

async function runEnforcement(args: CliArguments): Promise<number> {
  const effectiveMax = args.max ?? MAX_DISABLES;
  const maxSource = args.max === null ? 'default' : '--max';
  const directives = await scanDirectives(args.root);
  const offendersMissingRationale = directives.filter(
    (directive) => directive.rationale.length < MIN_RATIONALE_LENGTH,
  );

  let failed = false;

  if (directives.length > effectiveMax) {
    console.error(
      `Found ${directives.length} oxlint-disable directive(s) in src/, ceiling is ${effectiveMax}.`,
    );
    for (const directive of directives) {
      console.error(`  ${directive.file}:${directive.line}`);
    }
    failed = true;
  }

  if (offendersMissingRationale.length > 0) {
    console.error(
      `Found ${offendersMissingRationale.length} oxlint-disable directive(s) without a rationale of at least ${MIN_RATIONALE_LENGTH} characters (excluding any leading ID:<token>):`,
    );
    for (const directive of offendersMissingRationale) {
      console.error(
        `  ${directive.file}:${directive.line}  rationale length=${directive.rationale.length}`,
      );
    }
    failed = true;
  }

  if (failed) return 1;

  console.log(
    `OK: ${directives.length}/${effectiveMax} oxlint-disable directive(s) in src/, all with rationales ≥ ${MIN_RATIONALE_LENGTH} chars. (effective max = ${effectiveMax} from ${maxSource})`,
  );
  return 0;
}

async function writeSnapshot(root: string, outputPath: string): Promise<void> {
  const directives = await scanDirectives(root);
  const lines = directives.map((directive) => {
    const id = directive.rawId ?? '';
    return `${id}\t${directive.file}\t${directive.line}`;
  });
  await write(outputPath, lines.join('\n') + (lines.length > 0 ? '\n' : ''));
  console.log(`Wrote snapshot of ${directives.length} directive(s) to ${outputPath}`);
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const args = parseArguments(argv);

  if (args.emitSnapshot !== null) {
    await writeSnapshot(args.root, args.emitSnapshot);
    return 0;
  }

  return await runEnforcement(args);
}

if (import.meta.main) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exit(exitCode);
}

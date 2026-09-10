#!/usr/bin/env bun
/**
 * Enforce that two process-local, TYPE-KEYED (not `(type, revision)`-keyed)
 * `EngineInternals` fields are referenced only from their audited call
 * sites (WFT-19).
 *
 * `internals.activityRegistriesByWorkflow` and
 * `internals.sources.lastResolvedRevisionByName` are both keyed by workflow
 * `type` alone. For a `registerSource()`-registered type with two or more
 * revisions live in one process, a type-only read or write of either map
 * cannot distinguish "this running instance's own pinned revision" from
 * "whichever revision this process last resolved" — the exact clobbering
 * bug this batch fixes (see `dynamic-source-execution.ts`'s
 * `loadAndInstallSourceRevision()` doc). A future change that reads or
 * writes either field from a NEW call site reopens that class of bug
 * without anyone noticing at review time; this script fails CI instead.
 *
 * Each field's allowlist is the exhaustive, audited set of files where a
 * type-only reference is either the field's own eager-only write path
 * (`registration.ts`), its documented eager-only accessor (`index.ts`), the
 * revision-gated resolver that owns the last-resolved-wins fallback
 * (`activity-resolution.ts`, `dynamic-source-execution.ts`), or bulk
 * teardown (`disposal.ts`). A reference from any OTHER file fails the
 * check — the fix is to key the new lookup by the running instance's exact
 * `(type, revision)` pin (read from `EngineInternals.workflowTypeByWorkflowId`)
 * instead, not to add the new file to the allowlist.
 *
 * Comments are stripped (`//` to end of line, `/* ... *`+`/` spanning
 * lines) before matching, so a doc comment that merely NAMES a guarded
 * field (as this file's own sibling modules' JSDoc does, to explain the
 * boundary) never counts as a reference. What DOES count: the match is a
 * bare word-boundary token (`\bfieldName\b`), not just a leading-dot
 * property access — this deliberately also catches a destructured binding
 * (`const { fieldName } = internals`) and a bracket-string access
 * (`internals['fieldName']`), two forms a new call site could use to read
 * or write a guarded field while evading a dot-only pattern (WFT-19 review
 * round 2, Codex: the original dot-only regex missed exactly these). The
 * tradeoff is a handful of expected non-access matches — each guarded
 * field's own type declaration and initial-value construction — which are
 * allowlisted explicitly per field rather than narrowing the pattern back
 * down and reopening the gap.
 *
 * `--root <path>` sets the directory the scanner walks. Defaults to the
 * repository root. Used by the script's own tests to point at fixture trees
 * instead of the live repo.
 */

import { Glob, file } from 'bun';
import { join } from 'node:path';

/** Inclusion glob for files in enforcement scope. */
export const SOURCE_FILE_GLOB = 'src/**/*.{ts,tsx,mts,cts}';

/** Path patterns excluded from enforcement scope (test and spec files). */
export const TEST_FILE_EXCLUSION_GLOBS = [
  '*.test.{ts,tsx,mts,cts}',
  '*.spec.{ts,tsx,mts,cts}',
  '**/test/**',
  '**/__tests__/**',
] as const;

export type GuardedField = {
  /** The bare field name, matched as `.fieldName` (a property access, not a declaration). */
  name: string;
  /** Repo-relative paths (POSIX separators) allowed to reference this field. */
  allowedFiles: readonly string[];
  /** Why each file in `allowedFiles` is there — surfaced in `--help` and failure output. */
  rationale: string;
};

/**
 * The two guarded fields and their exhaustive, audited allowlists — derived
 * by grepping the actual post-WFT-19 tree for every `.fieldName` reference,
 * not assumed from the field's own doc comment.
 */
export const GUARDED_FIELDS: readonly GuardedField[] = [
  {
    name: 'activityRegistriesByWorkflow',
    allowedFiles: [
      'src/core/engine/internals.ts',
      'src/core/engine/registration.ts',
      'src/core/engine/activity-resolution.ts',
      'src/core/engine/index.ts',
      'src/core/engine/disposal.ts',
    ],
    rationale:
      "internals.ts declares the field itself (EngineInternals' own type), registration.ts writes it " +
      '(engine.register()), activity-resolution.ts reads it as the eager-first branch of dispatch ' +
      'resolution, index.ts reads it for the documented eager-only ' +
      'getWorkflowActivityDefinition()/listWorkflowActivityDefinitions() accessors (and initializes it ' +
      'at construction), and disposal.ts clears it.',
  },
  {
    name: 'lastResolvedRevisionByName',
    allowedFiles: [
      'src/core/engine/source-runtime-state.ts',
      'src/core/engine/dynamic-source-execution.ts',
      'src/core/engine/index.ts',
      'src/core/engine/disposal.ts',
    ],
    rationale:
      "source-runtime-state.ts declares the field itself (WorkflowSourceRuntimeState's own type and " +
      'its empty-state factory). Last-resolved-revision-wins fallback, valid ONLY when a caller has no ' +
      'running instance to pin against: dynamic-source-execution.ts writes it on every dynamic-source ' +
      "resolve and reads it as getResolvedDynamicRegistration()'s revision:undefined fallback, index.ts " +
      'reads it for type enumeration (listRegisteredWorkflowTypes()), and disposal.ts clears it.',
  },
];

type Violation = {
  field: string;
  file: string;
  line: number;
  lineText: string;
};

type CliArguments = {
  root: string;
};

function parseArguments(argv: readonly string[]): CliArguments {
  let root: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      root = argv[index + 1] ?? null;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { root: root ?? join(import.meta.dir, '..') };
}

function printUsage(): void {
  const lines = [
    'Usage: bun scripts/check-revision-keyed-lookups.ts [--root <path>]',
    '',
    'Fails when a guarded, TYPE-only-keyed EngineInternals field is referenced',
    '(via an actual `.fieldName` property access, not a comment mention) from',
    'a file outside its audited allowlist.',
    '',
    'Guarded fields:',
  ];
  for (const guarded of GUARDED_FIELDS) {
    lines.push(`  ${guarded.name}`);
    lines.push(`    ${guarded.rationale}`);
    for (const path of guarded.allowedFiles) {
      lines.push(`      - ${path}`);
    }
  }
  console.log(lines.join('\n'));
}

/**
 * Strip `//` line comments and `/* ... *`+`/` block comments from `source`,
 * replacing comment characters with spaces (never removing a `\n`) so
 * reported line numbers stay accurate against the original file. A crude,
 * non-tokenizing pass — same tradeoff `check-lint-disables.ts` makes for
 * its own directive scan — that does not attempt to handle a comment
 * delimiter appearing inside a string literal, which is not a pattern this
 * repository's own source uses around these identifiers.
 */
export function stripComments(source: string): string {
  let result = '';
  let index = 0;
  const length = source.length;
  while (index < length) {
    const twoChars = source.slice(index, index + 2);
    if (twoChars === '//') {
      while (index < length && source[index] !== '\n') {
        result += ' ';
        index += 1;
      }
      continue;
    }
    if (twoChars === '/*') {
      result += '  ';
      index += 2;
      while (index < length && source.slice(index, index + 2) !== '*/') {
        result += source[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      if (index < length) {
        result += '  ';
        index += 2;
      }
      continue;
    }
    result += source[index];
    index += 1;
  }
  return result;
}

function isExcludedTestPath(relativePath: string): boolean {
  return (
    /\.test\.(ts|tsx|mts|cts)$/.test(relativePath) ||
    /\.spec\.(ts|tsx|mts|cts)$/.test(relativePath) ||
    relativePath.includes('/test/') ||
    relativePath.includes('/__tests__/')
  );
}

async function* iterateSourceFiles(root: string): AsyncGenerator<string> {
  const glob = new Glob(SOURCE_FILE_GLOB);
  for await (const relativePath of glob.scan({ cwd: root })) {
    if (isExcludedTestPath(relativePath)) continue;
    yield relativePath;
  }
}

async function scanViolations(root: string): Promise<Violation[]> {
  const violations: Violation[] = [];
  for await (const relativePath of iterateSourceFiles(root)) {
    const absolutePath = join(root, relativePath);
    const source = await file(absolutePath).text();
    const stripped = stripComments(source);
    const lines = stripped.split('\n');
    const rawLines = source.split('\n');
    for (const guarded of GUARDED_FIELDS) {
      if (guarded.allowedFiles.includes(relativePath)) continue;
      const identifierTokenRegex = new RegExp(`\\b${guarded.name}\\b`);
      for (const [index, lineText] of lines.entries()) {
        if (identifierTokenRegex.test(lineText)) {
          violations.push({
            field: guarded.name,
            file: relativePath,
            line: index + 1,
            lineText: (rawLines[index] ?? '').trim(),
          });
        }
      }
    }
  }
  return violations;
}

async function runEnforcement(args: CliArguments): Promise<number> {
  const violations = await scanViolations(args.root);
  if (violations.length > 0) {
    console.error(
      `Found ${violations.length} reference(s) to a revision-keyed-lookup-guarded field outside its audited allowlist:`,
    );
    for (const violation of violations) {
      console.error(`  ${violation.file}:${violation.line}  .${violation.field}`);
      console.error(`    ${violation.lineText}`);
    }
    console.error(
      "\nKey the new lookup by the running instance's exact (type, revision) pin " +
        '(EngineInternals.workflowTypeByWorkflowId) instead of adding this file to the ' +
        "allowlist in scripts/check-revision-keyed-lookups.ts — see that script's own doc.",
    );
    return 1;
  }

  const fieldSummary = GUARDED_FIELDS.map(
    (guarded) => `${guarded.name} (${guarded.allowedFiles.length} file(s))`,
  ).join(', ');
  console.log(`OK: no out-of-allowlist references to guarded fields: ${fieldSummary}.`);
  return 0;
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const args = parseArguments(argv);
  return await runEnforcement(args);
}

if (import.meta.main) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exit(exitCode);
}

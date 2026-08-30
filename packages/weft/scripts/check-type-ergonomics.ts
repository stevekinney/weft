#!/usr/bin/env bun
/**
 * Guard the public workflow authoring examples against two cast-heavy
 * anti-patterns that the type surface now makes unnecessary.
 */

import { $, file } from 'bun';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..');

interface Violation {
  file: string;
  line: number;
  message: string;
  text: string;
}

const violations: Violation[] = [];

async function scanFile(relPath: string): Promise<void> {
  const sourceFile = file(join(repoRoot, relPath));
  if (!(await sourceFile.exists())) return;

  const source = await sourceFile.text();
  const lines = source.split('\n');

  for (const [index, line] of lines.entries()) {
    if (/\bas\s+(?:Context\b|import\([^)]+\)\.Context\b)/.test(line)) {
      violations.push({
        file: relPath,
        line: index + 1,
        message: 'Workflow handlers should use WorkflowContext directly instead of casting.',
        text: line.trim(),
      });
    }

    if (!/\binput:\s*unknown\b/.test(line)) continue;

    const followingLines = lines.slice(index, index + 9);
    const castLineOffset = followingLines.findIndex((candidate) =>
      /\binput\s+as\s+(?:\{|[A-Z][A-Za-z0-9_$]*)/.test(candidate),
    );
    if (castLineOffset === -1) continue;

    violations.push({
      file: relPath,
      line: index + castLineOffset + 1,
      message: 'Payload examples should use inline parameter annotations instead of input casts.',
      text: lines[index + castLineOffset]?.trim() ?? '',
    });
  }
}

const globs = ['README.md', 'documentation/**/*.md', 'examples/**/*.ts', 'src/**/*.ts'];

const gitListOutput =
  await $`git -C ${repoRoot} ls-files -z --cached --others --exclude-standard -- ${globs}`
    .quiet()
    .text();

// The owner of the `Context` internals WeakMap. Its `hasContextInternals`
// probe casts an arbitrary `object` to the WeakMap's `Context` key type purely
// to ask `INTERNALS.has(value)` — a presence check, not handler code or an
// authoring example. This rule guards the latter, not the WeakMap owner.
const CONTEXT_INTERNALS_FILE = 'src/core/context/internals.ts';

for (const relPath of gitListOutput.split('\0')) {
  if (
    relPath === '' ||
    relPath === CONTEXT_INTERNALS_FILE ||
    relPath.endsWith('.test.ts') ||
    relPath.endsWith('.spec.ts') ||
    relPath.endsWith('.test-d.ts') ||
    relPath.includes('/__tests__/') ||
    relPath.startsWith('documentation/engine-split-log/')
  ) {
    continue;
  }
  await scanFile(relPath);
}

if (violations.length > 0) {
  console.error('Found workflow type-ergonomics regressions:');
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line}  ${violation.message}`);
    console.error(`    ${violation.text}`);
  }
  process.exit(1);
}

console.log('OK: workflow examples avoid Context casts and input-cast payload anti-patterns.');

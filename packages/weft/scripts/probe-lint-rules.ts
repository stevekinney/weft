#!/usr/bin/env bun
/**
 * Durable proof that oxlint's `complexity` and `max-lines` rules are wired up
 * and actually fire. Writes two temporary fixture files outside `src/`, runs
 * oxlint against each with the strict thresholds, asserts both fail with the
 * expected error count, deletes the fixtures, and exits 0.
 *
 * Runnable on demand: `bun run scripts/probe-lint-rules.ts`. Not part of CI.
 *
 * If this script ever fails, the strict-mode lint configuration has regressed
 * — investigate before assuming new violations are real.
 */

import { $, write } from 'bun';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..');
const probeDir = join(repoRoot, 'tmp/lint-probe');

if (existsSync(probeDir)) rmSync(probeDir, { recursive: true });
mkdirSync(probeDir, { recursive: true });

const complexityFixture = join(probeDir, 'complexity-12.ts');
const maxLinesFixture = join(probeDir, 'long-501.ts');

await write(
  complexityFixture,
  `// Fixture: a function with cyclomatic complexity 12 (limit is 10).
export function probeComplexity(value: number): number {
  if (value === 0) return 0;
  if (value === 1) return 1;
  if (value === 2) return 2;
  if (value === 3) return 3;
  if (value === 4) return 4;
  if (value === 5) return 5;
  if (value === 6) return 6;
  if (value === 7) return 7;
  if (value === 8) return 8;
  if (value === 9) return 9;
  if (value === 10) return 10;
  return -1;
}
`,
);

const longLines: string[] = ['// Fixture: 501 lines, exceeding max-lines limit of 500.'];
for (let lineIndex = 1; lineIndex <= 501; lineIndex += 1) {
  longLines.push(`export const value${lineIndex} = ${lineIndex};`);
}
await write(maxLinesFixture, longLines.join('\n'));

const probeConfig = {
  $schema:
    'https://raw.githubusercontent.com/oxc-project/oxc/main/npm/oxlint/configuration_schema.json',
  rules: {
    complexity: ['error', { max: 10 }],
    'max-lines': ['error', { max: 500, skipBlankLines: false, skipComments: false }],
  },
};
const probeConfigPath = join(probeDir, 'oxlint-probe.json');
await write(probeConfigPath, JSON.stringify(probeConfig, null, 2));

let allPassed = true;

async function runProbe(label: string, target: string, expectedRule: string): Promise<void> {
  const result =
    await $`bunx oxlint --config ${probeConfigPath} --no-ignore ${target} 2>&1`.nothrow();
  const output = result.stdout.toString();
  if (result.exitCode === 0) {
    console.error(`FAIL ${label}: oxlint did not report any error.`);
    console.error(output);
    allPassed = false;
    return;
  }
  if (!output.includes(`eslint(${expectedRule})`)) {
    console.error(`FAIL ${label}: expected eslint(${expectedRule}) in output, got:`);
    console.error(output);
    allPassed = false;
    return;
  }
  console.log(`OK   ${label}: oxlint reports eslint(${expectedRule}) as expected.`);
}

await runProbe('complexity rule fires', complexityFixture, 'complexity');
await runProbe('max-lines rule fires', maxLinesFixture, 'max-lines');

rmSync(probeDir, { recursive: true });

if (!allPassed) {
  console.error('\nProbe failed. Strict-mode lint rules are not configured correctly.');
  process.exit(1);
}

console.log('\nAll probes passed. Strict-mode lint rules are wired up correctly.');

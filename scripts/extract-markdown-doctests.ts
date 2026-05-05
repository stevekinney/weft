/**
 * Walks every `.md` file under `documentation/`, classifies fenced TypeScript
 * code blocks as runnable or partial, optionally extracts runnable blocks into
 * `tmp/markdown-doctests/`, and (in strict mode) type-checks them against the
 * source-side `paths` mapping that the JSDoc doctest pipeline uses.
 *
 * Design rationale:
 *
 * 1. **Opt-in per block.** Documentation legitimately contains partial snippets,
 *    pseudocode, error transcripts, and teaching examples that are not
 *    standalone TypeScript. A blanket "every fenced block must compile" gate
 *    is wrong. The opening fence carries the intent:
 *
 *      ```ts            -> runnable, must typecheck
 *      ```typescript    -> runnable, must typecheck
 *      ```ts partial    -> partial, never extracted
 *      ```ts no-check:reason  -> partial, reason must be in the allowlist
 *
 *    Any fence with text after the language tag is treated as a non-runnable
 *    classification annotation. Bare `ts` or `typescript` is the only runnable
 *    form.
 *
 * 2. **Skip ratchet.** `scripts/markdown-doctest-skip-counts.json` records the
 *    per-reason baseline. The script fails if any reason's count grows beyond
 *    the recorded baseline — preventing "fix the typecheck failure by marking
 *    the block no-check" abuse. To raise the ceiling, update the baseline file
 *    explicitly in a separate commit and document the reason in the commit body.
 *
 * 3. **Compile target: source-side.** Examples are typechecked against the
 *    same `paths` mapping the JSDoc doctest pipeline uses (sourced from the
 *    in-memory manifest's `publicEntryPoints` via `scripts/lib/jsdoc-manifest.ts`).
 *    The public-face JSDoc gate (`scripts/check-declaration-jsdoc.ts --all`) already proves
 *    source-vs-dist parity for the consumer-visible surface, so a snippet that
 *    imports `weft/storage/sqlite/node` resolves to `src/storage/node-sqlite.ts`
 *    and the result is verifiably equivalent to typechecking against built
 *    `dist/`. We avoid requiring a build (30+ seconds) for the doctest gate.
 *
 * 4. **Two modes.** `inventory` is lenient (exits 0 even if individual runnable
 *    blocks fail to typecheck) — used to ship this script without breaking
 *    existing documentation. `verify` is strict (exits non-zero on any failure)
 *    — wired into `verify:jsdoc:full` only after the documentation audit pass
 *    has fixed the existing failures.
 *
 * Usage:
 *   bun run scripts/extract-markdown-doctests.ts inventory [--paths <p1> <p2> ...]
 *   bun run scripts/extract-markdown-doctests.ts verify    [--paths <p1> <p2> ...]
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

import { buildManifest } from './lib/jsdoc-manifest.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');
const DOCUMENTATION_DIR = resolve(REPO_ROOT, 'documentation');
const DOCTESTS_DIR = resolve(REPO_ROOT, 'tmp/markdown-doctests');
const INVENTORY_PATH = resolve(REPO_ROOT, 'tmp/markdown-doctest-inventory.json');
const SKIP_COUNTS_PATH = resolve(REPO_ROOT, 'scripts/markdown-doctest-skip-counts.json');
const SKIP_REASONS_PATH = resolve(REPO_ROOT, 'scripts/markdown-doctest-skip-reasons.txt');

type Mode = 'inventory' | 'verify';

type FenceClassification =
  | { kind: 'runnable' }
  | { kind: 'partial'; reason: string }
  | { kind: 'unknown-language' };

type Block = {
  file: string;
  index: number;
  startLine: number;
  endLine: number;
  language: string;
  rawInfoString: string;
  classification: FenceClassification;
  body: string;
};

type InventoryEntry = {
  file: string;
  index: number;
  startLine: number;
  endLine: number;
  classification: 'runnable' | 'partial';
  reason?: string;
  typecheck?: 'pass' | 'fail';
  failures?: string[];
};

function slugify(input: string): string {
  return input.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function parseArgs(argv: string[]): { mode: Mode; paths: string[] } {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const mode = positional[0] as Mode | undefined;
  if (mode !== 'inventory' && mode !== 'verify') {
    console.error('extract-markdown-doctests: usage: <inventory|verify> [--paths p1 p2 ...]');
    process.exit(1);
  }
  const pathsIdx = argv.indexOf('--paths');
  const paths: string[] = [];
  if (pathsIdx !== -1) {
    for (let i = pathsIdx + 1; i < argv.length; i++) {
      const a = argv[i];
      if (a === undefined || a.startsWith('--')) break;
      paths.push(a);
    }
  }
  return { mode, paths };
}

function* walkMarkdown(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkMarkdown(full);
    else if (entry.isFile() && entry.name.endsWith('.md')) yield full;
  }
}

function loadSkipReasons(): Set<string> {
  if (!existsSync(SKIP_REASONS_PATH)) {
    console.error(`extract-markdown-doctests: missing ${SKIP_REASONS_PATH}`);
    process.exit(1);
  }
  const text = readFileSync(SKIP_REASONS_PATH, 'utf8');
  const reasons = new Set<string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    reasons.add(trimmed);
  }
  return reasons;
}

function loadSkipCounts(): Record<string, number> {
  if (!existsSync(SKIP_COUNTS_PATH)) return {};
  return JSON.parse(readFileSync(SKIP_COUNTS_PATH, 'utf8'));
}

function classifyFence(
  language: string,
  rawInfoString: string,
  allowedReasons: Set<string>,
): FenceClassification {
  if (language !== 'ts' && language !== 'typescript') {
    return { kind: 'unknown-language' };
  }
  const suffix = rawInfoString.slice(language.length).trim();
  if (suffix.length === 0) return { kind: 'runnable' };
  // Suffix is one of: a bare reason word, or "no-check:<reason>", etc.
  // We accept any token that, after stripping a leading "no-check:" prefix,
  // matches the allowlist.
  const reason = suffix.startsWith('no-check:') ? suffix.slice('no-check:'.length) : suffix;
  if (!allowedReasons.has(reason)) {
    return { kind: 'unknown-language' };
  }
  return { kind: 'partial', reason };
}

function extractBlocksFromFile(
  filePath: string,
  allowedReasons: Set<string>,
): {
  blocks: Block[];
  unknownLanguageBlocks: Array<{ file: string; line: number; rawInfoString: string }>;
} {
  const text = readFileSync(filePath, 'utf8');
  const lines = text.split('\n');
  const blocks: Block[] = [];
  const unknownLanguageBlocks: Array<{ file: string; line: number; rawInfoString: string }> = [];
  let inFence = false;
  let fenceStart = -1;
  let fenceInfoString = '';
  let bodyLines: string[] = [];
  let blockIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trimStart();
    if (!inFence) {
      // Opening fence: ```<info>
      const match = trimmed.match(/^```([^\s`].*)?$/);
      if (match) {
        const info = (match[1] ?? '').trim();
        // Only consider TS-language fences. Bare backticks or other languages
        // (json, bash, sh, mermaid, etc.) are pure prose and ignored.
        const language = info.split(/\s+/)[0] ?? '';
        if (language === 'ts' || language === 'typescript') {
          inFence = true;
          fenceStart = i;
          fenceInfoString = info;
          bodyLines = [];
        }
      }
      continue;
    }
    // Inside fence: look for closing ``` on a line by itself.
    if (trimmed === '```') {
      const language = fenceInfoString.split(/\s+/)[0] ?? '';
      const classification = classifyFence(language, fenceInfoString, allowedReasons);
      if (classification.kind === 'unknown-language') {
        unknownLanguageBlocks.push({
          file: filePath,
          line: fenceStart + 1,
          rawInfoString: fenceInfoString,
        });
      } else {
        blocks.push({
          file: filePath,
          index: blockIndex,
          startLine: fenceStart + 1,
          endLine: i + 1,
          language,
          rawInfoString: fenceInfoString,
          classification,
          body: bodyLines.join('\n'),
        });
        blockIndex += 1;
      }
      inFence = false;
      fenceStart = -1;
      fenceInfoString = '';
      bodyLines = [];
      continue;
    }
    bodyLines.push(raw);
  }
  return { blocks, unknownLanguageBlocks };
}

function writeTsconfig(publicEntryPoints: Record<string, string>): void {
  const paths: Record<string, string[]> = {};
  for (const [importPath, sourceRel] of Object.entries(publicEntryPoints)) {
    paths[importPath] = [`../../${sourceRel.replace(/\.ts$/, '')}`];
  }
  const tsconfig = {
    extends: '../../tsconfig.json',
    compilerOptions: {
      noEmit: true,
      noUnusedLocals: false,
      noUnusedParameters: false,
      baseUrl: '.',
      paths,
    },
    include: ['./**/*.ts'],
    exclude: [],
  };
  writeFileSync(
    resolve(DOCTESTS_DIR, 'tsconfig.json'),
    JSON.stringify(tsconfig, null, 2) + '\n',
    'utf8',
  );
}

function writeRunnableBlock(block: Block): string {
  const fileSlug = slugify(relative(DOCUMENTATION_DIR, block.file).replace(/\.md$/, ''));
  const filename = `${fileSlug}__${block.index}.ts`;
  const filePath = resolve(DOCTESTS_DIR, filename);
  const header = `// auto-generated from ${relative(REPO_ROOT, block.file)} (block ${block.index}, lines ${block.startLine}-${block.endLine})\n`;
  writeFileSync(filePath, header + block.body + '\n', 'utf8');
  return filename;
}

function typecheck(expectedFileCount: number): { ok: boolean; failures: Map<string, string[]> } {
  const tsconfigPath = resolve(DOCTESTS_DIR, 'tsconfig.json');
  const config = ts.readConfigFile(tsconfigPath, (p) => readFileSync(p, 'utf8'));
  if (config.error) {
    console.error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
    process.exit(1);
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, DOCTESTS_DIR);
  if (expectedFileCount > 0 && parsed.fileNames.length === 0) {
    console.error(
      `extract-markdown-doctests: tsconfig resolved to zero files but ${expectedFileCount} runnable blocks were extracted; the typecheck would silently pass without checking anything.`,
    );
    process.exit(1);
  }
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  // Include parsed-config errors (e.g. invalid tsconfig fields) and program
  // option diagnostics so a misconfigured tsconfig surfaces as a failure
  // rather than silently letting the gate pass.
  const diagnostics = [
    ...parsed.errors,
    ...program.getOptionsDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
    ...program.getGlobalDiagnostics(),
  ];
  const failures = new Map<string, string[]>();
  for (const diag of diagnostics) {
    const fileName = diag.file?.fileName ?? '<unknown>';
    const messages = failures.get(fileName) ?? [];
    const message = ts.flattenDiagnosticMessageText(diag.messageText, '\n');
    if (diag.file && diag.start !== undefined) {
      const { line, character } = diag.file.getLineAndCharacterOfPosition(diag.start);
      messages.push(
        `  ${fileName}:${line + 1}:${character + 1} - error TS${diag.code}: ${message}`,
      );
    } else {
      messages.push(`  ${fileName} - error TS${diag.code}: ${message}`);
    }
    failures.set(fileName, messages);
  }
  return { ok: diagnostics.length === 0, failures };
}

function pathFilter(filePath: string, allowedPaths: string[]): boolean {
  if (allowedPaths.length === 0) return true;
  return allowedPaths.some((p) => {
    const absolute = resolve(REPO_ROOT, p);
    return filePath === absolute || filePath.startsWith(absolute + '/');
  });
}

function assertPrerequisites(): void {
  if (!existsSync(DOCUMENTATION_DIR)) {
    console.error(`extract-markdown-doctests: ${DOCUMENTATION_DIR} not found`);
    process.exit(1);
  }
}

function collectAllBlocks(
  allowedPaths: string[],
  allowedReasons: Set<string>,
): {
  blocks: Block[];
  unknownLanguageBlocks: Array<{ file: string; line: number; rawInfoString: string }>;
} {
  const blocks: Block[] = [];
  const unknownLanguageBlocks: Array<{ file: string; line: number; rawInfoString: string }> = [];
  for (const file of walkMarkdown(DOCUMENTATION_DIR)) {
    if (!pathFilter(file, allowedPaths)) continue;
    const { blocks: fileBlocks, unknownLanguageBlocks: fileUnknownBlocks } = extractBlocksFromFile(
      file,
      allowedReasons,
    );
    blocks.push(...fileBlocks);
    unknownLanguageBlocks.push(...fileUnknownBlocks);
  }
  return { blocks, unknownLanguageBlocks };
}

function reportUnknownFences(
  unknownLanguageBlocks: Array<{ file: string; line: number; rawInfoString: string }>,
): void {
  if (unknownLanguageBlocks.length === 0) return;
  console.error(
    'extract-markdown-doctests: unknown skip-reason or unrecognized info-string in fences:',
  );
  for (const u of unknownLanguageBlocks) {
    console.error(`  ${relative(REPO_ROOT, u.file)}:${u.line} - "${u.rawInfoString}"`);
  }
  console.error(
    `  → Fix: use bare \`ts\` for runnable, or one of the allowed reasons listed in ${relative(REPO_ROOT, SKIP_REASONS_PATH)} (e.g. \`ts partial\`).`,
  );
  process.exit(1);
}

function enforceSkipRatchet(blocks: Block[], baselineCounts: Record<string, number>): void {
  const skipCountsNow: Record<string, number> = {};
  for (const block of blocks) {
    if (block.classification.kind === 'partial') {
      const r = block.classification.reason;
      skipCountsNow[r] = (skipCountsNow[r] ?? 0) + 1;
    }
  }
  // Strict equality: the live count must match the baseline exactly. If it
  // grew, reviewers will see the bump in the diff and can ask why. If it
  // shrank, the contributor must lower the baseline in the same change so
  // the ceiling can't drift upward over time. Either drift is a finding.
  const violations: string[] = [];
  const reasons = new Set([...Object.keys(skipCountsNow), ...Object.keys(baselineCounts)]);
  for (const reason of reasons) {
    const live = skipCountsNow[reason] ?? 0;
    const baseline = baselineCounts[reason] ?? 0;
    if (live !== baseline) {
      const direction = live > baseline ? 'grew' : 'shrank';
      violations.push(
        `  reason "${reason}": ${live} occurrences ${direction} from baseline ${baseline}`,
      );
    }
  }
  if (violations.length === 0) return;
  console.error('extract-markdown-doctests: skip-count drift detected:');
  for (const v of violations) console.error(v);
  console.error(
    `  → Update ${relative(REPO_ROOT, SKIP_COUNTS_PATH)} to match the new counts. Reviewers will see the bump in the diff and can challenge the rationale. Counts must match exactly so the ceiling cannot drift upward across uncoordinated commits.`,
  );
  process.exit(1);
}

function buildInventoryEntry(block: Block, perFileFailures: Map<string, string[]>): InventoryEntry {
  const fileRel = relative(REPO_ROOT, block.file);
  if (block.classification.kind === 'partial') {
    return {
      file: fileRel,
      index: block.index,
      startLine: block.startLine,
      endLine: block.endLine,
      classification: 'partial',
      reason: block.classification.reason,
    };
  }
  const fileSlug = slugify(relative(DOCUMENTATION_DIR, block.file).replace(/\.md$/, ''));
  const generated = `${fileSlug}__${block.index}.ts`;
  const generatedPath = resolve(DOCTESTS_DIR, generated);
  const failures = perFileFailures.get(generatedPath) ?? [];
  return {
    file: fileRel,
    index: block.index,
    startLine: block.startLine,
    endLine: block.endLine,
    classification: 'runnable',
    typecheck: failures.length === 0 ? 'pass' : 'fail',
    failures: failures.length > 0 ? failures : undefined,
  };
}

function reportSummary(
  mode: Mode,
  blocks: Block[],
  totalRunnable: number,
  totalPartial: number,
  totalFailing: number,
): void {
  const fileCount = new Set(blocks.map((b) => b.file)).size;
  console.log(
    `extract-markdown-doctests (${mode}): ${blocks.length} blocks across ${fileCount} files (${totalRunnable} runnable, ${totalPartial} partial)`,
  );
  console.log(`  inventory written to ${relative(REPO_ROOT, INVENTORY_PATH)}`);
  if (totalRunnable === 0) return;
  const typecheckLine =
    totalFailing === 0
      ? 'all runnable blocks pass'
      : `${totalFailing} of ${totalRunnable} runnable blocks fail`;
  console.log(`  typecheck: ${typecheckLine}`);
}

function reportVerifyFailures(perFileFailures: Map<string, string[]>): void {
  console.error('\nextract-markdown-doctests: typecheck failures (verify mode):');
  for (const [file, messages] of perFileFailures) {
    const rel = relative(REPO_ROOT, file);
    console.error(`  ${rel}:`);
    for (const m of messages) console.error(m);
  }
  process.exit(1);
}

function main(): void {
  const { mode, paths: allowedPaths } = parseArgs(process.argv.slice(2));
  assertPrerequisites();
  const manifest = buildManifest();
  const allowedReasons = loadSkipReasons();
  const baselineCounts = loadSkipCounts();

  if (existsSync(DOCTESTS_DIR)) rmSync(DOCTESTS_DIR, { recursive: true, force: true });
  mkdirSync(DOCTESTS_DIR, { recursive: true });

  const { blocks, unknownLanguageBlocks } = collectAllBlocks(allowedPaths, allowedReasons);
  reportUnknownFences(unknownLanguageBlocks);
  // The skip-count baseline is repository-wide. Path-filtered runs are for
  // targeted typechecking; the full gate below still enforces the ratchet.
  if (allowedPaths.length === 0) {
    enforceSkipRatchet(blocks, baselineCounts);
  }

  const runnableBlocks = blocks.filter((b) => b.classification.kind === 'runnable');
  for (const block of runnableBlocks) writeRunnableBlock(block);
  writeTsconfig(manifest.publicEntryPoints);

  let typecheckOk = true;
  let perFileFailures = new Map<string, string[]>();
  if (runnableBlocks.length > 0) {
    const result = typecheck(runnableBlocks.length);
    typecheckOk = result.ok;
    perFileFailures = result.failures;
  }

  const inventory = blocks.map((b) => buildInventoryEntry(b, perFileFailures));
  writeFileSync(INVENTORY_PATH, JSON.stringify(inventory, null, 2) + '\n', 'utf8');

  const totalRunnable = runnableBlocks.length;
  const totalPartial = blocks.length - totalRunnable;
  const totalFailing = inventory.filter((e) => e.typecheck === 'fail').length;
  reportSummary(mode, blocks, totalRunnable, totalPartial, totalFailing);

  if (mode === 'verify' && !typecheckOk) reportVerifyFailures(perFileFailures);
}

main();

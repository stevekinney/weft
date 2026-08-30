#!/usr/bin/env bun

/**
 * Rewrites relative import and export specifiers when a TypeScript file moves
 * to a new path, such as `src/core/types.ts` becoming
 * `src/core/types/index.ts`.
 *
 * Dry-run mode prints unified-style diffs. Pass `--apply` to write the changed
 * files after validating that the destination path does not already exist.
 */

import { dirname, isAbsolute, join, relative } from 'node:path';
import ts from 'typescript';

const REPOSITORY_ROOT = join(import.meta.dir, '..');
const SOURCE_PATTERNS = ['src/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.ts'] as const;
const SKIPPED_DIRECTORIES = new Set(['dist', 'node_modules', 'coverage', '.bun', 'tmp']);
const DIFF_CONTEXT_LINES = 2;

type CommandLineOptions = {
  apply: boolean;
  fromPath: string;
  toPath: string;
};

type ParsedCommandLineOptions = {
  apply: boolean;
  fromPath: string | undefined;
  toPath: string | undefined;
};

type Replacement = {
  length: number;
  newText: string;
  start: number;
};

type ChangedFile = {
  filePath: string;
  modifiedText: string;
  originalText: string;
  relativePath: string;
  replacements: Replacement[];
};

type DiffRange = {
  end: number;
  start: number;
};

function usage(): string {
  return [
    'Usage:',
    '  bun run scripts/migrate-import-paths.ts --from <source-file> --to <destination-file> [--apply]',
  ].join('\n');
}

function parseArguments(argumentsList: string[]): ParsedCommandLineOptions {
  const parsed: ParsedCommandLineOptions = {
    apply: false,
    fromPath: undefined,
    toPath: undefined,
  };

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === undefined) continue;

    if (argument === '--apply') {
      parsed.apply = true;
      continue;
    }

    if (argument === '--from') {
      parsed.fromPath = argumentsList[index + 1];
      index += 1;
      continue;
    }

    if (argument.startsWith('--from=')) {
      parsed.fromPath = argument.slice('--from='.length);
      continue;
    }

    if (argument === '--to') {
      parsed.toPath = argumentsList[index + 1];
      index += 1;
      continue;
    }

    if (argument.startsWith('--to=')) {
      parsed.toPath = argument.slice('--to='.length);
      continue;
    }
  }

  return parsed;
}

function requireCommandLineOptions(parsed: ParsedCommandLineOptions): CommandLineOptions | null {
  if (!parsed.fromPath || !parsed.toPath) {
    console.error(usage());
    return null;
  }

  return {
    apply: parsed.apply,
    fromPath: parsed.fromPath,
    toPath: parsed.toPath,
  };
}

function toAbsolutePath(path: string): string {
  return isAbsolute(path) ? join(path) : join(REPOSITORY_ROOT, path);
}

function toRepositoryRelativePath(path: string): string {
  return normalizeSpecifier(relative(REPOSITORY_ROOT, path));
}

function normalizeSpecifier(path: string): string {
  return path.replaceAll('\\', '/');
}

function hasSkippedDirectory(path: string): boolean {
  const relativePath = toRepositoryRelativePath(path);
  return relativePath.split('/').some((part) => SKIPPED_DIRECTORIES.has(part));
}

async function collectCandidateFiles(): Promise<string[]> {
  const files = new Set<string>();

  for (const pattern of SOURCE_PATTERNS) {
    const glob = new Bun.Glob(pattern);
    for await (const filePath of glob.scan({
      absolute: true,
      cwd: REPOSITORY_ROOT,
      onlyFiles: true,
    })) {
      if (!hasSkippedDirectory(filePath)) {
        files.add(filePath);
      }
    }
  }

  return [...files].toSorted();
}

function moduleSpecifierResolvesToFile(
  callSiteDirectory: string,
  moduleSpecifier: string,
  targetFilePath: string,
): boolean {
  const rawResolvedPath = join(callSiteDirectory, moduleSpecifier);
  const extensionResolvedPath = join(callSiteDirectory, `${moduleSpecifier}.ts`);

  return rawResolvedPath === targetFilePath || extensionResolvedPath === targetFilePath;
}

function createNewModuleSpecifier(callSiteDirectory: string, targetFilePath: string): string {
  const relativePath = normalizeSpecifier(relative(callSiteDirectory, targetFilePath));
  if (relativePath.startsWith('.') || relativePath.startsWith('/')) {
    return relativePath;
  }

  return `./${relativePath}`;
}

function getSpecifierReplacement(
  sourceText: string,
  sourceFile: ts.SourceFile,
  moduleSpecifier: ts.StringLiteral,
  newModuleSpecifier: string,
): Replacement | null {
  const start = moduleSpecifier.getStart(sourceFile) + 1;
  const end = moduleSpecifier.getEnd() - 1;
  const openingQuote = sourceText[start - 1];
  const closingQuote = sourceText[end];

  if (
    (openingQuote !== "'" && openingQuote !== '"') ||
    (closingQuote !== "'" && closingQuote !== '"') ||
    openingQuote !== closingQuote
  ) {
    return null;
  }

  return {
    length: end - start,
    newText: newModuleSpecifier,
    start,
  };
}

function collectReplacementsForFile(
  filePath: string,
  sourceText: string,
  fromFilePath: string,
  toFilePath: string,
): Replacement[] {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const callSiteDirectory = dirname(filePath);
  const newModuleSpecifier = createNewModuleSpecifier(callSiteDirectory, toFilePath);
  const replacements: Replacement[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (
        moduleSpecifierResolvesToFile(callSiteDirectory, node.moduleSpecifier.text, fromFilePath)
      ) {
        const replacement = getSpecifierReplacement(
          sourceText,
          sourceFile,
          node.moduleSpecifier,
          newModuleSpecifier,
        );
        if (replacement) replacements.push(replacement);
      }
    }

    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (
        moduleSpecifierResolvesToFile(callSiteDirectory, node.moduleSpecifier.text, fromFilePath)
      ) {
        const replacement = getSpecifierReplacement(
          sourceText,
          sourceFile,
          node.moduleSpecifier,
          newModuleSpecifier,
        );
        if (replacement) replacements.push(replacement);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return replacements;
}

function applyReplacements(sourceText: string, replacements: Replacement[]): string {
  return replacements
    .toSorted((left, right) => right.start - left.start)
    .reduce((currentText, replacement) => {
      return (
        currentText.slice(0, replacement.start) +
        replacement.newText +
        currentText.slice(replacement.start + replacement.length)
      );
    }, sourceText);
}

function changedLineIndices(originalText: string, modifiedText: string): number[] {
  const originalLines = originalText.split('\n');
  const modifiedLines = modifiedText.split('\n');
  const longestLineCount = Math.max(originalLines.length, modifiedLines.length);
  const indices: number[] = [];

  for (let index = 0; index < longestLineCount; index += 1) {
    if (originalLines[index] !== modifiedLines[index]) {
      indices.push(index);
    }
  }

  return indices;
}

function createDiffRanges(changedIndices: number[], lineCount: number): DiffRange[] {
  const ranges: DiffRange[] = [];

  for (const changedIndex of changedIndices) {
    const start = Math.max(0, changedIndex - DIFF_CONTEXT_LINES);
    const end = Math.min(lineCount - 1, changedIndex + DIFF_CONTEXT_LINES);
    const previousRange = ranges.at(-1);

    if (previousRange && start <= previousRange.end + 1) {
      previousRange.end = Math.max(previousRange.end, end);
      continue;
    }

    ranges.push({ end, start });
  }

  return ranges;
}

function printDiff(changedFile: ChangedFile): void {
  const originalLines = changedFile.originalText.split('\n');
  const modifiedLines = changedFile.modifiedText.split('\n');
  const changedIndices = new Set(
    changedLineIndices(changedFile.originalText, changedFile.modifiedText),
  );
  const lineCount = Math.max(originalLines.length, modifiedLines.length);
  const ranges = createDiffRanges([...changedIndices], lineCount);

  console.log(`--- a/${changedFile.relativePath}`);
  console.log(`+++ b/${changedFile.relativePath}`);

  for (const range of ranges) {
    const rangeLength = range.end - range.start + 1;
    console.log(`@@ -${range.start + 1},${rangeLength} +${range.start + 1},${rangeLength} @@`);

    for (let index = range.start; index <= range.end; index += 1) {
      const originalLine = originalLines[index] ?? '';
      const modifiedLine = modifiedLines[index] ?? '';

      if (changedIndices.has(index)) {
        console.log(`-${originalLine}`);
        console.log(`+${modifiedLine}`);
      } else {
        console.log(` ${originalLine}`);
      }
    }
  }
}

function printSummary(changedFiles: ChangedFile[]): void {
  console.log('');
  console.log(`Files changed: ${changedFiles.length}`);

  for (const changedFile of changedFiles) {
    const specifierLabel = changedFile.replacements.length === 1 ? 'specifier' : 'specifiers';
    console.log(
      `- ${changedFile.relativePath}: ${changedFile.replacements.length} ${specifierLabel}`,
    );
  }
}

async function findChangedFiles(fromFilePath: string, toFilePath: string): Promise<ChangedFile[]> {
  const candidateFiles = await collectCandidateFiles();
  const changedFiles: ChangedFile[] = [];

  for (const filePath of candidateFiles) {
    const originalText = await Bun.file(filePath).text();
    const replacements = collectReplacementsForFile(
      filePath,
      originalText,
      fromFilePath,
      toFilePath,
    );

    if (replacements.length === 0) continue;

    const modifiedText = applyReplacements(originalText, replacements);
    changedFiles.push({
      filePath,
      modifiedText,
      originalText,
      relativePath: toRepositoryRelativePath(filePath),
      replacements,
    });
  }

  return changedFiles;
}

async function run(): Promise<number> {
  const options = requireCommandLineOptions(parseArguments(process.argv.slice(2)));

  if (!options) {
    return 1;
  }

  const fromFilePath = toAbsolutePath(options.fromPath);
  const toFilePath = toAbsolutePath(options.toPath);

  if (!(await Bun.file(fromFilePath).exists())) {
    console.error(`Error: --from does not exist: ${options.fromPath}`);
    return 1;
  }

  if (options.apply && (await Bun.file(toFilePath).exists())) {
    console.error(`Error: refusing to overwrite existing --to path: ${options.toPath}`);
    return 1;
  }

  const changedFiles = await findChangedFiles(fromFilePath, toFilePath);

  if (options.apply) {
    for (const changedFile of changedFiles) {
      await Bun.write(changedFile.filePath, changedFile.modifiedText);
    }

    console.log(`Files written: ${changedFiles.length}`);
  } else {
    for (const changedFile of changedFiles) {
      printDiff(changedFile);
    }
  }

  printSummary(changedFiles);
  return 0;
}

const exitCode = await run();
process.exit(exitCode);

import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { isRecord, safeDebugStringify } from '../core/debug-output.ts';

function isGlobPattern(value: string): boolean {
  return value.includes('*') || value.includes('?') || value.includes('[');
}

function normalizeGlobPatternPath(entryPath: string): string {
  return entryPath.replaceAll('\\', '/');
}

function isMissingDirectoryError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function globPatternIncludesTestFiles(scanRoot: string, pattern: string): boolean {
  const testSegmentRegex = /(?:^|[./{,])(?:test|tests|spec|specs)(?:[.}/,]|$)/;
  if (testSegmentRegex.test(normalizeGlobPatternPath(pattern))) {
    return true;
  }
  const lastScanRootSegment = normalizeGlobPatternPath(scanRoot).split('/').pop() ?? '';
  return testSegmentRegex.test(lastScanRootSegment);
}

function shouldIgnoreExpandedGlobPath(entryPath: string, ignoreTestFiles: boolean): boolean {
  const normalizedEntryPath = normalizeGlobPatternPath(entryPath);
  if (normalizedEntryPath.split('/').includes('node_modules')) {
    return true;
  }
  return (
    ignoreTestFiles &&
    (/\.test\.[cm]?tsx?$/.test(normalizedEntryPath) ||
      /\.spec\.[cm]?tsx?$/.test(normalizedEntryPath))
  );
}

/** Splits a glob entry path into the directory to scan and the pattern to match. */
export function splitGlobPattern(entryPath: string): { scanRoot: string; pattern: string } {
  const normalizedEntryPath = normalizeGlobPatternPath(entryPath);
  const firstGlobIndex = Array.from(normalizedEntryPath).findIndex((character) =>
    ['*', '?', '['].includes(character),
  );

  if (firstGlobIndex === -1) {
    return { scanRoot: '.', pattern: normalizedEntryPath };
  }

  const separatorIndex = normalizedEntryPath.lastIndexOf('/', firstGlobIndex);
  if (separatorIndex === -1) {
    return { scanRoot: '.', pattern: normalizedEntryPath };
  }

  const scanRootCandidate = normalizedEntryPath.slice(0, separatorIndex);
  const scanRoot =
    scanRootCandidate === ''
      ? '/'
      : /^[A-Za-z]:\//.test(normalizedEntryPath) &&
          scanRootCandidate === normalizedEntryPath.slice(0, 2)
        ? `${scanRootCandidate}/`
        : scanRootCandidate;
  const pattern = normalizedEntryPath.slice(separatorIndex + 1);

  return { scanRoot, pattern };
}

export async function expandGlobEntryPaths(entryPaths: string[]): Promise<string[]> {
  const expandedEntryPaths: string[] = [];

  for (const entryPath of entryPaths) {
    if (!isGlobPattern(entryPath)) {
      expandedEntryPaths.push(entryPath);
      continue;
    }

    const { scanRoot, pattern } = splitGlobPattern(entryPath);
    const { matchedPaths, ignoredMatchCount } = await scanGlobMatches(scanRoot, pattern, {
      ignoreTestFiles: !globPatternIncludesTestFiles(scanRoot, pattern),
      recurseIntoSubdirectories: globPatternMayMatchNestedPath(pattern),
    });
    const matches = matchedPaths.map((match) => join(scanRoot, match)).toSorted();
    if (matches.length > 0) {
      expandedEntryPaths.push(...matches);
    } else if (ignoredMatchCount === 0) {
      expandedEntryPaths.push(entryPath);
    }
  }

  return Array.from(new Set(expandedEntryPaths));
}

async function scanGlobMatches(
  scanRoot: string,
  pattern: string,
  options: { ignoreTestFiles: boolean; recurseIntoSubdirectories: boolean },
): Promise<{ ignoredMatchCount: number; matchedPaths: string[] }> {
  const glob = new Bun.Glob(pattern);
  const matchedPaths: string[] = [];
  const scanState = { ignoredMatchCount: 0 };

  await walkGlobScanRoot(scanRoot, '', glob, matchedPaths, scanState, options);

  return { ignoredMatchCount: scanState.ignoredMatchCount, matchedPaths };
}

async function walkGlobScanRoot(
  absoluteDirectory: string,
  relativeDirectory: string,
  glob: Bun.Glob,
  matchedPaths: string[],
  scanState: { ignoredMatchCount: number },
  options: { ignoreTestFiles: boolean; recurseIntoSubdirectories: boolean },
): Promise<void> {
  let directoryEntries: Dirent[];
  try {
    directoryEntries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    if (isMissingDirectoryError(error)) {
      return;
    }
    throw error;
  }

  for (const directoryEntry of directoryEntries) {
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${directoryEntry.name}`
      : directoryEntry.name;

    if (handleGlobFileEntry(directoryEntry, relativePath, glob, matchedPaths, scanState, options)) {
      continue;
    }

    if (shouldIgnoreExpandedGlobPath(relativePath, options.ignoreTestFiles)) {
      continue;
    }

    if (directoryEntry.isDirectory()) {
      if (!options.recurseIntoSubdirectories) {
        continue;
      }
      await walkGlobScanRoot(
        join(absoluteDirectory, directoryEntry.name),
        relativePath,
        glob,
        matchedPaths,
        scanState,
        options,
      );
    }
  }
}

function handleGlobFileEntry(
  directoryEntry: Dirent,
  relativePath: string,
  glob: Bun.Glob,
  matchedPaths: string[],
  scanState: { ignoredMatchCount: number },
  options: { ignoreTestFiles: boolean },
): boolean {
  if (!directoryEntry.isFile() || !glob.match(relativePath)) {
    return false;
  }

  if (shouldIgnoreExpandedGlobPath(relativePath, options.ignoreTestFiles)) {
    scanState.ignoredMatchCount += 1;
  } else {
    matchedPaths.push(relativePath);
  }

  return true;
}

function globPatternMayMatchNestedPath(pattern: string): boolean {
  return pattern.includes('/') || pattern.includes('**');
}

export function formatValue(value: unknown): string {
  return safeDebugStringify(value, 2);
}

function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Recursively records changed paths between two checkpoint-like values. */
export function collectDiffLines(
  beforeValue: unknown,
  afterValue: unknown,
  path: string,
  lines: string[],
): void {
  if (Object.is(beforeValue, afterValue)) {
    return;
  }

  if (Array.isArray(beforeValue) && Array.isArray(afterValue)) {
    const length = Math.max(beforeValue.length, afterValue.length);
    for (let index = 0; index < length; index++) {
      collectDiffLines(beforeValue[index], afterValue[index], `${path}[${index}]`, lines);
    }
    return;
  }

  if (isPlainObjectRecord(beforeValue) && isPlainObjectRecord(afterValue)) {
    const keys = new Set([...Object.keys(beforeValue), ...Object.keys(afterValue)]);
    for (const key of [...keys].toSorted()) {
      const childPath = path ? `${path}.${key}` : key;
      collectDiffLines(beforeValue[key], afterValue[key], childPath, lines);
    }
    return;
  }

  lines.push(`${path}: ${formatValue(beforeValue)} -> ${formatValue(afterValue)}`);
}

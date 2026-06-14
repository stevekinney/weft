#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';

export type Finding = {
  file: string;
  line: number;
  message: string;
};

export type DocumentationFile = {
  absolutePath: string;
  relativePath: string;
  text: string;
};

const REPOSITORY_ROOT = resolve(import.meta.dir, '..');

export const DOCUMENTATION_ROOTS = [
  'README.md',
  'BREAKING-CHANGES.md',
  'AGENTS.md',
  'CLAUDE.md',
  'documentation',
  'reference',
  'src/server/__fixtures__/subscription-wire/README.md',
];

const IGNORED_PATH_SEGMENTS = new Set(['.git', 'coverage', 'dist', 'node_modules', 'tmp']);
const ERROR_REFERENCE_PATH = 'documentation/reference/api-errors.md';
const ERROR_UNION_SOURCES = [
  { relativePath: 'src/core/weft-error.ts', unionName: 'WeftErrorCode' },
  { relativePath: 'src/core/fault-code.ts', unionName: 'FaultCode' },
] as const;

type VerificationOptions = {
  repositoryRoot?: string;
  documentationRoots?: readonly string[];
};

export function repositoryRelativePath(
  absolutePath: string,
  repositoryRoot = REPOSITORY_ROOT,
): string {
  return relative(repositoryRoot, absolutePath).split(sep).join('/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseMinimumBunVersion(repositoryRoot = REPOSITORY_ROOT): string {
  const packageJsonPath = resolve(repositoryRoot, 'package.json');
  const packageJson: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  if (!isRecord(packageJson) || !isRecord(packageJson.engines)) {
    throw new Error('package.json must define engines.bun');
  }
  const bunRange = packageJson.engines.bun;
  if (typeof bunRange !== 'string') throw new Error('package.json engines.bun must be a string');
  const match = bunRange.match(/(?:^|\s|[<>=~^])v?(\d+\.\d+\.\d+)/);
  if (!match?.[1]) throw new Error(`Unsupported Bun engine range: ${bunRange}`);
  return match[1];
}

function markdownFilesInDirectory(directoryPath: string, repositoryRoot: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    const absolutePath = resolve(directoryPath, entry.name);
    const relativePath = repositoryRelativePath(absolutePath, repositoryRoot);
    if (relativePath.split('/').some((segment) => IGNORED_PATH_SEGMENTS.has(segment))) continue;
    if (entry.isDirectory()) {
      files.push(...markdownFilesInDirectory(absolutePath, repositoryRoot));
    } else if (entry.isFile() && extname(entry.name) === '.md') {
      files.push(absolutePath);
    }
  }
  return files;
}

export function collectDocumentationFiles(options: VerificationOptions = {}): DocumentationFile[] {
  const repositoryRoot = resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  const documentationRoots = options.documentationRoots ?? DOCUMENTATION_ROOTS;
  const absolutePaths = new Set<string>();
  for (const root of documentationRoots) {
    const absoluteRoot = resolve(repositoryRoot, root);
    if (!existsSync(absoluteRoot)) continue;
    const stat = statSync(absoluteRoot);
    if (stat.isDirectory()) {
      for (const filePath of markdownFilesInDirectory(absoluteRoot, repositoryRoot)) {
        absolutePaths.add(filePath);
      }
    } else if (stat.isFile() && extname(absoluteRoot) === '.md') {
      absolutePaths.add(absoluteRoot);
    }
  }
  return [...absolutePaths]
    .toSorted((a, b) =>
      repositoryRelativePath(a, repositoryRoot).localeCompare(
        repositoryRelativePath(b, repositoryRoot),
      ),
    )
    .map((absolutePath) => ({
      absolutePath,
      relativePath: repositoryRelativePath(absolutePath, repositoryRoot),
      text: readFileSync(absolutePath, 'utf8'),
    }));
}

export function markdownHeadingSlug(heading: string): string {
  return heading
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number} _-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

export function collectAnchors(text: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const line of text.split('\n')) {
    const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!match?.[1]) continue;
    const baseSlug = markdownHeadingSlug(match[1]);
    if (baseSlug.length === 0) continue;
    const occurrence = seen.get(baseSlug) ?? 0;
    seen.set(baseSlug, occurrence + 1);
    anchors.add(occurrence === 0 ? baseSlug : `${baseSlug}-${occurrence}`);
  }
  return anchors;
}

function extractInlineLinkTarget(rawTarget: string): string {
  const target = rawTarget.trim();
  if (target.startsWith('<')) {
    const closingIndex = target.indexOf('>');
    return closingIndex === -1 ? target.slice(1) : target.slice(1, closingIndex);
  }
  const titleIndex = target.search(/\s+["'(]/);
  return titleIndex === -1 ? target : target.slice(0, titleIndex);
}

function decodeLinkTarget(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

function isExternalTarget(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//');
}

function splitTarget(target: string): { pathPart: string; anchor: string | undefined } {
  const withoutQuery = target.split('?')[0] ?? target;
  const hashIndex = withoutQuery.indexOf('#');
  if (hashIndex === -1) return { pathPart: withoutQuery, anchor: undefined };
  return {
    pathPart: withoutQuery.slice(0, hashIndex),
    anchor: decodeLinkTarget(withoutQuery.slice(hashIndex + 1)),
  };
}

function lineNumberForIndex(text: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor++) {
    if (text[cursor] === '\n') line++;
  }
  return line;
}

export function collectLinkFindings(
  files: DocumentationFile[],
  repositoryRoot = REPOSITORY_ROOT,
): Finding[] {
  const findings: Finding[] = [];
  const filesByAbsolutePath = new Map(files.map((file) => [file.absolutePath, file]));
  const anchorsByAbsolutePath = new Map(
    files.map((file) => [file.absolutePath, collectAnchors(file.text)]),
  );

  for (const file of files) {
    let textOutsideCode = '';
    let inFence = false;
    for (const line of file.text.split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        textOutsideCode += '\n';
        continue;
      }
      textOutsideCode += inFence ? '\n' : `${line}\n`;
    }

    const patterns = [/!?\[[^\]\n]*\]\(([^)\n]+)\)/g, /^\s*\[[^\]\n]+\]:\s+(\S+)/gm];

    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(textOutsideCode)) !== null) {
        const rawTarget = match[1];
        if (!rawTarget) continue;
        const target = extractInlineLinkTarget(rawTarget);
        if (target.length === 0 || isExternalTarget(target)) continue;

        const { pathPart, anchor } = splitTarget(target);
        const decodedPathPart = decodeLinkTarget(pathPart);
        const resolvedPath =
          decodedPathPart.length === 0
            ? file.absolutePath
            : decodedPathPart.startsWith('/')
              ? resolve(repositoryRoot, `.${decodedPathPart}`)
              : resolve(dirname(file.absolutePath), decodedPathPart);

        if (!existsSync(resolvedPath)) {
          findings.push({
            file: file.relativePath,
            line: lineNumberForIndex(textOutsideCode, match.index),
            message: `Broken local documentation link: ${target}`,
          });
          continue;
        }

        const stat = statSync(resolvedPath);
        if (stat.isDirectory() || anchor === undefined || anchor.length === 0) continue;
        const targetFile = filesByAbsolutePath.get(resolvedPath);
        if (extname(resolvedPath) !== '.md') continue;
        const anchors =
          anchorsByAbsolutePath.get(resolvedPath) ??
          collectAnchors(targetFile?.text ?? readFileSync(resolvedPath, 'utf8'));
        const normalizedAnchor = markdownHeadingSlug(anchor);
        if (!anchors.has(normalizedAnchor)) {
          findings.push({
            file: file.relativePath,
            line: lineNumberForIndex(textOutsideCode, match.index),
            message: `Broken local documentation anchor: ${target}`,
          });
        }
      }
    }
  }

  return findings;
}

export function parseSemanticVersion(version: string): [number, number, number] | undefined {
  const match = version.match(/^v?(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!match?.[1] || !match[2]) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function compareSemanticVersions(left: string, right: string): number | undefined {
  const parsedLeft = parseSemanticVersion(left);
  const parsedRight = parseSemanticVersion(right);
  if (!parsedLeft || !parsedRight) return undefined;
  for (let index = 0; index < parsedLeft.length; index++) {
    const difference = parsedLeft[index] - parsedRight[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

export function collectWorkflowBunVersionFindings(
  minimumBunVersion: string,
  repositoryRoot = REPOSITORY_ROOT,
): Finding[] {
  const workflowsDirectory = resolve(repositoryRoot, '.github/workflows');
  if (!existsSync(workflowsDirectory)) return [];
  const findings: Finding[] = [];

  for (const entry of readdirSync(workflowsDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    const absolutePath = resolve(workflowsDirectory, entry.name);
    const relativePath = repositoryRelativePath(absolutePath, repositoryRoot);
    const lines = readFileSync(absolutePath, 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      const match = line.match(/\bbun-version:\s*['"]?([^'"\s#]+)['"]?/);
      const version = match?.[1];
      if (!version) continue;
      const comparison = compareSemanticVersions(version, minimumBunVersion);
      if (comparison === undefined) {
        findings.push({
          file: relativePath,
          line: index + 1,
          message: `Unsupported bun-version format: ${version}. Use a concrete semver pin.`,
        });
      } else if (comparison < 0) {
        findings.push({
          file: relativePath,
          line: index + 1,
          message: `Bun workflow pin ${version} is lower than package.json engines.bun >=${minimumBunVersion}.`,
        });
      }
    }
  }

  return findings;
}

function extractStringUnionMembers(source: string, unionName: string): string[] {
  const unionMatch = new RegExp(`export\\s+type\\s+${unionName}\\s*=([\\s\\S]*?);`, 'm').exec(
    source,
  );
  if (!unionMatch?.[1]) {
    throw new Error(`Could not find exported ${unionName} union.`);
  }
  return [...unionMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1]).toSorted();
}

export function collectErrorReferenceFindings(repositoryRoot = REPOSITORY_ROOT): Finding[] {
  const sourceMembers: Array<{ unionName: string; member: string }> = [];
  for (const source of ERROR_UNION_SOURCES) {
    const absolutePath = resolve(repositoryRoot, source.relativePath);
    if (!existsSync(absolutePath)) return [];
    const members = extractStringUnionMembers(readFileSync(absolutePath, 'utf8'), source.unionName);
    sourceMembers.push(...members.map((member) => ({ unionName: source.unionName, member })));
  }

  const referencePath = resolve(repositoryRoot, ERROR_REFERENCE_PATH);
  if (!existsSync(referencePath)) {
    return [
      {
        file: ERROR_REFERENCE_PATH,
        line: 1,
        message: 'Required error-code reference page missing.',
      },
    ];
  }

  const referenceText = readFileSync(referencePath, 'utf8');
  const findings: Finding[] = [];
  for (const { unionName, member } of sourceMembers) {
    if (referenceText.includes(`\`${member}\``)) continue;
    findings.push({
      file: ERROR_REFERENCE_PATH,
      line: 1,
      message: `Missing ${unionName} member \`${member}\` from error-code reference.`,
    });
  }
  return findings;
}

export function collectBunClaimFindings(
  files: DocumentationFile[],
  minimumBunVersion: string,
): Finding[] {
  const findings: Finding[] = [];
  const bunVersionRequirementPattern =
    /\bbun\b(?=.*\b(?:minimum|need|needs|required|requires?|runtime version|or later)\b).*?\bv?(\d+\.\d+(?:\.\d+)?)\b/gi;
  const escapedMinimumVersion = minimumBunVersion.replaceAll('.', '\\.');
  const requiredClaims = [
    {
      file: 'README.md',
      pattern: new RegExp(`bun.*${escapedMinimumVersion}.*or later`, 'i'),
      message: `README.md must state the Bun runtime minimum as ${minimumBunVersion} or later.`,
    },
    {
      file: 'documentation/getting-started/installation.md',
      pattern: new RegExp(`Bun ${escapedMinimumVersion} or later`, 'i'),
      message: `Installation guide must state Bun ${minimumBunVersion} or later.`,
    },
    {
      file: 'documentation/contributing/development-setup.md',
      pattern: new RegExp(`minimum version is ${escapedMinimumVersion}`, 'i'),
      message: `Development setup must state minimum version is ${minimumBunVersion}.`,
    },
  ];

  for (const file of files) {
    for (const [index, line] of file.text.split('\n').entries()) {
      bunVersionRequirementPattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = bunVersionRequirementPattern.exec(line)) !== null) {
        const candidateVersion = match[1];
        if (!candidateVersion) continue;
        const comparison = compareSemanticVersions(candidateVersion, minimumBunVersion);
        if (comparison === undefined || comparison >= 0) continue;
        findings.push({
          file: file.relativePath,
          line: index + 1,
          message: `Stale Bun version claim ${candidateVersion}; package.json requires >=${minimumBunVersion}.`,
        });
      }
    }
  }

  const filesByRelativePath = new Map(files.map((file) => [file.relativePath, file]));
  for (const expectation of requiredClaims) {
    const file = filesByRelativePath.get(expectation.file);
    if (!file) {
      findings.push({
        file: expectation.file,
        line: 1,
        message: 'Required documentation file missing.',
      });
      continue;
    }
    if (!expectation.pattern.test(file.text)) {
      findings.push({ file: expectation.file, line: 1, message: expectation.message });
    }
  }

  return findings;
}

export function verifyDocumentation(options: VerificationOptions = {}): {
  filesChecked: number;
  findings: Finding[];
} {
  const repositoryRoot = resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  const minimumBunVersion = parseMinimumBunVersion(repositoryRoot);
  const files = collectDocumentationFiles({ ...options, repositoryRoot });
  const findings = [
    ...collectLinkFindings(files, repositoryRoot),
    ...collectBunClaimFindings(files, minimumBunVersion),
    ...collectWorkflowBunVersionFindings(minimumBunVersion, repositoryRoot),
    ...collectErrorReferenceFindings(repositoryRoot),
  ];

  return { filesChecked: files.length, findings };
}

type CliConsole = Pick<typeof console, 'error' | 'log'>;
type ExitFunction = (code?: number) => never;
const DEFAULT_EXIT: ExitFunction = process.exit.bind(process) as ExitFunction;

export function runCli(repositoryRoot = REPOSITORY_ROOT, cliConsole: CliConsole = console): number {
  const { filesChecked, findings } = verifyDocumentation({ repositoryRoot });

  if (findings.length > 0) {
    cliConsole.error(`verify-documentation: ${findings.length} finding(s)`);
    for (const finding of findings) {
      cliConsole.error(`${finding.file}:${finding.line}: ${finding.message}`);
    }
    return 1;
  }

  cliConsole.log(
    `verify-documentation: checked ${filesChecked} Markdown files, local links, anchors, Bun version claims, workflow Bun pins, and error-code references.`,
  );
  return 0;
}

export function runMain(
  repositoryRoot = REPOSITORY_ROOT,
  cliConsole: CliConsole = console,
  exit: ExitFunction = DEFAULT_EXIT,
): never {
  return exit(runCli(repositoryRoot, cliConsole));
}

const maybeRunMain = import.meta.main ? runMain : undefined;
maybeRunMain?.();

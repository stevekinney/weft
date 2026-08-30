import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

type Finding = {
  file: string;
  line: number;
  message: string;
};

const ROOTS = ['README.md', 'documentation', 'reference', 'src'] as const;
const TEXT_EXTENSIONS = new Set(['.md', '.ts', '.txt']);
const IGNORED_PATH_PARTS = new Set(['.git', 'coverage', 'dist', 'node_modules', 'tmp']);
const IGNORED_FILES = new Set<string>();

type CallExpression = {
  argumentsList: string[];
  index: number;
  methodName?: string;
  receiverName?: string;
};

function extension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot);
}

function isTestFile(path: string): boolean {
  return /\.test-d\.ts$|\.test\.ts$|\.spec\.ts$|\.test-support\.ts$/.test(path);
}

async function collectFiles(path: string): Promise<string[]> {
  if (IGNORED_PATH_PARTS.has(path)) return [];
  if (TEXT_EXTENSIONS.has(extension(path))) return [path];

  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (IGNORED_PATH_PARTS.has(entry.name)) continue;
    const childPath = join(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(childPath)));
    } else if (TEXT_EXTENSIONS.has(extension(entry.name))) {
      files.push(childPath);
    }
  }
  return files;
}

function lineNumberForIndex(source: string, index: number): number {
  let line = 1;
  for (let currentIndex = 0; currentIndex < index; currentIndex++) {
    if (source[currentIndex] === '\n') line++;
  }
  return line;
}

function findCallArguments(fileText: string, receiverPattern: RegExp): CallExpression[] {
  const calls: CallExpression[] = [];
  receiverPattern.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = receiverPattern.exec(fileText)) !== null) {
    let index = receiverPattern.lastIndex;
    let depth = 1;
    let quote: '"' | "'" | '`' | undefined;
    let escaped = false;
    let argumentsSource = '';

    while (index < fileText.length && depth > 0) {
      const character = fileText[index];

      if (quote !== undefined) {
        argumentsSource += character;
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === quote) {
          quote = undefined;
        }
        index++;
        continue;
      }

      if (character === '"' || character === "'" || character === '`') {
        quote = character;
        argumentsSource += character;
        index++;
        continue;
      }

      if (character === '(') depth++;
      if (character === ')') depth--;
      if (depth > 0) argumentsSource += character;
      index++;
    }

    calls.push({
      argumentsList: splitTopLevelArguments(argumentsSource),
      index: match.index,
      methodName: match[2] ?? match[1],
      receiverName: match[1],
    });
  }

  return calls;
}

function splitTopLevelArguments(source: string): string[] {
  const argumentsList: string[] = [];
  let current = '';
  let depth = 0;
  let quote: '"' | "'" | '`' | undefined;
  let escaped = false;

  for (const character of source) {
    if (quote !== undefined) {
      current += character;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      current += character;
      continue;
    }

    if (character === '(' || character === '[' || character === '{') depth++;
    if (character === ')' || character === ']' || character === '}') depth--;

    if (character === ',' && depth === 0) {
      argumentsList.push(current.trim());
      current = '';
      continue;
    }

    current += character;
  }

  if (current.trim().length > 0) argumentsList.push(current.trim());
  return argumentsList;
}

function isStringLiteral(argument: string | undefined): boolean {
  return argument !== undefined && /^(['"]).*\1$/s.test(argument.trim());
}

function checkFile(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const testFile = isTestFile(file);

  if (!testFile) {
    const runCalls = findCallArguments(text, /\b(?:ctx|context)\.run\s*\(/g);
    for (const { argumentsList, index } of runCalls) {
      if (argumentsList.length > 3) {
        findings.push({
          file,
          line: lineNumberForIndex(text, index),
          message: 'ctx.run() accepts only activity, input?, options?.',
        });
      } else if (argumentsList.length === 3 && isStringLiteral(argumentsList[2])) {
        findings.push({
          file,
          line: lineNumberForIndex(text, index),
          message:
            'The third ctx.run() argument must be ActivityCallOptions, not another activity input.',
        });
      }
    }
  }

  if (!testFile) {
    const messageCalls = findCallArguments(
      text,
      /\b([A-Za-z_$][\w$]*)\.(signal|update|query)\s*\(/g,
    );
    for (const { argumentsList, index, receiverName } of messageCalls) {
      if (receiverName === 'KEYS') continue;
      const firstArgumentIsString = isStringLiteral(argumentsList[0]);
      const secondArgumentIsString = isStringLiteral(argumentsList[1]);
      if (firstArgumentIsString || secondArgumentIsString) {
        findings.push({
          file,
          line: lineNumberForIndex(text, index),
          message: 'Public examples should use signal(), update(), or query() typed handles.',
        });
      }
    }
  }

  return findings;
}

const filesByRoot = await Promise.all(ROOTS.map((root) => collectFiles(root)));
const files = filesByRoot.flat();
const findings: Finding[] = [];

for (const file of files) {
  if (IGNORED_FILES.has(file)) continue;
  const text = await Bun.file(file).text();
  findings.push(...checkFile(file, text));
}

if (findings.length > 0) {
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}: ${finding.message}`);
  }
  process.exit(1);
}

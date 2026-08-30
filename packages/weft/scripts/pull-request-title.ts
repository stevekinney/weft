type Command = 'normalize' | 'validate';

const LINEAR_PREFIX_PATTERN = /^([A-Z][A-Z0-9]+-\d+:\s+)(.+)$/;
const CONVENTIONAL_PREFIX_PATTERN =
  /^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([^)]+\))?!?:\s+/i;
const BRANCH_SLUG_PREFIX_PATTERN = /^([a-z0-9]+(?:-[a-z0-9]+)*-?):\s+(.+)$/;
const MARKDOWN_PATTERN = /(\*\*|__|`)/;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
const HTML_TAG_PATTERN = /<\/?[^>]+>/g;
const USAGE_TEXT =
  'Usage: bun run scripts/pr-title.ts <normalize|validate> --title "Your PR title"';

export interface TitleValidationResult {
  valid: boolean;
  issues: string[];
}

export interface TitleNormalizationResult {
  originalTitle: string;
  normalizedTitle: string | null;
  changed: boolean;
  safeToAutofix: boolean;
  issues: string[];
}

export interface PullRequestTitleCliOutput {
  stdout: string[];
  stderr: string[];
  exitCode: number;
}

function containsHtmlFragments(value: string): boolean {
  return /<!--[\s\S]*?-->/u.test(value) || /<\/?[^>]+>/u.test(value);
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stripFormatting(value: string): string {
  return collapseWhitespace(
    value
      .replace(HTML_COMMENT_PATTERN, ' ')
      .replace(HTML_TAG_PATTERN, ' ')
      .replace(/\*\*/g, ' ')
      .replace(/__/g, ' ')
      .replace(/`+/g, ' '),
  );
}

function splitLinearPrefix(title: string): { prefix: string; baseTitle: string } {
  const match = title.match(LINEAR_PREFIX_PATTERN);
  if (!match) {
    return { prefix: '', baseTitle: title };
  }

  const prefix = match[1];
  const baseTitle = match[2];
  return { prefix, baseTitle };
}

function capitalizeFirstLetter(value: string): string {
  if (value.length === 0) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function removeTrailingPunctuation(value: string): string {
  return value.replace(/[.!?]+$/u, '').trimEnd();
}

function extractFirstSentence(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== '.' && character !== '!' && character !== '?') continue;

    const nextCharacter = value[index + 1] ?? '';
    const previousCharacter = value[index - 1] ?? '';
    if (character === '.' && /\d/.test(previousCharacter) && /\d/.test(nextCharacter)) {
      continue;
    }

    if (nextCharacter === '' || /\s/.test(nextCharacter)) {
      return value.slice(0, index);
    }
  }

  return value;
}

function looksLikeBranchSlugPrefix(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*-?$/u.test(value) && value.includes('-');
}

function looksLikeStandaloneBranchSlug(value: string): boolean {
  const candidate = value.replace(/:+$/u, '').trim();
  return (
    candidate.length > 0 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*-?$/u.test(candidate) &&
    candidate.includes('-')
  );
}

function normalizeBaseTitle(baseTitle: string): string {
  let workingTitle = collapseWhitespace(baseTitle);

  if (looksLikeStandaloneBranchSlug(workingTitle)) {
    return '';
  }

  if (CONVENTIONAL_PREFIX_PATTERN.test(workingTitle)) {
    workingTitle = workingTitle.replace(CONVENTIONAL_PREFIX_PATTERN, '');
  }

  const slugMatch = workingTitle.match(BRANCH_SLUG_PREFIX_PATTERN);
  if (slugMatch) {
    const slugPrefix = slugMatch[1];
    const remainder = slugMatch[2];
    if (
      slugPrefix !== undefined &&
      remainder !== undefined &&
      looksLikeBranchSlugPrefix(slugPrefix)
    ) {
      workingTitle = remainder;
    }
  }

  workingTitle = stripFormatting(workingTitle);
  workingTitle = extractFirstSentence(workingTitle);
  workingTitle = removeTrailingPunctuation(workingTitle);
  workingTitle = collapseWhitespace(workingTitle);

  if (workingTitle.length === 0) {
    return workingTitle;
  }

  return capitalizeFirstLetter(workingTitle);
}

export function validatePullRequestTitle(title: string): TitleValidationResult {
  const issues: string[] = [];
  const trimmedTitle = title.trim();

  if (trimmedTitle.length === 0) {
    issues.push('PR title must not be empty.');
    return { valid: false, issues };
  }

  if (trimmedTitle !== title) {
    issues.push('PR title must not start or end with whitespace.');
  }

  if (/[\r\n]/u.test(title)) {
    issues.push('PR title must be a single line.');
  }

  const { baseTitle } = splitLinearPrefix(trimmedTitle);

  if (looksLikeStandaloneBranchSlug(baseTitle)) {
    issues.push('PR title must not be just a branch slug.');
  }

  if (CONVENTIONAL_PREFIX_PATTERN.test(baseTitle)) {
    issues.push('PR title must not start with a conventional-commit prefix like feat: or fix:.');
  }

  const slugMatch = baseTitle.match(BRANCH_SLUG_PREFIX_PATTERN);
  if (slugMatch && slugMatch[1] !== undefined && looksLikeBranchSlugPrefix(slugMatch[1])) {
    issues.push('PR title must not start with a branch-slug prefix.');
  }

  if (MARKDOWN_PATTERN.test(trimmedTitle) || /[_*`]{2,}/u.test(trimmedTitle)) {
    issues.push('PR title must not contain Markdown emphasis or inline code.');
  }

  if (containsHtmlFragments(trimmedTitle)) {
    issues.push('PR title must not contain HTML or HTML comments.');
  }

  const plainBaseTitle = stripFormatting(baseTitle);
  const firstSentence = extractFirstSentence(plainBaseTitle);
  const baseTitleWithoutTrailingPunctuation = removeTrailingPunctuation(plainBaseTitle);
  if (firstSentence !== baseTitleWithoutTrailingPunctuation) {
    issues.push('PR title must be a single concise sentence fragment, not a multi-sentence dump.');
  } else if (baseTitleWithoutTrailingPunctuation !== plainBaseTitle) {
    issues.push('PR title must not end with trailing punctuation.');
  }

  if (!/^[A-Z]/u.test(baseTitle)) {
    issues.push(
      'PR title must start with an uppercase letter after any optional Linear ticket prefix.',
    );
  }

  return { valid: issues.length === 0, issues };
}

export function normalizePullRequestTitle(title: string): TitleNormalizationResult {
  const originalTitle = title;
  const trimmedTitle = title.trim();
  const { prefix, baseTitle } = splitLinearPrefix(trimmedTitle);
  const normalizedBaseTitle = normalizeBaseTitle(baseTitle);
  const candidateNormalizedTitle =
    normalizedBaseTitle.length > 0 ? `${prefix}${normalizedBaseTitle}` : null;
  const validation = candidateNormalizedTitle
    ? validatePullRequestTitle(candidateNormalizedTitle)
    : null;
  const normalizedTitle = validation?.valid === true ? candidateNormalizedTitle : null;

  return {
    originalTitle,
    normalizedTitle,
    changed: normalizedTitle !== null && normalizedTitle !== trimmedTitle,
    safeToAutofix: normalizedTitle !== null,
    issues:
      normalizedTitle !== null ? [] : (validation?.issues ?? ['Unable to derive a safe PR title.']),
  };
}

function getCommand(value: string | undefined): Command | null {
  if (value === 'normalize' || value === 'validate') {
    return value;
  }

  return null;
}

function getFlagValue(arguments_: string[], name: string): string | undefined {
  const prefix = `${name}=`;

  for (const argument of arguments_) {
    if (argument.startsWith(prefix)) {
      return argument.slice(prefix.length);
    }
  }

  const flagIndex = arguments_.findIndex((argument) => argument === name);
  if (flagIndex === -1) return undefined;
  return arguments_[flagIndex + 1];
}

function printUsage(writeError: (line: string) => void = console.error): void {
  writeError(USAGE_TEXT);
}

export function runPullRequestTitleCli(argv: string[]): PullRequestTitleCliOutput {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const command = getCommand(argv[0]);
  const title = getFlagValue(argv.slice(1), '--title');

  if (command === null || title === undefined) {
    printUsage((line) => stderr.push(line));
    return { stdout, stderr, exitCode: 1 };
  }

  if (command === 'normalize') {
    stdout.push(JSON.stringify(normalizePullRequestTitle(title)));
    return { stdout, stderr, exitCode: 0 };
  }

  const validation = validatePullRequestTitle(title);
  if (!validation.valid) {
    for (const issue of validation.issues) {
      stderr.push(`- ${issue}`);
    }
    return { stdout, stderr, exitCode: 1 };
  }

  stdout.push(title.trim());
  return { stdout, stderr, exitCode: 0 };
}

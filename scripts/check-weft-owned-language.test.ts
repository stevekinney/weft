import { describe, expect, it } from 'bun:test';

const repositoryRoot = new URL('../', import.meta.url).pathname;

// Disallowed terms are written as fragment arrays joined at runtime so this
// file does not trip its own check. A future maintainer adding a new term
// should follow the same pattern; writing the term as a single literal
// string here would make the test fail on itself the next time it runs.
const disallowedTerms = [
  ['agent', ' bureau'],
  ['agent', '-bureau'],
  ['agent', '.bureau'],
  ['agent', '_bureau'],
  ['agent', 'bureau'],
  ['arm', 'orer'],
  ['arm', 'orers'],
  ['convers', 'ationalist'],
  ['convers', 'ationalists'],
].map((parts) => parts.join('').toLowerCase());

// CHANGELOG.md preserves the literal name of a single removed export as a
// historical accuracy record. Only the exact inline-code token is exempt; any
// other spelling, prose mention, or longer identifier still fails the check.
const allowedHistoricalChangelogToken = ['`', 'Agent', 'Bureau', 'ConversationHistory', '`'].join(
  '',
);

// Tracked text surfaces that can carry prose, identifiers, or configuration.
// The list is built from the actual set of tracked file shapes in this repo
// (extensions + extensionless husky hook scripts + env-example files); when
// a new text-carrying file type lands in the repo it must be added here so
// the check covers it. The set is intentionally explicit rather than
// "every tracked file" so binary blobs and vendored generated artifacts
// stay out of the scan without per-path skip logic.
const trackedTextGlobs = [
  '*.ts',
  '*.tsx',
  '*.js',
  '*.mjs',
  '*.cjs',
  '*.svelte',
  '*.md',
  '*.mdx',
  '*.json',
  '*.jsonc',
  '*.toml',
  '*.yaml',
  '*.yml',
  '*.html',
  '*.css',
  '*.sh',
  '.env*',
  '.husky/*',
];

async function trackedFiles(): Promise<string[]> {
  const output = await Bun.$`git -C ${repositoryRoot} ls-files -z -- ${trackedTextGlobs}`.text();
  return output.split('\0').filter((path) => path.length > 0);
}

function contentForCheck(relativePath: string, content: string): string {
  if (relativePath === 'CHANGELOG.md') {
    return content.replaceAll(allowedHistoricalChangelogToken, '');
  }
  return content;
}

describe('Weft-owned language', () => {
  it('does not name downstream projects outside the documented historical changelog export token', async () => {
    const matches: string[] = [];

    for (const relativePath of await trackedFiles()) {
      const trackedFile = Bun.file(new URL(relativePath, `file://${repositoryRoot}/`));
      if (!(await trackedFile.exists())) continue;

      const rawContent = await trackedFile.text();
      const lowered = contentForCheck(relativePath, rawContent).toLowerCase();
      const lines = lowered.split('\n');

      for (const term of disallowedTerms) {
        const lineIndex = lines.findIndex((line) => line.includes(term));
        if (lineIndex !== -1) {
          matches.push(`${relativePath}:${lineIndex + 1}: ${term}`);
        }
      }
    }

    expect(matches).toEqual([]);
  });
});

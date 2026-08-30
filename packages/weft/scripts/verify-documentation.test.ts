import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  collectErrorReferenceFindings,
  collectRemovedReferenceFindings,
  parseMinimumBunVersion,
  runCli,
  runMain,
  verifyDocumentation,
} from './verify-documentation.ts';

const temporaryRepositories: string[] = [];

const BASE_DOCUMENTATION_FILES: Record<string, string> = {
  'package.json': JSON.stringify({ engines: { bun: '>=1.3.13' } }, null, 2),
  'README.md': [
    '# Weft',
    '',
    'The bun runtime version 1.3.13 or later is required.',
    '',
    'See [Installation](documentation/getting-started/installation.md#installation).',
    '',
  ].join('\n'),
  'documentation/getting-started/installation.md': [
    '# Installation',
    '',
    'You need Bun 1.3.13 or later.',
    '',
  ].join('\n'),
  'documentation/contributing/development-setup.md': [
    '# Development Setup',
    '',
    'The minimum version is 1.3.13.',
    '',
  ].join('\n'),
};

afterEach(() => {
  while (temporaryRepositories.length > 0) {
    const repositoryPath = temporaryRepositories.pop();
    if (repositoryPath) rmSync(repositoryPath, { recursive: true, force: true });
  }
});

async function createFixtureRepository(files: Record<string, string>): Promise<string> {
  const repositoryRoot = join(tmpdir(), `weft-documentation-${crypto.randomUUID()}`);
  temporaryRepositories.push(repositoryRoot);

  for (const [relativePath, contents] of Object.entries({
    ...BASE_DOCUMENTATION_FILES,
    ...files,
  })) {
    const absolutePath = join(repositoryRoot, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    await Bun.write(absolutePath, contents);
  }

  return repositoryRoot;
}

describe('verifyDocumentation', () => {
  it('passes for a minimal repository with required Bun version claims', async () => {
    const repositoryRoot = await createFixtureRepository({});

    const result = verifyDocumentation({ repositoryRoot });

    expect(result.findings).toEqual([]);
    expect(result.filesChecked).toBe(3);
  });

  it('detects broken local links', async () => {
    const repositoryRoot = await createFixtureRepository({
      'documentation/guides/broken-links.md': '# Broken Links\n\n[Missing](missing.md)\n',
    });

    const result = verifyDocumentation({ repositoryRoot });

    expect(result.findings).toContainEqual({
      file: 'documentation/guides/broken-links.md',
      line: 3,
      message: 'Broken local documentation link: missing.md',
    });
  });

  it('rejects removed interfaces from current reference documentation', async () => {
    const repositoryRoot = await createFixtureRepository({
      'documentation/reference/types.md':
        '### `WorkflowRegistration`\n\ninterface WorkflowRegistration {}\n',
    });

    const result = verifyDocumentation({ repositoryRoot });

    expect(result.findings).toContainEqual({
      file: 'documentation/reference/types.md',
      line: 1,
      message:
        'Removed WorkflowRegistration must not appear in current reference documentation; use the workflow builder definition instead.',
    });
  });

  it('keeps historical references outside the current reference inventory', () => {
    expect(
      collectRemovedReferenceFindings([
        {
          absolutePath: '/tmp/CHANGELOG.md',
          relativePath: 'CHANGELOG.md',
          text: 'WorkflowRegistration was removed.',
        },
      ]),
    ).toEqual([]);
  });

  it('validates duplicate heading anchors and ignores links inside fenced code blocks', async () => {
    const repositoryRoot = await createFixtureRepository({
      'README.md': [
        '# Weft',
        '',
        'The bun runtime version 1.3.13 or later is required.',
        '',
        'See [the second heading](documentation/guides/anchors.md#repeat-1).',
        '',
        '```markdown',
        '[This missing link is example text](missing.md)',
        '```',
        '',
      ].join('\n'),
      'documentation/guides/anchors.md': ['# Anchors', '', '## Repeat', '', '## Repeat', ''].join(
        '\n',
      ),
    });

    const result = verifyDocumentation({ repositoryRoot });

    expect(result.findings).toEqual([]);
  });

  it('detects broken reference-style anchors', async () => {
    const repositoryRoot = await createFixtureRepository({
      'README.md': [
        '# Weft',
        '',
        'The bun runtime version 1.3.13 or later is required.',
        '',
        '[Target][target]',
        '',
        '[target]: documentation/getting-started/installation.md#missing-heading',
        '',
      ].join('\n'),
    });

    const result = verifyDocumentation({ repositoryRoot });

    expect(result.findings).toContainEqual({
      file: 'README.md',
      line: 6,
      message:
        'Broken local documentation anchor: documentation/getting-started/installation.md#missing-heading',
    });
  });

  it('detects stale Bun version claims from any lower version', async () => {
    const repositoryRoot = await createFixtureRepository({
      'README.md': '# Weft\n\nThe bun runtime version 1.3.12 or later is required.\n',
    });

    const result = verifyDocumentation({ repositoryRoot });

    expect(result.findings).toContainEqual({
      file: 'README.md',
      line: 3,
      message: 'Stale Bun version claim 1.3.12; package.json requires >=1.3.13.',
    });
  });

  it('detects workflow Bun pins below the package minimum', async () => {
    const repositoryRoot = await createFixtureRepository({
      '.github/workflows/ci.yaml': [
        'name: CI',
        'jobs:',
        '  test:',
        '    steps:',
        '      - uses: oven-sh/setup-bun@v1',
        '        with:',
        '          bun-version: 1.3.2',
        '',
      ].join('\n'),
    });

    const result = verifyDocumentation({ repositoryRoot });

    expect(result.findings).toContainEqual({
      file: '.github/workflows/ci.yaml',
      line: 7,
      message: 'Bun workflow pin 1.3.2 is lower than package.json engines.bun >=1.3.13.',
    });
  });

  it('detects unsupported workflow Bun version formats', async () => {
    const repositoryRoot = await createFixtureRepository({
      '.github/workflows/ci.yaml': [
        'name: CI',
        'jobs:',
        '  test:',
        '    steps:',
        '      - uses: oven-sh/setup-bun@v1',
        '        with:',
        '          bun-version: latest',
        '',
      ].join('\n'),
    });

    const result = verifyDocumentation({ repositoryRoot });

    expect(result.findings).toContainEqual({
      file: '.github/workflows/ci.yaml',
      line: 7,
      message: 'Unsupported bun-version format: latest. Use a concrete semver pin.',
    });
  });

  it('requires the error reference to cover every public error and fault code', async () => {
    const repositoryRoot = await createFixtureRepository({
      'src/core/weft-error.ts': "export type WeftErrorCode = 'WorkflowNotFoundError';\n",
      'src/core/fault-code.ts': "export type FaultCode = 'NotFound' | 'Conflict';\n",
      'documentation/reference/api-errors.md': [
        '# Error Codes',
        '',
        '| Code | Description |',
        '| ---- | ----------- |',
        '| `WorkflowNotFoundError` | Missing workflow record. |',
        '| `NotFound` | Missing resource. |',
        '',
      ].join('\n'),
    });

    expect(collectErrorReferenceFindings(repositoryRoot)).toContainEqual({
      file: 'documentation/reference/api-errors.md',
      line: 1,
      message: 'Missing FaultCode member `Conflict` from error-code reference.',
    });
  });

  it('skips error reference validation when the source union files are absent', async () => {
    const repositoryRoot = await createFixtureRepository({});

    expect(collectErrorReferenceFindings(repositoryRoot)).toEqual([]);
  });

  it('reports malformed exported error unions', async () => {
    const repositoryRoot = await createFixtureRepository({
      'src/core/weft-error.ts': 'export const notAUnion = true;\n',
      'src/core/fault-code.ts': "export type FaultCode = 'NotFound';\n",
    });

    expect(() => collectErrorReferenceFindings(repositoryRoot)).toThrow(
      'Could not find exported WeftErrorCode union.',
    );
  });

  it('reports a missing error reference page after source union files are present', async () => {
    const repositoryRoot = await createFixtureRepository({
      'src/core/weft-error.ts': "export type WeftErrorCode = 'WorkflowNotFoundError';\n",
      'src/core/fault-code.ts': "export type FaultCode = 'NotFound';\n",
    });

    expect(collectErrorReferenceFindings(repositoryRoot)).toEqual([
      {
        file: 'documentation/reference/api-errors.md',
        line: 1,
        message: 'Required error-code reference page missing.',
      },
    ]);
  });

  it('rejects package.json files that do not define engines.bun as a string semver range', async () => {
    const missingEnginesRoot = await createFixtureRepository({
      'package.json': JSON.stringify({}, null, 2),
    });
    expect(() => parseMinimumBunVersion(missingEnginesRoot)).toThrow(
      'package.json must define engines.bun',
    );

    const nonStringRoot = await createFixtureRepository({
      'package.json': JSON.stringify({ engines: { bun: 123 } }, null, 2),
    });
    expect(() => parseMinimumBunVersion(nonStringRoot)).toThrow(
      'package.json engines.bun must be a string',
    );

    const unsupportedRangeRoot = await createFixtureRepository({
      'package.json': JSON.stringify({ engines: { bun: 'workspace:*' } }, null, 2),
    });
    expect(() => parseMinimumBunVersion(unsupportedRangeRoot)).toThrow(
      'Unsupported Bun engine range: workspace:*',
    );
  });

  it('parses angle-bracket links without closing brackets and tolerates malformed percent escapes', async () => {
    const repositoryRoot = await createFixtureRepository({
      'README.md': [
        '# Weft',
        '',
        'The bun runtime version 1.3.13 or later is required.',
        '',
        'See [Installation](<documentation/getting-started/installation.md#installation).',
        'See [Odd path](documentation/%E0%A4%A.md).',
        '',
      ].join('\n'),
      'documentation/%E0%A4%A.md': '# Odd path\n',
    });

    const result = verifyDocumentation({ repositoryRoot });
    expect(result.findings).toEqual([]);
  });

  it('reports missing required documentation files', async () => {
    const repositoryRoot = await createFixtureRepository({
      'README.md': '# Weft\n\nThe bun runtime version 1.3.13 or later is required.\n',
    });
    rmSync(join(repositoryRoot, 'documentation/contributing/development-setup.md'));

    const result = verifyDocumentation({ repositoryRoot });

    expect(result.findings).toContainEqual({
      file: 'documentation/contributing/development-setup.md',
      line: 1,
      message: 'Required documentation file missing.',
    });
  });

  it('returns exit code 0 for a clean repository via the CLI helper', async () => {
    const repositoryRoot = await createFixtureRepository({});
    const logs: string[] = [];

    const exitCode = runCli(repositoryRoot, {
      log(message) {
        logs.push(String(message));
      },
      error(message) {
        logs.push(String(message));
      },
    });

    expect(exitCode).toBe(0);
    expect(logs.join('\n')).toContain('verify-documentation: checked 3 Markdown files');
  });

  it('runs the CLI entrypoint successfully in import.meta.main mode', async () => {
    const scriptPath = join(import.meta.dir, 'verify-documentation.ts');
    const proc = Bun.spawn(['bun', scriptPath], {
      cwd: join(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...Bun.env, FORCE_COLOR: '0' },
    });

    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
  });

  it('returns exit code 1 for repositories with findings via the CLI helper', async () => {
    const repositoryRoot = await createFixtureRepository({
      'README.md': '# Weft\n\nThe bun runtime version 1.3.12 or later is required.\n',
    });
    const errors: string[] = [];

    const exitCode = runCli(repositoryRoot, {
      log(message) {
        errors.push(String(message));
      },
      error(message) {
        errors.push(String(message));
      },
    });

    expect(exitCode).toBe(1);
    expect(errors.join('\n')).toContain('verify-documentation: 2 finding(s)');
    expect(errors.join('\n')).toContain(
      'README.md:3: Stale Bun version claim 1.3.12; package.json requires >=1.3.13.',
    );
  });

  it('calls the provided exit function with the computed CLI status', async () => {
    const repositoryRoot = await createFixtureRepository({
      'README.md': '# Weft\n\nThe bun runtime version 1.3.12 or later is required.\n',
    });

    expect(() =>
      runMain(repositoryRoot, { log() {}, error() {} }, (code?: number) => {
        throw new Error(`exit:${code ?? 0}`);
      }),
    ).toThrow('exit:1');
  });
});

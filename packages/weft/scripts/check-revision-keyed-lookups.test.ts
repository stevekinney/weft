import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { write } from 'bun';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { GUARDED_FIELDS, stripComments } from './check-revision-keyed-lookups.ts';

const scriptPath = join(import.meta.dir, 'check-revision-keyed-lookups.ts');

type RunResult = { exitCode: number; stdout: string; stderr: string };

function run(args: readonly string[]): RunResult {
  const result = Bun.spawnSync(['bun', 'run', scriptPath, ...args]);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

async function writeFixtureFile(root: string, relativePath: string, body: string): Promise<void> {
  await write(join(root, relativePath), body);
}

describe('check-revision-keyed-lookups', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'revision-keyed-lookups-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('passes on an empty fixture', async () => {
    const result = run(['--root', root]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('OK: no out-of-allowlist references');
  });

  it('fails when a non-allowlisted file reads .activityRegistriesByWorkflow', async () => {
    await writeFixtureFile(
      root,
      'src/core/engine/some-new-file.ts',
      `export function readIt(internals: { activityRegistriesByWorkflow: Map<string, unknown> }) {\n` +
        `  return internals.activityRegistriesByWorkflow.get('type');\n` +
        `}\n`,
    );
    const result = run(['--root', root]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('src/core/engine/some-new-file.ts:2');
    expect(result.stderr).toContain('.activityRegistriesByWorkflow');
  });

  it('fails when a non-allowlisted file writes .lastResolvedRevisionByName', async () => {
    await writeFixtureFile(
      root,
      'src/core/engine/some-other-file.ts',
      `export function writeIt(internals: { sources: { lastResolvedRevisionByName: Map<string, string> } }) {\n` +
        `  internals.sources.lastResolvedRevisionByName.set('type', 'rev');\n` +
        `}\n`,
    );
    const result = run(['--root', root]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('src/core/engine/some-other-file.ts:2');
    expect(result.stderr).toContain('.lastResolvedRevisionByName');
  });

  it('passes when a `.activityRegistriesByWorkflow` reference is inside a line comment', async () => {
    await writeFixtureFile(
      root,
      'src/core/engine/comment-only.ts',
      `// See internals.activityRegistriesByWorkflow for the eager-only registry.\n` +
        `export const value = 1;\n`,
    );
    const result = run(['--root', root]);
    expect(result.exitCode).toBe(0);
  });

  it('passes when a `.lastResolvedRevisionByName` reference is inside a block/JSDoc comment', async () => {
    await writeFixtureFile(
      root,
      'src/core/engine/block-comment-only.ts',
      `/**\n * Falls back to \`internals.sources.lastResolvedRevisionByName\`.\n */\nexport const value = 1;\n`,
    );
    const result = run(['--root', root]);
    expect(result.exitCode).toBe(0);
  });

  it('fails when a non-allowlisted file destructures the guarded field, evading a dot-only pattern (WFT-19 review round 2)', async () => {
    await writeFixtureFile(
      root,
      'src/core/engine/destructure-only.ts',
      `export function readIt(internals: { activityRegistriesByWorkflow: Map<string, unknown> }) {\n` +
        `  const { activityRegistriesByWorkflow } = internals;\n` +
        `  return activityRegistriesByWorkflow.get('type');\n` +
        `}\n`,
    );
    const result = run(['--root', root]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('src/core/engine/destructure-only.ts:2');
  });

  it('fails when a non-allowlisted file uses bracket-string access on the guarded field, evading a dot-only pattern (WFT-19 review round 2)', async () => {
    await writeFixtureFile(
      root,
      'src/core/engine/bracket-only.ts',
      `export function writeIt(internals: { sources: { lastResolvedRevisionByName: Map<string, string> } }) {\n` +
        `  internals.sources['lastResolvedRevisionByName'].set('type', 'rev');\n` +
        `}\n`,
    );
    const result = run(['--root', root]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('src/core/engine/bracket-only.ts:2');
  });

  it("fails when the bare field name appears without a leading dot in a non-allowlisted file (a type/property declaration is itself flagged unless the file is allowlisted — the field's own declaring files are)", async () => {
    await writeFixtureFile(
      root,
      'src/core/engine/declaration-only.ts',
      `export type Sources = {\n  lastResolvedRevisionByName: Map<string, string>;\n};\n` +
        `export function build(): Sources {\n  return { lastResolvedRevisionByName: new Map() };\n}\n`,
    );
    const result = run(['--root', root]);
    expect(result.exitCode).toBe(1);
  });

  it("passes when the reference is in one of the field's own allowed files", async () => {
    const guarded = GUARDED_FIELDS.find((field) => field.name === 'activityRegistriesByWorkflow')!;
    const allowedPath = guarded.allowedFiles[0];
    await writeFixtureFile(
      root,
      allowedPath,
      `export function readIt(internals: { activityRegistriesByWorkflow: Map<string, unknown> }) {\n` +
        `  return internals.activityRegistriesByWorkflow.get('type');\n` +
        `}\n`,
    );
    const result = run(['--root', root]);
    expect(result.exitCode).toBe(0);
  });

  it('excludes .test.ts and __tests__ paths from enforcement', async () => {
    await writeFixtureFile(
      root,
      'src/core/engine/some-new-file.test.ts',
      `export function readIt(internals: { activityRegistriesByWorkflow: Map<string, unknown> }) {\n` +
        `  return internals.activityRegistriesByWorkflow.get('type');\n` +
        `}\n`,
    );
    await writeFixtureFile(
      root,
      'src/core/engine/__tests__/some-new-file.ts',
      `export function readIt(internals: { activityRegistriesByWorkflow: Map<string, unknown> }) {\n` +
        `  return internals.activityRegistriesByWorkflow.get('type');\n` +
        `}\n`,
    );
    const result = run(['--root', root]);
    expect(result.exitCode).toBe(0);
  });

  it('reports every violation, not just the first, across multiple files and fields', async () => {
    await writeFixtureFile(
      root,
      'src/core/engine/file-a.ts',
      // A type-only import (never matching the guarded identifier itself)
      // keeps this fixture at exactly one violation line — the access —
      // rather than also matching an inline structural type annotation.
      `import type { InternalsLike } from './fixture-types.ts';\n` +
        `export function a(internals: InternalsLike) {\n` +
        `  return internals.activityRegistriesByWorkflow.get('x');\n` +
        `}\n`,
    );
    await writeFixtureFile(
      root,
      'src/core/engine/file-b.ts',
      `import type { InternalsLike } from './fixture-types.ts';\n` +
        `export function b(internals: InternalsLike) {\n` +
        `  return internals.sources.lastResolvedRevisionByName.get('x');\n` +
        `}\n`,
    );
    const result = run(['--root', root]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Found 2 reference(s)');
    expect(result.stderr).toContain('src/core/engine/file-a.ts:3');
    expect(result.stderr).toContain('src/core/engine/file-b.ts:3');
  });
});

describe('stripComments()', () => {
  it('replaces a line comment with spaces up to the newline, preserving line count', () => {
    const source = 'const a = 1; // comment with .activityRegistriesByWorkflow\nconst b = 2;\n';
    const stripped = stripComments(source);
    expect(stripped.split('\n').length).toBe(source.split('\n').length);
    expect(stripped).not.toContain('activityRegistriesByWorkflow');
    expect(stripped).toContain('const a = 1;');
    expect(stripped).toContain('const b = 2;');
  });

  it('replaces a multi-line block comment with spaces, preserving newlines and line count', () => {
    const source = '/**\n * .lastResolvedRevisionByName mention\n */\nconst a = 1;\n';
    const stripped = stripComments(source);
    expect(stripped.split('\n').length).toBe(source.split('\n').length);
    expect(stripped).not.toContain('lastResolvedRevisionByName');
    expect(stripped).toContain('const a = 1;');
  });

  it('leaves non-comment code untouched', () => {
    const source = "const value = internals.activityRegistriesByWorkflow.get('type');\n";
    expect(stripComments(source)).toBe(source);
  });
});

describe('check-revision-keyed-lookups GUARDED_FIELDS', () => {
  it('names exactly the two guarded fields', () => {
    expect(GUARDED_FIELDS.map((field) => field.name).toSorted()).toEqual([
      'activityRegistriesByWorkflow',
      'lastResolvedRevisionByName',
    ]);
  });

  it('every allowlisted path is non-empty and repo-relative (no leading slash)', () => {
    for (const guarded of GUARDED_FIELDS) {
      expect(guarded.allowedFiles.length).toBeGreaterThan(0);
      for (const path of guarded.allowedFiles) {
        expect(path.startsWith('/')).toBe(false);
        expect(path.startsWith('src/')).toBe(true);
      }
    }
  });
});

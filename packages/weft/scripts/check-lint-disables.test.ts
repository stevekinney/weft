import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { write } from 'bun';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { MAX_DISABLES, MIN_RATIONALE_LENGTH } from './check-lint-disables.ts';

const scriptPath = join(import.meta.dir, 'check-lint-disables.ts');

const RATIONALE_PASS = 'rationale that comfortably exceeds the forty character floor for clarity';
// 73 chars — well above MIN_RATIONALE_LENGTH (40).

const RATIONALE_SHORT = 'too short';

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

async function makeDirective(
  root: string,
  relativePath: string,
  rationale: string,
  rule = 'complexity',
): Promise<void> {
  const body = `// oxlint-disable-next-line ${rule} -- ${rationale}\nexport function noop(): void {}\n`;
  await writeFixtureFile(root, relativePath, body);
}

describe('check-lint-disables ceiling mode', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'oxlint-check-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('passes on an empty fixture with --max 5', async () => {
    const result = run(['--root', root, '--max', '5']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('OK: 0/5');
    expect(result.stdout).toContain('effective max = 5 from --max');
  });

  it('passes when five directives all carry rationales of at least 40 chars', async () => {
    for (let i = 0; i < 5; i += 1) {
      await makeDirective(root, `src/file-${i}.ts`, RATIONALE_PASS);
    }
    const result = run(['--root', root, '--max', '5']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('OK: 5/5');
  });

  it('fails when a sixth directive pushes the count above the ceiling', async () => {
    for (let i = 0; i < 6; i += 1) {
      await makeDirective(root, `src/file-${i}.ts`, RATIONALE_PASS);
    }
    const result = run(['--root', root, '--max', '5']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Found 6 oxlint-disable directive(s)');
    expect(result.stderr).toContain('ceiling is 5');
  });

  it('fails when a directive has a rationale shorter than the floor', async () => {
    await makeDirective(root, 'src/short.ts', RATIONALE_SHORT);
    const result = run(['--root', root, '--max', '5']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('without a rationale of at least');
    expect(result.stderr).toContain('src/short.ts:1');
  });

  it('fails when a directive has no `--` rationale at all', async () => {
    await writeFixtureFile(
      root,
      'src/no-rationale.ts',
      '// oxlint-disable-next-line complexity\nexport function noop(): void {}\n',
    );
    const result = run(['--root', root, '--max', '5']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('without a rationale of at least');
    expect(result.stderr).toContain('src/no-rationale.ts:1');
  });

  it('counts and validates a block-comment directive', async () => {
    await writeFixtureFile(
      root,
      'src/block.ts',
      `/* oxlint-disable max-lines -- ${RATIONALE_PASS} */\nexport const value = 1;\n`,
    );
    const result = run(['--root', root, '--max', '5']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('OK: 1/5');
  });

  it('counts and validates an oxlint-disable-line (inline suffix) directive', async () => {
    await writeFixtureFile(
      root,
      'src/inline.ts',
      `export const value = 1; // oxlint-disable-line complexity -- ${RATIONALE_PASS}\n`,
    );
    const result = run(['--root', root, '--max', '5']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('OK: 1/5');
  });

  it('fails an oxlint-disable-line directive whose rationale is too short', async () => {
    await writeFixtureFile(
      root,
      'src/inline-short.ts',
      `export const value = 1; // oxlint-disable-line complexity -- ${RATIONALE_SHORT}\n`,
    );
    const result = run(['--root', root, '--max', '5']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('src/inline-short.ts:1');
  });

  it('fails a block-comment directive whose rationale is too short', async () => {
    await writeFixtureFile(
      root,
      'src/block.ts',
      `/* oxlint-disable max-lines -- ${RATIONALE_SHORT} */\nexport const value = 1;\n`,
    );
    const result = run(['--root', root, '--max', '5']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('src/block.ts:1');
  });

  it('strips a leading ID:<token> before measuring rationale length', async () => {
    await writeFixtureFile(
      root,
      'src/id-token-short.ts',
      `// oxlint-disable-next-line complexity -- ID:a-very-long-identifier-token short\nexport function noop(): void {}\n`,
    );
    const result = run(['--root', root, '--max', '5']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('src/id-token-short.ts:1');
  });

  it('passes when an ID:<token> precedes a sufficient rationale', async () => {
    await writeFixtureFile(
      root,
      'src/id-token-ok.ts',
      `// oxlint-disable-next-line complexity -- ID:token ${RATIONALE_PASS}\nexport function noop(): void {}\n`,
    );
    const result = run(['--root', root, '--max', '5']);
    expect(result.exitCode).toBe(0);
  });

  it('excludes .test.ts, .test.tsx, .test.mts, .test.cts files', async () => {
    for (const extension of ['ts', 'tsx', 'mts', 'cts']) {
      await writeFixtureFile(
        root,
        `src/file.test.${extension}`,
        `// oxlint-disable-next-line complexity -- ${RATIONALE_SHORT}\nexport const value = 1;\n`,
      );
    }
    const result = run(['--root', root, '--max', '5']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('OK: 0/5');
  });

  it('excludes .spec.ts, .spec.tsx, .spec.mts, .spec.cts files', async () => {
    for (const extension of ['ts', 'tsx', 'mts', 'cts']) {
      await writeFixtureFile(
        root,
        `src/file.spec.${extension}`,
        `// oxlint-disable-next-line complexity -- ${RATIONALE_SHORT}\nexport const value = 1;\n`,
      );
    }
    const result = run(['--root', root, '--max', '5']);
    expect(result.exitCode).toBe(0);
  });

  it('excludes files under /test/ and /__tests__/', async () => {
    await writeFixtureFile(
      root,
      'src/test/inside.ts',
      `// oxlint-disable-next-line complexity -- ${RATIONALE_SHORT}\nexport const value = 1;\n`,
    );
    await writeFixtureFile(
      root,
      'src/__tests__/inside.ts',
      `// oxlint-disable-next-line complexity -- ${RATIONALE_SHORT}\nexport const value = 1;\n`,
    );
    const result = run(['--root', root, '--max', '5']);
    expect(result.exitCode).toBe(0);
  });

  it('passes with --max 0 on an empty fixture', async () => {
    const result = run(['--root', root, '--max', '0']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('OK: 0/0');
    expect(result.stdout).toContain('effective max = 0 from --max');
  });

  it('fails with --max 0 when even one directive exists', async () => {
    await makeDirective(root, 'src/one.ts', RATIONALE_PASS);
    const result = run(['--root', root, '--max', '0']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Found 1 oxlint-disable directive(s)');
    expect(result.stderr).toContain('ceiling is 0');
  });

  it('applies MAX_DISABLES as the default ceiling when --max is omitted', async () => {
    for (let i = 0; i < MAX_DISABLES; i += 1) {
      await makeDirective(root, `src/file-${i}.ts`, RATIONALE_PASS);
    }
    const okResult = run(['--root', root]);
    expect(okResult.exitCode).toBe(0);
    expect(okResult.stdout).toContain(`OK: ${MAX_DISABLES}/${MAX_DISABLES}`);
    expect(okResult.stdout).toContain('effective max = 5 from default');

    await makeDirective(root, `src/file-${MAX_DISABLES}.ts`, RATIONALE_PASS);
    const failResult = run(['--root', root]);
    expect(failResult.exitCode).toBe(1);
    expect(failResult.stderr).toContain(`Found ${MAX_DISABLES + 1} oxlint-disable directive(s)`);
    expect(failResult.stderr).toContain(`ceiling is ${MAX_DISABLES}`);
  });
});

describe('check-lint-disables --emit-snapshot', () => {
  let root: string;
  let snapshotPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'oxlint-snap-'));
    snapshotPath = join(root, 'snapshot.txt');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes scan-only output and does not enforce a ceiling', async () => {
    for (let i = 0; i < 7; i += 1) {
      await makeDirective(root, `src/file-${i}.ts`, RATIONALE_PASS);
    }
    const result = run(['--root', root, '--emit-snapshot', snapshotPath]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Wrote snapshot of 7 directive(s)');
    const contents = await Bun.file(snapshotPath).text();
    expect(contents.split('\n').filter(Boolean).length).toBe(7);
  });

  it('does not enforce rationale length', async () => {
    await makeDirective(root, 'src/short.ts', RATIONALE_SHORT);
    const result = run(['--root', root, '--emit-snapshot', snapshotPath]);
    expect(result.exitCode).toBe(0);
  });

  it('records the ID token when present, blank when absent', async () => {
    await writeFixtureFile(
      root,
      'src/with-id.ts',
      `// oxlint-disable-next-line complexity -- ID:sample-token-name\nexport const a = 1;\n`,
    );
    await writeFixtureFile(
      root,
      'src/no-id.ts',
      `// oxlint-disable-next-line complexity -- ${RATIONALE_PASS}\nexport const b = 1;\n`,
    );
    const result = run(['--root', root, '--emit-snapshot', snapshotPath]);
    expect(result.exitCode).toBe(0);
    const contents = await Bun.file(snapshotPath).text();
    expect(contents).toContain('sample-token-name\tsrc/with-id.ts\t1');
    expect(contents).toContain('\tsrc/no-id.ts\t1');
  });
});

describe('check-lint-disables constants', () => {
  it('exposes the documented defaults', () => {
    expect(MAX_DISABLES).toBe(5);
    expect(MIN_RATIONALE_LENGTH).toBe(40);
  });
});

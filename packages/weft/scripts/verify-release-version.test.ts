import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { releaseVersionProblem } from './verify-release-version.ts';

const scriptPath = path.join(import.meta.dir, 'verify-release-version.ts');
const packageRoot = path.resolve(import.meta.dir, '..');

describe('releaseVersionProblem', () => {
  test('accepts a VERSION constant that equals package.json', () => {
    expect(releaseVersionProblem({ packageVersion: '0.27.18', exportedVersion: '0.27.18' })).toBe(
      undefined,
    );
  });

  test('names both values when VERSION disagrees with package.json', () => {
    const problem = releaseVersionProblem({
      packageVersion: '0.27.18',
      exportedVersion: '0.27.17',
    });
    expect(problem).toContain('VERSION=0.27.17');
    expect(problem).toContain('package.json=0.27.18');
  });

  test('rejects a package.json with no version', () => {
    expect(releaseVersionProblem({ packageVersion: undefined, exportedVersion: '0.27.18' })).toBe(
      'package.json is missing a version field.',
    );
  });
});

describe('verify-release-version CLI', () => {
  test('passes on the working tree and does not ask for a tag', () => {
    const environment = { ...process.env };
    delete environment['GITHUB_REF_NAME'];
    delete environment['TAG_NAME'];
    const result = Bun.spawnSync(['bun', 'run', scriptPath], {
      cwd: packageRoot,
      env: environment,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('Release version verified');
  });

  test('ignores a tag that disagrees, because a release is no longer tag-triggered', () => {
    const result = Bun.spawnSync(['bun', 'run', scriptPath, '--tag=v0.0.1'], {
      cwd: packageRoot,
      env: { ...process.env, GITHUB_REF_NAME: 'v0.0.2' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
  });

  test('fails when package.json and VERSION disagree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weft-verify-release-'));
    try {
      fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.copyFileSync(scriptPath, path.join(root, 'scripts', 'verify-release-version.ts'));
      fs.writeFileSync(path.join(root, 'src', 'version.ts'), "export const VERSION = '1.0.0';\n");
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.1' }));
      const result = Bun.spawnSync(['bun', 'run', 'scripts/verify-release-version.ts'], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain('VERSION=1.0.0');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

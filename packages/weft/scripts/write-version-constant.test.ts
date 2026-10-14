import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  VersionConstantError,
  updateVersionSource,
  writeVersionConstant,
} from './write-version-constant.ts';

const versionSource = [
  '/**',
  ' * Current Weft package version.',
  ' */',
  "export const VERSION = '0.27.17';",
  '',
].join('\n');

const temporaryDirectories: string[] = [];

function createPackage(options: { version?: string; source?: string }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weft-write-version-'));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, 'packages', 'weft', 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'packages', 'weft', 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'packages', 'weft', 'package.json'),
    JSON.stringify({ name: '@lostgradient/weft', version: options.version }, null, 2),
  );
  fs.writeFileSync(
    path.join(root, 'packages', 'weft', 'src', 'version.ts'),
    options.source ?? versionSource,
  );
  return path.join(root, 'packages', 'weft');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('updateVersionSource', () => {
  test('replaces only the version literal and keeps the surrounding source', () => {
    const updated = updateVersionSource(versionSource, '0.27.18');
    expect(updated).toBe(versionSource.replace('0.27.17', '0.27.18'));
  });

  test('returns the source unchanged when it already holds the version', () => {
    expect(updateVersionSource(versionSource, '0.27.17')).toBe(versionSource);
  });

  test('refuses a source with no version constant', () => {
    expect(() => updateVersionSource('export const OTHER = 1;\n', '1.0.0')).toThrow(
      VersionConstantError,
    );
  });

  test('refuses a source that declares the constant twice', () => {
    expect(() => updateVersionSource(`${versionSource}${versionSource}`, '1.0.0')).toThrow(
      'exactly one',
    );
  });

  test('refuses a version that is not semver', () => {
    expect(() => updateVersionSource(versionSource, "1.0.0'; evil()")).toThrow('semver');
  });
});

describe('writeVersionConstant', () => {
  test('makes VERSION equal the package.json version', () => {
    const packageRoot = createPackage({ version: '0.27.18' });
    expect(writeVersionConstant(packageRoot)).toEqual({ version: '0.27.18', changed: true });
    expect(fs.readFileSync(path.join(packageRoot, 'src', 'version.ts'), 'utf8')).toContain(
      "export const VERSION = '0.27.18';",
    );
  });

  test('reports no change when VERSION already agrees', () => {
    const packageRoot = createPackage({ version: '0.27.17' });
    expect(writeVersionConstant(packageRoot)).toEqual({ version: '0.27.17', changed: false });
  });

  test('refuses a package.json with no version', () => {
    const packageRoot = createPackage({});
    expect(() => writeVersionConstant(packageRoot)).toThrow('missing a version');
  });

  test('the script resolves packages/weft from its own location, not the working directory', () => {
    const packageRoot = createPackage({ version: '0.27.19' });
    const copy = path.join(packageRoot, 'scripts', 'write-version-constant.ts');
    fs.copyFileSync(path.join(import.meta.dir, 'write-version-constant.ts'), copy);
    const unrelated = fs.mkdtempSync(path.join(os.tmpdir(), 'weft-write-version-cwd-'));
    temporaryDirectories.push(unrelated);

    const result = Bun.spawnSync(['bun', copy], { cwd: unrelated, stdout: 'pipe', stderr: 'pipe' });

    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(packageRoot, 'src', 'version.ts'), 'utf8')).toContain(
      "export const VERSION = '0.27.19';",
    );
  });
});

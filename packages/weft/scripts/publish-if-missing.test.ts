import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PublishError,
  publishIfMissing,
  type CommandOptions,
  type CommandResult,
} from './publish-if-missing.ts';

const name = '@lostgradient/weft';
const version = '0.27.18';
const gitHead = '8472c3fe955e92eed8a5a09a05364c70d138a576';
const repositoryRoot = '/repository';
const packageRoot = '/repository/packages/weft';

const viewVersion = `npm view ${name}@${version} version --json`;
const viewGitHead = `npm view ${name}@${version} gitHead`;
const lsRemote = `git ls-remote --tags origin v${version}`;

const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
const failure = (stdout: string, stderr = ''): CommandResult => ({
  exitCode: 1,
  stdout,
  stderr,
});
const notFound = failure(JSON.stringify({ error: { code: 'E404', summary: 'No match found' } }));

interface Call {
  command: string;
  cwd: string;
  environment: Record<string, string> | undefined;
}

function harness(responses: Record<string, CommandResult>) {
  const calls: Call[] = [];
  const lines: string[] = [];
  return {
    calls,
    lines,
    commands: () => calls.map((call) => call.command),
    run: (command: readonly string[], options: CommandOptions): CommandResult => {
      const text = command.join(' ');
      calls.push({ command: text, cwd: options.cwd, environment: options.environment });
      const matched = Object.entries(responses).find(([key]) => text.startsWith(key));
      return matched ? matched[1] : ok();
    },
    options() {
      return {
        packageRoot,
        repositoryRoot,
        name,
        version,
        run: this.run,
        log: (line: string) => lines.push(line),
      };
    },
  };
}

describe('publishIfMissing: version already on npm', () => {
  test('skips the publish and leaves an existing tag alone', async () => {
    const h = harness({
      [viewVersion]: ok(JSON.stringify(version)),
      [lsRemote]: ok(`${gitHead}\trefs/tags/v${version}\n`),
    });

    await publishIfMissing(h.options());

    expect(h.lines).toContain(`${name}@${version} is already on npm; skipping publish`);
    expect(h.commands()).toEqual([viewVersion, lsRemote]);
  });

  test('creates and pushes the missing tag on the commit that published', async () => {
    const h = harness({
      [viewVersion]: ok(JSON.stringify(version)),
      [lsRemote]: ok(''),
      [viewGitHead]: ok(`${gitHead}\n`),
    });

    await publishIfMissing(h.options());

    const commands = h.commands();
    expect(commands.slice(0, 3)).toEqual([viewVersion, lsRemote, viewGitHead]);
    expect(commands[3]).toBe(`git fetch origin ${gitHead}`);
    expect(commands[4]).toContain(`tag -a v${version} -m Weft ${version} ${gitHead}`);
    expect(commands[5]).toBe(`git push origin refs/tags/v${version}`);
    expect(commands).toHaveLength(6);
    expect(commands.some((command) => command.startsWith('npm publish'))).toBe(false);
    expect(h.lines.join('\n')).toContain(gitHead);
  });

  test('warns and exits cleanly when the tag is missing and the registry has no gitHead', async () => {
    const h = harness({
      [viewVersion]: ok(JSON.stringify(version)),
      [lsRemote]: ok(''),
      [viewGitHead]: ok('\n'),
    });

    await publishIfMissing(h.options());

    expect(h.lines.some((line) => line.startsWith('::warning::') && line.includes(version))).toBe(
      true,
    );
    expect(h.commands()).toEqual([viewVersion, lsRemote, viewGitHead]);
  });

  test('fails when the heal itself cannot push the tag', async () => {
    const h = harness({
      [viewVersion]: ok(JSON.stringify(version)),
      [lsRemote]: ok(''),
      [viewGitHead]: ok(gitHead),
      'git push': failure('', 'remote: permission denied'),
    });

    await expect(publishIfMissing(h.options())).rejects.toThrow('permission denied');
  });

  test('refuses a gitHead that is not a commit id', async () => {
    const h = harness({
      [viewVersion]: ok(JSON.stringify(version)),
      [lsRemote]: ok(''),
      [viewGitHead]: ok('--upload-pack=evil'),
    });

    await expect(publishIfMissing(h.options())).rejects.toThrow(PublishError);
    expect(h.commands()).toEqual([viewVersion, lsRemote, viewGitHead]);
  });

  test('fails when git cannot list the remote tags', async () => {
    const h = harness({
      [viewVersion]: ok(JSON.stringify(version)),
      [lsRemote]: failure('', 'fatal: could not read from remote'),
    });

    await expect(publishIfMissing(h.options())).rejects.toThrow('could not read from remote');
  });
});

describe('publishIfMissing: version absent from npm', () => {
  test('verifies, dry-runs, publishes, then tags the checked-out commit', async () => {
    const h = harness({ [viewVersion]: notFound });

    await publishIfMissing(h.options());

    const commands = h.commands();
    expect(commands[0]).toBe(viewVersion);
    expect(commands.slice(1, 5)).toEqual([
      'bun run scripts/verify-release-version.ts',
      'bun run prepack',
      'npm publish --dry-run --ignore-scripts',
      'npm publish --ignore-scripts',
    ]);
    expect(commands[5]).toContain(`tag -a v${version} -m Weft ${version}`);
    expect(commands[5]).not.toContain(gitHead);
    expect(commands[6]).toBe(`git push origin refs/tags/v${version}`);
    expect(commands).toHaveLength(7);
    expect(h.lines.some((line) => line.includes('skipping publish'))).toBe(false);
  });

  test('runs the package commands in the package and the git commands at the repository root', async () => {
    const h = harness({ [viewVersion]: notFound });

    await publishIfMissing(h.options());

    for (const call of h.calls) {
      const isGit = call.command.startsWith('git ');
      expect(call.cwd).toBe(isGit ? repositoryRoot : packageRoot);
    }
  });

  test('keeps provenance off the dry run, exactly as the previous publish job did', async () => {
    const h = harness({ [viewVersion]: notFound });

    await publishIfMissing(h.options());

    const dryRun = h.calls.find(
      (call) => call.command === 'npm publish --dry-run --ignore-scripts',
    );
    const publish = h.calls.find((call) => call.command === 'npm publish --ignore-scripts');
    expect(dryRun?.environment).toEqual({ NPM_CONFIG_PROVENANCE: 'false' });
    expect(publish?.environment).toBeUndefined();
  });

  test('stops before publishing when the version check fails', async () => {
    const h = harness({
      [viewVersion]: notFound,
      'bun run scripts/verify-release-version.ts': failure('', 'Version mismatch'),
    });

    await expect(publishIfMissing(h.options())).rejects.toThrow('Version mismatch');
    expect(h.commands().some((command) => command.startsWith('npm publish'))).toBe(false);
  });

  test('never publishes when the dry run fails', async () => {
    const h = harness({
      [viewVersion]: notFound,
      'npm publish --dry-run': failure('', 'EPUBLISHCONFLICT'),
    });

    await expect(publishIfMissing(h.options())).rejects.toThrow('EPUBLISHCONFLICT');
    expect(h.commands()).not.toContain('npm publish --ignore-scripts');
  });

  test('does not tag a version whose publish failed', async () => {
    const h = harness({
      [viewVersion]: notFound,
      'npm publish --ignore-scripts': failure('', 'E403 forbidden'),
    });

    await expect(publishIfMissing(h.options())).rejects.toThrow('E403');
    expect(h.commands().some((command) => command.startsWith('git'))).toBe(false);
  });

  test('leaves a failed tag push to the next run, which heals it from gitHead', async () => {
    const h = harness({
      [viewVersion]: notFound,
      'git push': failure('', 'remote: rejected'),
    });

    await expect(publishIfMissing(h.options())).rejects.toThrow('rejected');
    expect(h.commands()).toContain('npm publish --ignore-scripts');
  });
});

describe('publishIfMissing: registry error', () => {
  test('fails on a registry error that is not a 404, without publishing or tagging', async () => {
    const h = harness({
      [viewVersion]: failure(
        JSON.stringify({ error: { code: 'E503', summary: 'Service Unavailable' } }),
        'npm error code E503',
      ),
    });

    await expect(publishIfMissing(h.options())).rejects.toThrow('E503');
    expect(h.commands()).toEqual([viewVersion]);
  });

  test('fails on a failure that prints no parseable error', async () => {
    const h = harness({ [viewVersion]: failure('', 'getaddrinfo ENOTFOUND registry.npmjs.org') });

    await expect(publishIfMissing(h.options())).rejects.toThrow('ENOTFOUND');
    expect(h.commands()).toEqual([viewVersion]);
  });

  test('fails when a successful lookup answers with a different version', async () => {
    const h = harness({ [viewVersion]: ok(JSON.stringify('9.9.9')) });

    await expect(publishIfMissing(h.options())).rejects.toThrow('unexpected');
    expect(h.commands()).toEqual([viewVersion]);
  });
});

describe('publish-if-missing CLI', () => {
  const temporaryDirectories: string[] = [];
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('exits non-zero with the message when package.json has no version', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weft-publish-if-missing-'));
    temporaryDirectories.push(root);
    const scripts = path.join(root, 'packages', 'weft', 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(root, 'packages', 'weft', 'package.json'), JSON.stringify({ name }));
    const copy = path.join(scripts, 'publish-if-missing.ts');
    fs.copyFileSync(path.join(import.meta.dir, 'publish-if-missing.ts'), copy);

    const result = Bun.spawnSync(['bun', copy], {
      cwd: os.tmpdir(),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('missing a name or version');
  });
});

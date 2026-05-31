import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  completionInstallPath,
  executeCompletions,
  generateCompletionScript,
} from './completions.ts';

describe('generateCompletionScript', () => {
  it('emits a zsh completion script referencing weft commands', () => {
    const script = generateCompletionScript('zsh');
    expect(script).toContain('#compdef weft');
    expect(script).toContain('workflow');
    expect(script).toContain('server');
    expect(script).toContain('tail');
  });

  it('emits a bash completion script', () => {
    const script = generateCompletionScript('bash');
    expect(script).toContain('complete -F _weft_completions weft');
    expect(script).toContain('workflow)');
  });

  it('emits a fish completion script', () => {
    const script = generateCompletionScript('fish');
    expect(script).toContain('complete -c weft');
    expect(script).toContain('__fish_seen_subcommand_from workflow');
  });
});

describe('executeCompletions', () => {
  it('generate prints the script to stdout', async () => {
    const result = await executeCompletions({
      command: 'completions',
      action: 'generate',
      shell: 'zsh',
      help: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('#compdef weft');
  });

  it('install writes the script to a per-shell path', async () => {
    const home = await mkdtemp(join(tmpdir(), 'weft-completions-'));
    const priorHome = Bun.env['HOME'];
    Bun.env['HOME'] = home;
    try {
      const result = await executeCompletions({
        command: 'completions',
        action: 'install',
        shell: 'fish',
        help: false,
      });
      expect(result.exitCode).toBe(0);
      const expectedPath = completionInstallPath('fish');
      expect(result.stdout).toContain(expectedPath);
      const written = await readFile(expectedPath, 'utf8');
      expect(written).toContain('complete -c weft');
    } finally {
      if (priorHome === undefined) delete Bun.env['HOME'];
      else Bun.env['HOME'] = priorHome;
    }
  });

  it('install reports shell-specific activation hints', async () => {
    const home = await mkdtemp(join(tmpdir(), 'weft-completions-shell-'));
    const priorHome = Bun.env['HOME'];
    Bun.env['HOME'] = home;
    try {
      const zsh = await executeCompletions({
        command: 'completions',
        action: 'install',
        shell: 'zsh',
        help: false,
      });
      expect(zsh.stdout).toContain('autoload -U compinit && compinit');

      const bash = await executeCompletions({
        command: 'completions',
        action: 'install',
        shell: 'bash',
        help: false,
      });
      expect(bash.stdout).toContain('source ');
    } finally {
      if (priorHome === undefined) delete Bun.env['HOME'];
      else Bun.env['HOME'] = priorHome;
    }
  });

  it('returns a write error when the completion directory cannot be created', async () => {
    const sandboxRoot = await mkdtemp(join(tmpdir(), 'weft-completions-error-'));
    const fakeHome = join(sandboxRoot, 'home-file');
    await Bun.write(fakeHome, 'not a directory');

    const priorHome = Bun.env['HOME'];
    Bun.env['HOME'] = fakeHome;
    try {
      const result = await executeCompletions({
        command: 'completions',
        action: 'install',
        shell: 'zsh',
        help: false,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('failed to write');
    } finally {
      if (priorHome === undefined) delete Bun.env['HOME'];
      else Bun.env['HOME'] = priorHome;
    }
  });
});

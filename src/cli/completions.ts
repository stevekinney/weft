/**
 * `weft completions generate|install --shell zsh|bash|fish` — emit or install a
 * shell completion script for the `weft` CLI.
 *
 * `generate` prints the script to stdout (pipe it into your shell config).
 * `install` writes it to the conventional per-shell completion directory and
 * prints the path plus any one-time activation step.
 *
 * @module cli/completions
 */

import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { CommandOutput, CompletionShell, CompletionsCommand } from './types.ts';

function homeDirectory(): string {
  return Bun.env['HOME'] ?? homedir();
}

/** Top-level commands offered for completion. */
const TOP_LEVEL_COMMANDS = [
  'serve',
  'doctor',
  'conformance',
  'schedule',
  'timeline',
  'version:check',
  'validate',
  'codegen',
  'api',
  'server',
  'workflow',
  'tail',
  'completions',
] as const;

/** Subcommands keyed by noun, for nested completion. */
const SUBCOMMANDS: Readonly<Record<string, ReadonlyArray<string>>> = {
  server: ['health', 'info'],
  workflow: ['ls', 'get', 'events', 'start', 'cancel', 'signal'],
  schedule: ['list', 'create', 'pause', 'resume', 'cancel'],
  completions: ['generate', 'install'],
};

/** Generate the completion script for the requested shell. */
export function generateCompletionScript(shell: CompletionShell): string {
  if (shell === 'zsh') return zshScript();
  if (shell === 'bash') return bashScript();
  return fishScript();
}

function zshScript(): string {
  const commands = TOP_LEVEL_COMMANDS.join(' ');
  const subcases = Object.entries(SUBCOMMANDS)
    .map(([noun, subs]) => `        ${noun}) _values 'subcommand' ${subs.join(' ')} ;;`)
    .join('\n');
  return `#compdef weft
_weft() {
  local -a commands
  commands=(${commands})
  if (( CURRENT == 2 )); then
    _values 'command' \${commands[@]}
    return
  fi
  case "\${words[2]}" in
${subcases}
  esac
}
_weft "$@"
`;
}

function bashScript(): string {
  const commands = TOP_LEVEL_COMMANDS.join(' ');
  const subcases = Object.entries(SUBCOMMANDS)
    .map(
      ([noun, subs]) =>
        `      ${noun}) COMPREPLY=( $(compgen -W "${subs.join(' ')}" -- "$cur") ) ;;`,
    )
    .join('\n');
  return `# bash completion for weft
_weft_completions() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${commands}" -- "$cur") )
    return
  fi
  case "\${COMP_WORDS[1]}" in
${subcases}
  esac
}
complete -F _weft_completions weft
`;
}

function fishScript(): string {
  const topLevel = TOP_LEVEL_COMMANDS.map(
    (command) => `complete -c weft -n '__fish_use_subcommand' -a '${command}'`,
  ).join('\n');
  const nested = Object.entries(SUBCOMMANDS)
    .flatMap(([noun, subs]) =>
      subs.map((sub) => `complete -c weft -n '__fish_seen_subcommand_from ${noun}' -a '${sub}'`),
    )
    .join('\n');
  return `# fish completion for weft
${topLevel}
${nested}
`;
}

/** Conventional install path for each shell's completion script. */
export function completionInstallPath(shell: CompletionShell): string {
  const home = homeDirectory();
  if (shell === 'zsh') return join(home, '.zsh', 'completions', '_weft');
  if (shell === 'bash') return join(home, '.bash_completion.d', 'weft');
  return join(home, '.config', 'fish', 'completions', 'weft.fish');
}

function activationHint(shell: CompletionShell, path: string): string {
  if (shell === 'zsh') {
    return `Add 'fpath=(~/.zsh/completions $fpath)' and 'autoload -U compinit && compinit' to ~/.zshrc, then restart your shell.`;
  }
  if (shell === 'bash') {
    return `Add 'source ${path}' to ~/.bashrc, then restart your shell.`;
  }
  return 'Fish loads completions from this directory automatically; restart your shell.';
}

/** Execute `weft completions generate|install`. */
export async function executeCompletions(command: CompletionsCommand): Promise<CommandOutput> {
  const script = generateCompletionScript(command.shell);

  if (command.action === 'generate') {
    return { stdout: script, exitCode: 0 };
  }

  const path = completionInstallPath(command.shell);
  try {
    await mkdir(join(path, '..'), { recursive: true });
    await Bun.write(path, script);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { stdout: '', stderr: `completions: failed to write ${path}: ${message}`, exitCode: 1 };
  }

  return {
    stdout: `Installed ${command.shell} completions to ${path}\n${activationHint(command.shell, path)}`,
    exitCode: 0,
  };
}

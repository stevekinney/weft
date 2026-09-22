/**
 * Argument parsers for the hand-authored, server-facing noun-verb commands:
 * `server`, `workflow`, `tail`, and `completions`. Each returns a typed
 * {@link CliCommand} variant consumed by `cli-main.ts`.
 *
 * @module cli/noun-verb-arguments
 */

import { parseArgs } from 'node:util';

import type { CliCommand, CompletionShell } from './types.ts';

const DEFAULT_WAIT_TIMEOUT_MS = 30000;
const VALID_COMPLETION_SHELLS = new Set(['zsh', 'bash', 'fish']);

const CONNECTION_OPTIONS = {
  server: { type: 'string' },
  token: { type: 'string' },
  profile: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
  json: { type: 'boolean', short: 'j', default: false },
  quiet: { type: 'boolean', short: 'q', default: false },
} as const;

function parsePositiveInteger(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

/** Parse `weft server health|info`. */
export function parseServerArguments(args: string[]): CliCommand {
  const { values, positionals } = parseArgs({
    args,
    options: {
      ...CONNECTION_OPTIONS,
      wait: { type: 'boolean', default: false },
      'wait-timeout': { type: 'string' },
    },
    strict: true,
    allowPositionals: true,
  });

  const action = positionals[0] ?? (values.help ? 'health' : undefined);
  if (action !== 'health' && action !== 'info') {
    throw new Error('server: expected a subcommand: health or info');
  }
  const waitTimeoutMs =
    parsePositiveInteger(values['wait-timeout'], '--wait-timeout') ?? DEFAULT_WAIT_TIMEOUT_MS;

  return {
    command: 'server',
    action,
    ...connectionFields(values),
    wait: values.wait ?? false,
    waitTimeoutMs,
  };
}

/** Parse `weft workflow ls|get|events|start|cancel|signal`. */
type WorkflowValues = ReturnType<typeof parseWorkflowValues>['values'];

function parseWorkflowValues(args: string[]) {
  return parseArgs({
    args,
    options: {
      ...CONNECTION_OPTIONS,
      type: { type: 'string' },
      status: { type: 'string' },
      limit: { type: 'string' },
      input: { type: 'string' },
      'input-file': { type: 'string' },
      id: { type: 'string' },
      yes: { type: 'boolean', short: 'y', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: true,
  });
}

function connectionFields(
  values: Pick<WorkflowValues, 'server' | 'token' | 'profile' | 'help' | 'json' | 'quiet'>,
) {
  return {
    ...(values.server !== undefined ? { server: values.server } : {}),
    ...(values.token !== undefined ? { token: values.token } : {}),
    ...(values.profile !== undefined ? { profile: values.profile } : {}),
    help: values.help ?? false,
    json: values.json ?? false,
    quiet: values.quiet ?? false,
  } as const;
}

const WORKFLOW_ACTION_BUILDERS: Record<
  string,
  (values: WorkflowValues, rest: string[]) => CliCommand
> = {
  ls: (values) => {
    const limit = parsePositiveInteger(values.limit, '--limit');
    return {
      command: 'workflow',
      action: 'ls',
      ...connectionFields(values),
      ...(values.type !== undefined ? { type: values.type } : {}),
      ...(values.status !== undefined ? { status: values.status } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
  },
  get: (values, rest) => buildWorkflowGetOrEvents('get', values, rest),
  events: (values, rest) => buildWorkflowGetOrEvents('events', values, rest),
  start: (values, rest) => ({
    command: 'workflow',
    action: 'start',
    ...connectionFields(values),
    workflowType: requirePositional(rest[0], 'workflow start', '<workflow-type>'),
    ...(values.input !== undefined ? { input: values.input } : {}),
    ...(values['input-file'] !== undefined ? { inputFile: values['input-file'] } : {}),
    ...(values.id !== undefined ? { id: values.id } : {}),
  }),
  cancel: (values, rest) => ({
    command: 'workflow',
    action: 'cancel',
    ...connectionFields(values),
    workflowId: requirePositional(rest[0], 'workflow cancel', '<workflow-id>'),
    yes: values.yes ?? false,
    dryRun: values['dry-run'] ?? false,
  }),
  signal: (values, rest) => ({
    command: 'workflow',
    action: 'signal',
    ...connectionFields(values),
    workflowId: requirePositional(rest[0], 'workflow signal', '<workflow-id> <signal-name>'),
    signalName: requirePositional(rest[1], 'workflow signal', '<workflow-id> <signal-name>'),
    ...(values.input !== undefined ? { input: values.input } : {}),
    ...(values['input-file'] !== undefined ? { inputFile: values['input-file'] } : {}),
  }),
};

function buildWorkflowGetOrEvents(
  action: 'get' | 'events',
  values: WorkflowValues,
  rest: string[],
): CliCommand {
  return {
    command: 'workflow',
    action,
    ...connectionFields(values),
    workflowId: requirePositional(rest[0], `workflow ${action}`, '<workflow-id>'),
  };
}

export function parseWorkflowArguments(args: string[]): CliCommand {
  const { values, positionals } = parseWorkflowValues(args);
  if (values.input !== undefined && values['input-file'] !== undefined) {
    throw new Error('workflow: --input and --input-file cannot be used together');
  }

  const action = positionals[0] ?? (values.help ? 'ls' : '');
  const builder = WORKFLOW_ACTION_BUILDERS[action];
  if (builder === undefined) {
    throw new Error('workflow: expected a subcommand: ls, get, events, start, cancel, or signal');
  }
  // When --help is requested, skip required-positional validation — help text
  // is shown before the command executes. Use 'ls' (no required positionals)
  // as the action placeholder regardless of what the user typed.
  if (values.help) {
    return { command: 'workflow', action: 'ls', ...connectionFields(values) };
  }
  return builder(values, positionals.slice(1));
}

/** Parse `weft tail [workflow-id]`. */
export function parseTailArguments(args: string[]): CliCommand {
  const { values, positionals } = parseArgs({
    args,
    options: CONNECTION_OPTIONS,
    strict: true,
    allowPositionals: true,
  });

  return {
    command: 'tail',
    ...connectionFields(values),
    ...(positionals[0] !== undefined ? { workflowId: positionals[0] } : {}),
  };
}

function isCompletionShell(value: string): value is CompletionShell {
  return VALID_COMPLETION_SHELLS.has(value);
}

/**
 * Resolve and validate the `--shell` value for completions.
 * When `isHelp` is true, validation is skipped and a sensible default is used
 * because the shell value is irrelevant when showing help text.
 */
function resolveCompletionShell(rawShell: string | undefined, isHelp: boolean): CompletionShell {
  if (isHelp) {
    return rawShell !== undefined && isCompletionShell(rawShell) ? rawShell : 'zsh';
  }
  if (rawShell === undefined) {
    throw new Error('completions: --shell is required (zsh, bash, or fish)');
  }
  if (!isCompletionShell(rawShell)) {
    throw new Error(
      `completions: unsupported shell '${rawShell}'. Must be one of: zsh, bash, fish`,
    );
  }
  return rawShell;
}

/** Parse `weft completions generate|install --shell <shell>`. */
export function parseCompletionsArguments(args: string[]): CliCommand {
  const { values, positionals } = parseArgs({
    args,
    options: {
      shell: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  const isHelp = values.help ?? false;
  const action = positionals[0] ?? (isHelp ? 'generate' : undefined);
  if (action !== 'generate' && action !== 'install') {
    throw new Error('completions: expected a subcommand: generate or install');
  }

  const shell = resolveCompletionShell(values.shell, isHelp);
  return { command: 'completions', action, shell, help: isHelp };
}

function requirePositional(value: string | undefined, command: string, usage: string): string {
  if (value === undefined || value === '') {
    throw new Error(`${command}: missing required argument. Usage: weft ${command} ${usage}`);
  }
  return value;
}

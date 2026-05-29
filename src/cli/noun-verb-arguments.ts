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

function optionalField<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): Record<Key, Value> | Record<string, never> {
  // The computed-key object is a known single-entry record; the cast narrows
  // the inferred index signature back to the precise `Record<Key, Value>`.
  return value === undefined ? {} : ({ [key]: value } as Record<Key, Value>);
}

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
    ...optionalField('server', values.server),
    ...optionalField('token', values.token),
    ...optionalField('profile', values.profile),
    wait: values.wait ?? false,
    waitTimeoutMs,
    help: values.help ?? false,
    json: values.json ?? false,
    quiet: values.quiet ?? false,
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

function workflowConnectionFields(values: WorkflowValues) {
  return {
    ...optionalField('server', values.server),
    ...optionalField('token', values.token),
    ...optionalField('profile', values.profile),
    help: values.help ?? false,
    json: values.json ?? false,
    quiet: values.quiet ?? false,
  } as const;
}

const WORKFLOW_ACTION_BUILDERS: Record<
  string,
  (values: WorkflowValues, rest: string[]) => CliCommand
> = {
  ls: (values) => ({
    command: 'workflow',
    action: 'ls',
    ...workflowConnectionFields(values),
    ...optionalField('type', values.type),
    ...optionalField('status', values.status),
    ...optionalField('limit', parsePositiveInteger(values.limit, '--limit')),
  }),
  get: (values, rest) => buildWorkflowGetOrEvents('get', values, rest),
  events: (values, rest) => buildWorkflowGetOrEvents('events', values, rest),
  start: (values, rest) => ({
    command: 'workflow',
    action: 'start',
    ...workflowConnectionFields(values),
    workflowType: requirePositional(rest[0], 'workflow start', '<workflow-type>'),
    ...optionalField('input', values.input),
    ...optionalField('inputFile', values['input-file']),
    ...optionalField('id', values.id),
  }),
  cancel: (values, rest) => ({
    command: 'workflow',
    action: 'cancel',
    ...workflowConnectionFields(values),
    workflowId: requirePositional(rest[0], 'workflow cancel', '<workflow-id>'),
    yes: values.yes ?? false,
    dryRun: values['dry-run'] ?? false,
  }),
  signal: (values, rest) => ({
    command: 'workflow',
    action: 'signal',
    ...workflowConnectionFields(values),
    workflowId: requirePositional(rest[0], 'workflow signal', '<workflow-id> <signal-name>'),
    signalName: requirePositional(rest[1], 'workflow signal', '<workflow-id> <signal-name>'),
    ...optionalField('input', values.input),
    ...optionalField('inputFile', values['input-file']),
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
    ...workflowConnectionFields(values),
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
  return builder(values, positionals.slice(1));
}

/** Parse `weft tail [workflow-id]`. */
export function parseTailArguments(args: string[]): CliCommand {
  const { values, positionals } = parseArgs({
    args,
    options: {
      server: { type: 'string' },
      token: { type: 'string' },
      profile: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      quiet: { type: 'boolean', short: 'q', default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  return {
    command: 'tail',
    ...optionalField('server', values.server),
    ...optionalField('token', values.token),
    ...optionalField('profile', values.profile),
    ...optionalField('workflowId', positionals[0]),
    help: values.help ?? false,
    json: values.json ?? false,
    quiet: values.quiet ?? false,
  };
}

function isCompletionShell(value: string): value is CompletionShell {
  return VALID_COMPLETION_SHELLS.has(value);
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

  const action = positionals[0] ?? (values.help ? 'generate' : undefined);
  if (action !== 'generate' && action !== 'install') {
    throw new Error('completions: expected a subcommand: generate or install');
  }

  const shellValue = values.shell;
  if (shellValue === undefined) {
    throw new Error('completions: --shell is required (zsh, bash, or fish)');
  }
  if (!isCompletionShell(shellValue)) {
    throw new Error(
      `completions: unsupported shell '${shellValue}'. Must be one of: zsh, bash, fish`,
    );
  }

  return {
    command: 'completions',
    action,
    shell: shellValue,
    help: values.help ?? false,
  };
}

function requirePositional(value: string | undefined, command: string, usage: string): string {
  if (value === undefined || value === '') {
    throw new Error(`${command}: missing required argument. Usage: weft ${command} ${usage}`);
  }
  return value;
}

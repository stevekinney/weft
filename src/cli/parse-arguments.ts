import { parseArgs } from 'node:util';

import type { ScheduleOverlapPolicy } from '../core/types.ts';
import { parseApiArguments } from './api-arguments.ts';
import { parseCodegenArguments } from './codegen-arguments.ts';
import { formatUnknownCommandError } from './command-suggestions.ts';
import type {
  CliCommand,
  PersistentStorageBackend,
  ScheduleAction,
  ScheduleCreateCommand,
  ScheduleListCommand,
  ScheduleMutationCommand,
  StorageBackend,
} from './types.ts';

const KNOWN_SUBCOMMANDS = new Set([
  'serve',
  'doctor',
  'version:check',
  'validate',
  'conformance',
  'timeline',
  'schedule',
  'codegen',
  'api',
]);
const FLAG_VALUE_OPTIONS = new Set([
  '-p',
  '-d',
  '-s',
  '-w',
  '-o',
  '--port',
  '--database',
  '--storage',
  '--workflows',
  '--timeout',
  '--server',
  '--from',
  '--token',
  '--out',
  '--input',
  '--input-file',
  '--profile',
]);
const VALID_STORAGE_BACKENDS = new Set(['sqlite', 'lmdb', 'memory']);
const SCHEDULE_ACTIONS = new Set(['list', 'create', 'pause', 'resume', 'cancel']);
const VALID_SCHEDULE_OVERLAP_POLICIES = new Set(['skip', 'queue', 'cancel-running', 'allow']);

const SUBCOMMAND_PARSERS: Record<string, (args: string[]) => CliCommand> = {
  serve: parseServeArguments,
  doctor: parseDoctorArguments,
  'version:check': parseVersionCheckArguments,
  validate: parseValidateArguments,
  conformance: parseConformanceArguments,
  timeline: parseTimelineArguments,
  schedule: parseScheduleArguments,
  codegen: parseCodegenArguments,
  api: parseApiArguments,
};

const KNOWN_SUBCOMMAND_LIST = [...KNOWN_SUBCOMMANDS];

type ParsedSubcommand = {
  subcommand?: string;
  subcommandIndex: number;
};

function findSubcommand(args: string[]): ParsedSubcommand {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg.startsWith('-')) {
      if (FLAG_VALUE_OPTIONS.has(arg)) {
        index++;
      }
      continue;
    }

    if (KNOWN_SUBCOMMANDS.has(arg)) {
      return { subcommand: arg, subcommandIndex: index };
    }

    throw new Error(formatUnknownCommandError(arg, KNOWN_SUBCOMMAND_LIST));
  }

  return { subcommandIndex: -1 };
}

function removeSubcommand(args: string[], subcommandIndex: number): string[] {
  return subcommandIndex >= 0
    ? [...args.slice(0, subcommandIndex), ...args.slice(subcommandIndex + 1)]
    : args;
}

/** Parses raw CLI arguments into a command object for the runner. */
export function parseCliArguments(args: string[]): CliCommand {
  const { subcommand, subcommandIndex } = findSubcommand(args);
  const remainingArgs = removeSubcommand(args, subcommandIndex);
  const parser = SUBCOMMAND_PARSERS[subcommand ?? ''];
  return parser ? parser(remainingArgs) : parseServeArguments(remainingArgs);
}

function isValidStorageBackend(value: string): value is StorageBackend {
  return VALID_STORAGE_BACKENDS.has(value);
}

function parseStorageBackend(value: string | undefined): StorageBackend {
  const storageValue = value ?? 'sqlite';

  if (!isValidStorageBackend(storageValue)) {
    throw new Error(
      `Invalid storage backend '${storageValue}'. Must be one of: sqlite, lmdb, memory`,
    );
  }

  return storageValue;
}

function parsePersistentStorageBackend(value: string | undefined): PersistentStorageBackend {
  const storageValue = parseStorageBackend(value);

  if (storageValue === 'memory') {
    throw new Error(
      "Invalid storage backend 'memory'. Schedule commands support only sqlite and lmdb because data must persist across CLI invocations",
    );
  }

  return storageValue;
}

function parseServeArguments(args: string[]): CliCommand {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string', short: 'p', default: '7233' },
      database: { type: 'string', short: 'd', default: './weft.db' },
      storage: { type: 'string', short: 's', default: 'sqlite' },
      ui: { type: 'boolean', default: true },
      help: { type: 'boolean', short: 'h', default: false },
      workflows: { type: 'string', short: 'w' },
    },
    strict: true,
    allowPositionals: false,
    allowNegative: true,
  });

  if (values.workflows === '') {
    throw new Error('--workflows must be a non-empty path');
  }

  return {
    command: 'serve',
    port: values.port ?? '7233',
    database: values.database ?? './weft.db',
    storage: parseStorageBackend(values.storage),
    ui: values.ui ?? true,
    help: values.help ?? false,
    ...(values.workflows ? { workflows: values.workflows } : {}),
  };
}

function parseDoctorArguments(args: string[]): CliCommand {
  const { values } = parseArgs({
    args,
    options: {
      database: { type: 'string', short: 'd', default: './weft.db' },
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  return {
    command: 'doctor',
    database: values.database ?? './weft.db',
    help: values.help ?? false,
    json: values.json ?? false,
  };
}

function parseVersionCheckArguments(args: string[]): CliCommand {
  const { values } = parseArgs({
    args,
    options: {
      database: { type: 'string', short: 'd', default: './weft.db' },
      workflows: { type: 'string', short: 'w', default: '' },
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  return {
    command: 'version:check',
    database: values.database ?? './weft.db',
    workflows: values.workflows ?? '',
    help: values.help ?? false,
    json: values.json ?? false,
  };
}

function parseValidateArguments(args: string[]): CliCommand {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  return {
    command: 'validate',
    entryPaths: positionals,
    help: values.help ?? false,
    json: values.json ?? false,
  };
}

function parseConformanceTimeout(value: string | undefined): number {
  const timeoutText = value ?? '15000';
  const timeoutMs = Number(timeoutText);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('--timeout must be a positive integer number of milliseconds');
  }
  return timeoutMs;
}

function parseConformanceArguments(args: string[]): CliCommand {
  const separatorIndex = args.indexOf('--');
  const optionArgs = separatorIndex === -1 ? args : args.slice(0, separatorIndex);
  const workerCommand = separatorIndex === -1 ? [] : args.slice(separatorIndex + 1);

  const { values } = parseArgs({
    args: optionArgs,
    options: {
      timeout: { type: 'string', default: '15000' },
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  return {
    command: 'conformance',
    timeoutMs: parseConformanceTimeout(values.timeout),
    help: values.help ?? false,
    json: values.json ?? false,
    workerCommand,
  };
}

function parseTimelineStep(value: string, flagName: string): number {
  const step = Number(value);
  if (!Number.isSafeInteger(step) || step < 0) {
    throw new Error(`${flagName} must be a non-negative integer`);
  }
  return step;
}

function parseOptionalTimelineStep(value: string | undefined): number | undefined {
  return value !== undefined ? parseTimelineStep(value, '--step') : undefined;
}

function parseTimelineDiff(
  enabled: boolean | undefined,
  positionals: string[],
): [number, number] | undefined {
  if (!enabled) {
    return undefined;
  }

  const fromStep = positionals[1];
  const toStep = positionals[2];
  if (fromStep === undefined || toStep === undefined) {
    throw new Error('--diff requires two step numbers');
  }

  return [parseTimelineStep(fromStep, '--diff'), parseTimelineStep(toStep, '--diff')];
}

function parseTimelineArguments(args: string[]): CliCommand {
  const { values, positionals } = parseArgs({
    args,
    options: {
      database: { type: 'string', short: 'd', default: './weft.db' },
      step: { type: 'string' },
      diff: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  const step = parseOptionalTimelineStep(values.step);
  const diff = parseTimelineDiff(values.diff, positionals);

  if (step !== undefined && diff !== undefined) {
    throw new Error('--step and --diff cannot be used together');
  }

  return {
    command: 'timeline',
    database: values.database ?? './weft.db',
    workflowId: positionals[0] ?? '',
    ...(step !== undefined ? { step } : {}),
    ...(diff !== undefined ? { diff } : {}),
    help: values.help ?? false,
  };
}

function parseScheduleCliValues(args: string[]) {
  return parseArgs({
    args,
    options: {
      database: { type: 'string', short: 'd', default: './weft.db' },
      storage: { type: 'string', short: 's', default: 'sqlite' },
      workflows: { type: 'string', short: 'w', default: '' },
      input: { type: 'string', default: 'null' },
      id: { type: 'string' },
      overlap: { type: 'string' },
      backfill: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
    },
    strict: true,
    allowPositionals: true,
  });
}

function isScheduleOverlapPolicy(value: string): value is ScheduleOverlapPolicy {
  return VALID_SCHEDULE_OVERLAP_POLICIES.has(value);
}

function parseScheduleOverlapPolicy(value: string | undefined): ScheduleOverlapPolicy | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isScheduleOverlapPolicy(value)) {
    throw new Error(
      `Invalid overlap policy '${value}'. Must be one of: skip, queue, cancel-running, allow`,
    );
  }

  return value;
}

function buildScheduleListCommand(
  values: ReturnType<typeof parseScheduleCliValues>['values'],
): ScheduleListCommand {
  return {
    command: 'schedule',
    action: 'list',
    database: values.database ?? './weft.db',
    storage: parsePersistentStorageBackend(values.storage),
    help: values.help ?? false,
    json: values.json ?? false,
  };
}

function buildScheduleHelpCommand(
  values: ReturnType<typeof parseScheduleCliValues>['values'],
): ScheduleListCommand {
  return {
    command: 'schedule',
    action: 'list',
    database: values.database ?? './weft.db',
    storage: 'sqlite',
    help: true,
    json: values.json ?? false,
  };
}

function defaultString(value: string | undefined, fallback: string): string {
  return value ?? fallback;
}

function defaultBoolean(value: boolean | undefined): boolean {
  return value ?? false;
}

function formatScheduleActionList(): string {
  return [...SCHEDULE_ACTIONS].join(', ');
}

function assertExactSchedulePositionals(
  action: string,
  positionals: string[],
  count: number,
  usage: string,
): void {
  if (positionals.length === count) {
    return;
  }

  const noun = count === 1 ? 'positional argument' : 'positional arguments';
  throw new Error(`schedule ${action} expects exactly ${count} ${noun}: ${usage}`);
}

function isScheduleAction(value: string): value is ScheduleAction {
  return SCHEDULE_ACTIONS.has(value);
}

function requireScheduleAction(positionals: string[]): ScheduleAction {
  const action = positionals[0];
  if (action === undefined) {
    throw new Error(`Missing schedule action. Expected one of: ${formatScheduleActionList()}`);
  }

  if (!isScheduleAction(action)) {
    throw new Error(
      `Unknown schedule action "${action}". Expected one of: ${formatScheduleActionList()}`,
    );
  }

  return action;
}

function buildScheduleCreateOptionalFields(
  values: ReturnType<typeof parseScheduleCliValues>['values'],
): Partial<Pick<ScheduleCreateCommand, 'id' | 'overlap'>> {
  const overlap = parseScheduleOverlapPolicy(values.overlap);

  return {
    ...(values.id !== undefined ? { id: values.id } : {}),
    ...(overlap !== undefined ? { overlap } : {}),
  };
}

function buildScheduleCreateCommand(
  values: ReturnType<typeof parseScheduleCliValues>['values'],
  positionals: string[],
): ScheduleCreateCommand {
  return {
    command: 'schedule',
    action: 'create',
    database: defaultString(values.database, './weft.db'),
    storage: parsePersistentStorageBackend(values.storage),
    workflows: defaultString(values.workflows, ''),
    workflowType: defaultString(positionals[0], ''),
    cronExpression: defaultString(positionals[1], ''),
    input: defaultString(values.input, 'null'),
    ...buildScheduleCreateOptionalFields(values),
    backfill: defaultBoolean(values.backfill),
    help: defaultBoolean(values.help),
    json: defaultBoolean(values.json),
  };
}

function buildScheduleMutationCommand(
  action: ScheduleMutationCommand['action'],
  values: ReturnType<typeof parseScheduleCliValues>['values'],
  positionals: string[],
): ScheduleMutationCommand {
  return {
    command: 'schedule',
    action,
    database: values.database ?? './weft.db',
    storage: parsePersistentStorageBackend(values.storage),
    scheduleId: positionals[0] ?? '',
    help: values.help ?? false,
    json: values.json ?? false,
  };
}

function parseScheduleArguments(args: string[]): CliCommand {
  const { values, positionals } = parseScheduleCliValues(args);
  if (values.help) {
    return buildScheduleHelpCommand(values);
  }

  const action = requireScheduleAction(positionals);
  const actionPositionals = positionals.slice(1);

  if (action === 'create') {
    assertExactSchedulePositionals(action, actionPositionals, 2, '<workflowType> <cronExpression>');
    return buildScheduleCreateCommand(values, actionPositionals);
  }

  if (action === 'pause' || action === 'resume' || action === 'cancel') {
    assertExactSchedulePositionals(action, actionPositionals, 1, '<scheduleId>');
    return buildScheduleMutationCommand(action, values, actionPositionals);
  }

  if (actionPositionals.length > 0) {
    throw new Error('schedule list does not accept positional arguments');
  }

  return buildScheduleListCommand(values);
}

import { parseArgs } from 'node:util';

import { parseApiArguments } from './api-arguments.ts';
import { parseCodegenArguments } from './codegen-arguments.ts';
import { formatUnknownCommandError } from './command-suggestions.ts';
import {
  parseCompletionsArguments,
  parseServerArguments,
  parseTailArguments,
  parseWorkflowArguments,
} from './noun-verb-arguments.ts';
import { parseScheduleArguments } from './parse-schedule-arguments.ts';
import { parseStorageBackend } from './storage-backend-arguments.ts';
import { CLI_FLAG_VALUE_OPTIONS } from './subcommand-detection.ts';
import type { CliCommand } from './types.ts';

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
  'server',
  'workflow',
  'tail',
  'completions',
]);
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
  server: parseServerArguments,
  workflow: parseWorkflowArguments,
  tail: parseTailArguments,
  completions: parseCompletionsArguments,
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
      if (CLI_FLAG_VALUE_OPTIONS.has(arg)) {
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

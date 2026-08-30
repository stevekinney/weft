/**
 * CLI parsing for the `weft schedule` subcommand and its actions
 * (`list`, `create`, `pause`, `resume`, `cancel`).
 *
 * @module cli/parse-schedule-arguments
 */

import { parseArgs } from 'node:util';

import type { ScheduleOverlapPolicy } from '../core/types.ts';
import { parsePersistentStorageBackend } from './storage-backend-arguments.ts';
import type {
  CliCommand,
  ScheduleAction,
  ScheduleCreateCommand,
  ScheduleListCommand,
  ScheduleMutationCommand,
} from './types.ts';

const SCHEDULE_ACTIONS = new Set(['list', 'create', 'pause', 'resume', 'cancel']);
const VALID_SCHEDULE_OVERLAP_POLICIES = new Set(['skip', 'queue', 'cancel-running', 'allow']);

function parseScheduleCliValues(args: string[]) {
  return parseArgs({
    args,
    options: {
      database: { type: 'string', short: 'd', default: './weft.db' },
      storage: { type: 'string', short: 's', default: 'sqlite' },
      workflows: { type: 'string', short: 'w', default: '' },
      every: { type: 'string' },
      input: { type: 'string', default: 'null' },
      id: { type: 'string' },
      overlap: { type: 'string' },
      backfill: { type: 'boolean', default: false },
      jitter: { type: 'string' },
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
): Partial<Pick<ScheduleCreateCommand, 'id' | 'overlap' | 'jitter'>> {
  const overlap = parseScheduleOverlapPolicy(values.overlap);

  return {
    ...(values.id !== undefined ? { id: values.id } : {}),
    ...(overlap !== undefined ? { overlap } : {}),
    ...(values.jitter !== undefined ? { jitter: values.jitter } : {}),
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
    ...(values.every !== undefined ? { every: values.every } : {}),
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

/** Parse `weft schedule <action> [...]` into a {@link CliCommand}. */
export function parseScheduleArguments(args: string[]): CliCommand {
  const { values, positionals } = parseScheduleCliValues(args);
  if (values.help) {
    return buildScheduleHelpCommand(values);
  }

  const action = requireScheduleAction(positionals);
  const actionPositionals = positionals.slice(1);

  if (action === 'create') {
    // With --every the cadence comes from the flag, so only <workflowType> is a
    // positional. Without it, the cron string is the second positional.
    if (values.every !== undefined) {
      assertExactSchedulePositionals(
        action,
        actionPositionals,
        1,
        '<workflowType> --every <duration>',
      );
    } else {
      assertExactSchedulePositionals(
        action,
        actionPositionals,
        2,
        '<workflowType> <cronExpression>',
      );
    }
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

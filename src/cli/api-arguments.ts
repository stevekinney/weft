import { parseArgs } from 'node:util';

import type { CliCommand } from './types.ts';

export function parseApiArguments(args: string[]): CliCommand {
  const { values, positionals } = parseArgs({
    args,
    options: {
      server: { type: 'string' },
      token: { type: 'string' },
      profile: { type: 'string' },
      input: { type: 'string' },
      'input-file': { type: 'string' },
      list: { type: 'boolean', default: false },
      describe: { type: 'string' },
      yes: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  validateApiArguments(values, positionals);

  return {
    command: 'api',
    ...optionalField('operationName', positionals[0]),
    ...optionalField('server', values.server),
    ...optionalField('token', values.token),
    ...optionalField('profile', values.profile),
    ...optionalField('input', values.input),
    ...optionalField('inputFile', values['input-file']),
    list: values.list ?? false,
    ...optionalField('describe', values.describe),
    yes: values.yes ?? false,
    help: values.help ?? false,
    json: values.json ?? false,
  };
}

type ApiValues = {
  readonly input?: string;
  readonly 'input-file'?: string;
  readonly list?: boolean;
  readonly describe?: string;
};

function validateApiArguments(values: ApiValues, positionals: readonly string[]): void {
  if (positionals.length > 1) throw new Error('api: expected at most one operation name');
  if (values.input !== undefined && values['input-file'] !== undefined) {
    throw new Error('api: --input and --input-file cannot be used together');
  }
  if (values.describe !== undefined && positionals.length > 0) {
    throw new Error('api: --describe cannot be combined with an operation name');
  }
  if (values.list === true && (values.describe !== undefined || positionals.length > 0)) {
    throw new Error('api: --list cannot be combined with --describe or an operation name');
  }
}

function optionalField<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): Record<Key, Value> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<Key, Value>);
}

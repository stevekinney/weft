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
    ...(positionals[0] !== undefined ? { operationName: positionals[0] } : {}),
    ...(values.server !== undefined ? { server: values.server } : {}),
    ...(values.token !== undefined ? { token: values.token } : {}),
    ...(values.profile !== undefined ? { profile: values.profile } : {}),
    ...apiInputFields(values),
    list: values.list ?? false,
    ...(values.describe !== undefined ? { describe: values.describe } : {}),
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

function apiInputFields(values: ApiValues) {
  return {
    ...(values.input !== undefined ? { input: values.input } : {}),
    ...(values['input-file'] !== undefined ? { inputFile: values['input-file'] } : {}),
  };
}

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

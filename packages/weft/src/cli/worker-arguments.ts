import { parseArgs } from 'node:util';

import type { CliCommand } from './types.ts';

function requiredFlag(value: string | undefined, name: '--manifest' | '--from'): string {
  if (value === undefined || value === '') {
    throw new Error(`worker verify: ${name} is required`);
  }
  return value;
}

export function parseWorkerArguments(args: string[]): CliCommand {
  const action = args[0];
  if (action !== 'verify') {
    throw new Error('worker: expected action "verify"');
  }
  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      manifest: { type: 'string' },
      from: { type: 'string' },
      json: { type: 'boolean', short: 'j', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  const help = values.help ?? false;
  const manifest = help ? (values.manifest ?? '') : requiredFlag(values.manifest, '--manifest');
  const from = help ? (values.from ?? '') : requiredFlag(values.from, '--from');
  return {
    command: 'worker',
    action: 'verify',
    manifest,
    from,
    help,
    json: values.json ?? false,
  };
}

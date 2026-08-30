/**
 * Argument parser for the `weft codegen` subcommand. Kept in its own
 * module so {@link parse-arguments} doesn't grow past the per-file
 * size budget.
 *
 * @module cli/codegen-arguments
 */

import { parseArgs } from 'node:util';

import type { CliCommand } from './types.ts';

const CODEGEN_DEFAULT_TIMEOUT_MS = 30_000;

function parseCodegenTimeout(value: string | undefined): number {
  if (value === undefined) return CODEGEN_DEFAULT_TIMEOUT_MS;
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`--timeout must be a positive integer number of milliseconds (got '${value}')`);
  }
  return timeoutMs;
}

type CodegenParsedValues = {
  server?: string;
  from?: string;
  token?: string;
  out?: string;
  timeout?: string;
  help?: boolean;
  json?: boolean;
};

function validateCodegenFlags(values: CodegenParsedValues): void {
  if (values.server !== undefined && values.from !== undefined) {
    throw new Error('codegen: --server and --from cannot be used together');
  }
  if (values.out === undefined || values.out === '') {
    throw new Error('codegen: --out is required');
  }
  if (values.token !== undefined && values.from !== undefined) {
    throw new Error('codegen: --token cannot be used with --from');
  }
}

function buildCodegenCommand(values: CodegenParsedValues, help: boolean): CliCommand {
  return {
    command: 'codegen',
    out: values.out ?? '',
    timeoutMs: help ? CODEGEN_DEFAULT_TIMEOUT_MS : parseCodegenTimeout(values.timeout),
    help,
    json: values.json ?? false,
    ...(values.server !== undefined ? { server: values.server } : {}),
    ...(values.from !== undefined ? { from: values.from } : {}),
    ...(values.token !== undefined ? { token: values.token } : {}),
  };
}

/** Parse a `weft codegen ...` argument list. */
export function parseCodegenArguments(args: string[]): CliCommand {
  const { values } = parseArgs({
    args,
    options: {
      server: { type: 'string' },
      from: { type: 'string' },
      token: { type: 'string' },
      out: { type: 'string', short: 'o' },
      timeout: { type: 'string' },
      json: { type: 'boolean', short: 'j', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  const help = values.help ?? false;
  if (help) {
    return buildCodegenCommand(values, true);
  }

  validateCodegenFlags(values);
  return buildCodegenCommand(values, false);
}

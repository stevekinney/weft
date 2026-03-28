#!/usr/bin/env bun

/**
 * Weft CLI entry point.
 *
 * Starts the Weft durable execution engine with HTTP + WebSocket server
 * backed by a SQLite database.
 *
 * @module cli
 */

import { parseArgs } from 'node:util';

import { Engine } from './core/engine.ts';
import { serve } from './server/index.ts';
import { BunSQLiteStorage } from './storage/bun-sql.ts';

// ---------------------------------------------------------------------------
// Subcommand types
// ---------------------------------------------------------------------------

export type CliCommand =
  | { command: 'serve'; port: string; database: string; help: boolean }
  | { command: 'doctor'; database: string; help: boolean; json: boolean }
  | {
      command: 'version:check';
      database: string;
      workflows: string;
      help: boolean;
      json: boolean;
    };

// ---------------------------------------------------------------------------
// Known subcommands
// ---------------------------------------------------------------------------

const KNOWN_SUBCOMMANDS = new Set(['doctor', 'version:check']);

// ---------------------------------------------------------------------------
// Argument parsing (exported for testing)
// ---------------------------------------------------------------------------

export function parseCliArguments(args: string[]): CliCommand {
  // Scan for the first non-flag value to determine the subcommand.
  let subcommand: string | undefined;
  let subcommandIndex = -1;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('-')) {
      // If this flag takes a value, skip the next arg too.
      if (
        arg === '-p' ||
        arg === '-d' ||
        arg === '-w' ||
        arg === '--port' ||
        arg === '--database' ||
        arg === '--workflows'
      ) {
        i++;
      }
      continue;
    }
    // First non-flag argument found.
    if (arg && KNOWN_SUBCOMMANDS.has(arg)) {
      subcommand = arg;
      subcommandIndex = i;
    }
    break;
  }

  // Remove the subcommand token from args before passing to parseArgs.
  const remainingArgs =
    subcommandIndex >= 0
      ? [...args.slice(0, subcommandIndex), ...args.slice(subcommandIndex + 1)]
      : args;

  if (subcommand === 'doctor') {
    return parseDoctorArguments(remainingArgs);
  }

  if (subcommand === 'version:check') {
    return parseVersionCheckArguments(remainingArgs);
  }

  return parseServeArguments(remainingArgs);
}

function parseServeArguments(args: string[]): CliCommand {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string', short: 'p', default: '7233' },
      database: { type: 'string', short: 'd', default: './weft.db' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  return {
    command: 'serve',
    port: values.port ?? '7233',
    database: values.database ?? './weft.db',
    help: values.help ?? false,
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

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

export const HELP_TEXT = `
weft - Bun-native durable execution engine

Usage: weft [command] [options]

Commands:
  serve           Start the Weft server (default)
  doctor          Run diagnostics on the Weft database
  version:check   Check workflow version compatibility

Serve Options:
  -p, --port <port>       Server port (default: 7233)
  -d, --database <path>   Database file path (default: ./weft.db)
  -h, --help              Show this help message
`;

export const DOCTOR_HELP_TEXT = `
weft doctor - Run diagnostics on the Weft database

Usage: weft doctor [options]

Options:
  -d, --database <path>   Database file path (default: ./weft.db)
  -j, --json              Output results as JSON
  -h, --help              Show this help message
`;

export const VERSION_CHECK_HELP_TEXT = `
weft version:check - Check workflow version compatibility

Usage: weft version:check [options]

Options:
  -d, --database <path>     Database file path (default: ./weft.db)
  -w, --workflows <path>    Path to workflows module
  -j, --json                Output results as JSON
  -h, --help                Show this help message
`;

// ---------------------------------------------------------------------------
// Command execution (exported for testing)
// ---------------------------------------------------------------------------

export interface CommandOutput {
  stdout: string;
  exitCode: number;
  stderr?: string;
}

type ShutdownSignal = 'SIGINT' | 'SIGTERM';

interface ServeResources {
  storage: Disposable;
  engine: Disposable;
  server: Disposable;
}

function registerResource(resourceStack: AsyncDisposableStack, resource: Disposable): void {
  resourceStack.adopt(resource, async (value) => {
    const asyncDispose = Reflect.get(value, Symbol.asyncDispose);
    if (typeof asyncDispose === 'function') {
      await asyncDispose.call(value);
      return;
    }

    value[Symbol.dispose]();
  });
}

export function waitForShutdownSignal(): Promise<ShutdownSignal> {
  return new Promise((resolve) => {
    const onSignal = (signal: ShutdownSignal): void => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      resolve(signal);
    };

    const onSigint = (): void => {
      onSignal('SIGINT');
    };

    const onSigterm = (): void => {
      onSignal('SIGTERM');
    };

    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
  });
}

export async function shutdownServeResources(
  resources: ServeResources,
  waitForSignal: () => Promise<ShutdownSignal> = waitForShutdownSignal,
): Promise<ShutdownSignal> {
  await using resourceStack = new AsyncDisposableStack();
  registerResource(resourceStack, resources.storage);
  registerResource(resourceStack, resources.engine);
  registerResource(resourceStack, resources.server);
  const signal = await waitForSignal();
  return signal;
}

export async function executeDoctor(options: {
  database: string;
  json: boolean;
}): Promise<CommandOutput> {
  const { collectDiagnostics } = await import('./diagnostics/doctor.ts');
  const { formatDiagnosticReport } = await import('./diagnostics/format.ts');

  const storage = new BunSQLiteStorage(options.database);

  try {
    const report = await collectDiagnostics(storage, options.database);
    const stdout = options.json ? JSON.stringify(report, null, 2) : formatDiagnosticReport(report);
    return { stdout, exitCode: 0 };
  } finally {
    storage[Symbol.dispose]();
  }
}

export async function executeVersionCheck(options: {
  database: string;
  workflows: string;
  json: boolean;
}): Promise<CommandOutput> {
  if (!options.workflows) {
    return {
      stdout: '',
      stderr: 'Error: --workflows flag is required for version:check',
      exitCode: 1,
    };
  }

  const { runVersionCheck } = await import('./diagnostics/version-check.ts');
  const { formatVersionCheckReport } = await import('./diagnostics/format.ts');

  const storage = new BunSQLiteStorage(options.database);

  try {
    const registrations = await import(options.workflows);
    const report = await runVersionCheck(storage, registrations.default);
    const stdout = options.json
      ? JSON.stringify(report, null, 2)
      : formatVersionCheckReport(report);
    return { stdout, exitCode: 0 };
  } finally {
    storage[Symbol.dispose]();
  }
}

// ---------------------------------------------------------------------------
// Main (only runs when executed directly, not when imported for tests)
// ---------------------------------------------------------------------------

const isDirectExecution = typeof Bun !== 'undefined' && Bun.main === import.meta.path;

if (isDirectExecution) {
  const parsed = parseCliArguments(Bun.argv.slice(2));

  if (parsed.command === 'serve') {
    if (parsed.help) {
      console.log(HELP_TEXT);
      process.exit(0);
    }

    const storage = new BunSQLiteStorage(parsed.database);
    const engine = new Engine({ storage });

    // Load the dashboard HTML if available
    let dashboard: unknown = null;
    try {
      const dashboardModule = await import('./dashboard/index.html' as string);
      dashboard = dashboardModule.default;
    } catch {
      // Dashboard not built — serve without it
    }

    const server = serve({
      engine,
      port: Number(parsed.port),
      dashboard,
    });

    console.log(`Weft running on ${server.url}`);
    if (dashboard !== null) {
      console.log(`Dashboard: ${server.url}/ui`);
    }
    console.log(`Database: ${parsed.database}`);

    const signal = await shutdownServeResources({ storage, engine, server });
    if (signal === 'SIGINT') {
      console.log('\nShutting down...');
    }
    process.exit(0);
  } else if (parsed.command === 'doctor') {
    if (parsed.help) {
      console.log(DOCTOR_HELP_TEXT);
      process.exit(0);
    }

    const result = await executeDoctor(parsed);
    console.log(result.stdout);
    process.exit(result.exitCode);
  } else if (parsed.command === 'version:check') {
    if (parsed.help) {
      console.log(VERSION_CHECK_HELP_TEXT);
      process.exit(0);
    }

    const result = await executeVersionCheck(parsed);
    if (result.stderr) console.error(result.stderr);
    if (result.stdout) console.log(result.stdout);
    process.exit(result.exitCode);
  }
}

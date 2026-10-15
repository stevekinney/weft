#!/usr/bin/env bun

import {
  API_HELP_TEXT,
  CODEGEN_HELP_TEXT,
  COMPLETIONS_HELP_TEXT,
  CONFORMANCE_HELP_TEXT,
  createStorage,
  DOCTOR_HELP_TEXT,
  executeApi,
  executeCodegen,
  executeCompletions,
  executeConformance,
  executeDoctor,
  executeSchedule,
  executeServer,
  executeTail,
  executeTimeline,
  executeValidate,
  executeVersion,
  executeVersionCheck,
  executeWorkerVerify,
  executeWorkflow,
  findCliSubcommandName,
  HELP_TEXT,
  parseCliArguments,
  removeRunLockfile,
  SCHEDULE_HELP_TEXT,
  SERVER_HELP_TEXT,
  TAIL_HELP_TEXT,
  TIMELINE_HELP_TEXT,
  VALIDATE_HELP_TEXT,
  VERSION_CHECK_HELP_TEXT,
  WORKER_HELP_TEXT,
  WORKFLOW_HELP_TEXT,
  writeRunLockfile,
} from './cli/index.ts';
import {
  CLI_SHUTDOWN_SIGNALS,
  createCliShutdownHandler,
  type CliShutdownSignal,
} from './cli/shutdown.ts';
import type { CliCommand, CommandOutput } from './cli/types.ts';
import { loadRegistrationsFromModule } from './cli/validation.ts';
import { Engine, serve } from './index.ts';

/**
 * Where `runCliMain` writes the output it produces itself (help text, each command's returned
 * stdout and stderr, and `serve`'s startup and shutdown lines) and how a `serve` run ends the
 * process. Subcommands that stream while they run, such as `tail` and the interactive workflow
 * cancellation prompt, still write to `process.stdout` and `process.stderr` directly.
 */
export type CliMainIo = {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly exit: (code: 0 | 1) => void;
};

/** A `serve` run that is listening: the entry point routes shutdown signals to `shutdown`. */
export type ServingCli = {
  readonly url: string;
  readonly shutdown: (signal: CliShutdownSignal) => Promise<void>;
};

/** Every subcommand except `version` and `serve`, which `runCliMain` handles itself. */
type DispatchedCommand = Exclude<CliCommand, { command: 'serve' } | { command: 'version' }>;

type Subcommand<Command extends DispatchedCommand> = {
  readonly helpText: string;
  readonly execute: (command: Command) => Promise<CommandOutput>;
};

const SUBCOMMANDS: {
  readonly [Name in DispatchedCommand['command']]: Subcommand<
    Extract<DispatchedCommand, { command: Name }>
  >;
} = {
  doctor: { helpText: DOCTOR_HELP_TEXT, execute: executeDoctor },
  'version:check': { helpText: VERSION_CHECK_HELP_TEXT, execute: executeVersionCheck },
  validate: { helpText: VALIDATE_HELP_TEXT, execute: executeValidate },
  conformance: { helpText: CONFORMANCE_HELP_TEXT, execute: executeConformance },
  timeline: { helpText: TIMELINE_HELP_TEXT, execute: executeTimeline },
  schedule: { helpText: SCHEDULE_HELP_TEXT, execute: executeSchedule },
  codegen: { helpText: CODEGEN_HELP_TEXT, execute: executeCodegen },
  worker: { helpText: WORKER_HELP_TEXT, execute: executeWorkerVerify },
  api: { helpText: API_HELP_TEXT, execute: executeApi },
  server: { helpText: SERVER_HELP_TEXT, execute: executeServer },
  workflow: { helpText: WORKFLOW_HELP_TEXT, execute: executeWorkflow },
  tail: { helpText: TAIL_HELP_TEXT, execute: executeTail },
  completions: { helpText: COMPLETIONS_HELP_TEXT, execute: executeCompletions },
};

/**
 * Registers the workflows module and starts listening. If any step fails, everything created so
 * far is released before the error propagates: an in-process caller gets no shutdown handler for
 * a failed start, so the server, the engine's background work and the storage would otherwise leak.
 */
async function listenOrRollBack(
  parsedArguments: Extract<CliCommand, { command: 'serve' }>,
  storage: Awaited<ReturnType<typeof createStorage>>,
  engine: Engine,
  io: CliMainIo,
): Promise<ReturnType<typeof serve>> {
  let server: ReturnType<typeof serve> | undefined;
  try {
    if (parsedArguments.workflows) {
      const { registerModuleExports } = await import('./cli/serve-registrations.ts');
      const loaded = await loadRegistrationsFromModule(parsedArguments.workflows);
      registerModuleExports(engine, loaded.registrations, loaded.activities);
    } else {
      io.stdout('No --workflows module provided; starting in inspect-only mode.\n');
    }
    server = serve({ engine, port: Number(parsedArguments.port) });
    await writeRunLockfile(server.url);
    return server;
  } catch (error) {
    // Each release is best effort, so a failing one cannot replace the startup error it follows.
    await server?.stop().catch(() => {});
    await engine.shutdown().catch(() => false);
    await Promise.resolve()
      .then(() => storage[Symbol.dispose]())
      .catch(() => {});
    throw error;
  }
}

/** Starts `weft serve`: opens storage, registers the workflows module, and listens. */
async function startServe(
  parsedArguments: Extract<CliCommand, { command: 'serve' }>,
  io: CliMainIo,
): Promise<number | ServingCli> {
  if (parsedArguments.help) {
    io.stdout(`${HELP_TEXT}\n`);
    return 0;
  }

  const storage = await createStorage(parsedArguments.storage, parsedArguments.database);
  const engine = new Engine({ storage });
  const server = await listenOrRollBack(parsedArguments, storage, engine, io);

  io.stdout(`Weft API running at ${new URL('/api/v1', server.url).href}\n`);
  io.stdout(`Health check: ${new URL('/v1/health', server.url).href}\n`);
  io.stdout(`Storage: ${parsedArguments.storage}\n`);
  io.stdout(`Database: ${parsedArguments.database}\n`);

  const shutdown = createCliShutdownHandler({
    stopServer: () => server.stop(),
    shutdownEngine: async () => {
      if (!(await engine.shutdown())) throw new Error('the engine lease release did not commit');
    },
    removeRunLockfile: () => removeRunLockfile(server.url),
    disposeStorage: () => storage[Symbol.dispose](),
    log: (message) => io.stdout(`${message}\n`),
    reportError: (message, error) => io.stderr(`${message} ${String(error)}\n`),
    exit: io.exit,
  });
  return { url: server.url, shutdown };
}

/**
 * The `weft` command: parses `argv`, runs the subcommand, and returns its exit code, or, for
 * `serve`, the listening server and its shutdown handler. Exported so tests run the CLI in
 * process; spawning `bun src/cli-main.ts` puts a Bun boot inside each test's 5 s budget.
 */
export async function runCliMain(
  argv: readonly string[],
  io: CliMainIo,
): Promise<number | ServingCli> {
  let parsedArguments: ReturnType<typeof parseCliArguments>;
  try {
    parsedArguments = parseCliArguments([...argv]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`Error: ${message}\n`);
    return findCliSubcommandName(argv) === 'api' ? 3 : 1;
  }

  if (parsedArguments.command === 'version') {
    const result = executeVersion();
    io.stdout(result.stdout + '\n');
    return result.exitCode;
  } else if (parsedArguments.command === 'serve') {
    return await startServe(parsedArguments, io);
  }

  const subcommand = SUBCOMMANDS[parsedArguments.command] as Subcommand<DispatchedCommand>;
  if (parsedArguments.help) {
    io.stdout(`${subcommand.helpText}\n`);
    return 0;
  }

  const result = await subcommand.execute(parsedArguments);
  if (result.stderr) io.stderr(`${result.stderr}\n`);
  if (result.stdout) io.stdout(result.stdout + '\n');
  return result.exitCode;
}

if (import.meta.main) {
  const outcome = await runCliMain(Bun.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    exit: (code) => process.exit(code),
  });
  if (typeof outcome === 'number') process.exit(outcome);
  for (const signal of CLI_SHUTDOWN_SIGNALS)
    process.on(signal, () => void outcome.shutdown(signal));
}

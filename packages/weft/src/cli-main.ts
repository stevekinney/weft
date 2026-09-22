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
  WORKFLOW_HELP_TEXT,
  writeRunLockfile,
} from './cli/index.ts';
import { CLI_SHUTDOWN_SIGNALS, createCliShutdownHandler } from './cli/shutdown.ts';
import { loadRegistrationsFromModule } from './cli/validation.ts';
import { Engine, serve } from './index.ts';

const parsedArguments = (() => {
  try {
    return parseCliArguments(Bun.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    return process.exit(findCliSubcommandName(Bun.argv.slice(2)) === 'api' ? 3 : 1);
  }
})();

if (parsedArguments.command === 'version') {
  const result = executeVersion();
  process.stdout.write(result.stdout + '\n');
  process.exit(result.exitCode);
} else if (parsedArguments.command === 'serve') {
  if (parsedArguments.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    process.exit(0);
  }

  const storage = await createStorage(parsedArguments.storage, parsedArguments.database);
  const engine = new Engine({ storage });

  if (parsedArguments.workflows) {
    const { registerModuleExports } = await import('./cli/serve-registrations.ts');

    const loaded = await loadRegistrationsFromModule(parsedArguments.workflows);
    registerModuleExports(engine, loaded.registrations, loaded.activities);
  } else {
    process.stdout.write('No --workflows module provided; starting in inspect-only mode.\n');
  }

  const server = serve({
    engine,
    port: Number(parsedArguments.port),
  });
  await writeRunLockfile(server.url);

  process.stdout.write(`Weft API running at ${new URL('/api/v1', server.url).href}\n`);
  process.stdout.write(`Health check: ${new URL('/v1/health', server.url).href}\n`);
  process.stdout.write(`Storage: ${parsedArguments.storage}\n`);
  process.stdout.write(`Database: ${parsedArguments.database}\n`);

  const shutdown = createCliShutdownHandler({
    stopServer: () => server.stop(),
    removeRunLockfile: () => removeRunLockfile(server.url),
    disposeStorage: () => storage[Symbol.dispose](),
    log: (message) => process.stdout.write(`${message}\n`),
    reportError: (message, error) => process.stderr.write(`${message} ${String(error)}\n`),
    exit: (code) => process.exit(code),
  });

  for (const signal of CLI_SHUTDOWN_SIGNALS) {
    process.on(signal, () => void shutdown(signal));
  }
} else if (parsedArguments.command === 'doctor') {
  if (parsedArguments.help) {
    process.stdout.write(`${DOCTOR_HELP_TEXT}\n`);
    process.exit(0);
  }

  const result = await executeDoctor(parsedArguments);
  process.stdout.write(result.stdout + '\n');
  process.exit(result.exitCode);
} else if (parsedArguments.command === 'version:check') {
  if (parsedArguments.help) {
    process.stdout.write(`${VERSION_CHECK_HELP_TEXT}\n`);
    process.exit(0);
  }

  const result = await executeVersionCheck(parsedArguments);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  if (result.stdout) process.stdout.write(result.stdout + '\n');
  process.exit(result.exitCode);
} else if (parsedArguments.command === 'validate') {
  if (parsedArguments.help) {
    process.stdout.write(`${VALIDATE_HELP_TEXT}\n`);
    process.exit(0);
  }

  const result = await executeValidate(parsedArguments);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  if (result.stdout) process.stdout.write(result.stdout + '\n');
  process.exit(result.exitCode);
} else if (parsedArguments.command === 'conformance') {
  if (parsedArguments.help) {
    process.stdout.write(`${CONFORMANCE_HELP_TEXT}\n`);
    process.exit(0);
  }

  const result = await executeConformance(parsedArguments);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  if (result.stdout) process.stdout.write(result.stdout + '\n');
  process.exit(result.exitCode);
} else if (parsedArguments.command === 'timeline') {
  if (parsedArguments.help) {
    process.stdout.write(`${TIMELINE_HELP_TEXT}\n`);
    process.exit(0);
  }

  const result = await executeTimeline(parsedArguments);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  if (result.stdout) process.stdout.write(result.stdout + '\n');
  process.exit(result.exitCode);
} else if (parsedArguments.command === 'schedule') {
  if (parsedArguments.help) {
    process.stdout.write(`${SCHEDULE_HELP_TEXT}\n`);
    process.exit(0);
  }

  const result = await executeSchedule(parsedArguments);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  if (result.stdout) process.stdout.write(result.stdout + '\n');
  process.exit(result.exitCode);
} else if (parsedArguments.command === 'codegen') {
  if (parsedArguments.help) {
    process.stdout.write(`${CODEGEN_HELP_TEXT}\n`);
    process.exit(0);
  }

  const result = await executeCodegen(parsedArguments);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  if (result.stdout) process.stdout.write(result.stdout + '\n');
  process.exit(result.exitCode);
} else if (parsedArguments.command === 'api') {
  if (parsedArguments.help) {
    process.stdout.write(`${API_HELP_TEXT}\n`);
    process.exit(0);
  }

  const result = await executeApi(parsedArguments);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  if (result.stdout) process.stdout.write(result.stdout + '\n');
  process.exit(result.exitCode);
} else if (parsedArguments.command === 'server') {
  if (parsedArguments.help) {
    process.stdout.write(`${SERVER_HELP_TEXT}\n`);
    process.exit(0);
  }

  const result = await executeServer(parsedArguments);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  if (result.stdout) process.stdout.write(result.stdout + '\n');
  process.exit(result.exitCode);
} else if (parsedArguments.command === 'workflow') {
  if (parsedArguments.help) {
    process.stdout.write(`${WORKFLOW_HELP_TEXT}\n`);
    process.exit(0);
  }

  const result = await executeWorkflow(parsedArguments);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  if (result.stdout) process.stdout.write(result.stdout + '\n');
  process.exit(result.exitCode);
} else if (parsedArguments.command === 'tail') {
  if (parsedArguments.help) {
    process.stdout.write(`${TAIL_HELP_TEXT}\n`);
    process.exit(0);
  }

  const result = await executeTail(parsedArguments);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  if (result.stdout) process.stdout.write(result.stdout + '\n');
  process.exit(result.exitCode);
} else if (parsedArguments.command === 'completions') {
  if (parsedArguments.help) {
    process.stdout.write(`${COMPLETIONS_HELP_TEXT}\n`);
    process.exit(0);
  }

  const result = await executeCompletions(parsedArguments);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  if (result.stdout) process.stdout.write(result.stdout + '\n');
  process.exit(result.exitCode);
}

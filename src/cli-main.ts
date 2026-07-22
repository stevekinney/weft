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
import { Engine } from './core/engine.ts';
import { serve } from './server/index.ts';

const parsedArguments = (() => {
  try {
    return parseCliArguments(Bun.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(findCliSubcommandName(Bun.argv.slice(2)) === 'api' ? 3 : 1);
  }
})();

if (parsedArguments.command === 'version') {
  const result = executeVersion();
  console.log(result.stdout);
  process.exit(result.exitCode);
} else if (parsedArguments.command === 'serve') {
  if (parsedArguments.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const storage = await createStorage(parsedArguments.storage, parsedArguments.database);
  const engine = new Engine({ storage });

  if (parsedArguments.workflows) {
    const { loadRegistrationsFromModule } = await import('./diagnostics/validate.ts');
    const { registerModuleExports } = await import('./cli/serve-registrations.ts');

    const loaded = await loadRegistrationsFromModule(parsedArguments.workflows);
    registerModuleExports(engine, loaded.registrations, loaded.activities);
  } else {
    console.log('No --workflows module provided; starting in inspect-only mode.');
  }

  const server = serve({
    engine,
    port: Number(parsedArguments.port),
  });
  await writeRunLockfile(server.url);

  console.log(`Weft API running at ${new URL('/api/v1', server.url).href}`);
  console.log(`Health check: ${new URL('/v1/health', server.url).href}`);
  console.log(`Storage: ${parsedArguments.storage}`);
  console.log(`Database: ${parsedArguments.database}`);

  const shutdown = createCliShutdownHandler({
    stopServer: () => server.stop(),
    removeRunLockfile: () => removeRunLockfile(server.url),
    disposeStorage: () => storage[Symbol.dispose](),
    log: (message) => console.log(message),
    reportError: (message, error) => console.error(message, error),
    exit: (code) => process.exit(code),
  });

  for (const signal of CLI_SHUTDOWN_SIGNALS) {
    process.on(signal, () => void shutdown(signal));
  }
} else if (parsedArguments.command === 'doctor') {
  if (parsedArguments.help) {
    console.log(DOCTOR_HELP_TEXT);
    process.exit(0);
  }

  const result = await executeDoctor(parsedArguments);
  console.log(result.stdout);
  process.exit(result.exitCode);
} else if (parsedArguments.command === 'version:check') {
  if (parsedArguments.help) {
    console.log(VERSION_CHECK_HELP_TEXT);
    process.exit(0);
  }

  const result = await executeVersionCheck(parsedArguments);
  if (result.stderr) console.error(result.stderr);
  if (result.stdout) console.log(result.stdout);
  process.exit(result.exitCode);
} else if (parsedArguments.command === 'validate') {
  if (parsedArguments.help) {
    console.log(VALIDATE_HELP_TEXT);
    process.exit(0);
  }

  const result = await executeValidate(parsedArguments);
  if (result.stderr) console.error(result.stderr);
  if (result.stdout) console.log(result.stdout);
  process.exit(result.exitCode);
} else if (parsedArguments.command === 'conformance') {
  if (parsedArguments.help) {
    console.log(CONFORMANCE_HELP_TEXT);
    process.exit(0);
  }

  const result = await executeConformance(parsedArguments);
  if (result.stderr) console.error(result.stderr);
  if (result.stdout) console.log(result.stdout);
  process.exit(result.exitCode);
} else if (parsedArguments.command === 'timeline') {
  if (parsedArguments.help) {
    console.log(TIMELINE_HELP_TEXT);
    process.exit(0);
  }

  const result = await executeTimeline(parsedArguments);
  if (result.stderr) console.error(result.stderr);
  if (result.stdout) console.log(result.stdout);
  process.exit(result.exitCode);
} else if (parsedArguments.command === 'schedule') {
  if (parsedArguments.help) {
    console.log(SCHEDULE_HELP_TEXT);
    process.exit(0);
  }

  const result = await executeSchedule(parsedArguments);
  if (result.stderr) console.error(result.stderr);
  if (result.stdout) console.log(result.stdout);
  process.exit(result.exitCode);
} else if (parsedArguments.command === 'codegen') {
  if (parsedArguments.help) {
    console.log(CODEGEN_HELP_TEXT);
    process.exit(0);
  }

  const result = await executeCodegen(parsedArguments);
  if (result.stderr) console.error(result.stderr);
  if (result.stdout) console.log(result.stdout);
  process.exit(result.exitCode);
} else if (parsedArguments.command === 'api') {
  if (parsedArguments.help) {
    console.log(API_HELP_TEXT);
    process.exit(0);
  }

  const result = await executeApi(parsedArguments);
  if (result.stderr) console.error(result.stderr);
  if (result.stdout) console.log(result.stdout);
  process.exit(result.exitCode);
} else if (parsedArguments.command === 'server') {
  if (parsedArguments.help) {
    console.log(SERVER_HELP_TEXT);
    process.exit(0);
  }

  const result = await executeServer(parsedArguments);
  if (result.stderr) console.error(result.stderr);
  if (result.stdout) console.log(result.stdout);
  process.exit(result.exitCode);
} else if (parsedArguments.command === 'workflow') {
  if (parsedArguments.help) {
    console.log(WORKFLOW_HELP_TEXT);
    process.exit(0);
  }

  const result = await executeWorkflow(parsedArguments);
  if (result.stderr) console.error(result.stderr);
  if (result.stdout) console.log(result.stdout);
  process.exit(result.exitCode);
} else if (parsedArguments.command === 'tail') {
  if (parsedArguments.help) {
    console.log(TAIL_HELP_TEXT);
    process.exit(0);
  }

  const result = await executeTail(parsedArguments);
  if (result.stderr) console.error(result.stderr);
  if (result.stdout) console.log(result.stdout);
  process.exit(result.exitCode);
} else if (parsedArguments.command === 'completions') {
  if (parsedArguments.help) {
    console.log(COMPLETIONS_HELP_TEXT);
    process.exit(0);
  }

  const result = await executeCompletions(parsedArguments);
  if (result.stderr) console.error(result.stderr);
  if (result.stdout) console.log(result.stdout);
  process.exit(result.exitCode);
}

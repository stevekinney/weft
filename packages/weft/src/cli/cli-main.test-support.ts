import { runCliMain, type ServingCli } from '../cli-main.ts';

export type CliRunResult = { exitCode: number; stdout: string; stderr: string };

export type CliServerSession = {
  readonly serving: ServingCli;
  /** Everything the CLI has written to stdout and stderr so far. */
  readonly output: () => string;
  /** Delivers `SIGTERM` to the CLI's shutdown handler and returns the exit code it requested. */
  readonly stop: () => Promise<number | undefined>;
};

/** Starts the CLI in process with every write and exit request captured. */
async function startCli(argv: readonly string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let requestedExit: number | undefined;
  const outcome = await runCliMain(argv, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    exit: (code) => {
      requestedExit = code;
    },
  });
  return {
    outcome,
    stdout: () => stdout.join(''),
    stderr: () => stderr.join(''),
    requestedExit: () => requestedExit,
  };
}

/**
 * Runs the `weft` CLI in process, as `bun src/cli-main.ts <argv>` would, capturing its output.
 * Spawning the binary puts a Bun boot inside each test's 5 s budget, which times out under host
 * load. A command that starts a server is shut down and reported as a test error; use
 * {@link startCliServerInProcess} for those.
 */
export async function runCliInProcess(argv: readonly string[]): Promise<CliRunResult> {
  const run = await startCli(argv);
  if (typeof run.outcome !== 'number') {
    await run.outcome.shutdown('SIGTERM');
    throw new Error('runCliInProcess: the command started a server; use startCliServerInProcess');
  }
  return { exitCode: run.outcome, stdout: run.stdout(), stderr: run.stderr() };
}

/** Starts `weft serve` in process and returns the listening server with its captured output. */
export async function startCliServerInProcess(argv: readonly string[]): Promise<CliServerSession> {
  const run = await startCli(argv);
  const serving = run.outcome;
  if (typeof serving === 'number') {
    throw new Error(`startCliServerInProcess: the CLI exited ${serving} instead of serving`);
  }
  return {
    serving,
    output: () => run.stdout() + run.stderr(),
    stop: async () => {
      await serving.shutdown('SIGTERM');
      return run.requestedExit();
    },
  };
}

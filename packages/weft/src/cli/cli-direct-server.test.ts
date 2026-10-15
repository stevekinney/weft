import { describe, expect, it } from 'bun:test';

import { throwingRejectionOf } from '../testing/promise-outcome.test-support.ts';
import { runCliInProcess, startCliServerInProcess } from './cli-main.test-support.ts';

describe('CLI direct execution', () => {
  it('rejects ignored serve positionals before starting the server', async () => {
    const result = await runCliInProcess(['./workflows.ts']);

    const exitCode = result.exitCode;
    const stderr = result.stderr;

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown command './workflows.ts'");
  });

  it('rejects a misspelled subcommand before starting the server', async () => {
    const result = await runCliInProcess(['timelin']);

    const exitCode = result.exitCode;
    const stderr = result.stderr;

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown command 'timelin'");
    expect(stderr).toContain("Did you mean 'timeline'?");
  });

  it('runs schedule --help and exits 0', async () => {
    const result = await runCliInProcess(['schedule', '--help']);

    const exitCode = result.exitCode;
    const stdout = result.stdout;

    expect(exitCode).toBe(0);
    expect(stdout).toContain('schedule list');
    expect(stdout).toContain('schedule create');
    expect(stdout).toContain('schedule pause');
    expect(stdout).toContain('schedule resume');
    expect(stdout).toContain('schedule cancel');
  });

  it('runs doctor against an in-memory database and exits 0', async () => {
    const result = await runCliInProcess(['doctor', '--database', ':memory:']);

    const exitCode = result.exitCode;
    const stdout = result.stdout;

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Database:');
    expect(stdout).toContain('Workflows:');
    expect(stdout).toContain('Activities:');
    expect(stdout).toContain('Recommendations:');
  });

  it('runs doctor with --json flag and outputs valid JSON', async () => {
    const result = await runCliInProcess(['doctor', '--database', ':memory:', '--json']);

    const exitCode = result.exitCode;
    const stdout = result.stdout;

    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout);
    expect(report).toHaveProperty('database');
    expect(report).toHaveProperty('workflows');
    expect(report).toHaveProperty('queues');
    expect(report).toHaveProperty('recommendations');
  });

  it('exits with an error for an invalid storage backend', async () => {
    const result = await runCliInProcess(['--storage', 'postgres']);

    const exitCode = result.exitCode;
    const stderr = result.stderr;

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Invalid storage backend 'postgres'");
  });

  it('exits with error when version:check is missing --workflows flag', async () => {
    const result = await runCliInProcess(['version:check', '--database', ':memory:']);

    const exitCode = result.exitCode;
    const stderr = result.stderr;

    expect(exitCode).toBe(1);
    expect(stderr).toContain('--workflows');
  });

  it('starts the server and responds to health check', async () => {
    const session = await startCliServerInProcess(['--port', '0', '--database', ':memory:']);
    const { url } = session.serving;

    let exitCode: number | undefined;
    try {
      const response = await fetch(new URL('/v1/health', url));
      expect(response.ok).toBe(true);
      expect(session.output()).toContain(`Weft API running at ${new URL('/api/v1', url).href}`);
      expect(session.output()).toContain(`Health check: ${new URL('/v1/health', url).href}`);
      expect(session.output()).toContain('starting in inspect-only mode');
    } finally {
      exitCode = await session.stop();
    }

    expect(exitCode).toBe(0);
    expect(session.output()).toContain('Received SIGTERM; shutting down...');
  });

  it('registers the workflows module it is given before serving', async () => {
    const session = await startCliServerInProcess([
      '--port',
      '0',
      '--database',
      ':memory:',
      '--workflows',
      'src/cli/__fixtures__/validation/hello-world/src/index.ts',
    ]);

    try {
      expect(session.output()).not.toContain('inspect-only mode');
    } finally {
      expect(await session.stop()).toBe(0);
    }
  });

  it('reports a serve command run through runCliInProcess as a test error, after shutting it down', async () => {
    expect(
      await throwingRejectionOf(runCliInProcess(['--port', '0', '--database', ':memory:'])),
    ).toThrow('runCliInProcess: the command started a server; use startCliServerInProcess');
  });

  it('reports a command that exits instead of serving', async () => {
    expect(await throwingRejectionOf(startCliServerInProcess(['timelin']))).toThrow(
      'startCliServerInProcess: the CLI exited 1 instead of serving',
    );
  });

  it('releases the storage and engine when the workflows module cannot be loaded', async () => {
    expect(
      await throwingRejectionOf(
        startCliServerInProcess([
          '--port',
          '0',
          '--database',
          ':memory:',
          '--workflows',
          'src/cli/__fixtures__/does-not-exist.ts',
        ]),
      ),
    ).toThrow();
  });
});

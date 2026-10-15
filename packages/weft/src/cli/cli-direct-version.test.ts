import { describe, expect, it } from 'bun:test';

import { runCliInProcess } from './cli-main.test-support.ts';

import { VERSION } from '../index.ts';

describe('CLI direct execution', () => {
  it('accepts --storage flag via the CLI binary', async () => {
    const result = await runCliInProcess(['--help', '--storage', 'memory']);

    const exitCode = result.exitCode;
    expect(exitCode).toBe(0);
  });

  it('rejects --no-ui flag via the CLI binary', async () => {
    const result = await runCliInProcess(['--help', '--no-ui']);

    const exitCode = result.exitCode;
    expect(exitCode).toBe(1);
  });

  it('validates the retained workflow fixtures through the CLI entrypoint and exits 0', async () => {
    const result = await runCliInProcess([
      'validate',
      'src/cli/__fixtures__/validation/hello-world/src/**/*.ts',
      'src/cli/__fixtures__/validation/order-processing/src/**/*.ts',
    ]);

    const exitCode = result.exitCode;
    const stdout = result.stdout;
    const stderr = result.stderr;

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('src/cli/__fixtures__/validation/hello-world/src/index.ts');
    expect(stdout).toContain(
      'src/cli/__fixtures__/validation/order-processing/src/workflows/order.ts',
    );
    expect(stdout).toContain('No issues found.');
  });

  it('runs --version through the binary and prints the version, exit 0', async () => {
    const result = await runCliInProcess(['--version']);

    const exitCode = result.exitCode;
    const stdout = result.stdout;

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(VERSION);
  });

  it('runs -v through the binary and prints the version, exit 0', async () => {
    const result = await runCliInProcess(['-v']);

    const exitCode = result.exitCode;
    const stdout = result.stdout;

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(VERSION);
  });

  it('runs the bare version subcommand through the binary and prints the version, exit 0', async () => {
    const result = await runCliInProcess(['version']);

    const exitCode = result.exitCode;
    const stdout = result.stdout;

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(VERSION);
  });
});

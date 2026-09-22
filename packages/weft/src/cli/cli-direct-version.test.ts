import { describe, expect, it } from 'bun:test';

import { VERSION } from '../index.ts';

describe('CLI direct execution', () => {
  it('accepts --storage flag via the CLI binary', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', '--help', '--storage', 'memory'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    expect(exitCode).toBe(0);
  });

  it('rejects --no-ui flag via the CLI binary', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', '--help', '--no-ui'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    expect(exitCode).toBe(1);
  });

  it('validates the retained workflow fixtures through the CLI entrypoint and exits 0', async () => {
    const childProcess = Bun.spawn(
      [
        'bun',
        './src/cli-main.ts',
        'validate',
        'src/cli/__fixtures__/validation/hello-world/src/**/*.ts',
        'src/cli/__fixtures__/validation/order-processing/src/**/*.ts',
      ],
      {
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    const exitCode = await childProcess.exited;
    const stdout = await new Response(childProcess.stdout).text();
    const stderr = await new Response(childProcess.stderr).text();

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('src/cli/__fixtures__/validation/hello-world/src/index.ts');
    expect(stdout).toContain(
      'src/cli/__fixtures__/validation/order-processing/src/workflows/order.ts',
    );
    expect(stdout).toContain('No issues found.');
  });

  it('runs --version through the binary and prints the version, exit 0', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(VERSION);
  });

  it('runs -v through the binary and prints the version, exit 0', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', '-v'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(VERSION);
  });

  it('runs the bare version subcommand through the binary and prints the version, exit 0', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', 'version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(VERSION);
  });
});

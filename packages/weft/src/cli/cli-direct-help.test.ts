import { describe, expect, it } from 'bun:test';

describe('CLI direct execution', () => {
  it('runs the CLI binary with --help and exits 0', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('weft');
    expect(stdout).toContain('--port');
    expect(stdout).toContain('--database');
    expect(stdout).toContain('--help');
    expect(stdout).toContain('doctor');
    expect(stdout).toContain('version:check');
  });

  it('runs the CLI binary with -h short flag and exits 0', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', '-h'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('weft');
  });

  it('runs doctor --help and exits 0', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', 'doctor', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('doctor');
    expect(stdout).toContain('--database');
    expect(stdout).toContain('--json');
  });

  it('runs version:check --help and exits 0', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', 'version:check', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('version:check');
    expect(stdout).toContain('--database');
    expect(stdout).toContain('--workflows');
    expect(stdout).toContain('--json');
  });

  it('runs conformance --help and exits 0', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', 'conformance', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('conformance');
    expect(stdout).toContain('--timeout');
    expect(stdout).toContain('WEFT_WORKER_URL');
  });

  it('runs timeline --help and exits 0', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', 'timeline', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('timeline');
    expect(stdout).toContain('--step');
    expect(stdout).toContain('--diff');
  });

  it('runs serve --help and exits 0', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', 'serve', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('weft');
    expect(stdout).toContain('--port');
    expect(stdout).toContain('--database');
    expect(stdout).not.toContain('--console');
  });
});

import { describe, expect, it } from 'bun:test';

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs: number; intervalMs: number; label: string },
): Promise<void> {
  const deadline = performance.now() + options.timeoutMs;
  while (!(await predicate())) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${options.label}`);
    await Bun.sleep(options.intervalMs);
  }
}

describe('CLI direct execution', () => {
  it('rejects ignored serve positionals before starting the server', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', './workflows.ts'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stderr = await new Response(process.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown command './workflows.ts'");
  });

  it('rejects a misspelled subcommand before starting the server', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', 'timelin'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stderr = await new Response(process.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown command 'timelin'");
    expect(stderr).toContain("Did you mean 'timeline'?");
  });

  it('runs schedule --help and exits 0', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', 'schedule', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('schedule list');
    expect(stdout).toContain('schedule create');
    expect(stdout).toContain('schedule pause');
    expect(stdout).toContain('schedule resume');
    expect(stdout).toContain('schedule cancel');
  });

  it('runs doctor against an in-memory database and exits 0', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', 'doctor', '--database', ':memory:'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Database:');
    expect(stdout).toContain('Workflows:');
    expect(stdout).toContain('Activities:');
    expect(stdout).toContain('Recommendations:');
  });

  it('runs doctor with --json flag and outputs valid JSON', async () => {
    const process = Bun.spawn(
      ['bun', './src/cli-main.ts', 'doctor', '--database', ':memory:', '--json'],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();

    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout);
    expect(report).toHaveProperty('database');
    expect(report).toHaveProperty('workflows');
    expect(report).toHaveProperty('queues');
    expect(report).toHaveProperty('recommendations');
  });

  it('exits with an error for an invalid storage backend', async () => {
    const process = Bun.spawn(['bun', './src/cli-main.ts', '--storage', 'postgres'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await process.exited;
    const stderr = await new Response(process.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Invalid storage backend 'postgres'");
  });

  it('exits with error when version:check is missing --workflows flag', async () => {
    const process = Bun.spawn(
      ['bun', './src/cli-main.ts', 'version:check', '--database', ':memory:'],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    const exitCode = await process.exited;
    const stderr = await new Response(process.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain('--workflows');
  });

  it('starts the server and responds to health check', async () => {
    const port = 17233 + Math.floor(Math.random() * 1000);
    const apiMessage = `Weft API running at http://0.0.0.0:${port}/api/v1`;
    const healthMessage = `Health check: http://0.0.0.0:${port}/v1/health`;
    const process = Bun.spawn(
      ['bun', './src/cli-main.ts', '--port', String(port), '--database', ':memory:'],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    let stdout = '';
    const stdoutReader = process.stdout.getReader();
    const stdoutDrain = (async () => {
      const decoder = new TextDecoder();
      try {
        while (true) {
          const chunk = await stdoutReader.read();
          if (chunk.done) break;
          stdout += decoder.decode(chunk.value, { stream: true });
        }
      } finally {
        stdout += decoder.decode();
        stdoutReader.releaseLock();
      }
    })();

    try {
      await waitForCondition(
        async () => {
          try {
            const response = await fetch(`http://localhost:${port}/v1/health`);
            return response.ok;
          } catch {
            return false;
          }
        },
        { timeoutMs: 3_000, intervalMs: 25, label: 'CLI health endpoint' },
      );

      await waitForCondition(
        async () => stdout.includes(apiMessage) && stdout.includes(healthMessage),
        { timeoutMs: 3_000, intervalMs: 25, label: 'CLI startup output' },
      );
    } finally {
      process.kill('SIGTERM');
      await process.exited;
      await stdoutDrain;
    }

    expect(stdout).toContain(apiMessage);
    expect(stdout).toContain(healthMessage);
  });
});

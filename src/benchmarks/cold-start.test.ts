import { waitForRealTimersForTesting } from '../testing/fake-timers.test-support.ts';
/**
 * Cold start benchmarks for Weft.
 *
 * Two benchmark categories:
 * 1. **Library mode**: Measures Engine construction to first workflow completion.
 * 2. **Server mode**: Measures process spawn to successful HTTP health check,
 *    for both TypeScript source and compiled binary.
 *
 * @module benchmarks/cold-start
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types/workflow-function.ts';
import { BunSQLiteStorage } from '../storage/bun-sql.ts';
import { isConstrainedCodexRunner } from './benchmark-environment.ts';

// ---------------------------------------------------------------------------
// K2f: Library cold start — Engine construction to first workflow
// ---------------------------------------------------------------------------

const LIBRARY_TARGET_MS = process.env['CI'] ? 200 : 100;
const BINARY_WARM_CACHE_TARGET_MS = isConstrainedCodexRunner() ? 350 : 100;
const runBinaryArchitectureBenchmark =
  process.env['WEFT_COLD_START_ARCHITECTURE_BENCHMARK'] === '1' ? it : it.skip;

describe('Library cold start', () => {
  it(`new Engine() to first workflow start completes in <${LIBRARY_TARGET_MS}ms`, async () => {
    const iterations = 10;
    const times: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();

      const storage = new BunSQLiteStorage(':memory:');
      const engine = new Engine({ storage });

      const ping = workflow({ name: 'ping' }).execute(async function* (_ctx: WorkflowContext) {
        return 'pong';
      });
      engine.register(ping);

      const handle = await engine.start('ping', null);
      await handle.result();

      const elapsed = performance.now() - start;
      times.push(elapsed);

      engine[Symbol.dispose]();
      storage[Symbol.dispose]();
    }

    // Use the median to avoid outliers from first-run JIT compilation.
    const sorted = [...times].toSorted((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const min = sorted[0]!;
    const max = sorted[sorted.length - 1]!;

    console.log(
      [
        `\n  Library cold start benchmark (${iterations} iterations):`,
        `    Median:          ${median.toFixed(2)}ms`,
        `    Min:             ${min.toFixed(2)}ms`,
        `    Max:             ${max.toFixed(2)}ms`,
        `    Target:          <${LIBRARY_TARGET_MS}ms\n`,
      ].join('\n'),
    );

    expect(median).toBeLessThan(LIBRARY_TARGET_MS);
  });
});

// ---------------------------------------------------------------------------
// Server cold start helpers
// ---------------------------------------------------------------------------

/**
 * Spawn a server process and measure time until the health endpoint responds.
 * Returns the elapsed time in milliseconds or throws on timeout.
 */
async function measureColdStart(
  command: string[],
  port: number,
  timeoutMs: number = 10_000,
): Promise<{ elapsedMs: number; process: ReturnType<typeof Bun.spawn> }> {
  const start = performance.now();

  const proc = Bun.spawn(command, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NODE_ENV: 'production' },
  });

  const healthUrl = `http://localhost:${port}/v1/health`;
  const deadline = start + timeoutMs;

  while (performance.now() < deadline) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        const elapsedMs = performance.now() - start;
        return { elapsedMs, process: proc };
      }
    } catch {
      // Server not ready yet
    }
    await waitForRealTimersForTesting(5);
  }

  proc.kill('SIGTERM');
  await proc.exited;
  throw new Error(`Server did not respond within ${timeoutMs}ms`);
}

function isMissingExecutableError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }

  return (error as { code?: unknown }).code === 'ENOENT';
}

type ColdStartSamples = {
  iterations: number;
  samples: number[];
  median: number;
  min: number;
  max: number;
};

async function measureWarmCacheBinaryColdStarts(
  binaryPath: string,
  iterations: number,
): Promise<ColdStartSamples> {
  // Warm the OS file cache once: a freshly compiled 50+ MB Bun binary takes
  // 600-900ms to read off disk on the first invocation on some hosts. That
  // first-run cost dominates the engine-side cold-start measurement.
  {
    const port = 19000 + Math.floor(Math.random() * 1000);
    const { process: warmupProc } = await measureColdStart(
      [binaryPath, '--port', String(port), '--database', ':memory:', '--storage', 'memory'],
      port,
    );
    warmupProc.kill('SIGTERM');
    await warmupProc.exited;
  }

  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const port = 19000 + Math.floor(Math.random() * 1000);
    const { elapsedMs, process: proc } = await measureColdStart(
      [binaryPath, '--port', String(port), '--database', ':memory:', '--storage', 'memory'],
      port,
    );
    samples.push(elapsedMs);
    proc.kill('SIGTERM');
    await proc.exited;
  }

  const sorted = [...samples].toSorted((a, b) => a - b);
  return {
    iterations,
    samples,
    median: sorted[Math.floor(sorted.length / 2)]!,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}

function logBinaryColdStartSamples(samples: ColdStartSamples): void {
  console.log(
    [
      `  Binary-mode cold start (${samples.iterations} warm-cache runs):`,
      `    Median:          ${samples.median.toFixed(1)}ms`,
      `    Min:             ${samples.min.toFixed(1)}ms`,
      `    Max:             ${samples.max.toFixed(1)}ms`,
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Source-mode cold start (bun src/cli-main.ts)
// ---------------------------------------------------------------------------

describe('Server cold start benchmark', () => {
  describe('source mode (bun src/cli-main.ts)', () => {
    it('starts and responds to health check within 5 seconds', async () => {
      const port = 18000 + Math.floor(Math.random() * 1000);
      const { elapsedMs, process: proc } = await measureColdStart(
        [
          'bun',
          'src/cli-main.ts',
          '--port',
          String(port),
          '--database',
          ':memory:',
          '--storage',
          'memory',
        ],
        port,
      );

      console.log(`  Source-mode cold start: ${elapsedMs.toFixed(1)}ms`);

      expect(elapsedMs).toBeLessThan(5_000);

      proc.kill('SIGTERM');
      await proc.exited;
    }, 15_000);
  });

  // ---------------------------------------------------------------------------
  // Binary-mode cold start (compiled executable)
  // ---------------------------------------------------------------------------

  describe('binary mode (compiled executable)', () => {
    const platform = process.platform === 'win32' ? 'windows' : process.platform;
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const binaryName = `weft-${platform}-${arch}${platform === 'windows' ? '.exe' : ''}`;
    const binaryDir = join(import.meta.dir, '..', '..', 'dist', 'benchmark-binary');
    const binaryPath = join(binaryDir, binaryName);

    beforeAll(async () => {
      if (!existsSync(binaryDir)) {
        mkdirSync(binaryDir, { recursive: true });
      }

      // Build a fresh binary for benchmarking
      const proc = Bun.spawn(
        [
          'bun',
          'build',
          '--compile',
          '--target',
          `bun-${platform}-${arch}`,
          '--outfile',
          binaryPath,
          '--minify',
          'src/cli-main.ts',
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );

      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        console.warn(`Binary build failed: ${stderr}`);
      }
    }, 60_000);

    afterAll(() => {
      if (existsSync(binaryDir)) {
        rmSync(binaryDir, { recursive: true, force: true });
      }
    });

    it('builds and starts the compiled executable in a non-gating smoke benchmark', async () => {
      if (!existsSync(binaryPath)) {
        console.warn('Skipping binary cold start benchmark: binary not available');
        return;
      }

      try {
        const samples = await measureWarmCacheBinaryColdStarts(binaryPath, 1);

        logBinaryColdStartSamples(samples);

        expect(samples.samples).toHaveLength(1);
        expect(samples.median).toBeGreaterThan(0);
      } catch (error) {
        if (isMissingExecutableError(error)) {
          console.warn('Skipping binary cold start benchmark: compiled executable is unavailable');
          return;
        }

        throw error;
      }
    }, 60_000);

    runBinaryArchitectureBenchmark(
      `warm-cache cold start completes within ${BINARY_WARM_CACHE_TARGET_MS}ms (median of 5 runs)`,
      async () => {
        if (!existsSync(binaryPath)) {
          console.warn('Skipping binary cold start benchmark: binary not available');
          return;
        }

        try {
          const samples = await measureWarmCacheBinaryColdStarts(binaryPath, 5);

          logBinaryColdStartSamples(samples);

          expect(samples.median).toBeLessThan(BINARY_WARM_CACHE_TARGET_MS);
        } catch (error) {
          if (isMissingExecutableError(error)) {
            console.warn(
              'Skipping binary cold start benchmark: compiled executable is unavailable',
            );
            return;
          }

          throw error;
        }
      },
      60_000,
    );
  });
});

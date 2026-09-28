/**
 * `bun --watch`-driven host restart recovers a durable run (COR-243).
 *
 * Spawns a REAL `bun --watch <entrypoint>` subprocess -- not a manual
 * SIGKILL-and-respawn (`spawnServerSubprocess`/`killAndReboot`'s own
 * scenario in `remote-worker-reconnection.test.ts`) -- durably starts a
 * workflow that parks on `ctx.waitForSignal`, then edits a file the
 * entrypoint imports so `bun --watch` itself detects the change and
 * reloads the process. Empirically confirmed against Bun 1.4.2 before
 * writing this test (a throwaway harness spawning `bun --watch` directly and
 * inspecting `process.pid` and `ps`/`pgrep` across an edit-triggered
 * restart, not committed here):
 * `bun --watch` re-executes the target module in the SAME OS process (no
 * child process, so no orphan-process risk) but with a FRESH module scope --
 * every top-level binding, including the `Engine` instance and its
 * `Bun.serve()` listener, is torn down and recreated. That is exactly what
 * this test needs to prove durable-recovery-across-restart with: the
 * pre-restart generator instance is gone, and only a durable read of the
 * `waitForSignal` checkpoint through a freshly-constructed `Engine` can
 * complete the run.
 *
 * Ordering is proven by markers this test polls for in the subprocess's
 * accumulated stdout (`waitForMarker`, mirroring
 * `remote-worker-reconnection.test.ts`'s own `waitForTestDispatchUrl`
 * pattern) and by polling the real HTTP API for the workflow's terminal
 * state -- never a fixed sleep standing in for either transition.
 *
 * @module server/bun-watch-restart.test
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { sleepForTesting } from '../testing/fake-timers.test-support.ts';

const REVISION_MODULE_NAME = 'revision.ts';

function entrypointSource(): string {
  const repoRoot = new URL('../..', import.meta.url);
  const indexUrl = new URL('src/index.ts', repoRoot).href;
  const serverUrl = new URL('src/server/index.ts', repoRoot).href;
  const sqliteUrl = new URL('src/storage/bun-sql.ts', repoRoot).href;
  return `
import { GENERATION } from './${REVISION_MODULE_NAME}';
import { Engine, workflow } from ${JSON.stringify(indexUrl)};
import { serve } from ${JSON.stringify(serverUrl)};
import { BunSQLiteStorage } from ${JSON.stringify(sqliteUrl)};

function readArgument(name, fallback) {
  const index = Bun.argv.indexOf(name);
  if (index === -1) return fallback;
  return Bun.argv[index + 1] ?? fallback;
}

const port = Number(readArgument('--port', '0'));
const databasePath = readArgument('--database', ':memory:');

const watchRestartWorkflow = workflow({ name: 'watch-restart-workflow' }).execute(
  async function* (ctx) {
    const value = yield* ctx.waitForSignal('release');
    return { value, generation: GENERATION };
  },
);

const storage = new BunSQLiteStorage(databasePath);
const engine = new Engine({ storage });
engine.register(watchRestartWorkflow);
await engine.recoverAll();

const server = serve({ engine, port, hostname: '127.0.0.1' });

if (GENERATION === 1) {
  await engine.start('watch-restart-workflow', undefined, { id: 'watch-restart-run' });
  console.log('CHECKPOINTED gen=' + GENERATION);
}

console.log('READY gen=' + GENERATION + ' url=' + server.url);
`;
}

/** Poll `handle`'s accumulated stdout for `pattern`, mirroring `waitForTestDispatchUrl`'s bounded real-clock poll -- an OBSERVED marker, not a fixed sleep standing in for the thing under test. */
async function waitForMarker(
  stdout: () => string,
  pattern: RegExp,
  timeoutMs: number,
): Promise<RegExpMatchArray> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = stdout().match(pattern);
    if (match !== null) return match;
    await sleepForTesting(20);
  }
  throw new Error(`Marker ${pattern} did not appear in subprocess stdout within ${timeoutMs}ms`);
}

/** Poll the real HTTP API for the run's terminal status -- an observed server response, not a timer. */
async function waitForWorkflowCompleted(
  baseUrl: string,
  workflowId: string,
  timeoutMs: number,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/v1/workflows/${workflowId}`).catch(() => null);
    if (response?.ok) {
      const body = (await response.json()) as { status?: string; result?: unknown };
      if (body.status === 'completed') return body.result;
      if (body.status === 'failed' || body.status === 'cancelled') {
        throw new Error(`workflow ended as ${body.status}`);
      }
    }
    await sleepForTesting(20);
  }
  throw new Error(`Workflow ${workflowId} did not complete within ${timeoutMs}ms`);
}

describe('bun --watch drives durable-run recovery across a real restart (COR-243)', () => {
  const cleanupDirs: string[] = [];
  let subprocess: ReturnType<typeof Bun.spawn> | undefined;
  let stdoutReaderTask: Promise<void> | undefined;
  let stdoutReaderError: unknown;
  let stoppingSubprocess = false;

  afterEach(async () => {
    stoppingSubprocess = true;
    if (subprocess) {
      subprocess.kill();
      await subprocess.exited.catch(() => {});
      subprocess = undefined;
    }
    await stdoutReaderTask;
    stdoutReaderTask = undefined;
    for (const dir of cleanupDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
    const readerError = stdoutReaderError;
    stdoutReaderError = undefined;
    stoppingSubprocess = false;
    if (readerError !== undefined) throw readerError;
  });

  it('recovers a workflow parked on ctx.waitForSignal after bun --watch reloads the module', async () => {
    const directory = join(tmpdir(), `weft-bun-watch-${crypto.randomUUID()}`);
    await Bun.write(join(directory, REVISION_MODULE_NAME), 'export const GENERATION = 1;\n');
    const entrypoint = join(directory, 'entry.ts');
    await Bun.write(entrypoint, entrypointSource());
    cleanupDirs.push(directory);
    const databasePath = join(directory, 'weft.db');

    let stdoutText = '';
    const watchProcess = Bun.spawn({
      cmd: ['bun', '--watch', entrypoint, '--database', databasePath],
      cwd: directory,
      stdout: 'pipe',
      stderr: 'inherit',
    });
    subprocess = watchProcess;
    stdoutReaderTask = (async () => {
      const decoder = new TextDecoder();
      const reader = watchProcess.stdout.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          stdoutText += decoder.decode(value);
        }
      } finally {
        reader.releaseLock();
      }
    })().catch((error: unknown) => {
      if (!stoppingSubprocess) stdoutReaderError = error;
    });

    await waitForMarker(() => stdoutText, /CHECKPOINTED gen=1/, 10_000);
    const firstReady = await waitForMarker(() => stdoutText, /READY gen=1 url=(\S+)/, 10_000);
    const firstUrl = firstReady[1];
    if (firstUrl === undefined) throw new Error('unreachable');

    // The durable checkpoint exists before any restart: readable over the
    // real HTTP API through the generation-1 process.
    const beforeRestart = await fetch(`${firstUrl}/v1/workflows/watch-restart-run`);
    expect(beforeRestart.ok).toBe(true);
    expect(((await beforeRestart.json()) as { status: string }).status).toBe('running');

    // Trigger bun --watch's own restart by editing the file the entrypoint
    // imports -- never a manual kill-and-respawn.
    await Bun.write(join(directory, REVISION_MODULE_NAME), 'export const GENERATION = 2;\n');

    const secondReady = await waitForMarker(() => stdoutText, /READY gen=2 url=(\S+)/, 10_000);
    const secondUrl = secondReady[1];
    if (secondUrl === undefined) throw new Error('unreachable');

    // A fresh Engine instance in a reloaded module scope, over the SAME
    // durable SQLite file, is the only thing that can now resume this run --
    // the generation-1 generator and its in-memory waiter are gone.
    const signalResponse = await fetch(
      `${secondUrl}/v1/workflows/watch-restart-run/signal/release`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload: 'go' }),
      },
    );
    expect(signalResponse.ok).toBe(true);

    const result = await waitForWorkflowCompleted(secondUrl, 'watch-restart-run', 10_000);
    // Durable replay re-invokes the SAME `watch-restart-run` execution's
    // generator function from the top (fast-forwarded past its recorded
    // history) inside the freshly reloaded module -- so `generation` in the
    // result is 2, the value the generation-2 process's own closure binds,
    // not the value that was live when the run started. That is exactly
    // `bun --watch`'s "coarse but consistent" contract this test proves:
    // the generator closure and the engine singleton reload TOGETHER, so
    // nothing observes a torn mix of old-generator/new-engine state -- the
    // failure mode this project's documentation names `bun --hot` for.
    expect(result).toEqual({ value: 'go', generation: 2 });
  }, 30_000);
});

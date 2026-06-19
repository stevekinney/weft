import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { HttpClient } from '../client/http-client.ts';
import type { WorkflowState } from '../core/types.ts';
import { sleepForTesting } from './fake-timers.test-support.ts';
import {
  killAndReboot,
  spawnServerSubprocess,
  type SubprocessServerHandle,
} from './subprocess-engine.ts';

const repositoryRoot = new URL('../..', import.meta.url);
const indexModuleUrl = new URL('src/index.ts', repositoryRoot).href;
const serverModuleUrl = new URL('src/server/index.ts', repositoryRoot).href;
const sqliteModuleUrl = new URL('src/storage/bun-sql.ts', repositoryRoot).href;

const createdFixtures: string[] = [];
let handles: SubprocessServerHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.map((handle) => handle.stop()));
  handles = [];
  for (const fixture of createdFixtures.splice(0)) {
    rmSync(fixture, { force: true, recursive: true });
    rmSync(`${fixture}-wal`, { force: true });
    rmSync(`${fixture}-shm`, { force: true });
  }
});

function createFixturePath(name: string): string {
  const directory = join(tmpdir(), `weft-subprocess-${name}-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  createdFixtures.push(directory);
  return directory;
}

async function writeEntrypoint(name: string, source: string): Promise<string> {
  const directory = createFixturePath(name);
  const path = join(directory, 'entrypoint.ts');
  await Bun.write(path, source);
  return path;
}

function parseArgumentsSource(): string {
  return `
function readOption(name, fallback) {
  const index = Bun.argv.indexOf(name);
  if (index === -1) return fallback;
  return Bun.argv[index + 1] ?? fallback;
}
const port = Number(readOption('--port', '0'));
const databasePath = readOption('--database', ':memory:');
`;
}

function durableEntrypointSource(): string {
  return `
import { Engine, activity, workflow } from ${JSON.stringify(indexModuleUrl)};
import { serve } from ${JSON.stringify(serverModuleUrl)};
import { BunSQLiteStorage } from ${JSON.stringify(sqliteModuleUrl)};

${parseArgumentsSource()}

async function waitForFile(path) {
  while (!(await Bun.file(path).exists())) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function incrementFile(path) {
  const current = (await Bun.file(path).exists()) ? Number(await Bun.file(path).text()) : 0;
  const next = current + 1;
  await Bun.write(path, String(next));
  return next;
}

const countPath = Bun.env.WEFT_ACTIVITY_COUNT_PATH;
const startedPath = Bun.env.WEFT_ACTIVITY_STARTED_PATH;
const releasePath = Bun.env.WEFT_ACTIVITY_RELEASE_PATH;
if (!countPath || !startedPath || !releasePath) {
  throw new Error('missing subprocess durability environment paths');
}

const countedActivity = activity({
  name: 'countedActivity',
  execute: async () => incrementFile(countPath),
});

const blockingActivity = activity({
  name: 'blockingActivity',
  execute: async () => {
    const attempt = await incrementFile(startedPath);
    await waitForFile(releasePath);
    return attempt;
  },
});

const storage = new BunSQLiteStorage(databasePath);
const engine = new Engine({ storage });
engine.register(countedActivity);
engine.register(blockingActivity);
const activityThenSignal = workflow({ name: 'activity-then-signal' }).execute(async function* (ctx) {
  const activityCount = yield* ctx.run('countedActivity');
  const signalPayload = yield* ctx.waitForSignal('finish');
  return { activityCount, signalPayload };
});
const blockingActivityWorkflow = workflow({ name: 'blocking-activity' }).execute(async function* (ctx) {
  const attempt = yield* ctx.run('blockingActivity');
  return { attempt };
});
const signalOnly = workflow({ name: 'signal-only' }).execute(async function* (ctx) {
  const signalPayload = yield* ctx.waitForSignal('finish');
  return { signalPayload };
});
engine.register(activityThenSignal);
engine.register(blockingActivityWorkflow);
engine.register(signalOnly);
await engine.recoverAll();
const server = serve({ engine, port, hostname: '127.0.0.1' });
console.log('WEFT_SUBPROCESS_READY ' + server.url);

async function stop(exitCode) {
  await server.stop();
  storage[Symbol.dispose]();
  process.exit(exitCode);
}
process.on('SIGTERM', () => void stop(0));
process.on('SIGINT', () => void stop(0));
`;
}

async function waitForWorkflowStatus(
  client: HttpClient,
  workflowId: string,
  predicate: (state: WorkflowState) => boolean,
  label: string,
): Promise<WorkflowState> {
  const deadline = Date.now() + 3_000;
  let lastState: WorkflowState | null = null;
  while (Date.now() < deadline) {
    lastState = await client.get(workflowId);
    if (lastState !== null && predicate(lastState)) return lastState;
    await sleepForTesting(10);
  }
  throw new Error(`Timed out waiting for ${label}; last state: ${JSON.stringify(lastState)}`);
}

async function waitForFileText(path: string, expected: string, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if ((await Bun.file(path).exists()) && (await Bun.file(path).text()) === expected) return;
    await sleepForTesting(10);
  }
  const actual = (await Bun.file(path).exists()) ? await Bun.file(path).text() : '<missing>';
  throw new Error(`Timed out waiting for ${label}; got ${actual}`);
}

async function readWorkflowResult(baseUrl: string, workflowId: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}/v1/workflows/${encodeURIComponent(workflowId)}/result`);
  if (!response.ok) {
    throw new Error(`Result request failed with ${response.status}: ${await response.text()}`);
  }
  const body = (await response.json()) as { result: unknown };
  return body.result;
}

async function startDurableServer(
  entrypoint: string,
  databasePath: string,
  port = 0,
  options: { startupTimeoutMs?: number } = {},
) {
  const directory = dirname(databasePath);
  const handle = await spawnServerSubprocess({
    entrypoint,
    databasePath,
    port,
    ...options,
    env: {
      WEFT_ACTIVITY_COUNT_PATH: join(directory, 'activity-count.txt'),
      WEFT_ACTIVITY_STARTED_PATH: join(directory, 'activity-started.txt'),
      WEFT_ACTIVITY_RELEASE_PATH: join(directory, 'activity-release.txt'),
    },
  });
  handles.push(handle);
  return handle;
}

describe('subprocess server harness', () => {
  it('surfaces startup crashes with captured stderr', async () => {
    const entrypoint = await writeEntrypoint(
      'startup-crash',
      "console.error('startup exploded'); process.exit(42);",
    );

    await expect(
      spawnServerSubprocess({
        entrypoint,
        databasePath: join(createFixturePath('startup-crash-db'), 'weft.db'),
      }),
    ).rejects.toThrow(/startup exploded/);
  });

  it('rejects killAndReboot when the subprocess already exited without a signal', async () => {
    const entrypoint = await writeEntrypoint(
      'early-exit',
      `
${parseArgumentsSource()}
console.log('WEFT_SUBPROCESS_READY http://127.0.0.1:' + port);
// Exit well after the parent's post-readiness stabilization window
// (verifyProcessSurvivedReadiness waits up to 50ms); a short delay races that
// window under load and trips a spurious "exited after readiness" rejection.
setTimeout(() => process.exit(17), 1_000);
`,
    );
    const handle = await spawnServerSubprocess({
      entrypoint,
      databasePath: join(createFixturePath('early-exit-db'), 'weft.db'),
    });
    handles.push(handle);

    await handle.process.exited;
    await expect(killAndReboot(handle)).rejects.toThrow(/already exited/);
  });

  it('rejects a subprocess that exits immediately after printing readiness', async () => {
    const entrypoint = await writeEntrypoint(
      'ready-then-exit',
      `
${parseArgumentsSource()}
console.log('WEFT_SUBPROCESS_READY http://127.0.0.1:' + port);
process.exit(0);
`,
    );

    await expect(
      spawnServerSubprocess({
        entrypoint,
        databasePath: join(createFixturePath('ready-then-exit-db'), 'weft.db'),
      }),
    ).rejects.toThrow(/after readiness/);
  });

  it('rejects readiness URLs without explicit ports', async () => {
    const entrypoint = await writeEntrypoint(
      'ready-without-port',
      `
console.log('WEFT_SUBPROCESS_READY http://127.0.0.1');
setInterval(() => {}, 1000);
`,
    );

    await expect(
      spawnServerSubprocess({
        entrypoint,
        databasePath: join(createFixturePath('ready-without-port-db'), 'weft.db'),
      }),
    ).rejects.toThrow(/explicit port/);
  });

  it('surfaces bind failures on a reused port', async () => {
    const entrypoint = await writeEntrypoint('bind-failure', durableEntrypointSource());
    const databasePath = join(createFixturePath('bind-failure-db'), 'weft.db');
    const handle = await startDurableServer(entrypoint, databasePath);
    handle.process.kill('SIGKILL');
    await handle.process.exited;
    const portBlocker = Bun.serve({
      hostname: '127.0.0.1',
      port: handle.port,
      fetch: () => new Response('blocked'),
    });

    try {
      // A subprocess that cannot bind the reused port either exits before
      // readiness or logs EADDRINUSE — both are causally tied to the port being
      // occupied. The startup timeout is generous (5s) so that, under test-suite
      // concurrency, the blocked subprocess has time to actually exit or log the
      // bind error rather than tripping the readiness-timeout path. Keeping the
      // assertion to these two messages preserves the test's intent: it must not
      // pass merely because some unrelated startup delay timed out.
      await expect(
        startDurableServer(entrypoint, databasePath, handle.port, { startupTimeoutMs: 5000 }),
      ).rejects.toThrow(/before readiness|EADDRINUSE/);
    } finally {
      portBlocker.stop(true);
    }
  });

  it('does not forward parent secrets unless explicitly requested', async () => {
    const entrypoint = await writeEntrypoint(
      'environment-allowlist',
      `
${parseArgumentsSource()}
if (Bun.env.WEFT_PARENT_SECRET === 'do-not-forward') {
  console.error('secret leaked');
  process.exit(9);
}
if (Bun.env.WEFT_EXPLICIT_VALUE !== 'forwarded') {
  console.error('explicit environment missing');
  process.exit(10);
}
console.log('WEFT_SUBPROCESS_READY http://127.0.0.1:' + port);
setInterval(() => {}, 1000);
`,
    );
    Bun.env['WEFT_PARENT_SECRET'] = 'do-not-forward';
    try {
      const handle = await spawnServerSubprocess({
        entrypoint,
        databasePath: join(createFixturePath('environment-allowlist-db'), 'weft.db'),
        env: { WEFT_EXPLICIT_VALUE: 'forwarded' },
      });
      handles.push(handle);
      expect(handle.stderr).not.toContain('secret leaked');
    } finally {
      delete Bun.env['WEFT_PARENT_SECRET'];
    }
  });

  it('rejects clean exits that do not report signal termination', async () => {
    const entrypoint = await writeEntrypoint(
      'sigterm-clean-exit',
      `
${parseArgumentsSource()}
console.log('WEFT_SUBPROCESS_READY http://127.0.0.1:' + port);
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`,
    );
    let handle = await spawnServerSubprocess({
      entrypoint,
      databasePath: join(createFixturePath('sigterm-clean-exit-db'), 'weft.db'),
    });
    handles.push(handle);

    await expect(killAndReboot(handle, 'SIGTERM')).rejects.toThrow(/Expected subprocess/);
  });

  it('recovers a parked workflow after SIGKILL without re-running a completed activity', async () => {
    const directory = createFixturePath('parked');
    const databasePath = join(directory, 'weft.db');
    const entrypoint = await writeEntrypoint('parked-entrypoint', durableEntrypointSource());
    let handle = await startDurableServer(entrypoint, databasePath);
    const client = new HttpClient({ baseUrl: handle.url });

    const workflow = await client.start('activity-then-signal', null, { id: 'parked-workflow' });
    await waitForWorkflowStatus(
      client,
      workflow.id,
      (state) => state.status === 'running',
      'workflow to park',
    );
    await waitForFileText(join(directory, 'activity-count.txt'), '1', 'activity count');

    handle = await killAndReboot(handle);
    handles.push(handle);
    const rebootedClient = new HttpClient({ baseUrl: handle.url });
    expect(handle.command).toContain('--port');
    expect(handle.command).toContain('0');
    await rebootedClient.signal(workflow.id, 'finish', 'done');

    await expect(readWorkflowResult(handle.url, workflow.id)).resolves.toEqual({
      activityCount: 1,
      signalPayload: 'done',
    });
    expect(await Bun.file(join(directory, 'activity-count.txt')).text()).toBe('1');
  });

  it('re-dispatches an in-flight activity after SIGKILL', async () => {
    const directory = createFixturePath('in-flight');
    const databasePath = join(directory, 'weft.db');
    const entrypoint = await writeEntrypoint('in-flight-entrypoint', durableEntrypointSource());
    let handle = await startDurableServer(entrypoint, databasePath);
    const client = new HttpClient({ baseUrl: handle.url });

    const workflow = await client.start('blocking-activity', null, { id: 'in-flight-workflow' });
    await waitForFileText(join(directory, 'activity-started.txt'), '1', 'first activity dispatch');

    handle = await killAndReboot(handle);
    handles.push(handle);
    await waitForFileText(join(directory, 'activity-started.txt'), '2', 'second activity dispatch');
    await Bun.write(join(directory, 'activity-release.txt'), 'go');

    await expect(readWorkflowResult(handle.url, workflow.id)).resolves.toEqual({ attempt: 2 });
  });

  it('accepts a signal over the wire after reboot and completes the recovered workflow', async () => {
    const directory = createFixturePath('queued-signal');
    const databasePath = join(directory, 'weft.db');
    const entrypoint = await writeEntrypoint('queued-signal-entrypoint', durableEntrypointSource());
    let handle = await startDurableServer(entrypoint, databasePath);
    const client = new HttpClient({ baseUrl: handle.url });

    const workflow = await client.start('signal-only', null, { id: 'signal-only-workflow' });
    await waitForWorkflowStatus(
      client,
      workflow.id,
      (state) => state.status === 'running',
      'signal-only workflow to park',
    );

    handle = await killAndReboot(handle);
    handles.push(handle);
    const rebootedClient = new HttpClient({ baseUrl: handle.url });
    await rebootedClient.signal(workflow.id, 'finish', { ok: true });

    await expect(readWorkflowResult(handle.url, workflow.id)).resolves.toEqual({
      signalPayload: { ok: true },
    });
  });
});

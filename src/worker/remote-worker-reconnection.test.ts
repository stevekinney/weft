/**
 * RemoteWorker WebSocket protocol durability tests.
 *
 * Four scenarios cover: visibility-timeout takeover (scanner path),
 * idempotent rejection of stale completions from displaced workers (covered
 * for the different-`workerId` takeover case only; same-`workerId`
 * reselection on a later attempt is documented as out-of-scope in
 * `onTaskResultMessage`'s ownership-guard comment), transient reconnect
 * continuity, and server-restart-while-leased recovery. The fault-injecting helper at
 * `../testing/worker-fault-injection.test-support.ts` gives tests byte-level control of the
 * WebSocket so partition and abrupt-close behaviors are reproducible.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Engine } from '../core/engine.ts';
import { serve, type ServeOptions, type WeftServer } from '../server/index.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { sleepForTesting } from '../testing/fake-timers.test-support.ts';
import {
  killAndReboot,
  spawnServerSubprocess,
  type SubprocessServerHandle,
} from '../testing/subprocess-engine.ts';
import {
  connectFaultInjectingWorker,
  type FaultInjectingWorker,
} from '../testing/worker-fault-injection.test-support.ts';
import { RemoteWorker } from './index.ts';
import type { ServerToWorkerMessage, TaskMessage } from './protocol.ts';

type Setup = {
  engine: Engine;
  server: WeftServer;
  workerUrl: string;
};

const sockets: FaultInjectingWorker[] = [];
let activeSetup: Setup | null = null;

afterEach(async () => {
  for (const worker of sockets.splice(0)) {
    try {
      await worker.hardClose();
    } catch {
      // Ignore.
    }
  }
  if (activeSetup !== null) {
    try {
      await activeSetup.server.stop?.();
    } catch {
      // Ignore.
    }
    try {
      activeSetup.engine[Symbol.dispose]();
    } catch {
      // Ignore.
    }
    activeSetup = null;
  }
});

function createSetup(overrides: Partial<Omit<ServeOptions, 'engine'>> = {}): Setup {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  const server = serve({
    engine,
    port: 0,
    routingPolicy: 'round-robin',
    visibilityPollIntervalMs: 20,
    workerReconnectGracePeriodMs: 50,
    ...overrides,
  });
  const workerUrl = `${server.url.replace(/^http/, 'ws').replace(/\/?$/, '/')}v1/tasks/default/stream`;
  const setup: Setup = { engine, server, workerUrl };
  activeSetup = setup;
  return setup;
}

async function connectAndRegisterWorker(
  setup: Setup,
  workerId: string,
  options: { activities?: string[]; concurrency?: number } = {},
): Promise<FaultInjectingWorker> {
  const worker = await connectFaultInjectingWorker({ url: setup.workerUrl, workerId });
  sockets.push(worker);
  worker.send({
    type: 'register',
    protocolVersion: 2,
    workerId,
    activities: options.activities ?? ['echo'],
    concurrency: options.concurrency ?? 1,
    queue: 'default',
  });
  await worker.nextServerMessage((m) => m.type === 'registerAck', { timeoutMs: 1_000 });
  return worker;
}

function isTask(message: ServerToWorkerMessage): message is TaskMessage {
  return message.type === 'task';
}

async function readResolvedRecord(engine: Engine, operationId: string): Promise<unknown> {
  return engine.storage.get(KEYS.operationResolved(operationId));
}

/** Wait until the inflight record is absent (null/undefined). */
async function waitForInflightCleared(
  engine: Engine,
  operationId: string,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 2_000);
  let value: unknown;
  while (Date.now() < deadline) {
    value = await engine.storage.get(KEYS.operationInflight(operationId));
    if (value === undefined || value === null) return;
    await sleepForTesting(5);
  }
  throw new Error(
    `Timed out waiting for inflight record of "${operationId}" to clear; last value type=${typeof value}, length=${(value as Uint8Array | null | undefined)?.byteLength ?? 'n/a'}`,
  );
}

describe('RemoteWorker durability — scanner-driven takeover', () => {
  it("redispatches a partitioned worker's task to a peer when the visibility deadline expires", async () => {
    const setup = createSetup();

    const workerA = await connectAndRegisterWorker(setup, 'worker-a');
    const workerB = await connectAndRegisterWorker(setup, 'worker-b');

    const operationId = 'scenario-1-op';
    void setup.server.dispatchTask({
      operationId,
      activityName: 'echo',
      input: { value: 'v' },
      // The visibilityTimeout governs BOTH worker-a's expiry (drives the
      // takeover) and worker-b's expiry (after takeover B has this long to
      // respond before another requeue). 250ms is short enough that the
      // initial takeover happens within the test budget but borderline for
      // B's response window under load. After we observe B's takeover
      // dispatch, we set the engine's effective deadline-tracker entry to
      // a long value below by sending a heartbeat from B before responding,
      // so the test's resolved-state polling cannot race the scanner.
      visibilityTimeout: 250,
    });

    const dispatchToA = await workerA.nextServerMessage(isTask, { timeoutMs: 2_000 });
    if (!isTask(dispatchToA)) throw new Error('expected task');
    expect(dispatchToA.operationId).toBe(operationId);
    expect(dispatchToA.attempt ?? 1).toBe(1);

    workerA.partition();

    const dispatchToB = await workerB.nextServerMessage(isTask, { timeoutMs: 5_000 });
    if (!isTask(dispatchToB)) throw new Error('expected task on B');
    expect(dispatchToB.operationId).toBe(operationId);
    expect(dispatchToB.attempt ?? 1).toBe(2);

    // Stay-connected assertion: worker-a's WS is still open at the moment B
    // receives the takeover. This pins that the path exercised is the scanner,
    // not a close-handler-triggered requeue.
    expect(workerA.closedState).toBe('open');

    // Watch for any inbound message on B to spot a possible protocolError.
    const allBMessages: ServerToWorkerMessage[] = [];
    workerB.onServerMessage((m) => allBMessages.push(m));

    // Send a heartbeat to extend B's deadline — the test's wall-clock should
    // not race the scanner.
    workerB.send({ type: 'heartbeat', workerId: 'worker-b' });

    workerB.send({
      type: 'taskResult',
      operationId,
      status: 'completed',
      value: 'v',
      attemptToken: dispatchToB.attemptToken!,
    });

    // The resolved record appears once the server processes the completion.
    let resolved: unknown;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      resolved = await readResolvedRecord(setup.engine, operationId);
      if (resolved !== undefined) break;
      await sleepForTesting(10);
    }
    expect(resolved).not.toBeUndefined();
    await waitForInflightCleared(setup.engine, operationId);
    expect(allBMessages.every((m) => m.type !== 'protocolError')).toBe(true);
  });
});

describe('RemoteWorker durability — idempotent duplicate completion (different-worker takeover)', () => {
  // Scope note: this scenario covers the case where takeover moves the task to a
  // different `workerId`, which the `(operationId, workerId)` ownership guard
  // alone rejects. The same-`workerId` reselection case (a single-worker
  // deployment whose only worker times out and is then re-selected for the next
  // attempt) is now defended by the per-dispatch attempt token — see the
  // dedicated test below and the attempt guard in `onTaskResultMessage`.
  it('rejects a stale completion from a displaced worker before and after final resolution', async () => {
    const setup = createSetup();
    const workerA = await connectAndRegisterWorker(setup, 'worker-a');
    const workerB = await connectAndRegisterWorker(setup, 'worker-b');

    const operationId = 'scenario-2-op';
    void setup.server.dispatchTask({
      operationId,
      activityName: 'echo',
      input: { value: 'real' },
      visibilityTimeout: 30_000, // long — we drive takeover via hardClose
    });

    const dispatchToA = await workerA.nextServerMessage(isTask, { timeoutMs: 2_000 });
    if (!isTask(dispatchToA)) throw new Error('expected task');
    expect(dispatchToA.operationId).toBe(operationId);

    await workerA.hardClose();

    const dispatchToB = await workerB.nextServerMessage(isTask, { timeoutMs: 5_000 });
    if (!isTask(dispatchToB)) throw new Error('expected task on B');
    expect(dispatchToB.operationId).toBe(operationId);

    // Phase 2a: worker-a reconnects (new socket, same id) and sends a stale
    // completion BEFORE worker-b has resolved its attempt.
    const workerAPrime = await connectAndRegisterWorker(setup, 'worker-a');
    const protocolErrorPromise = workerAPrime.nextServerMessage((m) => m.type === 'protocolError', {
      timeoutMs: 2_000,
    });
    workerAPrime.send({
      type: 'taskResult',
      operationId,
      status: 'completed',
      value: 'stale-from-a',
    });
    const protocolError = await protocolErrorPromise;
    if (protocolError.type !== 'protocolError') throw new Error('expected protocolError');
    expect(protocolError.code).toBe('invalid_message');
    expect(protocolError.message).toContain(operationId);

    // Workflow attempt is still in flight on B at this point — no resolved record.
    const inflightDuring2a = await setup.engine.storage.get(KEYS.operationInflight(operationId));
    expect(inflightDuring2a !== undefined && inflightDuring2a !== null).toBe(true);
    const resolvedDuring2a = await setup.engine.storage.get(KEYS.operationResolved(operationId));
    expect(resolvedDuring2a === undefined || resolvedDuring2a === null).toBe(true);

    // Worker-b completes the real attempt.
    workerB.send({
      type: 'taskResult',
      operationId,
      status: 'completed',
      value: 'real',
      attemptToken: dispatchToB.attemptToken!,
    });

    let resolved: unknown;
    const phase2aDeadline = Date.now() + 2_000;
    while (Date.now() < phase2aDeadline) {
      resolved = await readResolvedRecord(setup.engine, operationId);
      if (resolved !== undefined && resolved !== null) break;
      await sleepForTesting(10);
    }
    expect(resolved !== undefined && resolved !== null).toBe(true);

    // Phase 2b: after completion, worker-a' sends the same stale completion again.
    const secondErrorPromise = workerAPrime.nextServerMessage((m) => m.type === 'protocolError', {
      timeoutMs: 2_000,
    });
    workerAPrime.send({
      type: 'taskResult',
      operationId,
      status: 'completed',
      value: 'stale-from-a-again',
    });
    const secondError = await secondErrorPromise;
    if (secondError.type !== 'protocolError') throw new Error('expected protocolError');
    expect(secondError.code).toBe('invalid_message');
    expect(secondError.message).toContain(operationId);

    const stillResolved = await readResolvedRecord(setup.engine, operationId);
    expect(stillResolved !== undefined && stillResolved !== null).toBe(true);
    await waitForInflightCleared(setup.engine, operationId);
  });
});

describe('RemoteWorker durability — same-worker stale attempt (attempt token)', () => {
  it('rejects a stale completion from an earlier attempt reselected on the same worker', async () => {
    // The case the (operationId, workerId) guard alone cannot catch: a SINGLE
    // worker whose attempt times out is re-selected for the next attempt, so the
    // workerId still matches. The per-dispatch attempt token is the only field
    // that distinguishes attempt 1 from attempt 2. We use exactly one worker so
    // re-dispatch deterministically reselects it.
    const setup = createSetup();
    const workerA = await connectAndRegisterWorker(setup, 'worker-a');

    const operationId = 'same-worker-stale-op';
    void setup.server.dispatchTask({
      operationId,
      activityName: 'echo',
      input: { value: 'v' },
      // Short timeout so attempt 1 expires and the scanner re-dispatches to the
      // only worker (worker-a) as attempt 2.
      visibilityTimeout: 150,
    });

    const dispatch1 = await workerA.nextServerMessage(isTask, { timeoutMs: 2_000 });
    if (!isTask(dispatch1)) throw new Error('expected first dispatch');
    expect(dispatch1.operationId).toBe(operationId);
    expect(dispatch1.attempt ?? 1).toBe(1);
    expect(dispatch1.attemptToken).toBeString();

    // Do NOT complete attempt 1. Wait for the visibility timeout to re-dispatch
    // the SAME operation to the SAME worker as attempt 2 with a fresh token.
    const dispatch2 = await workerA.nextServerMessage(isTask, { timeoutMs: 5_000 });
    if (!isTask(dispatch2)) throw new Error('expected re-dispatch');
    expect(dispatch2.operationId).toBe(operationId);
    expect(dispatch2.attempt ?? 1).toBe(2);
    expect(dispatch2.attemptToken).toBeString();
    // The token rotated even though the worker id did not.
    expect(dispatch2.attemptToken).not.toBe(dispatch1.attemptToken);

    // Extend the deadline so the scanner cannot re-dispatch again mid-test.
    workerA.send({ type: 'heartbeat', workerId: 'worker-a' });

    // Stale completion: worker-a echoes attempt 1's token. Same workerId, so the
    // ownership guard passes — the attempt guard must reject it.
    const staleError = workerA.nextServerMessage((m) => m.type === 'protocolError', {
      timeoutMs: 2_000,
    });
    workerA.send({
      type: 'taskResult',
      operationId,
      status: 'completed',
      value: 'stale-attempt-1',
      attemptToken: dispatch1.attemptToken!,
    });
    const rejected = await staleError;
    if (rejected.type !== 'protocolError') throw new Error('expected protocolError');
    expect(rejected.code).toBe('invalid_message');
    expect(rejected.message).toContain(operationId);

    // The stale completion was a no-op: still in flight, not resolved.
    const resolvedAfterStale = await readResolvedRecord(setup.engine, operationId);
    expect(resolvedAfterStale === undefined || resolvedAfterStale === null).toBe(true);

    // Fresh completion: worker-a echoes attempt 2's token — accepted.
    workerA.send({
      type: 'taskResult',
      operationId,
      status: 'completed',
      value: 'fresh-attempt-2',
      attemptToken: dispatch2.attemptToken!,
    });

    let resolved: unknown;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      resolved = await readResolvedRecord(setup.engine, operationId);
      if (resolved !== undefined && resolved !== null) break;
      await sleepForTesting(10);
    }
    expect(resolved !== undefined && resolved !== null).toBe(true);
    await waitForInflightCleared(setup.engine, operationId);
  });
});

describe('RemoteWorker durability — transient reconnect continuity', () => {
  it('honors a reconnect within the grace period and suppresses requeue', async () => {
    // Grace period 1000ms (well above CI handshake jitter) and a 1200ms
    // expectNoServerMessage window: enough margin that hardClose + connect +
    // register reliably completes inside the grace window, and the grace
    // timer reliably fires inside our wait so we are testing
    // cancel-on-reregister rather than result-arrived-before-timer-fired.
    const setup = createSetup({ workerReconnectGracePeriodMs: 1_000 });
    const workerA = await connectAndRegisterWorker(setup, 'worker-a');

    const operationId = 'scenario-3-op';
    void setup.server.dispatchTask({
      operationId,
      activityName: 'echo',
      input: { value: 'v' },
      visibilityTimeout: 30_000,
    });

    const dispatch = await workerA.nextServerMessage(isTask, { timeoutMs: 2_000 });
    if (!isTask(dispatch)) throw new Error('expected task');
    expect(dispatch.operationId).toBe(operationId);

    await workerA.hardClose();

    const workerAPrime = await connectAndRegisterWorker(setup, 'worker-a');

    // Wait past the grace period: prove that no `task` frame arrived during
    // the deferred-requeue window — only `registerAck` shows up.
    await workerAPrime.expectNoServerMessage(isTask, { timeoutMs: 1_200 });

    workerAPrime.send({
      type: 'taskResult',
      operationId,
      status: 'completed',
      value: 'v',
      attemptToken: dispatch.attemptToken!,
    });

    let resolved: unknown;
    const scenario3Deadline = Date.now() + 2_000;
    while (Date.now() < scenario3Deadline) {
      resolved = await readResolvedRecord(setup.engine, operationId);
      if (resolved !== undefined && resolved !== null) break;
      await sleepForTesting(10);
    }
    expect(resolved !== undefined && resolved !== null).toBe(true);
    await waitForInflightCleared(setup.engine, operationId);
  });
});

describe('RemoteWorker durability — backpressure decline is redelivered', () => {
  it('redelivers a task that a buffer-full RemoteWorker declines without executing', async () => {
    // workerReconnectGracePeriodMs is short so the decline (which fails the SDK
    // worker's socket) is treated as a disconnect and the task becomes eligible
    // for redelivery quickly. visibilityTimeout is the redelivery ceiling.
    const setup = createSetup({ workerReconnectGracePeriodMs: 30 });

    // worker-A is the real RemoteWorker SDK with a zero-capacity result buffer:
    // isOutboxFull(0, 0) is true, so it declines every task without executing
    // it and without emitting a result frame — the backpressure decline branch.
    let activityRan = false;
    using workerA = new RemoteWorker({
      serverUrl: setup.workerUrl,
      workerId: 'sdk-worker-a',
      maxBufferedResults: 0,
      workflows: {
        orders: {
          name: 'orders',
          activities: {
            echo: async (input: unknown) => {
              activityRan = true;
              return input;
            },
          },
        },
      },
    });
    await workerA.connect();

    // Dispatch with only worker-A registered, so the first attempt lands on A,
    // which declines it (buffer full) and fails its socket.
    const operationId = 'backpressure-redelivery-op';
    void setup.server.dispatchTask({
      operationId,
      // The SDK worker advertises the qualified `orders.echo` name; the raw
      // worker-B below registers the same name so the redelivery routes to it.
      activityName: 'orders.echo',
      input: { value: 'v' },
      visibilityTimeout: 5_000,
    });

    // worker-A's socket fails as a result of the decline.
    const aDeadline = Date.now() + 3_000;
    while (Date.now() < aDeadline && workerA.connected) {
      await sleepForTesting(10);
    }
    expect(workerA.connected).toBe(false);
    // worker-A's activity must never have executed — it declined the task.
    expect(activityRan).toBe(false);

    // worker-B registers and receives the redelivery after A's lease expires.
    const workerB = await connectAndRegisterWorker(setup, 'worker-b', {
      activities: ['orders.echo'],
    });
    const dispatchToB = await workerB.nextServerMessage(isTask, { timeoutMs: 5_000 });
    if (!isTask(dispatchToB)) throw new Error('expected task on B');
    expect(dispatchToB.operationId).toBe(operationId);

    workerB.send({ type: 'heartbeat', workerId: 'worker-b' });
    workerB.send({
      type: 'taskResult',
      operationId,
      status: 'completed',
      value: 'v',
      attemptToken: dispatchToB.attemptToken!,
    });

    let resolved: unknown;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      resolved = await readResolvedRecord(setup.engine, operationId);
      if (resolved !== undefined && resolved !== null) break;
      await sleepForTesting(10);
    }
    expect(resolved !== undefined && resolved !== null).toBe(true);
    await waitForInflightCleared(setup.engine, operationId);
  });
});

describe('RemoteWorker durability — server restart while task is in flight', () => {
  const createdFixtures: string[] = [];
  const handles: SubprocessServerHandle[] = [];

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.stop()));
    for (const fixture of createdFixtures.splice(0)) {
      rmSync(fixture, { force: true, recursive: true });
      rmSync(`${fixture}-wal`, { force: true });
      rmSync(`${fixture}-shm`, { force: true });
    }
  });

  async function waitForTestDispatchUrl(handle: SubprocessServerHandle): Promise<string> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const match = handle.stdout.match(/WEFT_TEST_DISPATCH_URL\s+(\S+)/);
      if (match !== null && match[1] !== undefined) return match[1];
      await sleepForTesting(20);
    }
    throw new Error('Subprocess did not print WEFT_TEST_DISPATCH_URL within 3s');
  }

  function fixtureDir(name: string): string {
    const directory = join(tmpdir(), `weft-rwr-${name}-${crypto.randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    createdFixtures.push(directory);
    return directory;
  }

  async function writeEntrypoint(name: string, source: string): Promise<string> {
    const directory = fixtureDir(name);
    const path = join(directory, 'entrypoint.ts');
    await Bun.write(path, source);
    return path;
  }

  function entrypointSource(): string {
    const repoRoot = new URL('../..', import.meta.url);
    const indexUrl = new URL('src/index.ts', repoRoot).href;
    const serverUrl = new URL('src/server/index.ts', repoRoot).href;
    const sqliteUrl = new URL('src/storage/bun-sql.ts', repoRoot).href;
    return `
import { Engine, activity } from ${JSON.stringify(indexUrl)};
import { serve } from ${JSON.stringify(serverUrl)};
import { BunSQLiteStorage } from ${JSON.stringify(sqliteUrl)};

function readArgument(name, fallback) {
  const index = Bun.argv.indexOf(name);
  if (index === -1) return fallback;
  return Bun.argv[index + 1] ?? fallback;
}

const port = Number(readArgument('--port', '0'));
const databasePath = readArgument('--database', ':memory:');
const echo = activity({ name: 'echo', execute: async (input) => input.value });
const storage = new BunSQLiteStorage(databasePath);
const engine = new Engine({ storage });
engine.register(echo);
await engine.recoverAll();
const server = serve({
  engine,
  port,
  hostname: '127.0.0.1',
  routingPolicy: 'round-robin',
  visibilityPollIntervalMs: 50,
  workerReconnectGracePeriodMs: 50,
});

// Test control surface. The test posts to /__test__/dispatch after a WS
// worker is registered, so the dispatch can immediately land on the
// connected worker.
async function readResolvedKey(operationId) {
  const key = 'op:resolved:' + operationId;
  const raw = await engine.storage.get(key);
  return raw === undefined || raw === null ? null : { present: true };
}

const testServer = Bun.serve({
  port: Number(readArgument('--test-port', '0')),
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/__test__/dispatch') {
      const body = (await request.json());
      const ok = await server.dispatchTask({
        operationId: body.operationId,
        activityName: 'echo',
        input: { value: body.value },
        visibilityTimeout: body.visibilityTimeout,
      });
      return new Response(JSON.stringify({ dispatched: ok }), { status: 200 });
    }
    if (url.pathname.startsWith('/__test__/resolved/')) {
      const operationId = decodeURIComponent(url.pathname.slice('/__test__/resolved/'.length));
      const result = await readResolvedKey(operationId);
      return new Response(JSON.stringify({ resolved: result !== null }), { status: 200 });
    }
    return new Response(null, { status: 404 });
  },
});

console.log('WEFT_SUBPROCESS_READY ' + server.url);
console.log('WEFT_TEST_DISPATCH_URL ' + testServer.url);

async function stop(exitCode) {
  await server.stop();
  storage[Symbol.dispose]();
  process.exit(exitCode);
}
process.on('SIGTERM', () => void stop(0));
process.on('SIGINT', () => void stop(0));
`;
  }

  it('recovers an in-flight task across SIGKILL and re-dispatches to a fresh worker', async () => {
    const entrypoint = await writeEntrypoint('scenario-4', entrypointSource());
    const databasePath = join(fixtureDir('scenario-4-db'), 'weft.db');

    const operationId = 'scenario-4-op';
    let handle = await spawnServerSubprocess({
      entrypoint,
      databasePath,
    });
    handles.push(handle);

    const workerUrl = `${handle.url.replace(/^http/, 'ws').replace(/\/?$/, '/')}v1/tasks/default/stream`;
    const workerA = await connectFaultInjectingWorker({ url: workerUrl, workerId: 'worker-a' });
    sockets.push(workerA);
    workerA.send({
      type: 'register',
      protocolVersion: 2,
      workerId: 'worker-a',
      activities: ['echo'],
      concurrency: 1,
      queue: 'default',
    });
    await workerA.nextServerMessage((m) => m.type === 'registerAck', { timeoutMs: 2_000 });

    // Trigger the dispatch via the subprocess's test-control HTTP server.
    const testDispatchUrl = await waitForTestDispatchUrl(handle);
    const dispatchResponse = await fetch(`${testDispatchUrl}/__test__/dispatch`, {
      method: 'POST',
      // visibilityTimeout has to comfortably exceed the subprocess restart
      // wall-clock window. `restoreInflightTasks` deletes inflight records
      // whose deadline has elapsed while the server was down; a tight
      // timeout here would result in the task being silently dropped on
      // reboot under CI load. 5_000ms gives Bun.spawn + serve + restore the
      // time it needs even on a slow runner.
      body: JSON.stringify({ operationId, value: 'restart-value', visibilityTimeout: 5_000 }),
      headers: { 'content-type': 'application/json' },
    });
    expect(dispatchResponse.ok).toBe(true);

    const dispatchToA = await workerA.nextServerMessage(isTask, { timeoutMs: 5_000 });
    if (!isTask(dispatchToA)) throw new Error('expected task');
    expect(dispatchToA.operationId).toBe(operationId);

    const rebooted = await killAndReboot(handle);
    handles.length = 0;
    handles.push(rebooted);

    const newWorkerUrl = `${rebooted.url.replace(/^http/, 'ws').replace(/\/?$/, '/')}v1/tasks/default/stream`;
    const workerB = await connectFaultInjectingWorker({ url: newWorkerUrl, workerId: 'worker-b' });
    sockets.push(workerB);
    workerB.send({
      type: 'register',
      protocolVersion: 2,
      workerId: 'worker-b',
      activities: ['echo'],
      concurrency: 1,
      queue: 'default',
    });
    await workerB.nextServerMessage((m) => m.type === 'registerAck', { timeoutMs: 2_000 });

    // worker-A's task carries the original visibilityTimeout (5_000ms). After
    // reboot, `restoreInflightTasks` keeps the inflight record alive until
    // that deadline elapses, at which point the scanner re-dispatches to
    // worker-B. Wait window must comfortably exceed the remaining deadline
    // budget (post-reboot elapsed time + grace) — 15_000ms is conservative.
    const dispatchToB = await workerB.nextServerMessage(isTask, { timeoutMs: 15_000 });
    if (!isTask(dispatchToB)) throw new Error('expected task on B');
    expect(dispatchToB.operationId).toBe(operationId);
    expect((dispatchToB.attempt ?? 1) >= 2).toBe(true);

    workerB.send({
      type: 'taskResult',
      operationId,
      status: 'completed',
      value: 'restart-value',
      // Re-dispatch after recovery routes through selectAndReserveWorker, which
      // rotates the attempt token; echo the token from B's fresh dispatch.
      attemptToken: dispatchToB.attemptToken!,
    });

    // Poll the rebooted subprocess's test-control endpoint for resolution.
    const newTestDispatchUrl = await waitForTestDispatchUrl(rebooted);
    const deadline = Date.now() + 5_000;
    let resolvedFlag = false;
    while (Date.now() < deadline) {
      const response = await fetch(
        `${newTestDispatchUrl}/__test__/resolved/${encodeURIComponent(operationId)}`,
      );
      if (response.ok) {
        const body = (await response.json()) as { resolved: boolean };
        if (body.resolved) {
          resolvedFlag = true;
          break;
        }
      }
      await sleepForTesting(20);
    }
    expect(resolvedFlag).toBe(true);
  }, 45_000);
});

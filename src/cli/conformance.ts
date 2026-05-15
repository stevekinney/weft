import { decode } from '../core/codec.ts';
import { Engine } from '../core/engine.ts';
import { serve, type WeftServer } from '../server/index.ts';
import type { ResolvedRecord } from '../server/task-state.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import {
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS,
} from '../worker/protocol.ts';
import type { CommandOutput } from './types.ts';

type ConformanceCommandOptions = {
  timeoutMs: number;
  json: boolean;
  workerCommand: string[];
};

type ConformanceCheck = {
  name: string;
  ok: boolean;
  message: string;
};

type RunningWorker = {
  process: ReturnType<typeof Bun.spawn>;
};

const CONFORMANCE_QUEUE = 'conformance';
const CONFORMANCE_ACTIVITIES = [
  'weft.conformance.echo',
  'weft.conformance.sleep',
  'weft.conformance.cancel',
] as const;
const CONFORMANCE_HEARTBEAT_INTERVAL_MS = 25;

function createCheck(name: string, ok: boolean, message: string): ConformanceCheck {
  return { name, ok, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(25);
  }

  const message = `Timed out after ${timeoutMs}ms waiting for ${label}`;
  throw lastError instanceof Error
    ? new Error(`${message}: ${lastError.message}`)
    : new Error(message);
}

function startWorker(command: string[], server: WeftServer): RunningWorker {
  const environment = {
    ...Bun.env,
    WEFT_WORKER_URL: `${server.url.replace('http://', 'ws://')}/v1/tasks/${CONFORMANCE_QUEUE}/stream`,
    WEFT_WORKER_QUEUE: CONFORMANCE_QUEUE,
    WEFT_WORKER_ACTIVITIES: CONFORMANCE_ACTIVITIES.join(','),
    WEFT_WORKER_PROTOCOL_VERSION: String(REMOTE_WORKER_PROTOCOL_VERSION),
    WEFT_CONFORMANCE_HEARTBEAT_INTERVAL_MS: String(CONFORMANCE_HEARTBEAT_INTERVAL_MS),
  };

  return {
    process: Bun.spawn(command, {
      env: environment,
      stdout: 'ignore',
      stderr: 'ignore',
    }),
  };
}

async function stopWorker(worker: RunningWorker | undefined): Promise<void> {
  if (worker === undefined) return;
  if (worker.process.exitCode !== null) return;

  worker.process.kill('SIGTERM');
  try {
    await Promise.race([worker.process.exited, Bun.sleep(1_000)]);
  } catch {
    // Ignore shutdown races; the fallback kill below handles a still-running child.
  }
  if (worker.process.exitCode === null) {
    worker.process.kill('SIGKILL');
    await worker.process.exited.catch(() => undefined);
  }
}

async function waitForRegisteredWorker(server: WeftServer, timeoutMs: number): Promise<string> {
  await waitForCondition(() => server.registry.getAll().length > 0, timeoutMs, 'worker register');
  const worker = server.registry.getAll()[0];
  if (worker === undefined) {
    throw new Error('worker registry was empty after registration wait');
  }
  return worker.id;
}

async function waitForReplacementWorker(
  server: WeftServer,
  originalWorkerId: string,
  timeoutMs: number,
): Promise<string> {
  let replacementWorkerId: string | undefined;
  await waitForCondition(
    () => {
      replacementWorkerId = server.registry
        .getAll()
        .find((registeredWorker) => registeredWorker.id !== originalWorkerId)?.id;
      return replacementWorkerId !== undefined;
    },
    timeoutMs,
    'replacement worker register',
  );
  if (replacementWorkerId === undefined) {
    throw new Error('replacement worker registry was empty after registration wait');
  }
  return replacementWorkerId;
}

async function waitForWorkerHeartbeat(
  server: WeftServer,
  workerId: string,
  timeoutMs: number,
): Promise<void> {
  const disconnectedMessage = `Worker ${workerId} disconnected before heartbeat was observed`;
  const heartbeatBefore = server.registry.getWorker(workerId)?.lastHeartbeat;
  if (heartbeatBefore === undefined) {
    throw new Error(disconnectedMessage);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const worker = server.registry.getWorker(workerId);
    if (worker === undefined) {
      throw new Error(disconnectedMessage);
    }
    if (worker.lastHeartbeat > heartbeatBefore) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for worker ${workerId} heartbeat`);
}

async function waitForWorkerIdle(
  server: WeftServer,
  workerId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const worker = server.registry.getWorker(workerId);
    if (worker === undefined) {
      throw new Error(`Worker ${workerId} disconnected while waiting to become idle`);
    }
    if (worker.inFlight === 0) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for worker ${workerId} to become idle`);
}

function isResolvedRecord(value: unknown): value is ResolvedRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value['operationId'] === 'string' &&
    (value['status'] === 'completed' || value['status'] === 'failed') &&
    typeof value['resolvedAt'] === 'number'
  );
}

async function readResolvedStatus(
  storage: MemoryStorage,
  operationId: string,
): Promise<ResolvedRecord['status'] | undefined> {
  const stored = await storage.get(KEYS.operationResolved(operationId));
  if (stored === null) return undefined;
  const decoded = decode(stored);
  if (!isResolvedRecord(decoded)) return undefined;
  return decoded.status;
}

async function waitForResolvedStatus(
  storage: MemoryStorage,
  operationId: string,
  status: ResolvedRecord['status'],
  timeoutMs: number,
): Promise<void> {
  await waitForCondition(
    async () => (await readResolvedStatus(storage, operationId)) === status,
    timeoutMs,
    `${operationId} to resolve as ${status}`,
  );
}

async function dispatchAndWait(
  server: WeftServer,
  storage: MemoryStorage,
  operationId: string,
  activityName: string,
  input: unknown,
  expectedStatus: ResolvedRecord['status'],
  timeoutMs: number,
): Promise<void> {
  const dispatched = await server.dispatchTask({
    operationId,
    activityName,
    input,
    queue: CONFORMANCE_QUEUE,
    visibilityTimeout: Math.max(500, timeoutMs),
  });
  if (!dispatched) {
    throw new Error(`Could not dispatch ${operationId}`);
  }
  await waitForResolvedStatus(storage, operationId, expectedStatus, timeoutMs);
}

async function runConformanceChecks(
  command: string[],
  timeoutMs: number,
): Promise<ConformanceCheck[]> {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  const server = serve({ engine, port: 0, hostname: '127.0.0.1' });
  const checks: ConformanceCheck[] = [];
  let worker: RunningWorker | undefined;

  try {
    worker = startWorker(command, server);
    const workerId = await waitForRegisteredWorker(server, timeoutMs);
    const registered = server.registry.getWorker(workerId);
    checks.push(
      createCheck(
        'register',
        registered?.queue === CONFORMANCE_QUEUE &&
          CONFORMANCE_ACTIVITIES.every((activity) => registered.activities.includes(activity)),
        `registered worker ${workerId}`,
      ),
    );

    await dispatchAndWait(
      server,
      storage,
      'conformance-echo',
      'weft.conformance.echo',
      { ok: true },
      'completed',
      timeoutMs,
    );
    checks.push(createCheck('task completion', true, 'echo task resolved'));

    await waitForWorkerHeartbeat(server, workerId, timeoutMs);
    await dispatchAndWait(
      server,
      storage,
      'conformance-heartbeat',
      'weft.conformance.sleep',
      { milliseconds: CONFORMANCE_HEARTBEAT_INTERVAL_MS * 3 },
      'completed',
      timeoutMs,
    );
    checks.push(createCheck('heartbeat', true, 'heartbeat observed while worker was connected'));

    const cancelOperationId = 'conformance-cancel';
    const cancelDispatched = await server.dispatchTask({
      operationId: cancelOperationId,
      activityName: 'weft.conformance.cancel',
      input: { milliseconds: timeoutMs },
      queue: CONFORMANCE_QUEUE,
      visibilityTimeout: Math.max(500, timeoutMs),
    });
    if (!cancelDispatched) throw new Error('Could not dispatch cancellation task');
    await waitForCondition(
      () => (server.registry.getWorker(workerId)?.inFlight ?? 0) > 0,
      timeoutMs,
      'cancellable task assignment',
    );
    if (!server.cancelTask(cancelOperationId)) {
      throw new Error('Server could not send cancel message');
    }
    await waitForResolvedStatus(storage, cancelOperationId, 'failed', timeoutMs);
    checks.push(createCheck('cancellation', true, 'cancelled task resolved as failed'));

    const reconnectOperationId = 'conformance-reconnect';
    // Keep the first worker busy while its replacement registers, but leave room for retry.
    const reconnectDelayMs = Math.min(1_500, Math.max(250, Math.floor(timeoutMs * 0.75)));
    const reconnectDispatched = await server.dispatchTask({
      operationId: reconnectOperationId,
      activityName: 'weft.conformance.sleep',
      input: { milliseconds: reconnectDelayMs },
      queue: CONFORMANCE_QUEUE,
      visibilityTimeout: Math.max(500, timeoutMs),
    });
    if (!reconnectDispatched) throw new Error('Could not dispatch reconnect task');
    await waitForCondition(
      () => (server.registry.getWorker(workerId)?.inFlight ?? 0) > 0,
      timeoutMs,
      'in-flight reconnect task assignment',
    );

    const replacementWorker = startWorker(command, server);
    const replacementWorkerId = await waitForReplacementWorker(server, workerId, timeoutMs);
    await waitForWorkerHeartbeat(server, replacementWorkerId, timeoutMs);
    await stopWorker(worker);
    worker = replacementWorker;
    await waitForCondition(
      () => server.registry.getWorker(workerId) === undefined,
      timeoutMs,
      'original worker disconnect',
    );
    await waitForWorkerIdle(server, replacementWorkerId, timeoutMs);
    await waitForResolvedStatus(storage, reconnectOperationId, 'completed', timeoutMs);
    checks.push(createCheck('reconnect', true, 'in-flight task completed after reconnect'));

    const shutdownWorkerId = server.registry.getWorker(replacementWorkerId)?.id;
    if (shutdownWorkerId === undefined) {
      throw new Error('No worker available for graceful shutdown check');
    }
    await server.shutdownWorker(shutdownWorkerId, { timeoutMs });
    await waitForCondition(
      () => server.registry.getWorker(shutdownWorkerId) === undefined,
      timeoutMs,
      'worker graceful shutdown',
    );
    checks.push(createCheck('graceful shutdown', true, 'worker disconnected after shutdown'));
  } finally {
    await stopWorker(worker);
    await server.stop();
    engine[Symbol.dispose]();
  }

  return checks;
}

function formatChecks(checks: ConformanceCheck[], json: boolean): string {
  if (json) {
    return JSON.stringify(
      {
        ok: checks.every((check) => check.ok),
        protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
        supportedProtocolVersions: REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS,
        checks,
      },
      null,
      2,
    );
  }

  return checks
    .map((check) => `${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.message}`)
    .join('\n');
}

/** Runs RemoteWorker protocol conformance checks against a candidate worker command. */
export async function executeConformance(
  options: ConformanceCommandOptions,
): Promise<CommandOutput> {
  if (options.workerCommand.length === 0) {
    return {
      stdout: '',
      stderr: 'Error: worker command is required after --',
      exitCode: 2,
    };
  }

  try {
    const checks = await runConformanceChecks(options.workerCommand, options.timeoutMs);
    const ok = checks.every((check) => check.ok);
    return { stdout: formatChecks(checks, options.json), exitCode: ok ? 0 : 1 };
  } catch (error) {
    const failedCheck = createCheck(
      'conformance',
      false,
      error instanceof Error ? error.message : String(error),
    );
    return {
      stdout: formatChecks([failedCheck], options.json),
      exitCode: 1,
    };
  }
}

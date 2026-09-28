import {
  Engine,
  MemoryStorage,
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS,
  serve,
  type WeftServer,
} from '../index.ts';
import {
  CONFORMANCE_ACTIVITIES,
  CONFORMANCE_HEARTBEAT_INTERVAL_MS,
  CONFORMANCE_QUEUE,
  type RunningWorker,
  startWorker,
  stopWorker,
  waitForCancelledDisposition,
  waitForCondition,
  waitForReassignmentPastFirstAttempt,
  waitForRegisteredWorker,
  waitForReplacementWorker,
  waitForResolvedStatus,
  waitForWorkerHeartbeat,
  waitForWorkerIdle,
} from './conformance-harness.ts';
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

function createCheck(name: string, ok: boolean, message: string): ConformanceCheck {
  return { name, ok, message };
}

/**
 * Judge a registration from the registry record alone. A worker on the wrong
 * queue or missing a required activity can never pass a later check, so the
 * mismatch is reported here, from observed state, rather than left to surface
 * as whichever downstream wait happens to time out first.
 */
export function createRegisterCheck(
  workerId: string,
  registered: { queue: string; activities: readonly string[] } | undefined,
): ConformanceCheck {
  if (registered === undefined) {
    return createCheck('register', false, `worker ${workerId} disconnected after registering`);
  }
  const problems: string[] = [];
  if (registered.queue !== CONFORMANCE_QUEUE) {
    problems.push(`registered on queue ${registered.queue}, expected ${CONFORMANCE_QUEUE}`);
  }
  const missing = CONFORMANCE_ACTIVITIES.filter(
    (activity) => !registered.activities.includes(activity),
  );
  if (missing.length > 0) {
    problems.push(`does not advertise ${missing.join(', ')}`);
  }
  return problems.length === 0
    ? createCheck('register', true, `registered worker ${workerId}`)
    : createCheck('register', false, `worker ${workerId} ${problems.join('; ')}`);
}

async function dispatchAndWait(
  server: WeftServer,
  storage: MemoryStorage,
  operationId: string,
  activityName: string,
  input: unknown,
  expectedStatus: 'completed' | 'failed',
  timeoutMs: number,
  workflowRevision?: string,
): Promise<void> {
  const dispatched = await server.dispatchTask({
    operationId,
    activityName,
    workflowType: 'conformance',
    input,
    queue: CONFORMANCE_QUEUE,
    visibilityTimeout: Math.max(500, timeoutMs),
    ...(workflowRevision !== undefined && { workflowRevision }),
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
  const server = serve({
    engine,
    port: 0,
    hostname: '127.0.0.1',
    workerReconnectGracePeriodMs: 100,
    workerShutdownTimeoutMs: timeoutMs,
  });
  const checks: ConformanceCheck[] = [];
  let worker: RunningWorker | undefined;

  try {
    worker = startWorker(command, server);
    const workerId = await waitForRegisteredWorker(server, timeoutMs);
    const registerCheck = createRegisterCheck(workerId, server.registry.getWorker(workerId));
    checks.push(registerCheck);
    if (!registerCheck.ok) return checks;

    await dispatchAndWait(
      server,
      storage,
      'conformance-echo',
      'conformance.echo',
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
      'conformance.sleep',
      { milliseconds: CONFORMANCE_HEARTBEAT_INTERVAL_MS * 3 },
      'completed',
      timeoutMs,
    );
    checks.push(createCheck('heartbeat', true, 'heartbeat observed while worker was connected'));

    const cancelOperationId = 'conformance-cancel';
    const cancelDispatched = await server.dispatchTask({
      operationId: cancelOperationId,
      activityName: 'conformance.cancel',
      workflowType: 'conformance',
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
    if (!(await server.cancelTask(cancelOperationId))) {
      throw new Error('Server could not record cancellation intent');
    }
    await waitForCancelledDisposition(storage, cancelOperationId, timeoutMs);
    checks.push(
      createCheck('cancellation', true, 'cancelled task resolved with the cancelled disposition'),
    );

    const reconnectOperationId = 'conformance-reconnect';
    // `holdForReassignment` (COR-233/COR-235) tells a conforming fixture to
    // block its FIRST attempt (protocol `attempt` <= 1) indefinitely instead
    // of resolving it on a timer, and to resolve a reassigned attempt
    // (`attempt` > 1) immediately. A fixed sleep duration used to stand in
    // for "busy long enough to survive replacement registration": under
    // load, a machine slow enough to delay that registration let the
    // original worker complete the task on its own before this harness
    // could kill it, defeating the very reassignment this check exists to
    // prove. Blocking unconditionally removes that race instead of widening
    // its margin.
    const reconnectDispatched = await server.dispatchTask({
      operationId: reconnectOperationId,
      activityName: 'conformance.sleep',
      workflowType: 'conformance',
      input: { holdForReassignment: true },
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
    // The disconnect-driven requeue and redispatch to the replacement worker
    // happen asynchronously after the original worker is unregistered above
    // — there is no synchronous guarantee the reassignment has landed yet.
    // Observe the reassignment itself through the ledger's own monotonic
    // attempt counter (see `waitForReassignmentPastFirstAttempt`'s doc
    // comment for why that, rather than registry `inFlight` or "has resolved
    // at all", is the reliable AND discriminating signal here) before
    // checking for idle, or a not-yet-assigned replacement would read as
    // trivially idle.
    await waitForReassignmentPastFirstAttempt(
      server,
      storage,
      reconnectOperationId,
      replacementWorkerId,
      timeoutMs,
    );
    await waitForWorkerIdle(server, replacementWorkerId, timeoutMs);
    await waitForResolvedStatus(storage, reconnectOperationId, 'completed', timeoutMs);
    checks.push(createCheck('reconnect', true, 'in-flight task completed after reconnect'));

    // Dispatch with a workflowRevision (WFT-20) and confirm the reference
    // worker echoes it back correctly on taskResult — a worker that echoes
    // the wrong (or no) value would be rejected by the server's revision
    // authorization gate, which would surface here as a failure to resolve.
    await dispatchAndWait(
      server,
      storage,
      'conformance-revision-echo',
      'conformance.echo',
      { ok: true },
      'completed',
      timeoutMs,
      'conformance-revision-1',
    );
    checks.push(createCheck('revision echo', true, 'workflowRevision echoed and accepted'));

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

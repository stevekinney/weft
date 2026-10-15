/**
 * The RemoteWorker protocol conformance check sequence — the single source of
 * pass/fail truth for both the `weft conformance` CLI command
 * (`cli/conformance.ts`) and the `weft.conformance.report` server operation
 * (`server/operations/conformance.ts`, through `targets.ts`).
 *
 * Every run is sandboxed: it builds its own `MemoryStorage`, `Engine`, and a
 * loopback `serve({ port: 0 })`, spawns the worker command against that
 * private server, and tears all three down before returning. The reconnect
 * check kills a worker process and the graceful-shutdown check disconnects
 * one, so a run must never point at a live fleet or a production engine.
 *
 * Nothing reachable from the package root imports this module at runtime:
 * it spawns processes, and the root must still bundle for the browser
 * (COR-1192). Hosts reach it through `createConformanceTargets` in the
 * testing subpath, and the CLI imports it directly. `serve` is a parameter
 * so tests can hand a run a sandbox server that fails to start.
 *
 * @module conformance/run-conformance
 */

import { Engine } from '../core/engine/index.ts';
import type { ServeOptions, WeftServer } from '../server/index.ts';
import { MemoryStorage } from '../storage/memory.ts';
import {
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS,
} from '../worker/protocol-version.ts';
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
} from './harness.ts';

/** One named protocol check and its outcome. */
export type ConformanceCheck = {
  name: string;
  ok: boolean;
  message: string;
};

/**
 * A complete conformance report: overall verdict, the protocol version the
 * sandbox server spoke, and every check in the order it ran. A run that
 * aborts before its first verdict (a worker that never registers, a dispatch
 * that times out) reports one failed check named `conformance` carrying the
 * error message.
 */
export type ConformanceReport = {
  ok: boolean;
  protocolVersion: number;
  supportedProtocolVersions: number[];
  checks: ConformanceCheck[];
};

/** The `serve()` function a run starts its private sandbox server with. */
export type ConformanceServe = (options: ServeOptions) => WeftServer;

/** Inputs for one sandboxed conformance run. */
export type RunConformanceReportOptions = {
  /** Worker command and arguments, spawned directly (no shell). */
  command: readonly string[];
  /** Upper bound, in milliseconds, for each individual wait in the sequence. */
  timeoutMs: number;
  serve: ConformanceServe;
};

export function createCheck(name: string, ok: boolean, message: string): ConformanceCheck {
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
  command: readonly string[],
  timeoutMs: number,
  serve: ConformanceServe,
): Promise<ConformanceCheck[]> {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  let server: WeftServer;
  try {
    server = serve({
      engine,
      port: 0,
      hostname: '127.0.0.1',
      // The protocol under test carries no credentials, so the sandbox is
      // deliberately unauthenticated; it binds loopback only and lives for
      // one run. Saying so explicitly keeps every run from logging the
      // no-authentication warning into the host server's output.
      unauthenticatedAccess: 'allow',
      // Nothing in a run requests a discovery route or `/mcp`, so the sandbox
      // trusts no Host at all. An explicit empty allowlist is the strictest
      // setting and keeps every run from logging the MCP origin warning.
      trustedHosts: [],
      workerReconnectGracePeriodMs: 100,
      workerShutdownTimeoutMs: timeoutMs,
    });
  } catch (error) {
    // The sandbox never came up, so the `finally` below that normally owns
    // the engine's disposal is never reached; release its timers here.
    engine[Symbol.dispose]();
    throw error;
  }
  const checks: ConformanceCheck[] = [];
  let worker: RunningWorker | undefined;
  // Tracked apart from `worker` from the moment it spawns: a replacement that
  // never registers makes the waits below throw while `worker` still names
  // the original, and a long-lived host must not keep the orphan running.
  let replacementWorker: RunningWorker | undefined;

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

    replacementWorker = startWorker(command, server);
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
    if (replacementWorker !== worker) await stopWorker(replacementWorker);
    await server.stop();
    engine[Symbol.dispose]();
  }

  return checks;
}

/** Assemble a report from finished checks; `ok` holds only when every check passed. */
export function createConformanceReport(checks: ConformanceCheck[]): ConformanceReport {
  return {
    ok: checks.every((check) => check.ok),
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    supportedProtocolVersions: [...REMOTE_WORKER_SUPPORTED_PROTOCOL_VERSIONS],
    checks,
  };
}

/**
 * Run the full check sequence against one worker command in a fresh sandbox
 * and return its report. Never rejects: an error that aborts the sequence
 * becomes a single failed `conformance` check.
 */
export async function runConformanceReport(
  options: RunConformanceReportOptions,
): Promise<ConformanceReport> {
  try {
    return createConformanceReport(
      await runConformanceChecks(options.command, options.timeoutMs, options.serve),
    );
  } catch (error) {
    return createConformanceReport([
      createCheck('conformance', false, error instanceof Error ? error.message : String(error)),
    ]);
  }
}

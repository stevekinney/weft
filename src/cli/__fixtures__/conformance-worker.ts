#!/usr/bin/env bun

export type ConformanceWorkerFixture = 'conforming';

type InFlightTask = {
  activityName: string;
  timeout?: ReturnType<typeof setTimeout>;
  // The token captured from THIS dispatch. Carried on the per-dispatch task object
  // (not a side map keyed by operationId) so a re-dispatch of the same operation
  // cannot overwrite an earlier attempt's token — echoing the wrong token would
  // mask the very stale-attempt bug the conformance suite exists to catch.
  attemptToken: string;
};

const serverUrl = Bun.env['WEFT_WORKER_URL'];
const queue = Bun.env['WEFT_WORKER_QUEUE'] ?? 'conformance';
const protocolVersion = Number(Bun.env['WEFT_WORKER_PROTOCOL_VERSION'] ?? '2');
const activities = (Bun.env['WEFT_WORKER_ACTIVITIES'] ?? '')
  .split(',')
  .map((activity) => activity.trim())
  .filter((activity) => activity.length > 0);
const heartbeatIntervalMs = Number(Bun.env['WEFT_CONFORMANCE_HEARTBEAT_INTERVAL_MS'] ?? '10000');
const workerId = `conformance-worker-${crypto.randomUUID()}`;

if (serverUrl === undefined) {
  console.error('WEFT_WORKER_URL is required');
  process.exit(2);
}

const inFlightTasks = new Map<string, InFlightTask>();
const socket = new WebSocket(serverUrl);
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

function send(message: Record<string, unknown>): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function startHeartbeats(): void {
  if (heartbeatTimer !== undefined) return;
  heartbeatTimer = setInterval(() => {
    send({ type: 'heartbeat', workerId });
  }, heartbeatIntervalMs);
}

function complete(operationId: string, value: unknown, attemptToken: string): void {
  inFlightTasks.delete(operationId);
  send({
    type: 'taskResult',
    operationId,
    status: 'completed',
    value: value === undefined ? null : value,
    attemptToken,
  });
}

function fail(operationId: string, error: string, attemptToken: string): void {
  inFlightTasks.delete(operationId);
  send({
    type: 'taskResult',
    operationId,
    status: 'failed',
    error,
    attemptToken,
  });
}

function cancel(operationId: string): void {
  const task = inFlightTasks.get(operationId);
  if (task === undefined) return;
  if (task?.timeout !== undefined) {
    clearTimeout(task.timeout);
  }
  inFlightTasks.delete(operationId);
  send({
    type: 'taskResult',
    operationId,
    status: 'cancelled',
    cancelled: true,
    error: 'Task cancelled',
    // Echo the token captured on THIS dispatch's in-flight task object.
    attemptToken: task.attemptToken,
  });
}

function isInputRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

function millisecondsFromInput(input: unknown): number {
  if (!isInputRecord(input)) return 25;
  const milliseconds = input['milliseconds'];
  return typeof milliseconds === 'number' && Number.isFinite(milliseconds) ? milliseconds : 25;
}

function handleTask(message: Record<string, unknown>): void {
  const operationId = message['operationId'];
  const activityName = message['activityName'];
  if (typeof operationId !== 'string' || typeof activityName !== 'string') return;

  // Capture the per-dispatch token from THIS task and carry it on the dispatch —
  // either passed straight to the synchronous result or stored on the in-flight
  // task object for the deferred ones. Never looked up later by operationId.
  const attemptToken = message['attemptToken'];
  if (typeof attemptToken !== 'string' || attemptToken.length === 0) return;

  if (activityName === 'weft.conformance.echo') {
    complete(operationId, message['input'], attemptToken);
    return;
  }

  const tokenField = { attemptToken };

  if (activityName === 'weft.conformance.sleep') {
    const timeout = setTimeout(
      () => complete(operationId, message['input'], attemptToken),
      millisecondsFromInput(message['input']),
    );
    inFlightTasks.set(operationId, { activityName, timeout, ...tokenField });
    return;
  }

  if (activityName === 'weft.conformance.cancel') {
    const timeout = setTimeout(
      () => fail(operationId, 'Cancel was not delivered', attemptToken),
      millisecondsFromInput(message['input']),
    );
    inFlightTasks.set(operationId, { activityName, timeout, ...tokenField });
    return;
  }

  fail(operationId, `Unknown activity: ${activityName}`, attemptToken);
}

socket.addEventListener('open', () => {
  send({
    type: 'register',
    protocolVersion,
    workerId,
    activities,
    concurrency: 3,
    queue,
  });
});

socket.addEventListener('message', (event) => {
  const parsed = JSON.parse(String(event.data)) as Record<string, unknown>;
  if (parsed['type'] === 'registerAck') {
    startHeartbeats();
  } else if (parsed['type'] === 'task') {
    handleTask(parsed);
  } else if (parsed['type'] === 'cancel') {
    const operationId = parsed['operationId'];
    if (typeof operationId === 'string') cancel(operationId);
  } else if (parsed['type'] === 'shutdown') {
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    socket.close();
  } else if (parsed['type'] === 'registerError' || parsed['type'] === 'protocolError') {
    console.error(JSON.stringify(parsed));
    socket.close();
  }
});

socket.addEventListener('close', () => {
  if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
  process.exit(0);
});

socket.addEventListener('error', () => {
  if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
  process.exit(1);
});

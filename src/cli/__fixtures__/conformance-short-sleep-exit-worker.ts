#!/usr/bin/env bun

export type ConformanceShortSleepExitWorkerFixture = 'short-sleep-exit';

const serverUrl = Bun.env['WEFT_WORKER_URL'];
const queue = Bun.env['WEFT_WORKER_QUEUE'] ?? 'conformance';
const protocolVersion = Number(Bun.env['WEFT_WORKER_PROTOCOL_VERSION'] ?? '1');
const launchIndex = Number(Bun.env['WEFT_CONFORMANCE_LAUNCH_INDEX'] ?? '1');
const activities = (Bun.env['WEFT_WORKER_ACTIVITIES'] ?? '')
  .split(',')
  .map((activity) => activity.trim())
  .filter((activity) => activity.length > 0);
const workerId = `short-sleep-worker-${crypto.randomUUID()}`;

if (serverUrl === undefined) {
  console.error('WEFT_WORKER_URL is required');
  process.exit(2);
}

const socket = new WebSocket(serverUrl);
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

function send(message: Record<string, unknown>): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function readMilliseconds(input: unknown): number {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return 25;
  }

  const milliseconds = Reflect.get(input, 'milliseconds');
  return typeof milliseconds === 'number' ? milliseconds : 25;
}

function handleTaskMessage(parsed: Record<string, unknown>): void {
  const operationId = parsed['operationId'];
  const activityName = parsed['activityName'];
  const input = parsed['input'];
  if (typeof operationId !== 'string' || typeof activityName !== 'string') return;

  if (activityName === 'weft.conformance.echo') {
    send({ type: 'taskResult', operationId, status: 'completed', value: input ?? null });
    return;
  }

  if (activityName !== 'weft.conformance.sleep') {
    return;
  }

  const milliseconds = readMilliseconds(input);
  if (milliseconds > 100 && launchIndex === 1) {
    return;
  }

  setTimeout(() => {
    if (milliseconds > 100 && launchIndex > 1) {
      socket.close();
      return;
    }

    send({ type: 'taskResult', operationId, status: 'completed', value: input ?? null });
  }, milliseconds);
}

function handleCancelMessage(parsed: Record<string, unknown>): void {
  const operationId = parsed['operationId'];
  if (typeof operationId !== 'string') return;

  send({
    type: 'taskResult',
    operationId,
    status: 'failed',
    error: 'Task cancelled',
  });
}

socket.addEventListener('open', () => {
  send({
    type: 'register',
    protocolVersion,
    workerId,
    activities,
    concurrency: 1,
    queue,
  });
});

socket.addEventListener('message', (event) => {
  const parsed = JSON.parse(String(event.data)) as Record<string, unknown>;
  if (parsed['type'] === 'registerAck') {
    heartbeatTimer ??= setInterval(() => send({ type: 'heartbeat', workerId }), 25);
    return;
  }

  if (parsed['type'] === 'task') {
    handleTaskMessage(parsed);
    return;
  }

  if (parsed['type'] === 'cancel') {
    handleCancelMessage(parsed);
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

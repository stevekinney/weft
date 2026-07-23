#!/usr/bin/env bun

export type ConformanceShortSleepExitWorkerFixture = 'short-sleep-exit';

const serverUrl = Bun.env['WEFT_WORKER_URL'];
const queue = Bun.env['WEFT_WORKER_QUEUE'] ?? 'conformance';
const protocolVersion = Number(Bun.env['WEFT_WORKER_PROTOCOL_VERSION'] ?? '2');
const mode = Bun.env['WEFT_SHORT_SLEEP_EXIT_MODE'] ?? 'default';
const launchStateFile = Bun.env['WEFT_SHORT_SLEEP_EXIT_STATE_FILE'];
const activities = (Bun.env['WEFT_WORKER_ACTIVITIES'] ?? '')
  .split(',')
  .map((activity) => activity.trim())
  .filter((activity) => activity.length > 0);
const workerId = `short-sleep-worker-${crypto.randomUUID()}`;

if (serverUrl === undefined) {
  console.error('WEFT_WORKER_URL is required');
  process.exit(2);
}

async function nextLaunchIndex(): Promise<number> {
  if (launchStateFile === undefined) return 0;
  const file = Bun.file(launchStateFile);
  const previous = (await file.exists()) ? Number(await file.text()) : 0;
  const next = Number.isFinite(previous) ? previous + 1 : 1;
  await Bun.write(launchStateFile, String(next));
  return next;
}

const launchIndex = await nextLaunchIndex();
const socket = new WebSocket(serverUrl);
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
const taskTokens = new Map<string, string>();

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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function handleTaskMessage(parsed: Record<string, unknown>): void {
  const operationId = parsed['operationId'];
  const activityName = parsed['activityName'];
  const input = parsed['input'];
  const attemptToken = parsed['attemptToken'];
  if (typeof operationId !== 'string' || typeof activityName !== 'string') return;
  if (!isNonEmptyString(attemptToken)) return;
  taskTokens.set(operationId, attemptToken);

  if (activityName === 'weft.conformance.echo') {
    send({
      type: 'taskResult',
      operationId,
      attemptToken,
      status: 'completed',
      value: input ?? null,
    });
    return;
  }

  if (activityName !== 'weft.conformance.sleep') {
    return;
  }

  const milliseconds = readMilliseconds(input);
  if (mode === 'replacement-disconnect' && milliseconds > 100 && launchIndex === 1) {
    setTimeout(() => {
      send({
        type: 'taskResult',
        operationId,
        attemptToken,
        status: 'completed',
        value: input ?? null,
      });
    }, milliseconds * 20);
    return;
  }

  setTimeout(() => {
    if (mode === 'replacement-disconnect' && milliseconds > 100 && launchIndex > 1) {
      socket.close();
      return;
    }

    send({
      type: 'taskResult',
      operationId,
      attemptToken,
      status: 'completed',
      value: input ?? null,
    });
  }, milliseconds);
}

function handleCancelMessage(parsed: Record<string, unknown>): void {
  const operationId = parsed['operationId'];
  const attemptToken =
    typeof parsed['attemptToken'] === 'string'
      ? parsed['attemptToken']
      : taskTokens.get(operationId as string);
  if (typeof operationId !== 'string') return;
  if (typeof attemptToken !== 'string' || attemptToken.length === 0) return;

  send({
    type: 'taskResult',
    operationId,
    attemptToken,
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

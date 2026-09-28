#!/usr/bin/env bun

import { conformanceManifest } from './conformance-manifest.ts';
import { resolveFixtureEnvironment } from './environment-configuration.ts';

export type ConformanceShortSleepExitWorkerFixture = 'short-sleep-exit';

const serverUrl = resolveFixtureEnvironment().workerUrl;
const protocolVersion = resolveFixtureEnvironment().protocolVersion;
const mode = resolveFixtureEnvironment().shortSleepExitMode;
const activities = resolveFixtureEnvironment().activities;
const workerId = `short-sleep-worker-${crypto.randomUUID()}`;

if (serverUrl === undefined) {
  process.stderr.write(`WEFT_WORKER_URL is required\n`);
  process.exit(2);
}

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

  if (activityName === 'conformance.echo') {
    send({
      type: 'taskResult',
      operationId,
      attemptToken,
      status: 'completed',
      value: input ?? null,
    });
    return;
  }

  if (activityName !== 'conformance.sleep') {
    return;
  }

  const isRecordInput = input !== null && typeof input === 'object' && !Array.isArray(input);
  // mode 'ignore-hold' simulates a worker written against the pre-COR-235
  // contract that has no idea `holdForReassignment` exists: it falls straight
  // through to the plain-sleep branch below and resolves attempt 1 in place,
  // exactly the non-conforming behavior the reconnect check must now catch.
  const holdForReassignment =
    mode !== 'ignore-hold' && isRecordInput && Reflect.get(input, 'holdForReassignment') === true;

  if (holdForReassignment) {
    const attempt = typeof parsed['attempt'] === 'number' ? parsed['attempt'] : 1;
    if (attempt <= 1) {
      // First attempt (COR-233/COR-235's reconnect check): hold indefinitely
      // — this worker is killed before it can ever complete this task.
      return;
    }
    if (mode === 'replacement-disconnect') {
      // Simulate the REPLACEMENT itself disconnecting instead of resolving
      // the reassigned attempt, so the harness's later idle wait observes a
      // vanished worker rather than a completed task.
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
    return;
  }

  const milliseconds = readMilliseconds(input);
  setTimeout(() => {
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
  if (typeof operationId !== 'string') return;
  const attemptToken =
    typeof parsed['attemptToken'] === 'string'
      ? parsed['attemptToken']
      : taskTokens.get(operationId);
  if (typeof attemptToken !== 'string' || attemptToken.length === 0) return;

  // COR-230: report the cooperative `cancelled` status, not a generic
  // `failed` one — the server's ledger now records a distinct cancellation
  // disposition (acceptance criterion 13) only for a `taskResult` that says
  // `status: 'cancelled'`; an ordinary `failed` report resolves as a plain
  // failed completion instead, which is not what a `cancel` control being
  // honored actually means.
  send({
    type: 'taskResult',
    operationId,
    attemptToken,
    status: 'cancelled',
    cancelled: true,
    error: 'Task cancelled',
  });
}

socket.addEventListener('open', () => {
  send({
    type: 'register',
    protocolVersion,
    workerId,
    manifest: conformanceManifest(activities),
    concurrency: 1,
  });
});

socket.addEventListener('message', (event) => {
  const parsedData: unknown = JSON.parse(String(event.data));
  if (parsedData === null || typeof parsedData !== 'object' || Array.isArray(parsedData)) return;
  const parsed = Object.fromEntries(Object.entries(parsedData));
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

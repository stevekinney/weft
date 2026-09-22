#!/usr/bin/env bun

import { conformanceManifest } from './conformance-manifest.ts';
import { resolveFixtureEnvironment } from './environment-configuration.ts';

/**
 * COR-233 "Transport and Conformance Integration" — otherwise identical to
 * `conformance-worker.ts` (same echo/sleep/cancel activity handling), this
 * fixture additionally proves a worker resending a `taskResult` after losing
 * its first `taskResultAck` gets `duplicate` on the resend rather than a
 * rejection, and that the underlying task resolves exactly once.
 *
 * The FIRST `taskResultAck` this process ever receives is deliberately
 * treated as lost: its `disposition` is still recorded (for the test's own
 * visibility — a real worker whose frame never arrived could not do this,
 * but the test needs a way to observe what the server actually answered),
 * and then the byte-identical original `taskResult` frame is resent for that
 * operation over the same socket — mirroring `TaskResultOutbox`'s
 * buffer-until-acknowledged contract (`worker/task-result-outbox.ts`)
 * without pulling in the full `RemoteWorker` SDK this hand-rolled fixture
 * deliberately avoids, matching every other fixture in this directory. Every
 * `taskResultAck` after the first is handled normally (no resend).
 */
export type ConformanceLostAckWorkerFixture = 'lost-ack';

type InFlightTask = {
  activityName: string;
  timeout?: ReturnType<typeof setTimeout>;
  attemptToken: string;
  workflowRevision?: string;
};

const serverUrl = resolveFixtureEnvironment().workerUrl;
const protocolVersion = resolveFixtureEnvironment().protocolVersion;
const activities = resolveFixtureEnvironment().activities;
const heartbeatIntervalMs = resolveFixtureEnvironment().heartbeatIntervalMs;
const lostAckStateFile = resolveFixtureEnvironment().lostAckStateFile;
const workerId = `lost-ack-worker-${crypto.randomUUID()}`;

if (serverUrl === undefined) {
  process.stderr.write(`WEFT_WORKER_URL is required\n`);
  process.exit(2);
}

const inFlightTasks = new Map<string, InFlightTask>();
// The exact `taskResult` frame most recently sent for an operation, kept so
// the deliberate first-ack drop below can resend byte-identical content.
const sentResults = new Map<string, Record<string, unknown>>();
let hasDroppedFirstAck = false;
const socket = new WebSocket(serverUrl);
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

function send(message: Record<string, unknown>): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function sendTaskResult(message: Record<string, unknown>): void {
  const operationId = message['operationId'];
  if (typeof operationId === 'string') {
    sentResults.set(operationId, message);
  }
  send(message);
}

function parseMessage(data: unknown): Record<string, unknown> | undefined {
  const parsed: unknown = JSON.parse(String(data));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  return Object.fromEntries(Object.entries(parsed));
}

function startHeartbeats(): void {
  if (heartbeatTimer !== undefined) return;
  heartbeatTimer = setInterval(() => {
    send({ type: 'heartbeat', workerId });
  }, heartbeatIntervalMs);
}

/** Append `disposition` to the JSON array at `WEFT_LOST_ACK_STATE_FILE`, if configured. */
async function recordDisposition(disposition: string): Promise<void> {
  if (lostAckStateFile === undefined) return;
  const file = Bun.file(lostAckStateFile);
  const existing: unknown = (await file.exists()) ? JSON.parse(await file.text()) : [];
  const dispositions = Array.isArray(existing) ? existing : [];
  dispositions.push(disposition);
  await Bun.write(lostAckStateFile, JSON.stringify(dispositions));
}

function complete(
  operationId: string,
  value: unknown,
  attemptToken: string,
  workflowRevision?: string,
): void {
  inFlightTasks.delete(operationId);
  sendTaskResult({
    type: 'taskResult',
    operationId,
    status: 'completed',
    value: value === undefined ? null : value,
    attemptToken,
    ...(workflowRevision !== undefined && { workflowRevision }),
  });
}

function fail(
  operationId: string,
  error: string,
  attemptToken: string,
  workflowRevision?: string,
): void {
  inFlightTasks.delete(operationId);
  sendTaskResult({
    type: 'taskResult',
    operationId,
    status: 'failed',
    error,
    attemptToken,
    ...(workflowRevision !== undefined && { workflowRevision }),
  });
}

function cancel(operationId: string): void {
  const task = inFlightTasks.get(operationId);
  if (task === undefined) return;
  if (task.timeout !== undefined) {
    clearTimeout(task.timeout);
  }
  inFlightTasks.delete(operationId);
  sendTaskResult({
    type: 'taskResult',
    operationId,
    status: 'cancelled',
    cancelled: true,
    error: 'Task cancelled',
    attemptToken: task.attemptToken,
    ...(task.workflowRevision !== undefined && { workflowRevision: task.workflowRevision }),
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

  const attemptToken = message['attemptToken'];
  if (typeof attemptToken !== 'string' || attemptToken.length === 0) return;
  const rawWorkflowRevision = message['workflowRevision'];
  const workflowRevision =
    typeof rawWorkflowRevision === 'string' ? rawWorkflowRevision : undefined;

  if (activityName === 'conformance.echo') {
    complete(operationId, message['input'], attemptToken, workflowRevision);
    return;
  }

  const tokenField = { attemptToken, ...(workflowRevision !== undefined && { workflowRevision }) };

  if (activityName === 'conformance.sleep') {
    const timeout = setTimeout(
      () => complete(operationId, message['input'], attemptToken, workflowRevision),
      millisecondsFromInput(message['input']),
    );
    inFlightTasks.set(operationId, { activityName, timeout, ...tokenField });
    return;
  }

  if (activityName === 'conformance.cancel') {
    const timeout = setTimeout(
      () => fail(operationId, 'Cancel was not delivered', attemptToken, workflowRevision),
      millisecondsFromInput(message['input']),
    );
    inFlightTasks.set(operationId, { activityName, timeout, ...tokenField });
    return;
  }

  fail(operationId, `Unknown activity: ${activityName}`, attemptToken, workflowRevision);
}

/**
 * Handle a `taskResultAck`. The first one ever received by this process is
 * treated as lost — logged for the test's visibility, then the exact
 * original `taskResult` is resent — every ack after that is a normal,
 * logged acknowledgement with no resend.
 */
function handleTaskResultAck(message: Record<string, unknown>): void {
  const operationId = message['operationId'];
  const disposition = message['disposition'];
  if (typeof operationId !== 'string' || typeof disposition !== 'string') return;

  void recordDisposition(disposition);

  if (!hasDroppedFirstAck) {
    hasDroppedFirstAck = true;
    const original = sentResults.get(operationId);
    if (original !== undefined) {
      send(original);
    }
  }
}

socket.addEventListener('open', () => {
  send({
    type: 'register',
    protocolVersion,
    workerId,
    manifest: conformanceManifest(activities),
    concurrency: 3,
  });
});

socket.addEventListener('message', (event) => {
  const parsed = parseMessage(event.data);
  if (parsed === undefined) return;
  if (parsed['type'] === 'registerAck') {
    startHeartbeats();
  } else if (parsed['type'] === 'task') {
    handleTask(parsed);
  } else if (parsed['type'] === 'cancel') {
    const operationId = parsed['operationId'];
    if (typeof operationId === 'string') cancel(operationId);
  } else if (parsed['type'] === 'taskResultAck') {
    handleTaskResultAck(parsed);
  } else if (parsed['type'] === 'shutdown') {
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    socket.close();
  } else if (parsed['type'] === 'registerError' || parsed['type'] === 'protocolError') {
    process.stderr.write(`${JSON.stringify(parsed)}\n`);
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

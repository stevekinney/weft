#!/usr/bin/env bun

import { conformanceManifest } from './conformance-manifest.ts';

export type ConformanceRegisterExitWorkerFixture = 'register-exit';

const serverUrl = Bun.env['WEFT_WORKER_URL'];
const protocolVersion = Number(Bun.env['WEFT_WORKER_PROTOCOL_VERSION'] ?? '3');
const activities = (Bun.env['WEFT_WORKER_ACTIVITIES'] ?? '')
  .split(',')
  .map((activity) => activity.trim())
  .filter((activity) => activity.length > 0);
const workerId = `register-exit-worker-${crypto.randomUUID()}`;

if (serverUrl === undefined) {
  console.error('WEFT_WORKER_URL is required');
  process.exit(2);
}

const socket = new WebSocket(serverUrl);

function send(message: Record<string, unknown>): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
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
  const parsed = JSON.parse(String(event.data)) as Record<string, unknown>;
  if (parsed['type'] === 'registerAck') {
    return;
  }
  if (parsed['type'] !== 'task') {
    return;
  }

  const operationId = parsed['operationId'];
  const activityName = parsed['activityName'];
  if (typeof operationId !== 'string' || activityName !== 'conformance.echo') {
    return;
  }

  send({
    type: 'taskResult',
    operationId,
    attemptToken: parsed['attemptToken'],
    status: 'completed',
    value: parsed['input'] ?? null,
  });
  // Allow the server's asynchronous result transition to observe the frame
  // before closing the socket; closing immediately can trigger disconnect
  // cleanup before the completion persistence finishes.
  setTimeout(() => {
    socket.close();
  }, 100);
});

socket.addEventListener('close', () => {
  process.exit(0);
});

socket.addEventListener('error', () => {
  process.exit(1);
});

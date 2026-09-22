#!/usr/bin/env bun

import { conformanceManifest } from './conformance-manifest.ts';
import { resolveFixtureEnvironment } from './environment-configuration.ts';

export type ConformanceRegisterExitWorkerFixture = 'register-exit';

const serverUrl = resolveFixtureEnvironment().workerUrl;
const protocolVersion = resolveFixtureEnvironment().protocolVersion;
const activities = resolveFixtureEnvironment().activities;
const workerId = `register-exit-worker-${crypto.randomUUID()}`;

if (serverUrl === undefined) {
  process.stderr.write(`WEFT_WORKER_URL is required\n`);
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
  const parsedData: unknown = JSON.parse(String(event.data));
  if (parsedData === null || typeof parsedData !== 'object' || Array.isArray(parsedData)) return;
  const parsed = Object.fromEntries(Object.entries(parsedData));
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

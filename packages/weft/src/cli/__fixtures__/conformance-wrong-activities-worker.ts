#!/usr/bin/env bun

import { conformanceManifest } from './conformance-manifest.ts';
import { resolveFixtureEnvironment } from './environment-configuration.ts';

export type ConformanceWrongActivitiesWorkerFixture = 'wrong-activities';

const serverUrl = resolveFixtureEnvironment().workerUrl;

if (serverUrl === undefined) {
  process.stderr.write(`WEFT_WORKER_URL is required\n`);
  process.exit(2);
}

const socket = new WebSocket(serverUrl);

socket.addEventListener('open', () => {
  socket.send(
    JSON.stringify({
      type: 'register',
      protocolVersion: resolveFixtureEnvironment().protocolVersion,
      workerId: 'wrong-activities-worker',
      manifest: conformanceManifest(['other.activity']),
      concurrency: 1,
    }),
  );
});

socket.addEventListener('close', () => {
  process.exit(0);
});

socket.addEventListener('error', () => {
  process.exit(1);
});

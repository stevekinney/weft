#!/usr/bin/env bun

import { resolveFixtureEnvironment } from './environment-configuration.ts';

export type ConformanceBrokenWorkerFixture = 'broken';

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
      workerId: 'broken-conformance-worker',
      activities: ['conformance.echo'],
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

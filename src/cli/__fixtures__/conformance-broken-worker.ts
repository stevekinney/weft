#!/usr/bin/env bun

export type ConformanceBrokenWorkerFixture = 'broken';

const serverUrl = Bun.env['WEFT_WORKER_URL'];

if (serverUrl === undefined) {
  console.error('WEFT_WORKER_URL is required');
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

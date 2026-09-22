#!/usr/bin/env bun

import { resolveFixtureEnvironment } from './environment-configuration.ts';

/**
 * COR-240: registers with the retired protocol version 3 explicitly, rather
 * than omitting `protocolVersion` (see `conformance-broken-worker.ts`) or
 * relying on the fixture environment's default (which tracks the current
 * `REMOTE_WORKER_PROTOCOL_VERSION`). Proves the server has no second
 * compatibility parser for the retired wire version — the registration is
 * rejected exactly as an unrecognized future version would be.
 */
export type ConformanceLegacyProtocolWorkerFixture = 'legacy-protocol';

const RETIRED_PROTOCOL_VERSION = 3;

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
      protocolVersion: RETIRED_PROTOCOL_VERSION,
      workerId: 'legacy-protocol-conformance-worker',
      manifest: {
        manifestVersion: 1,
        protocolVersion: RETIRED_PROTOCOL_VERSION,
        sdkVersion: '0.0.0',
        runtime: { name: 'bun', version: Bun.version },
        deployment: {
          name: 'legacy-conformance',
          buildId: 'legacy-conformance-fixture',
          artifactDigest: 'sha256:legacy-conformance-fixture',
        },
        workflows: {},
        capabilities: {},
      },
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

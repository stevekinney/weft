#!/usr/bin/env bun

import { createStorage } from '../src/cli/index.ts';
import { Engine } from '../src/core/engine.ts';
import { helloWorldWorkflow } from '../src/hello-world.test-support.ts';
import { serve } from '../src/server/index.ts';

const portArgument = Bun.argv.find((argument) => argument.startsWith('--port='));
const parsedPort = portArgument ? Number(portArgument.slice('--port='.length)) : 0;
if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65_535) {
  console.error(`Invalid --port value: ${portArgument}`);
  process.exit(1);
}

const storage = await createStorage('memory', ':memory:');
const engine = new Engine({ storage });

engine.register(helloWorldWorkflow);

// Bind to loopback only — the smoke harness is a local subprocess, not a
// public server. Pinning to 127.0.0.1 keeps it off the wildcard interface.
const server = serve({ engine, port: parsedPort, hostname: '127.0.0.1' });

console.log(`SMOKE_READY ${server.url}`);

process.on('SIGTERM', () => {
  void (async () => {
    await server.stop();
    storage[Symbol.dispose]();
    process.exit(0);
  })();
});

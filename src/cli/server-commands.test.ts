import { describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import { serve } from '../server/index.ts';
import { executeServer } from './server-commands.ts';
import type { ServerCommand } from './types.ts';

function healthCommand(overrides: Partial<ServerCommand> = {}): ServerCommand {
  return {
    command: 'server',
    action: 'health',
    wait: false,
    waitTimeoutMs: 2000,
    help: false,
    json: false,
    quiet: false,
    ...overrides,
  };
}

describe('weft server health', () => {
  it('returns exit 0 against a live server', async () => {
    const engine = new Engine();
    const server = serve({ engine, port: 0 });
    try {
      const result = await executeServer(healthCommand({ server: server.url.toString() }));
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('healthy');
    } finally {
      await server.stop();
      engine[Symbol.dispose]();
    }
  });

  it('returns exit 2 on a connection error (no server at address)', async () => {
    const result = await executeServer(healthCommand({ server: 'http://127.0.0.1:1/' }));
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('unreachable');
  });

  it('--wait returns 0 once a server is up and non-zero when none appears', async () => {
    const engine = new Engine();
    const server = serve({ engine, port: 0 });
    try {
      const ready = await executeServer(
        healthCommand({ server: server.url.toString(), wait: true, waitTimeoutMs: 2000 }),
      );
      expect(ready.exitCode).toBe(0);
    } finally {
      await server.stop();
      engine[Symbol.dispose]();
    }

    const unreachable = await executeServer(
      healthCommand({ server: 'http://127.0.0.1:1/', wait: true, waitTimeoutMs: 300 }),
    );
    // Port 1 refuses connections — every probe is a connection error → exit 2.
    expect(unreachable.exitCode).toBe(2);
  });

  it('emits JSON when requested', async () => {
    const engine = new Engine();
    const server = serve({ engine, port: 0 });
    try {
      const result = await executeServer(
        healthCommand({ server: server.url.toString(), json: true }),
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ healthy: true });
    } finally {
      await server.stop();
      engine[Symbol.dispose]();
    }
  });

  it('surfaces connection configuration errors and quiet health failures', async () => {
    const badConnection = await executeServer(healthCommand({ server: 'not-a-url' }));
    expect(badConnection.exitCode).toBe(2);
    expect(badConnection.stderr).toContain('connection error');

    const quietFailure = await executeServer(
      healthCommand({ server: 'http://127.0.0.1:1/', quiet: true }),
    );
    expect(quietFailure.exitCode).toBe(2);
    expect(quietFailure.stderr).toBe('');
  });
});

describe('weft server info', () => {
  it('reports health and the catalog operation count', async () => {
    const engine = new Engine();
    const server = serve({ engine, port: 0 });
    try {
      const result = await executeServer(
        healthCommand({ action: 'info', server: server.url.toString() }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Health:  ok');
      expect(result.stdout).toContain('CLI catalog operations:');
    } finally {
      await server.stop();
      engine[Symbol.dispose]();
    }
  });

  it('reports JSON info and preserves unhealthy exit codes', async () => {
    const result = await executeServer(
      healthCommand({ action: 'info', server: 'http://127.0.0.1:1/', json: true }),
    );
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      healthy: false,
      serverOperationCount: null,
      additionalOperations: [],
    });
  });
});

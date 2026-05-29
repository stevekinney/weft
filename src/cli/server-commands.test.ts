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
  } as ServerCommand;
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

  it('returns non-zero when the server is unreachable', async () => {
    const result = await executeServer(healthCommand({ server: 'http://127.0.0.1:1/' }));
    expect(result.exitCode).toBe(1);
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
    expect(unreachable.exitCode).toBe(1);
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
});

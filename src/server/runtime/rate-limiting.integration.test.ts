import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import type { AuthAuditEvent } from '../authentication.ts';
import { serve, type WeftServer } from '../index.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

const TEST_API_KEY = 'weft_key_ratelimit_test';

function createEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register(echoWorkflow);
  return engine;
}

describe('serve() with rate limiting', () => {
  let engine: Engine;
  let server: WeftServer;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  it('rate-limits a flood from one authenticated principal with 429 + Retry-After', async () => {
    engine = createEngine();
    server = serve({
      engine,
      port: 0,
      auth: { apiKeys: [TEST_API_KEY] },
      rateLimit: { maxRequests: 3, windowMs: 60_000 },
    });

    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const response = await fetch(`${server.url}/v1/workflows`, {
        headers: { 'X-API-Key': TEST_API_KEY },
      });
      statuses.push(response.status);
      await response.body?.cancel();
    }

    const limited = statuses.filter((status) => status === 429);
    // 3 allowed within the window, the remaining 5 throttled.
    expect(limited.length).toBe(5);

    const flooded = await fetch(`${server.url}/v1/workflows`, {
      headers: { 'X-API-Key': TEST_API_KEY },
    });
    expect(flooded.status).toBe(429);
    expect(flooded.headers.get('Retry-After')).not.toBeNull();
    expect(flooded.headers.get('X-RateLimit-Limit')).toBe('3');
    const body = (await flooded.json()) as { error: string };
    expect(body.error).toBe('Too Many Requests');
  });

  it('exempts public paths (health) from rate limiting', async () => {
    engine = createEngine();
    server = serve({
      engine,
      port: 0,
      auth: { apiKeys: [TEST_API_KEY] },
      rateLimit: { maxRequests: 1, windowMs: 60_000 },
    });

    // Far more health probes than the budget — none should be throttled.
    for (let i = 0; i < 5; i++) {
      const response = await fetch(`${server.url}/v1/health`);
      expect(response.status).not.toBe(429);
      await response.body?.cancel();
    }
  });

  it('does not rate-limit when rateLimit is omitted', async () => {
    engine = createEngine();
    server = serve({ engine, port: 0, auth: { apiKeys: [TEST_API_KEY] } });

    for (let i = 0; i < 10; i++) {
      const response = await fetch(`${server.url}/v1/workflows`, {
        headers: { 'X-API-Key': TEST_API_KEY },
      });
      expect(response.status).not.toBe(429);
      await response.body?.cancel();
    }
  });

  it('rejects an invalid rateLimit config before binding', () => {
    engine = createEngine();
    expect(() =>
      serve({ engine, port: 0, rateLimit: { maxRequests: 0, windowMs: 1_000 } }),
    ).toThrow();
    // No server was created; stub the afterEach handle so cleanup is a no-op.
    server = { stop: async () => {} } as WeftServer;
  });
});

describe('serve() auth audit trail', () => {
  let engine: Engine;
  let server: WeftServer;

  afterEach(async () => {
    await server?.stop();
    engine?.[Symbol.dispose]();
  });

  it('emits structured success and failure audit events through the pipeline', async () => {
    engine = createEngine();
    const events: AuthAuditEvent[] = [];

    server = serve({
      engine,
      port: 0,
      auth: {
        apiKeys: [TEST_API_KEY],
        defaultApiKeyScopes: ['workflows:read'],
        auditSink: (event) => events.push(event),
      },
    });

    // Success.
    const ok = await fetch(`${server.url}/v1/workflows`, {
      headers: { 'X-API-Key': TEST_API_KEY },
    });
    await ok.body?.cancel();

    // Failure.
    const bad = await fetch(`${server.url}/v1/workflows`, {
      headers: { 'X-API-Key': 'wrong-key' },
    });
    await bad.body?.cancel();

    const success = events.find((event) => event.outcome === 'success');
    const failure = events.find((event) => event.outcome === 'failure');

    expect(success).toBeDefined();
    expect(success!.method).toBe('api-key');
    expect(success!.subject).toBe('api-key-caller');

    expect(failure).toBeDefined();
    expect(failure!.reason).toBe('No valid credentials provided');

    // No event may carry a raw credential.
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(TEST_API_KEY);
    expect(serialized).not.toContain('wrong-key');
  });

  it('does not audit public-path bypasses', async () => {
    engine = createEngine();
    const events: AuthAuditEvent[] = [];

    server = serve({
      engine,
      port: 0,
      auth: { apiKeys: [TEST_API_KEY], auditSink: (event) => events.push(event) },
    });

    const health = await fetch(`${server.url}/v1/health`);
    await health.body?.cancel();

    expect(events.some((event) => event.path === '/v1/health')).toBe(false);
  });
});

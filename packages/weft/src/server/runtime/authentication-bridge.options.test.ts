import { afterEach, describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { Engine } from '../../core/engine.ts';
import type { ServeOptions } from '../index.ts';
import { buildServerContext, resolveNetworkConfig } from '../serve-internals.ts';
import { handleServerFetchRequest } from './authentication-bridge.ts';

const engines: Engine[] = [];

afterEach(() => {
  for (const engine of engines.splice(0)) engine[Symbol.dispose]();
});

function createHarness(overrides: Partial<ServeOptions> = {}) {
  const engine = new Engine({ storage: new MemoryStorage() });
  engines.push(engine);
  const configuration = resolveNetworkConfig({
    engine,
    port: 0,
    unauthenticatedAccess: 'allow',
    trustedHosts: ['localhost'],
    ...overrides,
  });
  const context = buildServerContext(
    configuration.serverOptions,
    configuration.serverMetricsCollector,
  );
  const server = { requestIP: () => null } as unknown as ReturnType<typeof Bun.serve>;
  return {
    context,
    options: configuration.serverOptions,
    fetch: (
      request: Request,
      options: Parameters<typeof handleServerFetchRequest>[2] = configuration.serverOptions,
    ) => handleServerFetchRequest(server, context, options, request),
  };
}

describe('handleServerFetchRequest option forwarding', () => {
  it('rejects a JSON-RPC body over maxRequestBodyBytes with 413', async () => {
    const harness = createHarness({ maxRequestBodyBytes: 128 });
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'rpc.discover',
      params: { padding: 'x'.repeat(512) },
    });

    const response = await harness.fetch(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    );

    expect(response?.status).toBe(413);
  });

  it('rejects a REST request body over maxRequestBodyBytes with 413', async () => {
    const harness = createHarness({ maxRequestBodyBytes: 128 });

    const response = await harness.fetch(
      new Request('http://localhost/v1/workflows', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'echo', input: 'x'.repeat(512) }),
      }),
    );

    expect(response?.status).toBe(413);
  });

  it('still demands a principal at the MCP endpoint when the path is public on an authenticated server', async () => {
    const harness = createHarness({
      auth: {
        apiKeys: ['unused-key'],
        defaultApiKeyScopes: ['system:read'],
        publicPaths: ['/mcp'],
      },
    });

    const response = await harness.fetch(new Request('http://localhost/mcp', { method: 'GET' }));

    // The gate admits the request as public (no principal is forwarded), and the MCP handler
    // itself, told that authentication is required, refuses to serve it without one.
    expect(response?.status).toBe(401);
  });

  it('falls back to the engine metrics when no Prometheus exporter is configured', async () => {
    const harness = createHarness();
    const { prometheusExporter: _omitted, ...withoutExporter } = harness.options;

    const response = await harness.fetch(
      new Request('http://localhost/v1/metrics'),
      withoutExporter,
    );

    expect(response?.status).toBe(200);
    expect(await response?.text()).toContain('# HELP weft_workflow_failed');
  });
});

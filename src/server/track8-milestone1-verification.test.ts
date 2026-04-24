/**
 * Track 8 acceptance — verifies that `serve()` wires the live
 * `OperationRegistry` + `REST_BINDINGS` into `handleRequest`, and that
 * the migrated `weft.workflows.get` route resolves end-to-end through
 * the shared pipeline.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import type { Context } from '../core/context.ts';
import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { serve, type WeftServer } from './index.ts';
import { createLiveOperationRegistry, REST_BINDINGS } from './rest-bindings.ts';

function createHoldEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register('hold', async function* (ctx: WorkflowContext, _input: unknown) {
    return yield* (ctx as Context).waitForSignal<string>('release');
  });
  return engine;
}

async function waitForStatus(
  engine: Engine,
  workflowId: string,
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out',
  timeoutMilliseconds = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const state = await engine.get(workflowId);
    if (state?.status === status) return;
    await Bun.sleep(5);
  }
  throw new Error(`workflow ${workflowId} did not reach ${status} in time`);
}

describe('Track 8 — live operation registry matches REST_BINDINGS', () => {
  it('createLiveOperationRegistry resolves every operation referenced by REST_BINDINGS', () => {
    const registry = createLiveOperationRegistry();
    for (const binding of REST_BINDINGS) {
      const operation = registry.get(binding.operationName);
      expect(operation).toBeDefined();
      expect(operation?.name).toBe(binding.operationName);
    }
  });

  it('REST_BINDINGS mounts weft.workflows.get at GET /v1/workflows/:id', () => {
    const binding = REST_BINDINGS.find((b) => b.method === 'GET' && b.path === '/v1/workflows/:id');
    expect(binding).toBeDefined();
    expect(binding?.operationName).toBe('weft.workflows.get');
  });
});

describe('Track 8 — end-to-end serve() → REST pipeline', () => {
  let server: WeftServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('GET /v1/workflows/:id returns the workflow state', async () => {
    const engine = createHoldEngine();
    const handle = await engine.start('hold', { track: 8 }, {});
    await waitForStatus(engine, handle.id, 'running');

    server = serve({ engine, port: 0 });
    const response = await fetch(`${server.url}/v1/workflows/${handle.id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    const body = (await response.json()) as { id?: string };
    expect(body.id).toBe(handle.id);
  });

  it('GET /openapi.json returns a valid OpenAPI 3.1 document that includes the migrated route', async () => {
    const engine = createHoldEngine();
    server = serve({ engine, port: 0 });

    const response = await fetch(`${server.url}/openapi.json`);
    expect(response.status).toBe(200);
    const doc = (await response.json()) as { openapi?: string; paths?: Record<string, unknown> };
    expect(doc.openapi).toMatch(/^3\.1/);
    expect(doc.paths?.['/v1/workflows/{id}']).toBeDefined();
  });
});

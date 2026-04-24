/**
 * Phase 17 — Track 8 Milestone 1 acceptance suite.
 *
 * Verifies that `ServeOptions.restDispatchMode` threads correctly
 * through `serve()` into `handleRequest`, and that the migrated
 * `weft.workflows.get` operation produces byte-for-byte identical
 * responses under legacy AND `via-execute-operation`. The JSON-RPC
 * / WebSocket / stdio / rpc.discover surfaces are not mounted in
 * `serve()` yet — those phases are owed to Milestone 2.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { Context } from '../core/context.ts';
import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { handleRequest } from './handler.ts';
import { serve, type WeftServer } from './index.ts';
import { createOperationRegistry } from './operation-catalog.ts';
import { defineOperation } from './operation-registry.ts';
import type { UnknownRestBinding } from './rest-bindings.ts';
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

describe('Track 8 Milestone 1 — live operation registry matches REST_BINDINGS', () => {
  it('createLiveOperationRegistry resolves every operation referenced by REST_BINDINGS', () => {
    const registry = createLiveOperationRegistry();
    for (const binding of REST_BINDINGS) {
      const operation = registry.get(binding.operationName);
      expect(operation).toBeDefined();
      expect(operation?.name).toBe(binding.operationName);
    }
  });

  it('REST_BINDINGS mounts weft.workflows.get at GET /v1/workflows/:id', () => {
    // Pinning the (method, path, operationName) triple — without this,
    // renaming the operation or remounting it at a different path would
    // silently pass the other tests in this suite.
    const binding = REST_BINDINGS.find((b) => b.method === 'GET' && b.path === '/v1/workflows/:id');
    expect(binding).toBeDefined();
    expect(binding?.operationName).toBe('weft.workflows.get');
  });
});

describe('Track 8 Milestone 1 — end-to-end serve() → REST pipeline', () => {
  let server: WeftServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('GET /v1/workflows/:id returns matching body + content-type under legacy AND via-execute-operation', async () => {
    const engine = createHoldEngine();
    const handle = await engine.start('hold', { phase: 17 }, {});
    await waitForStatus(engine, handle.id, 'running');

    // Legacy dispatch (default).
    server = serve({ engine, port: 0 });
    const legacyResponse = await fetch(`${server.url}/v1/workflows/${handle.id}`);
    expect(legacyResponse.status).toBe(200);
    const legacyBody = await legacyResponse.text();
    await server.stop();

    // Via-execute-operation dispatch. Reuse the same engine so both
    // paths see identical state.
    server = serve({
      engine,
      port: 0,
      restDispatchMode: { operations: { 'weft.workflows.get': 'via-execute-operation' } },
    });
    const pipelineResponse = await fetch(`${server.url}/v1/workflows/${handle.id}`);
    expect(pipelineResponse.status).toBe(200);
    const pipelineBody = await pipelineResponse.text();

    // Response-body parity (plus matching Content-Type) is what Milestone 1
    // guarantees — the pipeline path serializes the engine's state the same
    // way as the legacy executor. This assertion does NOT prove the pipeline
    // branch was actually taken (both modes return the same body); that's
    // covered by the spy test below.
    expect(pipelineBody).toBe(legacyBody);
    expect(pipelineResponse.headers.get('content-type')).toBe(
      legacyResponse.headers.get('content-type'),
    );
  });

  it('restDispatchMode=via-execute-operation actually routes through the pipeline (sentinel spy)', async () => {
    // The parity test above proves body equality, but body equality is the
    // same on both paths by design — a silent regression that routes the
    // pipeline back to legacy would still pass. This test injects a spy
    // registry whose `weft.workflows.get` returns a sentinel only the
    // pipeline path can produce, proving `restDispatchMode` is honored.
    const engine = createHoldEngine();
    const handle = await engine.start('hold', { phase: 17 }, {});
    await waitForStatus(engine, handle.id, 'running');

    const spyOperation = defineOperation({
      name: 'weft.workflows.get',
      summary: 'spy',
      inputSchema: z.object({ workflowId: z.string() }),
      outputSchema: z.object({ sentinel: z.literal('via-pipeline') }),
      access: { kind: 'public' },
      transports: { http: true, jsonRpcHttp: false, jsonRpcWebSocket: false, jsonRpcStdio: false },
      unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
      invoke: async () => ({ sentinel: 'via-pipeline' as const }),
    });

    // Use the live `getWorkflowRestBinding` path — we want the production
    // route ('GET /v1/workflows/:id') to resolve to the spy so a regression
    // in the real binding shows up. Point the binding's operationName into
    // the spy registry by reusing the real binding unchanged.
    const spyRegistry = createOperationRegistry([spyOperation]);
    const liveBinding: UnknownRestBinding | undefined = REST_BINDINGS.find(
      (b) => b.method === 'GET' && b.path === '/v1/workflows/:id',
    );
    expect(liveBinding).toBeDefined();

    // Legacy mode: the handler ignores the registry. Response comes from
    // the engine via the legacy executor → a real WorkflowState, NOT the
    // sentinel.
    const legacyRequest = new Request(`http://localhost/v1/workflows/${handle.id}`, {
      method: 'GET',
    });
    const legacyResponse = await handleRequest(legacyRequest, engine, {
      operationRegistry: spyRegistry,
      restBindings: [liveBinding as UnknownRestBinding],
      // restDispatchMode omitted → default is legacy.
    });
    const legacyBody = (await legacyResponse.json()) as Record<string, unknown>;
    expect(legacyBody['sentinel']).toBeUndefined();
    expect(legacyBody['id']).toBe(handle.id);

    // Pipeline mode: via-execute-operation routes through the spy, whose
    // invoke returns { sentinel: 'via-pipeline' }. If the option is
    // ignored, the response would be the real engine state instead.
    const pipelineRequest = new Request(`http://localhost/v1/workflows/${handle.id}`, {
      method: 'GET',
    });
    const pipelineResponse = await handleRequest(pipelineRequest, engine, {
      operationRegistry: spyRegistry,
      restBindings: [liveBinding as UnknownRestBinding],
      restDispatchMode: { operations: { 'weft.workflows.get': 'via-execute-operation' } },
    });
    const pipelineBody = (await pipelineResponse.json()) as Record<string, unknown>;
    expect(pipelineBody['sentinel']).toBe('via-pipeline');
  });
});

describe('Track 8 Milestone 1 — /openapi.json survives the new wiring', () => {
  let server: WeftServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  for (const mode of ['legacy', 'via-execute-operation'] as const) {
    it(`returns a valid OpenAPI 3.1 document under restDispatchMode='${mode}'`, async () => {
      const engine = createHoldEngine();
      server = serve({
        engine,
        port: 0,
        restDispatchMode: { operations: { 'weft.workflows.get': mode } },
      });

      const response = await fetch(`${server.url}/openapi.json`);
      expect(response.status).toBe(200);
      const doc = (await response.json()) as { openapi?: string; paths?: Record<string, unknown> };
      expect(doc.openapi).toMatch(/^3\.1/);
      expect(doc.paths?.['/v1/workflows/{id}']).toBeDefined();
    });
  }
});

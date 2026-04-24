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

describe('Track 8 Milestone 1 — live operation registry matches REST_BINDINGS', () => {
  it('createLiveOperationRegistry resolves every operation referenced by REST_BINDINGS', () => {
    const registry = createLiveOperationRegistry();
    for (const binding of REST_BINDINGS) {
      const operation = registry.get(binding.operationName);
      expect(operation).toBeDefined();
      expect(operation?.name).toBe(binding.operationName);
    }
  });

  it('REST_BINDINGS contains at least one entry (the Milestone 1 surface is non-empty)', () => {
    expect(REST_BINDINGS.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Track 8 Milestone 1 — end-to-end serve() → REST pipeline', () => {
  let server: WeftServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('GET /v1/workflows/:id serves the same state under legacy AND via-execute-operation', async () => {
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

    // Byte-for-byte parity — the pipeline path must produce exactly
    // the same wire output as the legacy path. Content-Type matches
    // too (both produce `application/json` without charset).
    expect(pipelineBody).toBe(legacyBody);
    expect(pipelineResponse.headers.get('content-type')).toBe(
      legacyResponse.headers.get('content-type'),
    );
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

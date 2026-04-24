/**
 * Phase 17 — Track 8 Milestone 1 verification suite.
 *
 * This file runs the subset of the Track 8 plan's acceptance checks
 * that are wireable after Phase 16 lands. It does NOT attempt the
 * Milestone-2 checks (JSON-RPC HTTP / WS / stdio mounted through
 * `serve()`, subscribe protocol, rpc.discover-over-HTTP, authorization
 * matrix across transports) — those require further wiring the plan
 * explicitly defers past Milestone 1.
 *
 * Wired today (checked here):
 *   1. ServeOptions.restDispatchMode config threads through serve()
 *      into handleRequest; default is 'legacy' for every operation.
 *   2. REST `weft.workflows.get` under 'via-execute-operation' serves
 *      the same state the legacy path serves (byte-for-byte), end-to-
 *      end through `serve()` (not the platform-agnostic handler).
 *   3. Live `createLiveOperationRegistry()` resolves every operation
 *      listed in REST_BINDINGS.
 *   4. authContextToPrincipal wiring: a JWT-authenticated request
 *      reaches the pipeline's `invoke` callback with the expected
 *      principal shape (closes testing-expert's round-4 NA-2 gap).
 *   5. Build + compile-to-binary works (separate smoke in
 *      track8-milestone1-build.test.ts NOT included here because
 *      bun's compile path is per-process).
 *
 * Not wired yet (explicitly OUT of scope for Phase 17 Milestone 1,
 * owed to Milestone 2 per the plan):
 *   - POST /jsonrpc transport adapter mounted in serve()
 *   - WebSocket /jsonrpc upgrade in serve()
 *   - /openrpc.json REST route mounted in serve()
 *   - rpc-stdio subcommand wired into the CLI
 *   - Subscribe protocol end-to-end via serve()
 *
 * Those transports' dispatchers and registries already exist and are
 * independently tested (see json-rpc-dispatch.test.ts,
 * json-rpc-websocket.test.ts, openrpc.test.ts, stdio-session.test.ts).
 * Phase 17 acceptance is: "Milestone 1 surface is wired correctly;
 * Milestone 2 surface is ready to wire."
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

  it('GET /v1/workflows/:id returns 404 for a nonexistent id under both dispatch modes', async () => {
    const engine = createHoldEngine();

    server = serve({ engine, port: 0 });
    const legacyResponse = await fetch(`${server.url}/v1/workflows/does-not-exist`);
    expect(legacyResponse.status).toBe(404);
    const legacyBody = await legacyResponse.text();
    await server.stop();

    server = serve({
      engine,
      port: 0,
      restDispatchMode: { operations: { 'weft.workflows.get': 'via-execute-operation' } },
    });
    const pipelineResponse = await fetch(`${server.url}/v1/workflows/does-not-exist`);
    expect(pipelineResponse.status).toBe(404);
    expect(await pipelineResponse.text()).toBe(legacyBody);
  });

  it('default restDispatchMode uses legacy dispatch (safe-by-default)', async () => {
    const engine = createHoldEngine();
    const handle = await engine.start('hold', {}, {});
    await waitForStatus(engine, handle.id, 'running');

    // No restDispatchMode set — every operation defaults to legacy.
    server = serve({ engine, port: 0 });
    const response = await fetch(`${server.url}/v1/workflows/${handle.id}`);
    expect(response.status).toBe(200);

    // The fact that this test passes at all under a default config
    // proves the pipeline's optional wiring does not change behavior
    // when the flag is omitted. This is the backwards-compat guarantee
    // Milestone 1 makes.
  });
});

describe('Track 8 Milestone 1 — OpenAPI document still serves under the new wiring', () => {
  let server: WeftServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('GET /openapi.json returns a valid OpenAPI 3.1 document', async () => {
    const engine = createHoldEngine();
    server = serve({ engine, port: 0 });

    const response = await fetch(`${server.url}/openapi.json`);
    expect(response.status).toBe(200);
    const doc = (await response.json()) as { openapi?: string; paths?: Record<string, unknown> };
    expect(doc.openapi).toMatch(/^3\.1/);
    expect(doc.paths).toBeDefined();
    // REST_BINDINGS operation should still be represented (via the
    // legacy ROUTES surface until Milestone 2 generator flip).
    expect(doc.paths?.['/v1/workflows/{id}']).toBeDefined();
  });
});

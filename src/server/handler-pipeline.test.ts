/**
 * Phase 15 — Integration tests for the `handleRequest` pipeline path.
 *
 * Covers the seams the per-operation parity tests don't naturally
 * exercise:
 *
 *   - Streaming binding without `shapeSuccess` → handler-level 500.
 *   - `authContextToPrincipal` branches through the live pipeline:
 *     jwt-with-claims, api-key, mtls, undefined.
 *
 * Each test wires a minimal "spy" operation that records which
 * principal.method reached the `invoke` callback; the assertion is on
 * that recorded value (proving the right branch of
 * `authContextToPrincipal` ran).
 */

import { describe, expect, it } from 'bun:test';

import { z } from 'zod';
import type { Context } from '../core/context.ts';
import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { handleRequest } from './handler.ts';
import { createOperationRegistry, type OperationRegistry } from './operation-catalog.ts';
import { defineOperation } from './operation-registry.ts';
import type { Principal } from './principal.ts';
import type { RestBinding } from './rest-binding.ts';
import type { UnknownRestBinding } from './rest-bindings.ts';

function createEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register('hold', async function* (ctx: WorkflowContext, _input: unknown) {
    return yield* (ctx as Context).waitForSignal<string>('release');
  });
  return engine;
}

async function waitForRunning(engine: Engine, workflowId: string): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    const state = await engine.get(workflowId);
    if (state?.status === 'running') return;
    await Bun.sleep(5);
  }
  throw new Error(`workflow ${workflowId} did not reach running`);
}

/**
 * Build an operation + binding pair that captures the principal the
 * pipeline hands `invoke`. The captured principal flows back through
 * the response body so tests can read it without poking private state.
 */
function buildPrincipalSpy(): {
  readonly registry: OperationRegistry;
  readonly bindings: ReadonlyArray<UnknownRestBinding>;
  readonly captured: { principal?: Principal };
} {
  const captured: { principal?: Principal } = {};
  const operation = defineOperation({
    name: 'weft.test.principalspy',
    summary: 'spy',
    inputSchema: z.object({ workflowId: z.string() }),
    outputSchema: z.object({ method: z.string() }),
    access: { kind: 'public' },
    transports: { http: true, jsonRpcHttp: false, jsonRpcWebSocket: false, jsonRpcStdio: false },
    unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
    invoke: async ({ principal }) => {
      captured.principal = principal;
      return { method: principal.method };
    },
  });
  const binding: RestBinding<{ workflowId: string }, { method: string }> = {
    method: 'GET',
    path: '/v1/test/principalspy/:id',
    pathParamNames: ['id'],
    operationName: 'weft.test.principalspy',
    inputSources: { workflowId: { kind: 'path', pathParam: 'id' } },
    extractInput: async (_request, pathParams) => ({ workflowId: pathParams['id'] ?? '' }),
    success: { kind: 'json', status: 200 },
  };
  const registry = createOperationRegistry([operation]);
  // Typed strict at the factory, widen at the router boundary.
  return { registry, bindings: [binding as UnknownRestBinding], captured };
}

describe('handler pipeline — streaming binding guard', () => {
  it('returns 500 when a streaming binding has no shapeSuccess', async () => {
    const engine = createEngine();
    const handle = await engine.start('hold', {}, {});
    await waitForRunning(engine, handle.id);

    const operation = defineOperation({
      name: 'weft.test.streamnoshape',
      summary: 'streaming op without shapeSuccess',
      inputSchema: z.object({ workflowId: z.string() }),
      outputSchema: z.unknown(),
      access: { kind: 'public' },
      transports: { http: true, jsonRpcHttp: false, jsonRpcWebSocket: false, jsonRpcStdio: false },
      unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
      invoke: async () => 'any-value',
    });
    const binding: UnknownRestBinding = {
      method: 'GET',
      path: '/v1/test/streamnoshape/:id',
      pathParamNames: ['id'],
      operationName: 'weft.test.streamnoshape',
      inputSources: { workflowId: { kind: 'path', pathParam: 'id' } },
      extractInput: async (_request, pathParams) => ({ workflowId: pathParams['id'] ?? '' }),
      success: { kind: 'streaming', mediaType: 'text/event-stream' },
      // shapeSuccess intentionally omitted — defaultShapeSuccess must
      // throw, and the outer handler must convert that to a 500.
    };
    const registry = createOperationRegistry([operation]);

    const request = new Request(`http://localhost/v1/test/streamnoshape/${handle.id}`, {
      method: 'GET',
    });
    const response = await handleRequest(request, engine, {
      restDispatchMode: 'via-execute-operation',
      operationRegistry: registry,
      restBindings: [binding],
    });
    expect(response.status).toBe(500);
  });
});

describe('handler pipeline — authContextToPrincipal branches', () => {
  it('undefined authContext → anonymousPrincipal (method "unauthenticated")', async () => {
    const engine = createEngine();
    const handle = await engine.start('hold', {}, {});
    await waitForRunning(engine, handle.id);

    const { registry, bindings, captured } = buildPrincipalSpy();
    const request = new Request(`http://localhost/v1/test/principalspy/${handle.id}`, {
      method: 'GET',
    });
    const response = await handleRequest(request, engine, {
      restDispatchMode: 'via-execute-operation',
      operationRegistry: registry,
      restBindings: bindings,
      // authContext intentionally omitted.
    });
    expect(response.status).toBe(200);
    expect(captured.principal?.method).toBe('unauthenticated');
  });

  it('jwt authContext with claims → principalFromJwtClaims (method "jwt")', async () => {
    const engine = createEngine();
    const handle = await engine.start('hold', {}, {});
    await waitForRunning(engine, handle.id);

    const { registry, bindings, captured } = buildPrincipalSpy();
    const request = new Request(`http://localhost/v1/test/principalspy/${handle.id}`, {
      method: 'GET',
    });
    const response = await handleRequest(request, engine, {
      restDispatchMode: 'via-execute-operation',
      operationRegistry: registry,
      restBindings: bindings,
      authContext: {
        method: 'jwt',
        claims: { sub: 'spy-subject', scope: 'workflows:read' },
      },
    });
    expect(response.status).toBe(200);
    expect(captured.principal?.method).toBe('jwt');
    if (captured.principal?.method === 'jwt') {
      expect(captured.principal.subject).toBe('spy-subject');
      expect(captured.principal.hasScope('workflows:read')).toBe(true);
    }
  });

  it('api-key authContext → principalFromApiKey (method "api-key")', async () => {
    const engine = createEngine();
    const handle = await engine.start('hold', {}, {});
    await waitForRunning(engine, handle.id);

    const { registry, bindings, captured } = buildPrincipalSpy();
    const request = new Request(`http://localhost/v1/test/principalspy/${handle.id}`, {
      method: 'GET',
    });
    const response = await handleRequest(request, engine, {
      restDispatchMode: 'via-execute-operation',
      operationRegistry: registry,
      restBindings: bindings,
      authContext: { method: 'api-key' },
    });
    expect(response.status).toBe(200);
    expect(captured.principal?.method).toBe('api-key');
  });

  it('mtls authContext → principalFromMutualTls (method "mtls")', async () => {
    const engine = createEngine();
    const handle = await engine.start('hold', {}, {});
    await waitForRunning(engine, handle.id);

    const { registry, bindings, captured } = buildPrincipalSpy();
    const request = new Request(`http://localhost/v1/test/principalspy/${handle.id}`, {
      method: 'GET',
    });
    const response = await handleRequest(request, engine, {
      restDispatchMode: 'via-execute-operation',
      operationRegistry: registry,
      restBindings: bindings,
      authContext: { method: 'mtls' },
    });
    expect(response.status).toBe(200);
    expect(captured.principal?.method).toBe('mtls');
  });
});

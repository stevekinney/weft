import { waitForCondition } from '../testing/fake-timers.test-support.ts';
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
import { Engine } from '../core/engine.ts';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { handleRequest } from './handler.ts';
import { createOperationRegistry, type OperationRegistry } from './operation-catalog.ts';
import { defineOperation } from './operation-registry.ts';
import { principalFromApiKey, type Principal } from './principal.ts';
import type { RestBinding } from './rest-binding.ts';
import type { UnknownRestBinding } from './rest-bindings.ts';

const holdWorkflow = workflow({ name: 'hold' }).execute(async function* (
  ctx: WorkflowContext,
  _input: unknown,
) {
  return yield* ctx.waitForSignal<string>('release');
});

function createEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register(holdWorkflow);
  return engine;
}

async function waitForRunning(engine: Engine, workflowId: string): Promise<void> {
  await waitForCondition(
    async () => {
      const state = await engine.get(workflowId);
      return state?.status === 'running';
    },
    { label: `workflow ${workflowId} to reach running`, timeoutMs: 500, intervalMs: 5 },
  );
}

async function recordExpectedConsoleError<T>(run: () => Promise<T>): Promise<{
  readonly result: T;
  readonly calls: readonly unknown[][];
}> {
  const recordedCalls: unknown[][] = [];
  const originalError = console.error;
  console.error = ((...args: unknown[]) => {
    recordedCalls.push(args);
  }) as typeof console.error;

  try {
    const result = await run();
    return { result, calls: recordedCalls };
  } finally {
    console.error = originalError;
  }
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
    mcpExposable: false,
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

describe('handler pipeline — restBindings / operationRegistry pairing guard', () => {
  it('rejects restBindings supplied without operationRegistry (500)', async () => {
    const engine = createEngine();
    const { registry: _registry, bindings } = buildPrincipalSpy();
    const request = new Request('http://localhost/v1/test/principalspy/any-id', {
      method: 'GET',
    });
    const response = await handleRequest(request, engine, {
      restBindings: bindings,
      // operationRegistry intentionally omitted — custom bindings would
      // silently pair with the live registry otherwise, producing
      // MethodNotFound at dispatch time for any operation that isn't in
      // the live registry.
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: '`restBindings` and `operationRegistry` must be supplied together (or both omitted).',
    });
  });

  it('rejects operationRegistry supplied without restBindings (500)', async () => {
    const engine = createEngine();
    const { registry, bindings: _bindings } = buildPrincipalSpy();
    const request = new Request('http://localhost/v1/test/principalspy/any-id', {
      method: 'GET',
    });
    const response = await handleRequest(request, engine, {
      operationRegistry: registry,
      // restBindings intentionally omitted — the custom registry would
      // silently pair with the live bindings otherwise, producing the
      // same MethodNotFound hazard in reverse.
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: '`restBindings` and `operationRegistry` must be supplied together (or both omitted).',
    });
  });
});

describe('handler pipeline — direct-route failures', () => {
  it('returns 500 when a direct route executor throws unexpectedly', async () => {
    const engine = createEngine();
    const explodingRegistry = {
      get() {
        throw new Error('registry exploded');
      },
    } as unknown as OperationRegistry;
    const binding: UnknownRestBinding = {
      method: 'GET',
      path: '/v1/test/openapi-trigger',
      pathParamNames: [],
      operationName: 'weft.test.openapi.trigger',
      inputSources: {},
      extractInput: async () => ({}),
      success: { kind: 'json', status: 200 },
    };

    const { result: response, calls } = await recordExpectedConsoleError(() =>
      handleRequest(new Request('http://localhost/openapi.json', { method: 'GET' }), engine, {
        operationRegistry: explodingRegistry,
        restBindings: [binding],
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe('handler pipeline — streaming binding guard', () => {
  it('returns 500 when a streaming binding has no shapeSuccess', async () => {
    const engine = createEngine();
    const handle = await engine.start('hold', {}, {});
    await waitForRunning(engine, handle.id);

    const operation = defineOperation({
      name: 'weft.test.streamnoshape',
      mcpExposable: false,
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
    const { result: response, calls } = await recordExpectedConsoleError(() =>
      handleRequest(request, engine, {
        operationRegistry: registry,
        restBindings: [binding],
      }),
    );
    expect(response.status).toBe(500);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('returns 400 when extractInput throws during via-execute-operation dispatch', async () => {
    const engine = createEngine();
    const handle = await engine.start('hold', {}, {});
    await waitForRunning(engine, handle.id);

    const operation = defineOperation({
      name: 'weft.test.extracterror',
      mcpExposable: false,
      summary: 'extract error',
      inputSchema: z.object({ workflowId: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      access: { kind: 'public' },
      transports: { http: true, jsonRpcHttp: false, jsonRpcWebSocket: false, jsonRpcStdio: false },
      unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
      invoke: async () => ({ ok: true }),
    });
    const binding: UnknownRestBinding = {
      method: 'GET',
      path: '/v1/test/extract-error/:id',
      pathParamNames: ['id'],
      operationName: 'weft.test.extracterror',
      inputSources: { workflowId: { kind: 'path', pathParam: 'id' } },
      extractInput: async () => {
        throw new Error('extract failed');
      },
      success: { kind: 'json', status: 200 },
    };
    const registry = createOperationRegistry([operation]);

    const request = new Request(`http://localhost/v1/test/extract-error/${handle.id}`, {
      method: 'GET',
    });
    const response = await handleRequest(request, engine, {
      operationRegistry: registry,
      restBindings: [binding],
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'extract failed' });
  });

  it('returns 400 when RestBinding path decoding sees malformed percent encoding', async () => {
    const engine = createEngine();
    const registry = createOperationRegistry([
      defineOperation({
        name: 'weft.test.bindingdecode',
        mcpExposable: false,
        summary: 'binding decode path',
        inputSchema: z.object({ workflowId: z.string() }),
        outputSchema: z.object({ ok: z.boolean() }),
        access: { kind: 'public' },
        transports: {
          http: true,
          jsonRpcHttp: false,
          jsonRpcWebSocket: false,
          jsonRpcStdio: false,
        },
        unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
        invoke: async () => ({ ok: true }),
      }),
    ]);
    const binding: UnknownRestBinding = {
      method: 'GET',
      path: '/v1/test/bindingdecode/:workflowId',
      pathParamNames: ['workflowId'],
      operationName: 'weft.test.bindingdecode',
      inputSources: { workflowId: { kind: 'path', pathParam: 'workflowId' } },
      extractInput: async (_request, pathParams) => ({
        workflowId: pathParams['workflowId'] ?? '',
      }),
      success: { kind: 'json', status: 200 },
    };

    const response = await handleRequest(
      new Request('http://localhost/v1/test/bindingdecode/%E0%A4%A', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [binding],
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Malformed route parameter encoding' });
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
      operationRegistry: registry,
      restBindings: bindings,
      authContext: { method: 'api-key' },
    });
    expect(response.status).toBe(200);
    expect(captured.principal?.method).toBe('api-key');
  });

  it('jwt authContext without claims throws (authenticator contract violation)', async () => {
    const engine = createEngine();
    const handle = await engine.start('hold', {}, {});
    await waitForRunning(engine, handle.id);

    const { registry, bindings } = buildPrincipalSpy();
    const request = new Request(`http://localhost/v1/test/principalspy/${handle.id}`, {
      method: 'GET',
    });
    // Authenticator always populates claims for jwt in production; a
    // missing claims field indicates the caller bypassed the authenticator
    // (a real security concern for `optionalAuth` operations). The pipeline
    // must throw rather than silently downgrade to anonymous.
    const { result: response, calls } = await recordExpectedConsoleError(() =>
      handleRequest(request, engine, {
        operationRegistry: registry,
        restBindings: bindings,
        authContext: { method: 'jwt' }, // claims intentionally omitted
      }),
    );
    // handleRequest wraps the throw in the outer try/catch → 500.
    expect(response.status).toBe(500);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('forwarded principal on authContext takes precedence over method reconstruction', async () => {
    // authContext.principal is set when the authenticator already
    // constructed a principal (e.g., via resolveApiKeyPrincipal). The
    // pipeline must use that forwarded principal directly — never
    // rebuild one from method+claims when the authenticator already
    // decided the answer.
    const engine = createEngine();
    const handle = await engine.start('hold', {}, {});
    await waitForRunning(engine, handle.id);

    const { registry, bindings, captured } = buildPrincipalSpy();
    // Use the real factory so the principal's type is authoritative
    // and `hasScope` doesn't need ad-hoc typed shims.
    const forwardedPrincipal = principalFromApiKey({
      subject: 'forwarded-subject',
      scopes: ['schedules:write'],
    });

    const request = new Request(`http://localhost/v1/test/principalspy/${handle.id}`, {
      method: 'GET',
    });
    const response = await handleRequest(request, engine, {
      operationRegistry: registry,
      restBindings: bindings,
      authContext: { method: 'api-key', principal: forwardedPrincipal },
    });
    expect(response.status).toBe(200);
    // The sentinel subject proves this principal is the one we
    // forwarded, not a rebuilt one that would have defaulted to
    // `{ subject: 'api-key-caller', scopes: [] }`.
    // `toBe` guarantees identity (same object reference): the pipeline
    // must use the forwarded principal verbatim, not reconstruct it.
    expect(captured.principal).toBe(forwardedPrincipal);
    expect(captured.principal?.method).toBe('api-key');
    // Narrow to AuthenticatedPrincipal before reading the subject — the
    // Principal union includes UnauthenticatedPrincipal. The
    // `.toBe(forwardedPrincipal)` above already proves the object is the
    // authenticated forwarded principal.
    if (captured.principal === undefined || captured.principal.method === 'unauthenticated') {
      throw new Error('expected forwarded authenticated principal');
    }
    expect(captured.principal.subject).toBe('forwarded-subject');
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
      operationRegistry: registry,
      restBindings: bindings,
      authContext: { method: 'mtls' },
    });
    expect(response.status).toBe(200);
    expect(captured.principal?.method).toBe('mtls');
  });

  it('public authContext is treated as anonymous', async () => {
    const engine = createEngine();
    const handle = await engine.start('hold', {}, {});
    await waitForRunning(engine, handle.id);

    const { registry, bindings, captured } = buildPrincipalSpy();
    const request = new Request(`http://localhost/v1/test/principalspy/${handle.id}`, {
      method: 'GET',
    });
    const response = await handleRequest(request, engine, {
      operationRegistry: registry,
      restBindings: bindings,
      authContext: { method: 'public' },
    });

    expect(response.status).toBe(200);
    expect(captured.principal?.method).toBe('unauthenticated');
  });

  it('returns 400 when route matching sees malformed percent encoding', async () => {
    const engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/%E0%A4%A', { method: 'GET' }),
      engine,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Malformed route parameter encoding' });
  });

  it('returns 400 when a matched RestBinding extractInput throws', async () => {
    const engine = createEngine();
    const handle = await engine.start('hold', {}, {});
    await waitForRunning(engine, handle.id);

    const registry = createOperationRegistry([
      defineOperation({
        name: 'weft.test.extractinput',
        mcpExposable: false,
        summary: 'extractInput failure path',
        inputSchema: z.object({ workflowId: z.string() }),
        outputSchema: z.object({ ok: z.boolean() }),
        access: { kind: 'public' },
        transports: {
          http: true,
          jsonRpcHttp: false,
          jsonRpcWebSocket: false,
          jsonRpcStdio: false,
        },
        unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
        invoke: async () => ({ ok: true }),
      }),
    ]);
    const binding: UnknownRestBinding = {
      method: 'GET',
      path: '/v1/test/extractinput/:id',
      pathParamNames: ['id'],
      operationName: 'weft.test.extractinput',
      inputSources: { workflowId: { kind: 'path', pathParam: 'id' } },
      extractInput: async () => {
        throw new Error('extract input exploded');
      },
      success: { kind: 'json', status: 200 },
    };

    const response = await handleRequest(
      new Request(`http://localhost/v1/test/extractinput/${handle.id}`, { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [binding],
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'extract input exploded' });
  });
});

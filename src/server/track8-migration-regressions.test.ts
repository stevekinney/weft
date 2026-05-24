/**
 * Track 8 Wave 1 — boundary regression tests.
 *
 * Captures the REST contract (status codes, headers, body shape) for
 * each of the 5 routes migrated in Wave 1. These tests must pass against
 * BOTH the old dispatch path AND the new catalog path — the migration
 * commit is safe to revert if they stay green.
 *
 * Traceability: 8-top-7, 8d-2
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import { tenantFromInputField } from '../core/tenant.ts';
import type { WorkflowContext } from '../core/types.ts';
import { workflow } from '../core/types.ts';
import { METRICS } from '../observability/metrics.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { signJWT } from './authentication.ts';
import { serve, type WeftServer } from './index.ts';
import { openWebSocket, waitForMessage } from './json-rpc-websocket-client.test-support.ts';
import { executeOperation } from './operation-catalog.ts';
import { principalFromJwtClaims } from './principal.ts';
import { createLiveOperationRegistry } from './rest-bindings.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

const TEST_SECRET = 'track-8-wave-1-test-secret-1234567890';

function createScheduleEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register(echoWorkflow);
  return engine;
}

function createTenantAwareEngine(): Engine {
  const engine = new Engine({
    storage: new MemoryStorage(),
    tenantResolver: tenantFromInputField('tenantId'),
    quotas: {
      maxConcurrentWorkflows: 2,
      maxWorkflowCreationRate: { count: 5, window: '1m' },
    },
  });
  engine.register(echoWorkflow);
  return engine;
}

function createReplayEngine(): Engine {
  const engine = new Engine({
    storage: new MemoryStorage(),
    checkpointHistory: 10,
  });

  async function firstStep() {
    return { phase: 'first' as const };
  }

  async function secondStep() {
    return { phase: 'second' as const };
  }

  async function thirdStep() {
    return { phase: 'third' as const };
  }

  engine.register(
    workflow({ name: 'three-steps', version: '1.0.0' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.run(firstStep);
      yield* ctx.run(secondStep);
      return yield* ctx.run(thirdStep);
    }),
  );

  return engine;
}

async function createReplayWorkflow(
  engine: Engine,
  workflowId = 'wf-track8-replay',
): Promise<string> {
  const handle = await engine.start('three-steps', null, { id: workflowId });
  await handle.result();
  return handle.id;
}

async function issueJwt(scopes: string[], claims: Record<string, unknown> = {}): Promise<string> {
  return signJWT(
    {
      sub: 'track-8-user',
      scope: scopes.join(' '),
      ...claims,
    },
    TEST_SECRET,
  );
}

async function postJsonRpc(
  server: WeftServer,
  body: Record<string, unknown>,
  token?: string,
): Promise<Response> {
  return fetch(`${server.url}/jsonrpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      ...body,
    }),
  });
}

describe('Track 8 Wave 1 migration regressions', () => {
  const servers: WeftServer[] = [];
  const engines: Engine[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()?.stop();
    }
    while (engines.length > 0) {
      engines.pop()?.[Symbol.dispose]();
    }
  });

  it('The parity surface covers all data-driven runtime operations', async () => {
    // Step 1: registry membership — all 5 Wave 1 operations are present.
    const registry = createLiveOperationRegistry();
    const expected = [
      'weft.schedules.list',
      'weft.schedules.get',
      'weft.tenants.quota.get',
      'weft.workflows.replay',
      'weft.system.metrics',
    ];
    for (const name of expected) {
      expect(registry.get(name)).toBeDefined();
    }

    // Step 2: behavioral — `weft.tenants.quota.get` (a representative
    // migrated operation) dispatches through REST and JSON-RPC HTTP and
    // both reach the same engine method with the same authoritative
    // result. This proves the parity surface is actually addressable
    // cross-transport, not just registered.
    const engine = createTenantAwareEngine();
    engines.push(engine);
    const server = serve({
      engine,
      port: 0,
      auth: { jwt: { secret: TEST_SECRET } },
    });
    servers.push(server);

    const token = await issueJwt(['quota:read'], { tenantId: 'acme' });

    const restResponse = await fetch(`${server.url}/v1/tenants/acme/quota`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(restResponse.status).toBe(200);
    const restBody = (await restResponse.json()) as Record<string, unknown>;

    const jsonRpcResponse = await postJsonRpc(
      server,
      { method: 'weft.tenants.quota.get', params: { tenantId: 'acme' } },
      token,
    );
    expect(jsonRpcResponse.status).toBe(200);
    const jsonRpcBody = (await jsonRpcResponse.json()) as { result: Record<string, unknown> };

    // Both transports dispatched into engine.getQuotaUsage('acme') and
    // returned the same shape. The parity surface is real.
    expect(jsonRpcBody.result).toEqual(restBody);
  });

  it('Track 8 adds transport-neutral authorization for runtime operations', async () => {
    // The 3 scoped ops use the catalog's evaluateAccess rather than
    // inline checks; behavioral check: an authenticated principal
    // missing the required scope is rejected Forbidden over REST,
    // JSON-RPC HTTP, JSON-RPC WebSocket, and stdio uniformly.
    const registry = createLiveOperationRegistry();
    expect(registry.get('weft.tenants.quota.get')?.access.kind).toBe('scoped');
    expect(registry.get('weft.workflows.replay')?.access.kind).toBe('scoped');
    expect(registry.get('weft.system.metrics')?.access.kind).toBe('scoped');

    const engine = createTenantAwareEngine();
    engines.push(engine);
    const server = serve({
      engine,
      port: 0,
      auth: { jwt: { secret: TEST_SECRET } },
    });
    servers.push(server);

    // Wrong scope: workflows:read instead of quota:read.
    const wrongScopeToken = await issueJwt(['workflows:read'], { tenantId: 'acme' });

    // REST — Forbidden
    const restResponse = await fetch(`${server.url}/v1/tenants/acme/quota`, {
      headers: { Authorization: `Bearer ${wrongScopeToken}` },
    });
    expect(restResponse.status).toBe(403);

    // JSON-RPC HTTP — Forbidden via Weft application code
    const jsonRpcResponse = await postJsonRpc(
      server,
      { method: 'weft.tenants.quota.get', params: { tenantId: 'acme' } },
      wrongScopeToken,
    );
    expect(jsonRpcResponse.status).toBe(200);
    const jsonRpcBody = (await jsonRpcResponse.json()) as {
      error?: { data?: { weftCode?: string; httpStatus?: number } };
    };
    expect(jsonRpcBody.error?.data?.weftCode).toBe('Forbidden');
    expect(jsonRpcBody.error?.data?.httpStatus).toBe(403);

    // JSON-RPC WebSocket — Forbidden, principal bound at upgrade
    const wsUrl = server.url.replace(/^http/, 'ws') + '/jsonrpc';
    const ws = await openWebSocket(wsUrl, wrongScopeToken);
    try {
      const wsId = crypto.randomUUID();
      const wsResponsePromise = waitForMessage(
        ws,
        (parsed) =>
          typeof parsed === 'object' &&
          parsed !== null &&
          'id' in parsed &&
          (parsed as { id: unknown }).id === wsId,
      );
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: wsId,
          method: 'weft.tenants.quota.get',
          params: { tenantId: 'acme' },
        }),
      );
      const wsResponse = (await wsResponsePromise) as {
        error?: { data?: { weftCode?: string } };
      };
      expect(wsResponse.error?.data?.weftCode).toBe('Forbidden');
    } finally {
      ws.close();
    }

    // stdio — Forbidden via the same operation policy hook
    const stdioPrincipal = principalFromJwtClaims({
      sub: 'track-8-user',
      scope: 'workflows:read',
      tenantId: 'acme',
    });
    const stdioResult = await executeOperation(
      'weft.tenants.quota.get',
      { tenantId: 'acme' },
      {
        engine,
        registry,
        principal: stdioPrincipal,
        transport: 'jsonRpcStdio',
      },
    );
    expect(stdioResult.ok).toBe(false);
    if (!stdioResult.ok) {
      expect(stdioResult.fault.code).toBe('Forbidden');
    }
  });

  it('GET /v1/schedules preserves the legacy success shape', async () => {
    const engine = createScheduleEngine();
    engines.push(engine);
    await engine.schedule('echo', { payload: 'alpha' }, '0 * * * *', { id: 'schedule-alpha' });
    await engine.schedule('echo', { payload: 'beta' }, '30 * * * *', { id: 'schedule-beta' });

    // Schedules require authentication (access:authenticated added in Wave 1).
    // Use an api-key server so the success-shape assertions can fire without
    // triggering the JWT-tenant scope check that fires for JWT principals.
    const server = serve({
      engine,
      port: 0,
      auth: { apiKeys: ['test-schedule-key'] },
    });
    servers.push(server);

    const response = await fetch(`${server.url}/v1/schedules`, {
      headers: { 'X-API-Key': 'test-schedule-key' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');

    const body = (await response.json()) as {
      items?: Array<{ id: string }>;
      total?: number;
      limit?: number;
      offset?: number;
    };
    expect(body.items?.map((schedule) => schedule.id).toSorted()).toEqual([
      'schedule-alpha',
      'schedule-beta',
    ]);
    expect(typeof body.total).toBe('number');
    expect(typeof body.limit).toBe('number');
    expect(typeof body.offset).toBe('number');
  });

  it('GET /v1/schedules/:id preserves the legacy success shape and 404 contract', async () => {
    const engine = createScheduleEngine();
    engines.push(engine);
    await engine.schedule('echo', { payload: 'alpha' }, '0 * * * *', { id: 'schedule-alpha' });

    // Schedules require authentication (access:authenticated added in Wave 1).
    // Use api-key auth to avoid the JWT-tenant scope check.
    const server = serve({
      engine,
      port: 0,
      auth: { apiKeys: ['test-schedule-key'] },
    });
    servers.push(server);

    const success = await fetch(`${server.url}/v1/schedules/schedule-alpha`, {
      headers: { 'X-API-Key': 'test-schedule-key' },
    });
    expect(success.status).toBe(200);
    expect(success.headers.get('content-type')).toBe('application/json');
    const successBody = (await success.json()) as {
      id?: string;
      workflowType?: string;
      cronExpression?: string;
    };
    expect(successBody.id).toBe('schedule-alpha');
    expect(successBody.workflowType).toBe('echo');
    expect(successBody.cronExpression).toBe('0 * * * *');

    const missing = await fetch(`${server.url}/v1/schedules/does-not-exist`, {
      headers: { 'X-API-Key': 'test-schedule-key' },
    });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toBe('application/json');
    expect(await missing.json()).toEqual({
      error: 'Schedule "does-not-exist" not found',
    });
  });

  it('GET /v1/tenants/:id/quota preserves success and auth outcomes on REST and JSON-RPC HTTP', async () => {
    const engine = createTenantAwareEngine();
    engines.push(engine);
    const quotaToken = await issueJwt(['quota:read'], { tenantId: 'acme' });
    const noScopeToken = await issueJwt(['workflows:read'], { tenantId: 'acme' });

    await engine.start(
      'echo',
      { tenantId: 'acme', payload: 'quota-probe' },
      { id: 'quota-probe-workflow' },
    );

    const anonymousServer = serve({ engine, port: 0 });
    const authenticatedServer = serve({
      engine,
      port: 0,
      auth: { jwt: { secret: TEST_SECRET } },
    });
    servers.push(anonymousServer, authenticatedServer);

    const anonymousRest = await fetch(`${anonymousServer.url}/v1/tenants/acme/quota`);
    expect(anonymousRest.status).toBe(401);
    expect(anonymousRest.headers.get('content-type')).toBe('application/json');

    const noScopeRest = await fetch(`${authenticatedServer.url}/v1/tenants/acme/quota`, {
      headers: { Authorization: `Bearer ${noScopeToken}` },
    });
    expect(noScopeRest.status).toBe(403);
    expect(noScopeRest.headers.get('content-type')).toBe('application/json');

    const successRest = await fetch(`${authenticatedServer.url}/v1/tenants/acme/quota`, {
      headers: { Authorization: `Bearer ${quotaToken}` },
    });
    expect(successRest.status).toBe(200);
    expect(successRest.headers.get('content-type')).toBe('application/json');
    const successRestBody = (await successRest.json()) as {
      tenantId?: string;
      workflowCreationRate?: { used?: number };
    };
    expect(successRestBody.tenantId).toBe('acme');
    expect(typeof successRestBody.workflowCreationRate?.used).toBe('number');

    const anonymousJsonRpc = await postJsonRpc(anonymousServer, {
      method: 'weft.tenants.quota.get',
      params: { tenantId: 'acme' },
    });
    expect(anonymousJsonRpc.status).toBe(200);
    const anonymousJsonRpcBody = (await anonymousJsonRpc.json()) as {
      error?: { data?: { weftCode?: string; httpStatus?: number } };
    };
    expect(anonymousJsonRpcBody.error?.data?.weftCode).toBe('Unauthorized');
    expect(anonymousJsonRpcBody.error?.data?.httpStatus).toBe(401);

    const noScopeJsonRpc = await postJsonRpc(
      authenticatedServer,
      {
        method: 'weft.tenants.quota.get',
        params: { tenantId: 'acme' },
      },
      noScopeToken,
    );
    expect(noScopeJsonRpc.status).toBe(200);
    const noScopeJsonRpcBody = (await noScopeJsonRpc.json()) as {
      error?: { data?: { weftCode?: string; httpStatus?: number } };
    };
    expect(noScopeJsonRpcBody.error?.data?.weftCode).toBe('Forbidden');
    expect(noScopeJsonRpcBody.error?.data?.httpStatus).toBe(403);

    const successJsonRpc = await postJsonRpc(
      authenticatedServer,
      {
        method: 'weft.tenants.quota.get',
        params: { tenantId: 'acme' },
      },
      quotaToken,
    );
    expect(successJsonRpc.status).toBe(200);
    const successJsonRpcBody = (await successJsonRpc.json()) as {
      result?: { tenantId?: string };
      error?: unknown;
    };
    expect(successJsonRpcBody.error).toBeUndefined();
    expect(successJsonRpcBody.result?.tenantId).toBe('acme');
  });

  it('tenant-IDOR guard rejects JWT tenant-A accessing tenant-B on all four transports', async () => {
    const engine = createTenantAwareEngine();
    engines.push(engine);
    // A token for tenant-a with quota:read — must not be able to read tenant-b.
    const tenantAToken = await issueJwt(['quota:read'], { tenantId: 'tenant-a' });

    const authenticatedServer = serve({
      engine,
      port: 0,
      auth: { jwt: { secret: TEST_SECRET } },
    });
    servers.push(authenticatedServer);

    // REST — should be 403
    const restResponse = await fetch(`${authenticatedServer.url}/v1/tenants/tenant-b/quota`, {
      headers: { Authorization: `Bearer ${tenantAToken}` },
    });
    expect(restResponse.status).toBe(403);

    // JSON-RPC HTTP — error.data.weftCode should be 'Forbidden'
    const jsonRpcResponse = await postJsonRpc(
      authenticatedServer,
      {
        method: 'weft.tenants.quota.get',
        params: { tenantId: 'tenant-b' },
      },
      tenantAToken,
    );
    expect(jsonRpcResponse.status).toBe(200);
    const jsonRpcBody = (await jsonRpcResponse.json()) as {
      error?: { data?: { weftCode?: string; httpStatus?: number } };
    };
    expect(jsonRpcBody.error?.data?.weftCode).toBe('Forbidden');
    expect(jsonRpcBody.error?.data?.httpStatus).toBe(403);

    // JSON-RPC WebSocket — error.data.weftCode should be 'Forbidden'
    const wsUrl = `${authenticatedServer.url.replace('http://', 'ws://')}/jsonrpc`;
    const ws = await openWebSocket(wsUrl, tenantAToken);
    const wsResponsePromise = waitForMessage(ws, (parsed) => {
      return (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { id?: string }).id === 'idor-ws'
      );
    });
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'idor-ws',
        method: 'weft.tenants.quota.get',
        params: { tenantId: 'tenant-b' },
      }),
    );
    const wsResponse = (await wsResponsePromise) as {
      error?: { data?: { weftCode?: string; httpStatus?: number } };
    };
    expect(wsResponse.error?.data?.weftCode).toBe('Forbidden');
    expect(wsResponse.error?.data?.httpStatus).toBe(403);
    ws.close();

    // stdio — executeOperation directly with the decoded JWT principal
    const tenantAPrincipal = principalFromJwtClaims({
      sub: 'user-a',
      scope: 'quota:read',
      tenantId: 'tenant-a',
    });
    const liveRegistry = createLiveOperationRegistry();
    const stdioResult = await executeOperation(
      'weft.tenants.quota.get',
      { tenantId: 'tenant-b' },
      { principal: tenantAPrincipal, engine, transport: 'jsonRpcStdio', registry: liveRegistry },
    );
    expect(stdioResult.ok).toBe(false);
    if (stdioResult.ok) throw new Error('expected Forbidden');
    expect(stdioResult.fault.code).toBe('Forbidden');
  });

  it('GET /v1/workflows/:id/replay/:step preserves the legacy success, 404, and REST auth contract', async () => {
    const engine = createReplayEngine();
    engines.push(engine);
    const replayToken = await issueJwt(['workflows:read']);
    const noScopeToken = await issueJwt(['quota:read']);
    const workflowId = await createReplayWorkflow(engine);

    const anonymousServer = serve({ engine, port: 0 });
    const authenticatedServer = serve({
      engine,
      port: 0,
      auth: { jwt: { secret: TEST_SECRET } },
    });
    servers.push(anonymousServer, authenticatedServer);

    const anonymous = await fetch(`${anonymousServer.url}/v1/workflows/${workflowId}/replay/2`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('content-type')).toBe('application/json');

    const forbidden = await fetch(
      `${authenticatedServer.url}/v1/workflows/${workflowId}/replay/2`,
      {
        headers: { Authorization: `Bearer ${noScopeToken}` },
      },
    );
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get('content-type')).toBe('application/json');

    const success = await fetch(`${authenticatedServer.url}/v1/workflows/${workflowId}/replay/2`, {
      headers: { Authorization: `Bearer ${replayToken}` },
    });
    expect(success.status).toBe(200);
    expect(success.headers.get('content-type')).toBe('application/json');
    const successBody = (await success.json()) as {
      checkpoint?: { step?: number };
      events?: unknown[];
      accumulatedResults?: unknown[];
    };
    expect(successBody.checkpoint?.step).toBe(2);
    expect(Array.isArray(successBody.events)).toBe(true);
    expect(Array.isArray(successBody.accumulatedResults)).toBe(true);

    const missingWorkflow = await fetch(
      `${authenticatedServer.url}/v1/workflows/does-not-exist/replay/2`,
      {
        headers: { Authorization: `Bearer ${replayToken}` },
      },
    );
    expect(missingWorkflow.status).toBe(404);
    expect(missingWorkflow.headers.get('content-type')).toBe('application/json');

    const missingReplay = await fetch(
      `${authenticatedServer.url}/v1/workflows/${workflowId}/replay/99`,
      {
        headers: { Authorization: `Bearer ${replayToken}` },
      },
    );
    expect(missingReplay.status).toBe(404);
    expect(missingReplay.headers.get('content-type')).toBe('application/json');
  });

  it('GET /v1/metrics/json preserves success and auth outcomes on REST and JSON-RPC HTTP', async () => {
    const engine = createScheduleEngine();
    engines.push(engine);

    const metricsToken = await issueJwt(['system:read']);
    const noScopeToken = await issueJwt(['workflows:read']);

    const anonymousServer = serve({ engine, port: 0 });
    const authenticatedServer = serve({
      engine,
      port: 0,
      auth: { jwt: { secret: TEST_SECRET } },
    });
    servers.push(anonymousServer, authenticatedServer);

    await authenticatedServer.dispatchTask({
      operationId: 'track-8-metrics-json-task',
      activityName: 'generateMetricsSnapshot',
      input: null,
    });

    const anonymousRest = await fetch(`${anonymousServer.url}/v1/metrics/json`);
    expect(anonymousRest.status).toBe(401);
    expect(anonymousRest.headers.get('content-type')).toBe('application/json');

    const noScopeRest = await fetch(`${authenticatedServer.url}/v1/metrics/json`, {
      headers: { Authorization: `Bearer ${noScopeToken}` },
    });
    expect(noScopeRest.status).toBe(403);
    expect(noScopeRest.headers.get('content-type')).toBe('application/json');

    const successRest = await fetch(`${authenticatedServer.url}/v1/metrics/json`, {
      headers: { Authorization: `Bearer ${metricsToken}` },
    });
    expect(successRest.status).toBe(200);
    expect(successRest.headers.get('content-type')).toBe('application/json');
    const successRestBody = (await successRest.json()) as Record<
      string,
      { type?: string; value?: number }
    >;
    expect(successRestBody[METRICS.taskBacklog.name]).toEqual({ type: 'gauge', value: 1 });

    const anonymousJsonRpc = await postJsonRpc(anonymousServer, {
      method: 'weft.system.metrics',
      params: {
        snapshot: {
          rpc_counter: { type: 'counter', value: 3 },
        },
      },
    });
    expect(anonymousJsonRpc.status).toBe(200);
    const anonymousJsonRpcBody = (await anonymousJsonRpc.json()) as {
      error?: { data?: { weftCode?: string; httpStatus?: number } };
    };
    expect(anonymousJsonRpcBody.error?.data?.weftCode).toBe('Unauthorized');
    expect(anonymousJsonRpcBody.error?.data?.httpStatus).toBe(401);

    const noScopeJsonRpc = await postJsonRpc(
      authenticatedServer,
      {
        method: 'weft.system.metrics',
        params: {
          snapshot: {
            rpc_counter: { type: 'counter', value: 3 },
          },
        },
      },
      noScopeToken,
    );
    expect(noScopeJsonRpc.status).toBe(200);
    const noScopeJsonRpcBody = (await noScopeJsonRpc.json()) as {
      error?: { data?: { weftCode?: string; httpStatus?: number } };
    };
    expect(noScopeJsonRpcBody.error?.data?.weftCode).toBe('Forbidden');
    expect(noScopeJsonRpcBody.error?.data?.httpStatus).toBe(403);

    const successJsonRpc = await postJsonRpc(
      authenticatedServer,
      {
        method: 'weft.system.metrics',
        // weft.system.metrics ignores all input and returns the server-owned collector's
        // snapshot. Send empty params — no unknown keys to trigger the 'reject' policy.
        params: {},
      },
      metricsToken,
    );
    expect(successJsonRpc.status).toBe(200);
    const successJsonRpcBody = (await successJsonRpc.json()) as {
      result?: Record<string, { type?: string; value?: number }>;
      error?: unknown;
    };
    expect(successJsonRpcBody.error).toBeUndefined();
    expect(successJsonRpcBody.result?.[METRICS.taskBacklog.name]).toEqual({
      type: 'gauge',
      value: 1,
    });
  });
});

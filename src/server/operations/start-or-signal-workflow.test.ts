import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { serve, type WeftServer } from '../index.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { jsonRequest } from './operation-test-helpers.test-support.ts';
import {
  startOrSignalWorkflowOperation,
  startOrSignalWorkflowRestBinding,
} from './start-or-signal-workflow.ts';

const waitForRelease = workflow({ name: 'wait-for-release' }).execute(async function* (
  ctx: WorkflowContext,
) {
  return yield* ctx.waitForSignal<string>('release');
});

const completesImmediately = workflow({ name: 'completes-immediately' }).execute(
  async function* () {
    return 'done';
  },
);

const waitWithSearchAttributes = workflow({ name: 'wait-with-search-attributes' })
  .searchAttributes({ customerId: { type: 'string' } })
  .execute(async function* (ctx: WorkflowContext) {
    return yield* ctx.waitForSignal<string>('release');
  });

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register(waitForRelease);
  engine.register(completesImmediately);
  engine.register(waitWithSearchAttributes);
  return engine;
}

const registry = createOperationRegistry([startOrSignalWorkflowOperation]);
const bindings = [startOrSignalWorkflowRestBinding];

function startOrSignalRequest(body: unknown): Request {
  return jsonRequest('POST', '/v1/workflows/start-or-signal', body);
}

describe('weft.workflows.startorsignal', () => {
  let engine: Engine | undefined;

  afterEach(async () => {
    if (engine) {
      await engine[Symbol.asyncDispose]();
      engine = undefined;
    }
  });

  it('creates the workflow and returns 201 with its id when the target is absent', async () => {
    engine = createEngine();

    const response = await handleRequest(
      startOrSignalRequest({
        type: 'wait-for-release',
        signalName: 'release',
        signalPayload: 'go',
        signalId: 'sig-create',
        id: 'sos-rest-create',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: 'sos-rest-create' });
    expect(await engine.getHandle('sos-rest-create').result()).toBe('go');
  });

  it('signals an existing running workflow and returns its id', async () => {
    engine = createEngine();
    const started = await engine.start('wait-for-release', null, { id: 'sos-rest-existing' });

    const response = await handleRequest(
      startOrSignalRequest({
        type: 'wait-for-release',
        signalName: 'release',
        signalPayload: 'late',
        signalId: 'sig-existing',
        id: 'sos-rest-existing',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: 'sos-rest-existing' });
    expect(await started.result()).toBe('late');
  });

  it('returns 409 Conflict when the target is terminal', async () => {
    engine = createEngine();
    const completed = await engine.start('completes-immediately', null, {
      id: 'sos-rest-terminal',
    });
    await completed.result();

    const response = await handleRequest(
      startOrSignalRequest({
        type: 'wait-for-release',
        signalName: 'release',
        signalId: 'sig-terminal',
        id: 'sos-rest-terminal',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(409);
  });

  it('honors searchAttributes on the create path over REST (not silently dropped)', async () => {
    engine = createEngine();

    const response = await handleRequest(
      startOrSignalRequest({
        type: 'wait-with-search-attributes',
        signalName: 'release',
        signalId: 'sig-attrs',
        id: 'sos-rest-attrs',
        searchAttributes: { customerId: 'acme' },
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(201);
    expect(await engine.getAttributes('sos-rest-attrs')).toEqual({ customerId: 'acme' });
  });

  it('returns 400 when both signalId and idempotencyKey are provided', async () => {
    engine = createEngine();

    const response = await handleRequest(
      startOrSignalRequest({
        type: 'wait-for-release',
        signalName: 'release',
        signalId: 'x',
        idempotencyKey: 'k',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/does not accept both/);
  });

  it('returns 400 when neither signalId nor idempotencyKey is provided', async () => {
    engine = createEngine();

    const response = await handleRequest(
      startOrSignalRequest({
        type: 'wait-for-release',
        signalName: 'release',
        id: 'sos-rest-no-convergence',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/signalId or idempotencyKey/);
  });

  it('returns 400 when the type is missing', async () => {
    engine = createEngine();

    const response = await handleRequest(
      startOrSignalRequest({ signalName: 'release', signalId: 'x' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Missing required field: type' });
  });

  it('returns 400 when the signalName is missing', async () => {
    engine = createEngine();

    const response = await handleRequest(
      startOrSignalRequest({ type: 'wait-for-release', signalId: 'x' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Missing required field: signalName' });
  });

  it('enforces idempotencyKey: a duplicate key returns the same id', async () => {
    engine = createEngine();

    const first = await handleRequest(
      startOrSignalRequest({
        type: 'wait-for-release',
        signalName: 'release',
        signalPayload: 'first',
        idempotencyKey: 'sos-rest-key',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { id: string };

    const second = await handleRequest(
      startOrSignalRequest({
        type: 'wait-for-release',
        signalName: 'release',
        signalPayload: 'second',
        idempotencyKey: 'sos-rest-key',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(second.status).toBe(201);
    expect((await second.json()) as { id: string }).toEqual(firstBody);
  });
});

describe('weft.workflows.startorsignal over JSON-RPC HTTP', () => {
  const servers: WeftServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
  });

  async function postJsonRpc(
    server: WeftServer,
    params: Record<string, unknown>,
  ): Promise<{ status: number; body: { result?: { id?: string }; error?: { message?: string } } }> {
    const response = await fetch(`${server.url}/jsonrpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method: 'weft.workflows.startorsignal',
        params,
      }),
    });
    return { status: response.status, body: await response.json() };
  }

  it('creates and signals over JSON-RPC, returning the workflow id', async () => {
    const engine = createEngine();
    const server = serve({ engine, port: 0 });
    servers.push(server);

    const created = await postJsonRpc(server, {
      type: 'wait-for-release',
      signalName: 'release',
      signalPayload: 'rpc-go',
      signalId: 'sig-rpc',
      id: 'sos-rpc-create',
    });

    expect(created.status).toBe(200);
    expect(created.body.result?.id).toBe('sos-rpc-create');
    expect(await engine.getHandle('sos-rpc-create').result()).toBe('rpc-go');
  });

  it('maps a terminal target to a JSON-RPC Conflict error', async () => {
    const engine = createEngine();
    const server = serve({ engine, port: 0 });
    servers.push(server);

    const completed = await engine.start('completes-immediately', null, { id: 'sos-rpc-terminal' });
    await completed.result();

    const conflict = await postJsonRpc(server, {
      type: 'wait-for-release',
      signalName: 'release',
      signalId: 'sig-rpc-terminal',
      id: 'sos-rpc-terminal',
    });

    expect(conflict.body.error).toBeDefined();
    expect(conflict.body.error?.message).toMatch(/terminal/i);
  });
});

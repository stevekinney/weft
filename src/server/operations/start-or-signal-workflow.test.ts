import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { StartWorkflowValidationError } from '../../core/start-workflow-validation.ts';
import type { AnyActivityDefinition, WorkflowContext } from '../../core/types.ts';
import { activity, workflow } from '../../core/types.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
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

type ControllableFinalizer = {
  destroy: AnyActivityDefinition;
  release: () => void;
  started: Promise<void>;
};

function createControllableFinalizer(name: string): ControllableFinalizer {
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const destroy = activity({
    name,
    execute: async () => {
      signalStarted();
      await gate;
    },
  });
  return { destroy, release, started };
}

function registerTeardownWorkflow(
  engine: Engine,
  type: string,
  finalizer: AnyActivityDefinition,
): void {
  const definition = workflow({ name: type, finalizer }).execute(async function* (
    ctx: WorkflowContext,
  ) {
    ctx.setFinalizerState({ resourceId: type });
    yield* ctx.waitForSignal('never');
  });
  engine.register(definition);
}

async function waitForRecordedFinalizerState(engine: Engine, workflowId: string): Promise<void> {
  await waitForCondition(
    async () => (await engine.storage.get(KEYS.finalizerState(workflowId))) !== null,
    {
      label: `workflow ${workflowId} recorded finalizer state`,
      timeoutMs: 2000,
      intervalMs: 5,
    },
  );
}

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
    expect(await response.json()).toEqual({ id: 'sos-rest-create', outcome: 'started' });
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
    expect(await response.json()).toEqual({ id: 'sos-rest-existing', outcome: 'signalled' });
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

  it('restarts a terminal target when onTerminalConflict is start-new', async () => {
    engine = createEngine();
    const completed = await engine.start('completes-immediately', null, {
      id: 'sos-rest-restart',
    });
    await completed.result();

    const response = await handleRequest(
      startOrSignalRequest({
        type: 'wait-for-release',
        signalName: 'release',
        signalPayload: 'fresh',
        signalId: 'sig-rest-restart',
        id: 'sos-rest-restart',
        onTerminalConflict: 'start-new',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: 'sos-rest-restart', outcome: 'started' });
    expect(await engine.getHandle('sos-rest-restart').result()).toBe('fresh');
  });

  it('includes weftCode when restart is blocked by pending teardown', async () => {
    const finalizer = createControllableFinalizer('destroy-sos-rest-teardown');
    const now = 1_000_000;
    engine = new Engine({ storage: new MemoryStorage(), getNow: () => now });
    registerTeardownWorkflow(engine, 'teardown-for-start-or-signal', finalizer.destroy);

    const handle = await engine.start('teardown-for-start-or-signal', null, {
      id: 'sos-rest-teardown-pending',
    });
    await waitForRecordedFinalizerState(engine, 'sos-rest-teardown-pending');
    await engine.cancel(handle.id);
    await expect(handle.result()).rejects.toThrow('Workflow cancelled');

    const drive = engine.scheduler.tick(now);
    await finalizer.started;
    try {
      const response = await handleRequest(
        startOrSignalRequest({
          type: 'teardown-for-start-or-signal',
          signalName: 'release',
          signalId: 'sig-rest-teardown-pending',
          id: 'sos-rest-teardown-pending',
          onTerminalConflict: 'start-new',
        }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: expect.stringContaining('tearing down a resource'),
        weftCode: 'WorkflowTeardownPendingError',
      });
    } finally {
      finalizer.release();
      await drive;
    }
  });

  it('forwards executionTimeout, startAfter, and tags to the create path', async () => {
    engine = createEngine();

    const response = await handleRequest(
      startOrSignalRequest({
        type: 'wait-for-release',
        signalName: 'release',
        signalId: 'sig-options',
        id: 'sos-rest-options',
        executionTimeout: '30s',
        startAfter: '1s',
        tags: ['alpha', 'beta'],
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: 'sos-rest-options', outcome: 'started' });
  });

  it('forwards startAt as an absolute scheduling timestamp', async () => {
    engine = createEngine();

    // `startAt` is a non-negative epoch-millisecond timestamp; a far-future value
    // keeps the run pending so the create path is exercised without it running.
    const farFuture = Date.UTC(2999, 0, 1);
    const response = await handleRequest(
      startOrSignalRequest({
        type: 'wait-for-release',
        signalName: 'release',
        signalId: 'sig-start-at',
        id: 'sos-rest-start-at',
        startAt: farFuture,
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: 'sos-rest-start-at', outcome: 'started' });
  });

  it('returns 400 when a start option is malformed (e.g. a non-string id)', async () => {
    engine = createEngine();

    const response = await handleRequest(
      startOrSignalRequest({
        type: 'wait-for-release',
        signalName: 'release',
        signalId: 'sig-bad-id',
        id: 42,
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/Field "id"/);
  });

  it('returns 400 when startAt and startAfter are both provided', async () => {
    engine = createEngine();

    const response = await handleRequest(
      startOrSignalRequest({
        type: 'wait-for-release',
        signalName: 'release',
        signalId: 'sig-both-schedules',
        startAt: Date.UTC(2999, 0, 1),
        startAfter: '1s',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Provide only one of startAt or startAfter' });
  });

  it('returns 400 when the request body is invalid JSON', async () => {
    engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/start-or-signal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ not json',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' });
  });

  it('returns 400 when the request body is JSON null (not an object)', async () => {
    engine = createEngine();

    const response = await handleRequest(startOrSignalRequest(null), engine, {
      operationRegistry: registry,
      restBindings: bindings,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Request body must be a JSON object' });
  });

  it('returns 400 InvalidParams when body is a JSON array', async () => {
    engine = createEngine();

    const response = await handleRequest(startOrSignalRequest(['not-an-object']), engine, {
      operationRegistry: registry,
      restBindings: bindings,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid params',
      data: {
        issues: [
          {
            path: ['signalName'],
            message: 'Invalid input: expected string, received undefined',
            code: 'invalid_type',
          },
        ],
      },
    });
  });

  it('returns 400 when engine.startOrSignal throws StartWorkflowValidationError', async () => {
    engine = createEngine();
    const original = engine.startOrSignal.bind(engine);
    engine.startOrSignal = async () => {
      throw new StartWorkflowValidationError('Field "id" must be a string');
    };

    try {
      const response = await handleRequest(
        startOrSignalRequest({ type: 'wait-for-release', signalName: 'release', signalId: 'x' }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Field "id" must be a string' });
    } finally {
      engine.startOrSignal = original;
    }
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

  it('returns 400 when both id and idempotencyKey are provided (mutually exclusive)', async () => {
    engine = createEngine();

    const response = await handleRequest(
      startOrSignalRequest({
        type: 'wait-for-release',
        signalName: 'release',
        idempotencyKey: 'sos-rest-id-key',
        id: 'sos-rest-explicit-id',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/mutually exclusive/);
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

  it('returns 400 when idempotencyKey is combined with restart policy', async () => {
    engine = createEngine();

    const response = await handleRequest(
      startOrSignalRequest({
        type: 'wait-for-release',
        signalName: 'release',
        idempotencyKey: 'sos-rest-restart-key',
        onTerminalConflict: 'start-new',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/mutually exclusive with options\.idempotencyKey/);
  });

  it('returns 400 when restart policy is missing signalId', async () => {
    engine = createEngine();

    const response = await handleRequest(
      startOrSignalRequest({
        type: 'wait-for-release',
        signalName: 'release',
        id: 'sos-rest-restart-missing-signal',
        onTerminalConflict: 'start-new',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/requires signalId/);
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

  it('returns 400 when the signalName is missing (rejected by the schema)', async () => {
    engine = createEngine();

    // signalName is `z.string().min(1)`, so an absent value is rejected at the
    // schema boundary with the generic invalid-params message.
    const response = await handleRequest(
      startOrSignalRequest({ type: 'wait-for-release', signalId: 'x' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid params',
      data: {
        issues: [
          {
            path: ['signalName'],
            message: 'Invalid input: expected string, received undefined',
            code: 'invalid_type',
          },
        ],
      },
    });
  });

  it('returns 400 when the signalName is an empty string (rejected by the schema)', async () => {
    engine = createEngine();

    const response = await handleRequest(
      startOrSignalRequest({ type: 'wait-for-release', signalName: '', signalId: 'x' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid params',
      data: {
        issues: [
          {
            path: ['signalName'],
            message: 'Too small: expected string to have >=1 characters',
            code: 'too_small',
          },
        ],
      },
    });
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
    const firstBody = (await first.json()) as { id: string; outcome: string };
    // The first call created the run.
    expect(firstBody.outcome).toBe('started');

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
    const secondBody = (await second.json()) as { id: string; outcome: string };
    // Same run (the duplicate key converges), but the second call signalled it.
    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.outcome).toBe('signalled');
  });

  it('returns 409 when an idempotency key maps to a purged run (not a masked 500)', async () => {
    engine = createEngine();

    // First call creates the run and the durable `start-idem:` mapping, then we
    // release and let it complete so it can be purged.
    const first = await handleRequest(
      startOrSignalRequest({
        type: 'wait-for-release',
        signalName: 'release',
        signalPayload: 'go',
        idempotencyKey: 'sos-purged-key',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(first.status).toBe(201);
    const { id } = (await first.json()) as { id: string };
    await engine.getHandle(id).result();
    // Purge the run; the `start-idem:` mapping intentionally survives, so the key
    // now resolves to a workflow that no longer exists.
    await engine.purge({ idPrefix: id });

    const second = await handleRequest(
      startOrSignalRequest({
        type: 'wait-for-release',
        signalName: 'release',
        signalPayload: 'again',
        idempotencyKey: 'sos-purged-key',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(second.status).toBe(409);
    expect((await second.json()) as { error: string }).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('no longer exists'),
      }),
    );
  });

  it('returns 400 InvalidParams when the workflow type is not registered', async () => {
    engine = createEngine();

    const response = await handleRequest(
      startOrSignalRequest({ type: 'not-registered', signalName: 'release', signalId: 'x' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/not-registered/);
  });

  it('masks an unexpected engine failure to a 500 generic error body', async () => {
    engine = createEngine();
    const original = engine.startOrSignal.bind(engine);
    engine.startOrSignal = async () => {
      throw new Error('startOrSignal failed internally');
    };

    try {
      const response = await handleRequest(
        startOrSignalRequest({ type: 'wait-for-release', signalName: 'release', signalId: 'x' }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
    } finally {
      engine.startOrSignal = original;
    }
  });
});

describe('weft.workflows.startorsignal over JSON-RPC HTTP', () => {
  const servers: WeftServer[] = [];
  const engines: Engine[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
    await Promise.all(engines.splice(0).map((engine) => engine[Symbol.asyncDispose]()));
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
    engines.push(engine);
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
    engines.push(engine);
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

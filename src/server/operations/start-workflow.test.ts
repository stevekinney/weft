import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { StartWorkflowValidationError } from '../../core/start-workflow-validation.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { invalidJsonRequest, jsonRequest } from './operation-test-helpers.test-support.ts';
import { startWorkflowOperation, startWorkflowRestBinding } from './start-workflow.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register(echoWorkflow);
  engine.register(
    workflow({ name: 'with-search-attributes' })
      .searchAttributes({
        createdAt: { type: 'string', format: 'date-time' },
        attempt: { type: 'number' },
      })
      .execute(async function* (_ctx: WorkflowContext, input: unknown) {
        return input;
      }),
  );
  return engine;
}

const registry = createOperationRegistry([startWorkflowOperation]);
const bindings = [startWorkflowRestBinding];

describe('weft.workflows.start', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('returns 201 with the started workflow id on the happy path', async () => {
    engine = createEngine();

    const response = await handleRequest(
      jsonRequest('POST', '/v1/workflows', {
        type: 'echo',
        input: { hello: 'world' },
        id: 'start-workflow-success',
        startAfter: '1s',
        tags: ['alpha'],
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: 'start-workflow-success' });
  });

  it('returns 400 when the request body is invalid JSON', async () => {
    engine = createEngine();

    const response = await handleRequest(invalidJsonRequest('POST', '/v1/workflows', '{'), engine, {
      operationRegistry: registry,
      restBindings: bindings,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' });
  });

  it('rejects an oversized declared body before reading a body', async () => {
    engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': '9',
        },
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings, maxRequestBodyBytes: 8 },
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'Payload Too Large' });
  });

  it('returns 400 when the request body is JSON null', async () => {
    // `null` is rejected (typeof 'object' && === null fails the guard) with
    // "Request body must be a JSON object". This pins that path; arrays are
    // handled by the next test.
    engine = createEngine();

    const response = await handleRequest(jsonRequest('POST', '/v1/workflows', null), engine, {
      operationRegistry: registry,
      restBindings: bindings,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Request body must be a JSON object' });
  });

  it('returns 400 with "Missing required field: type" when body is a JSON array', async () => {
    // arrays are typeof 'object' && !== null, so they pass the
    // body-shape guard and fall through to the "type" required-field check
    // (arrays do not have a string `'type'` property). Matching this exactly
    // keeps REST and JSON-RPC clients on the same error path.
    engine = createEngine();

    const response = await handleRequest(
      jsonRequest('POST', '/v1/workflows', ['not-an-object']),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Missing required field: type' });
  });

  it('returns 400 when startAt and startAfter are both provided', async () => {
    engine = createEngine();

    const response = await handleRequest(
      jsonRequest('POST', '/v1/workflows', {
        type: 'echo',
        startAt: Date.now(),
        startAfter: '1s',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Provide only one of startAt or startAfter' });
  });

  it('enforces idempotencyKey over raw REST: a duplicate key returns the same id', async () => {
    engine = createEngine();

    const first = await handleRequest(
      jsonRequest('POST', '/v1/workflows', {
        type: 'echo',
        idempotencyKey: 'dedupe-key',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { id: string };

    const second = await handleRequest(
      jsonRequest('POST', '/v1/workflows', {
        type: 'echo',
        idempotencyKey: 'dedupe-key',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { id: string };

    // Same dedup key -> same run, no second workflow started.
    expect(secondBody.id).toBe(firstBody.id);
  });

  it('returns 400 when both id and idempotencyKey are provided (mutually exclusive)', async () => {
    engine = createEngine();

    const response = await handleRequest(
      jsonRequest('POST', '/v1/workflows', {
        type: 'echo',
        id: 'explicit-id',
        idempotencyKey: 'dedupe-key',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/mutually exclusive/);
  });

  it('returns 400 when idempotencyKey is an empty string over raw REST', async () => {
    engine = createEngine();

    const response = await handleRequest(
      jsonRequest('POST', '/v1/workflows', {
        type: 'echo',
        idempotencyKey: '',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Field "idempotencyKey" must not be empty' });
  });

  it('coerces date-time search attributes before starting from raw REST', async () => {
    engine = createEngine();

    const response = await handleRequest(
      jsonRequest('POST', '/v1/workflows', {
        type: 'with-search-attributes',
        id: 'start-workflow-date-attribute',
        searchAttributes: { createdAt: '2026-01-02T03:04:05.000Z', attempt: 2 },
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(201);
    expect(await engine.getAttributes('start-workflow-date-attribute')).toEqual({
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      attempt: 2,
    });
  });

  it('returns 400 when search attributes do not match the registered schema', async () => {
    engine = createEngine();

    const response = await handleRequest(
      jsonRequest('POST', '/v1/workflows', {
        type: 'with-search-attributes',
        searchAttributes: { attempt: 'not-a-number' },
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toEqual(
      expect.objectContaining({
        error: expect.stringContaining(
          'Search attribute "attempt" is declared as "number" but received string',
        ),
      }),
    );
  });

  it('returns 400 when engine.start throws StartWorkflowValidationError', async () => {
    engine = createEngine();
    const originalStart = engine.start.bind(engine);

    try {
      engine.start = async () => {
        throw new StartWorkflowValidationError('Field "id" must be a string');
      };

      const response = await handleRequest(
        jsonRequest('POST', '/v1/workflows', { type: 'echo' }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Field "id" must be a string' });
    } finally {
      engine.start = originalStart;
    }
  });

  it('returns 400 when the workflow type is not registered', async () => {
    engine = createEngine();

    const response = await handleRequest(
      jsonRequest('POST', '/v1/workflows', { type: 'missing-workflow' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('No workflow registered'),
      }),
    );
  });

  it('returns 409 when the workflow id already exists', async () => {
    engine = createEngine();

    const firstResponse = await handleRequest(
      jsonRequest('POST', '/v1/workflows', { type: 'echo', id: 'duplicate-workflow-id' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(firstResponse.status).toBe(201);

    const secondResponse = await handleRequest(
      jsonRequest('POST', '/v1/workflows', { type: 'echo', id: 'duplicate-workflow-id' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(secondResponse.status).toBe(409);
    expect((await secondResponse.json()) as { error: string }).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('already exists'),
      }),
    );
  });

  it('returns 409 when an idempotency key maps to a purged run (not a masked 500)', async () => {
    engine = createEngine();

    // First start creates the run and the durable `start-idem:` mapping.
    const first = await handleRequest(
      jsonRequest('POST', '/v1/workflows', { type: 'echo', idempotencyKey: 'purged-key' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );
    expect(first.status).toBe(201);
    const { id } = (await first.json()) as { id: string };
    await engine.getHandle(id).result();
    // Purge the run while the mapping intentionally lives on; the key is now spent.
    await engine.purge({ idPrefix: id });

    const second = await handleRequest(
      jsonRequest('POST', '/v1/workflows', { type: 'echo', idempotencyKey: 'purged-key' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    // Client-actionable conflict (pick a different key), not an opaque 500.
    expect(second.status).toBe(409);
    expect((await second.json()) as { error: string }).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('no longer exists'),
      }),
    );
  });

  it('masks unexpected engine failures to a generic 500 (no raw message leak)', async () => {
    engine = createEngine();
    const originalStart = engine.start.bind(engine);

    try {
      engine.start = async () => {
        throw new Error('unexpected engine error');
      };

      const response = await handleRequest(
        jsonRequest('POST', '/v1/workflows', { type: 'echo' }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
      expect(response.headers.get('Content-Type')).toContain('application/json');
    } finally {
      engine.start = originalStart;
    }
  });
});

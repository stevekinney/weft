import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { StartWorkflowValidationError } from '../../core/start-workflow-validation.ts';
import { QuotaExceededError } from '../../core/tenant-quotas.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { invalidJsonRequest, jsonRequest } from './operation-test-helpers.ts';
import { startWorkflowOperation, startWorkflowRestBinding } from './start-workflow.ts';

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
    return input;
  });
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

  it('returns 400 when the request body is JSON null', async () => {
    // Legacy `handleStartWorkflow` rejects `null` (typeof 'object' && === null
    // fails the guard) with "Request body must be a JSON object". This pins
    // that path; arrays are handled by the next test as legacy parity.
    engine = createEngine();

    const response = await handleRequest(jsonRequest('POST', '/v1/workflows', null), engine, {
      operationRegistry: registry,
      restBindings: bindings,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Request body must be a JSON object' });
  });

  it('returns 400 with "Missing required field: type" when body is a JSON array', async () => {
    // Legacy parity: arrays are typeof 'object' && !== null, so they pass the
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

  it('returns 429 when engine.start throws QuotaExceededError', async () => {
    engine = createEngine();
    const originalStart = engine.start.bind(engine);

    try {
      engine.start = async () => {
        throw new QuotaExceededError({
          tenantId: 'acme',
          quota: 'maxConcurrentWorkflows',
          currentUsage: 2,
          limit: 1,
        });
      };

      const response = await handleRequest(
        jsonRequest('POST', '/v1/workflows', { type: 'echo' }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(429);
      expect((await response.json()) as { error: string }).toEqual(
        expect.objectContaining({
          error: expect.stringContaining('Tenant quota exceeded'),
        }),
      );
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

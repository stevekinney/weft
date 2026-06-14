/**
 * `weft.workflows.bulk.cancel` operation + REST binding — behavior tests.
 */

import { describe, expect, it } from 'bun:test';

import type { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { handleRequest } from '../handler.ts';
import { createJsonRequest } from '../http-request.test-support.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { principalFromApiKey } from '../principal.ts';
import { waitForStatus } from '../workflow-status.test-support.ts';
import {
  bulkCancelWorkflowsOperation,
  bulkCancelWorkflowsRestBinding,
} from './bulk-cancel-workflows.ts';
import {
  createBulkTestEngine,
  bulkAdminHandlerOptions as makeBulkAdminHandlerOptions,
} from './bulk-operation.test-support.ts';

const waitingWorkflow = workflow({ name: 'waiting' }).execute(async function* (
  ctx: WorkflowContext,
) {
  return yield* ctx.waitForSignal('release');
});

function createEngine(): Engine {
  return createBulkTestEngine(waitingWorkflow);
}

// Cancel call sites target different paths, so the path is passed in; the
// method is always POST for this operation.
function request(path: string, body?: unknown): Request {
  return createJsonRequest({ method: 'POST', path, body });
}

function streamingJsonRequest(path: string, body: unknown): Request {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  });
}

const registry = createOperationRegistry([bulkCancelWorkflowsOperation]);
const bindings = [bulkCancelWorkflowsRestBinding];

function bulkAdminHandlerOptions(customRegistry = registry) {
  return makeBulkAdminHandlerOptions({ registry: customRegistry, bindings });
}

describe('weft.workflows.bulk.cancel', () => {
  it('returns cancellation counts and cancels matching workflows', async () => {
    using engine = createEngine();

    await engine.start('waiting', undefined, {
      id: 'bulk-cancel-selected-a',
      tags: ['selected'],
    });
    await engine.start('waiting', undefined, {
      id: 'bulk-cancel-selected-b',
      tags: ['selected'],
    });
    await engine.start('waiting', undefined, {
      id: 'bulk-cancel-other',
      tags: ['other'],
    });

    await Promise.all([
      waitForStatus(engine, 'bulk-cancel-selected-a', 'running'),
      waitForStatus(engine, 'bulk-cancel-selected-b', 'running'),
      waitForStatus(engine, 'bulk-cancel-other', 'running'),
    ]);

    const previewResponse = await handleRequest(
      request('/v1/workflows/bulk/cancel', {
        filter: { tags: ['selected'] },
        dryRun: true,
        requestId: 'bulk-cancel-request',
      }),
      engine,
      bulkAdminHandlerOptions(),
    );

    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json();
    expect(preview).toEqual(
      expect.objectContaining({
        dryRun: true,
        action: 'cancel',
        matched: 2,
        requestId: 'bulk-cancel-request',
        confirmationToken: expect.stringMatching(/^bulk:/),
      }),
    );
    const firstPreviewedWorkflow = await engine.get('bulk-cancel-selected-a');
    const secondPreviewedWorkflow = await engine.get('bulk-cancel-selected-b');
    expect(firstPreviewedWorkflow?.status).toBe('running');
    expect(secondPreviewedWorkflow?.status).toBe('running');

    const response = await handleRequest(
      request('/v1/workflows/bulk/cancel', { filter: { tags: ['selected'] } }),
      engine,
      bulkAdminHandlerOptions(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Field "confirmationToken" is required after a dry run',
    });

    const confirmedResponse = await handleRequest(
      request('/v1/workflows/bulk/cancel', {
        filter: { tags: ['selected'] },
        confirmationToken: preview.confirmationToken,
        requestId: 'bulk-cancel-request',
      }),
      engine,
      bulkAdminHandlerOptions(),
    );

    expect(confirmedResponse.status).toBe(200);
    expect(confirmedResponse.headers.get('content-type')).toBe('application/json');
    expect(await confirmedResponse.json()).toEqual({
      cancelled: 2,
      failed: 0,
      errors: [],
      auditEvent: expect.objectContaining({
        type: 'bulk-operation:audit',
        action: 'cancel',
        affectedCount: 2,
        requestId: 'bulk-cancel-request',
      }),
    });
    const firstCancelledState = await engine.get('bulk-cancel-selected-a');
    const secondCancelledState = await engine.get('bulk-cancel-selected-b');
    const untouchedState = await engine.get('bulk-cancel-other');
    expect(firstCancelledState?.status).toBe('cancelled');
    expect(secondCancelledState?.status).toBe('cancelled');
    expect(untouchedState?.status).toBe('running');

    await engine.cancel('bulk-cancel-other');
  });

  it('returns 400 when bulkConcurrency is not a positive integer', async () => {
    using engine = createEngine();

    const response = await handleRequest(
      request('/v1/workflows/bulk/cancel', {
        filter: { status: 'running' },
        dryRun: true,
        bulkConcurrency: 0,
      }),
      engine,
      bulkAdminHandlerOptions(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Field "bulkConcurrency" must be a positive integer',
    });
  });

  it('rejects an oversized streaming bulk filter body', async () => {
    using engine = createEngine();

    const response = await handleRequest(
      streamingJsonRequest('/v1/workflows/bulk/cancel', {
        filter: { tags: ['selected'] },
        dryRun: true,
      }),
      engine,
      { ...bulkAdminHandlerOptions(), maxRequestBodyBytes: 8 },
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'Payload Too Large' });
  });

  it('returns 400 when the bulk filter is unscoped', async () => {
    using engine = createEngine();

    const response = await handleRequest(request('/v1/workflows/bulk/cancel', {}), engine, {
      ...bulkAdminHandlerOptions(),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      error:
        'Field "filter" must include at least one of status, type, tags, attributes, idPrefix (≥3 chars), or failureCategory paired with status',
    });
  });

  it('returns 400 for invalid filter bodies before dispatching', async () => {
    using engine = createEngine();

    const response = await handleRequest(
      request('/v1/workflows/bulk/cancel', {
        filter: {
          attributes: [{ key: '' }],
        },
      }),
      engine,
      bulkAdminHandlerOptions(),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      error: 'Field "filter.attributes[0].key" must be a non-empty string',
    });
  });

  it('caps request ids before they can become audit storage keys', async () => {
    using engine = createEngine();

    const response = await handleRequest(
      request('/v1/workflows/bulk/cancel', {
        filter: { tags: ['selected'] },
        dryRun: true,
        requestId: 'x'.repeat(201),
      }),
      engine,
      bulkAdminHandlerOptions(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Field "requestId" must be at most 200 characters',
    });
  });

  it('requires workflows:admin for authenticated bulk operators', async () => {
    using engine = createEngine();

    const response = await handleRequest(
      request('/v1/workflows/bulk/cancel', {
        filter: { tags: ['selected'] },
        dryRun: true,
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
        authContext: {
          method: 'api-key',
          principal: principalFromApiKey({
            subject: 'read-only-operator',
            scopes: ['workflows:read'],
          }),
        },
      },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'requires any of: workflows:admin' });
  });

  it('masks EngineFailure faults to a 500 with a generic error body', async () => {
    using engine = createEngine();
    const failingOperation = {
      ...bulkCancelWorkflowsOperation,
      invoke: async () => {
        const fault: OperationFault = {
          code: 'EngineFailure',
          message: 'cancel failed',
          data: {},
        };
        throw fault;
      },
    };
    const failingRegistry = createOperationRegistry([failingOperation]);

    const response = await handleRequest(
      request('/v1/workflows/bulk/cancel', { filter: { tags: ['selected'] } }),
      engine,
      {
        ...bulkAdminHandlerOptions(failingRegistry),
      },
    );

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });
});

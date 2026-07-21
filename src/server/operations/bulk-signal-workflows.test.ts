/**
 * `weft.workflows.bulk.signal` operation + REST binding — behavior tests.
 */

import { describe, expect, it } from 'bun:test';

import type { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { handleRequest } from '../handler.ts';
import { createJsonRequest } from '../http-request.test-support.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { waitForStatus } from '../workflow-status.test-support.ts';
import {
  createBulkTestEngine,
  bulkAdminHandlerOptions as makeBulkAdminHandlerOptions,
} from './bulk-operation.test-support.ts';
import {
  bulkSignalWorkflowsOperation,
  bulkSignalWorkflowsRestBinding,
} from './bulk-signal-workflows.ts';

const waitingWorkflow = workflow({ name: 'waiting' }).execute(async function* (
  ctx: WorkflowContext,
  input: unknown,
) {
  const payload = yield* ctx.waitForSignal<string>('continue');
  return `${String(input)}:${payload}`;
});

function createEngine(): Engine {
  return createBulkTestEngine(waitingWorkflow);
}

function request(body?: unknown): Request {
  return createJsonRequest({ method: 'POST', path: '/v1/workflows/bulk/signal', body });
}

const registry = createOperationRegistry([bulkSignalWorkflowsOperation]);
const bindings = [bulkSignalWorkflowsRestBinding];

function bulkAdminHandlerOptions(customRegistry = registry) {
  return makeBulkAdminHandlerOptions({ registry: customRegistry, bindings });
}

describe('weft.workflows.bulk.signal', () => {
  it('returns signal counts and signals matching workflows', async () => {
    using engine = createEngine();

    const firstHandle = await engine.start('waiting', 'first', {
      id: 'bulk-signal-selected-a',
      tags: ['selected'],
    });
    const secondHandle = await engine.start('waiting', 'second', {
      id: 'bulk-signal-selected-b',
      tags: ['selected'],
    });
    const otherHandle = await engine.start('waiting', 'other', {
      id: 'bulk-signal-other',
      tags: ['other'],
    });

    await Promise.all([
      waitForStatus(engine, firstHandle.id, 'running'),
      waitForStatus(engine, secondHandle.id, 'running'),
      waitForStatus(engine, otherHandle.id, 'running'),
    ]);

    const previewResponse = await handleRequest(
      request({
        filter: { tags: ['selected'] },
        name: 'continue',
        payload: 'released',
        dryRun: true,
        requestId: 'bulk-signal-request',
      }),
      engine,
      bulkAdminHandlerOptions(),
    );

    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json();
    expect(preview).toEqual(
      expect.objectContaining({
        dryRun: true,
        action: 'signal',
        matched: 2,
        requestId: 'bulk-signal-request',
        confirmationToken: expect.stringMatching(/^bulk:/),
      }),
    );
    const firstPreviewedWorkflow = await engine.get(firstHandle.id);
    const secondPreviewedWorkflow = await engine.get(secondHandle.id);
    expect(firstPreviewedWorkflow?.status).toBe('running');
    expect(secondPreviewedWorkflow?.status).toBe('running');

    const response = await handleRequest(
      request({
        filter: { tags: ['selected'] },
        name: 'continue',
        payload: 'released',
        confirmationToken: preview.confirmationToken,
        requestId: 'bulk-signal-request',
      }),
      engine,
      bulkAdminHandlerOptions(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      signalled: 2,
      failed: 0,
      auditEvent: expect.objectContaining({
        type: 'bulk-operation:audit',
        action: 'signal',
        affectedCount: 2,
        requestId: 'bulk-signal-request',
      }),
    });
    await expect(firstHandle.result()).resolves.toBe('first:released');
    await expect(secondHandle.result()).resolves.toBe('second:released');
    const untouchedState = await engine.get(otherHandle.id);
    expect(untouchedState?.status).toBe('running');

    await engine.signal(otherHandle.id, 'continue', 'cleanup');
    await otherHandle.result();
  });

  it('returns 400 when the request body is not a JSON object', async () => {
    using engine = createEngine();

    const response = await handleRequest(request(['not-an-object']), engine, {
      ...bulkAdminHandlerOptions(),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'Request body must be a JSON object' });
  });

  it('returns 400 for missing required fields and unscoped filters', async () => {
    using engine = createEngine();

    let response = await handleRequest(request({ filter: {}, name: 'continue' }), engine, {
      ...bulkAdminHandlerOptions(),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        'Field "filter" must include at least one of status, type, scheduleId, tags, attributes, idPrefix (≥3 chars), or failureCategory paired with status',
    });

    response = await handleRequest(
      request({
        filter: { tags: ['selected'] },
        name: '',
      }),
      engine,
      {
        ...bulkAdminHandlerOptions(),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Field "name" must be a non-empty string',
    });

    response = await handleRequest(
      request({
        filter: { tags: ['selected'] },
        name: 'continue',
      }),
      engine,
      {
        ...bulkAdminHandlerOptions(),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Field "confirmationToken" is required after a dry run',
    });
  });

  it('masks EngineFailure faults to a 500 with a generic error body', async () => {
    using engine = createEngine();
    const failingOperation = {
      ...bulkSignalWorkflowsOperation,
      invoke: async () => {
        const fault: OperationFault = {
          code: 'EngineFailure',
          message: 'signal failed',
          data: {},
        };
        throw fault;
      },
    };
    const failingRegistry = createOperationRegistry([failingOperation]);

    const response = await handleRequest(
      request({
        filter: { tags: ['selected'] },
        name: 'continue',
      }),
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

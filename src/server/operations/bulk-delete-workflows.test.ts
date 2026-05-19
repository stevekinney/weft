import { sleepForTesting } from '../../testing/fake-timers.ts';
/**
 * `weft.workflows.bulk.delete` operation + REST binding — behavior tests.
 */

import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { principalFromApiKey } from '../principal.ts';
import {
  bulkDeleteWorkflowsOperation,
  bulkDeleteWorkflowsRestBinding,
} from './bulk-delete-workflows.ts';

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
    return input;
  });
  engine.register('waiting', async function* (ctx: WorkflowContext) {
    return yield* ctx.waitForSignal('release');
  });
  return engine;
}

async function waitForStatus(
  engine: Engine,
  workflowId: string,
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out',
  timeoutMilliseconds = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const state = await engine.get(workflowId);
    if (state?.status === status) {
      return;
    }
    await sleepForTesting(5);
  }

  throw new Error(`Workflow ${workflowId} did not reach ${status} within ${timeoutMilliseconds}ms`);
}

function request(body?: unknown): Request {
  return new Request('http://localhost/v1/workflows/bulk', {
    method: 'DELETE',
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
}

const registry = createOperationRegistry([bulkDeleteWorkflowsOperation]);
const bindings = [bulkDeleteWorkflowsRestBinding];

function bulkAdminHandlerOptions(customRegistry = registry) {
  return {
    operationRegistry: customRegistry,
    restBindings: bindings,
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({
        subject: 'bulk-admin-operator',
        scopes: ['workflows:admin'],
      }),
    },
  };
}

describe('weft.workflows.bulk.delete', () => {
  it('deletes matching terminal workflows', async () => {
    const engine = createEngine();

    const firstHandle = await engine.start('echo', 'first', {
      id: 'bulk-delete-selected-a',
      tags: ['selected'],
    });
    const secondHandle = await engine.start('echo', 'second', {
      id: 'bulk-delete-selected-b',
      tags: ['selected'],
    });
    await firstHandle.result();
    await secondHandle.result();

    const previewResponse = await handleRequest(
      request({
        filter: { tags: ['selected'] },
        dryRun: true,
        requestId: 'bulk-delete-request',
      }),
      engine,
      bulkAdminHandlerOptions(),
    );

    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json();
    expect(preview).toEqual(
      expect.objectContaining({
        dryRun: true,
        action: 'delete',
        matched: 2,
        requestId: 'bulk-delete-request',
        confirmationToken: expect.stringMatching(/^bulk:/),
      }),
    );
    expect(await engine.get('bulk-delete-selected-a')).not.toBeNull();
    expect(await engine.get('bulk-delete-selected-b')).not.toBeNull();

    const response = await handleRequest(
      request({
        filter: { tags: ['selected'] },
        confirmationToken: preview.confirmationToken,
        requestId: 'bulk-delete-request',
      }),
      engine,
      bulkAdminHandlerOptions(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      deleted: 2,
      auditEvent: expect.objectContaining({
        type: 'bulk-operation:audit',
        action: 'delete',
        affectedCount: 2,
        requestId: 'bulk-delete-request',
      }),
    });
    expect(await engine.get('bulk-delete-selected-a')).toBeNull();
    expect(await engine.get('bulk-delete-selected-b')).toBeNull();
  });

  it('requires a confirmation token before deleting matching terminal workflows', async () => {
    const engine = createEngine();

    const handle = await engine.start('echo', 'first', {
      id: 'bulk-delete-token-required',
      tags: ['selected'],
    });
    await handle.result();

    const response = await handleRequest(request({ filter: { tags: ['selected'] } }), engine, {
      ...bulkAdminHandlerOptions(),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      error: 'Field "confirmationToken" is required after a dry run',
    });
    expect(await engine.get('bulk-delete-token-required')).not.toBeNull();
  });

  it('returns 422 when the filter matches non-terminal workflows', async () => {
    const engine = createEngine();

    const completedHandle = await engine.start('echo', 'done', {
      id: 'bulk-delete-completed',
      tags: ['mixed'],
    });
    await completedHandle.result();

    await engine.start('waiting', undefined, {
      id: 'bulk-delete-running',
      tags: ['mixed'],
    });
    await waitForStatus(engine, 'bulk-delete-running', 'running');

    const response = await handleRequest(
      request({ filter: { tags: ['mixed'] }, dryRun: true }),
      engine,
      bulkAdminHandlerOptions(),
    );

    expect(response.status).toBe(422);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      error: 'Bulk delete matches non-terminal workflows',
    });

    await engine.cancel('bulk-delete-running');
  });

  it('returns 400 when the bulk filter is unscoped', async () => {
    const engine = createEngine();

    const response = await handleRequest(request({ filter: {} }), engine, {
      ...bulkAdminHandlerOptions(),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      error:
        'Field "filter" must include at least one of status, type, tags, attributes, tenantId, idPrefix (≥3 chars), or failureCategory paired with status',
    });
  });

  it('returns 400 with the "Field \\"filter.tags\\"" label when filter tags contain an empty string', async () => {
    const engine = createEngine();

    const response = await handleRequest(request({ filter: { tags: [''] } }), engine, {
      ...bulkAdminHandlerOptions(),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      error: 'Field "filter.tags" must not contain empty tags',
    });
  });

  it('returns 400 when a filter time-range bound is not a finite number', async () => {
    const engine = createEngine();

    const response = await handleRequest(
      request({ filter: { tags: ['selected'], createdAt: { gt: 'not-a-number' } } }),
      engine,
      { ...bulkAdminHandlerOptions() },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      error: 'Time-range bound "gt" must be a finite number',
    });
  });

  it('maps EngineFailure faults to the legacy 500 response body', async () => {
    const engine = createEngine();
    const failingOperation = {
      ...bulkDeleteWorkflowsOperation,
      invoke: async () => {
        const fault: OperationFault = {
          code: 'EngineFailure',
          message: 'delete failed',
          data: {},
        };
        throw fault;
      },
    };
    const failingRegistry = createOperationRegistry([failingOperation]);

    const response = await handleRequest(request({ filter: { tags: ['selected'] } }), engine, {
      ...bulkAdminHandlerOptions(failingRegistry),
    });

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'delete failed' });
  });
});

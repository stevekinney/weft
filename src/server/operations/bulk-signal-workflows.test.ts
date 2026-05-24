import { sleepForTesting } from '../../testing/fake-timers.ts';
/**
 * `weft.workflows.bulk.signal` operation + REST binding — behavior tests.
 */

import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { principalFromApiKey } from '../principal.ts';
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
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register(waitingWorkflow);
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
  return new Request('http://localhost/v1/workflows/bulk/signal', {
    method: 'POST',
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
}

const registry = createOperationRegistry([bulkSignalWorkflowsOperation]);
const bindings = [bulkSignalWorkflowsRestBinding];

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

describe('weft.workflows.bulk.signal', () => {
  it('returns signal counts and signals matching workflows', async () => {
    const engine = createEngine();

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
    const engine = createEngine();

    const response = await handleRequest(request(['not-an-object']), engine, {
      ...bulkAdminHandlerOptions(),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'Request body must be a JSON object' });
  });

  it('returns 400 for missing required fields and unscoped filters', async () => {
    const engine = createEngine();

    let response = await handleRequest(request({ filter: {}, name: 'continue' }), engine, {
      ...bulkAdminHandlerOptions(),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        'Field "filter" must include at least one of status, type, tags, attributes, tenantId, idPrefix (≥3 chars), or failureCategory paired with status',
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
    const engine = createEngine();
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

/**
 * `weft.workflows.bulk.retryfailed` operation + REST binding — behavior tests.
 */

import { describe, expect, it } from 'bun:test';

import type { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { handleRequest } from '../handler.ts';
import { createJsonRequest } from '../http-request.test-support.ts';
import { handleJsonRpcHttpRequest } from '../json-rpc-http.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { principalFromApiKey } from '../principal.ts';
import { waitForStatus } from '../workflow-status.test-support.ts';
import {
  createBulkTestEngine,
  bulkAdminHandlerOptions as makeBulkAdminHandlerOptions,
} from './bulk-operation.test-support.ts';
import {
  bulkRetryFailedWorkflowsOperation,
  bulkRetryFailedWorkflowsRestBinding,
} from './bulk-retry-failed-workflows.ts';

function createRetryOnceWorkflow(control: { shouldFail: boolean }) {
  return workflow({ name: 'retry-once' }).execute(async function* (
    _ctx: WorkflowContext,
    input: { value: string },
  ) {
    if (control.shouldFail) {
      throw new Error(`failed:${input.value}`);
    }
    return `retried:${input.value}`;
  });
}

function createEngine(control: { shouldFail: boolean }): Engine {
  return createBulkTestEngine(createRetryOnceWorkflow(control));
}

function request(path: string, body?: unknown): Request {
  return createJsonRequest({ method: 'POST', path, body });
}

function jsonRpcRequest(params: unknown, id = 1): Request {
  return new Request('http://localhost/jsonrpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'weft.workflows.bulk.retryfailed',
      params,
      id,
    }),
  });
}

const registry = createOperationRegistry([bulkRetryFailedWorkflowsOperation]);
const bindings = [bulkRetryFailedWorkflowsRestBinding];

function bulkAdminHandlerOptions(customRegistry = registry) {
  return makeBulkAdminHandlerOptions({ registry: customRegistry, bindings });
}

function bulkAdminPrincipal() {
  return principalFromApiKey({
    subject: 'bulk-admin-operator',
    scopes: ['workflows:admin'],
  });
}

async function startFailedWorkflow(
  engine: Engine,
  workflowId: string,
  tags: string[],
): Promise<void> {
  await engine.start('retry-once', { value: workflowId }, { id: workflowId, tags });
  await waitForStatus(engine, workflowId, 'failed');
}

describe('weft.workflows.bulk.retryfailed', () => {
  it('previews and confirms failed-workflow retry over REST', async () => {
    const control = { shouldFail: true };
    using engine = createEngine(control);
    await startFailedWorkflow(engine, 'rest-retry-selected', ['rest-retry']);

    const previewResponse = await handleRequest(
      request('/v1/workflows/bulk/retry-failed', {
        filter: { tags: ['rest-retry'] },
        dryRun: true,
        requestId: 'rest-retry-request',
      }),
      engine,
      bulkAdminHandlerOptions(),
    );

    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json();
    expect(preview).toEqual(
      expect.objectContaining({
        dryRun: true,
        action: 'retry-failed',
        matched: 1,
        requestId: 'rest-retry-request',
        confirmationToken: expect.stringMatching(/^bulk:/),
      }),
    );
    const previewedState = await engine.get('rest-retry-selected');
    expect(previewedState?.status).toBe('failed');

    const missingTokenResponse = await handleRequest(
      request('/v1/workflows/bulk/retry-failed', { filter: { tags: ['rest-retry'] } }),
      engine,
      bulkAdminHandlerOptions(),
    );

    expect(missingTokenResponse.status).toBe(400);
    expect(await missingTokenResponse.json()).toEqual({
      error: 'Field "confirmationToken" is required after a dry run',
    });

    control.shouldFail = false;
    const confirmedResponse = await handleRequest(
      request('/v1/workflows/bulk/retry-failed', {
        filter: { tags: ['rest-retry'] },
        confirmationToken: preview.confirmationToken,
        requestId: 'rest-retry-request',
      }),
      engine,
      bulkAdminHandlerOptions(),
    );

    expect(confirmedResponse.status).toBe(200);
    expect(await confirmedResponse.json()).toEqual({
      retried: 1,
      failed: 0,
      errors: [],
      auditEvent: expect.objectContaining({
        type: 'bulk-operation:audit',
        action: 'retry-failed',
        affectedCount: 1,
        requestId: 'rest-retry-request',
      }),
    });
    await waitForStatus(engine, 'rest-retry-selected', 'completed');
  });

  it('previews and confirms failed-workflow retry over JSON-RPC HTTP', async () => {
    const control = { shouldFail: true };
    using engine = createEngine(control);
    await startFailedWorkflow(engine, 'json-rpc-retry-selected', ['json-rpc-retry']);

    const previewResponse = await handleJsonRpcHttpRequest(
      jsonRpcRequest({
        tags: ['json-rpc-retry'],
        dryRun: true,
        requestId: 'json-rpc-retry-request',
      }),
      { registry, engine, principal: bulkAdminPrincipal() },
    );

    expect(previewResponse.status).toBe(200);
    const previewEnvelope = await previewResponse.json();
    expect(previewEnvelope).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: expect.objectContaining({
        dryRun: true,
        action: 'retry-failed',
        matched: 1,
        requestId: 'json-rpc-retry-request',
        confirmationToken: expect.stringMatching(/^bulk:/),
      }),
    });

    control.shouldFail = false;
    const confirmationToken = previewEnvelope.result.confirmationToken;
    const confirmedResponse = await handleJsonRpcHttpRequest(
      jsonRpcRequest(
        {
          tags: ['json-rpc-retry'],
          confirmationToken,
          requestId: 'json-rpc-retry-request',
        },
        2,
      ),
      { registry, engine, principal: bulkAdminPrincipal() },
    );

    expect(confirmedResponse.status).toBe(200);
    expect(await confirmedResponse.json()).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: {
        retried: 1,
        failed: 0,
        errors: [],
        auditEvent: expect.objectContaining({
          type: 'bulk-operation:audit',
          action: 'retry-failed',
          affectedCount: 1,
          requestId: 'json-rpc-retry-request',
        }),
      },
    });
    await waitForStatus(engine, 'json-rpc-retry-selected', 'completed');
  });
});

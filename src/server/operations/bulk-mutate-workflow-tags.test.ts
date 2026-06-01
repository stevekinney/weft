/**
 * `weft.workflows.bulk.tags` operation + REST binding — behavior tests.
 */

import { describe, expect, it } from 'bun:test';

import type { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { handleRequest } from '../handler.ts';
import { createJsonRequest } from '../http-request.test-support.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import {
  bulkMutateWorkflowTagsOperation,
  bulkMutateWorkflowTagsRestBinding,
} from './bulk-mutate-workflow-tags.ts';
import {
  createBulkTestEngine,
  bulkAdminHandlerOptions as makeBulkAdminHandlerOptions,
} from './bulk-operation.test-support.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

function createEngine(): Engine {
  return createBulkTestEngine(echoWorkflow);
}

function request(body?: unknown): Request {
  return createJsonRequest({ method: 'PATCH', path: '/v1/workflows/bulk/tags', body });
}

const registry = createOperationRegistry([bulkMutateWorkflowTagsOperation]);
const bindings = [bulkMutateWorkflowTagsRestBinding];

function bulkAdminHandlerOptions(customRegistry = registry) {
  return makeBulkAdminHandlerOptions({ registry: customRegistry, bindings });
}

describe('weft.workflows.bulk.tags', () => {
  it('adds and removes tags on matching workflows', async () => {
    const engine = createEngine();

    const firstHandle = await engine.start('echo', 'first', {
      id: 'bulk-tags-selected-a',
      tags: ['selected'],
    });
    const secondHandle = await engine.start('echo', 'second', {
      id: 'bulk-tags-selected-b',
      tags: ['selected'],
    });
    await firstHandle.result();
    await secondHandle.result();

    let previewResponse = await handleRequest(
      request({
        filter: { tags: ['selected'] },
        tags: ['bulk'],
        operation: 'add',
        dryRun: true,
        requestId: 'bulk-tags-add-request',
      }),
      engine,
      bulkAdminHandlerOptions(),
    );

    expect(previewResponse.status).toBe(200);
    const addPreview = await previewResponse.json();
    expect(addPreview).toEqual(
      expect.objectContaining({
        dryRun: true,
        action: 'tag:add',
        matched: 2,
        requestId: 'bulk-tags-add-request',
        confirmationToken: expect.stringMatching(/^bulk:/),
      }),
    );
    const firstPreviewedWorkflow = await engine.get('bulk-tags-selected-a');
    const secondPreviewedWorkflow = await engine.get('bulk-tags-selected-b');
    expect(firstPreviewedWorkflow?.tags).toEqual(['selected']);
    expect(secondPreviewedWorkflow?.tags).toEqual(['selected']);

    let response = await handleRequest(
      request({
        filter: { tags: ['selected'] },
        tags: ['bulk'],
        operation: 'add',
        confirmationToken: addPreview.confirmationToken,
        requestId: 'bulk-tags-add-request',
      }),
      engine,
      bulkAdminHandlerOptions(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      modified: 2,
      auditEvent: expect.objectContaining({
        type: 'bulk-operation:audit',
        action: 'tag:add',
        affectedCount: 2,
        requestId: 'bulk-tags-add-request',
      }),
    });
    const firstAddedTagsState = await engine.get('bulk-tags-selected-a');
    const secondAddedTagsState = await engine.get('bulk-tags-selected-b');
    expect(firstAddedTagsState?.tags).toEqual(['bulk', 'selected']);
    expect(secondAddedTagsState?.tags).toEqual(['bulk', 'selected']);

    previewResponse = await handleRequest(
      request({
        filter: { tags: ['bulk'] },
        tags: ['selected'],
        operation: 'remove',
        dryRun: true,
        requestId: 'bulk-tags-remove-request',
      }),
      engine,
      bulkAdminHandlerOptions(),
    );

    expect(previewResponse.status).toBe(200);
    const removePreview = await previewResponse.json();
    expect(removePreview).toEqual(
      expect.objectContaining({
        dryRun: true,
        action: 'tag:remove',
        matched: 2,
        requestId: 'bulk-tags-remove-request',
        confirmationToken: expect.stringMatching(/^bulk:/),
      }),
    );

    response = await handleRequest(
      request({
        filter: { tags: ['bulk'] },
        tags: ['selected'],
        operation: 'remove',
        confirmationToken: removePreview.confirmationToken,
        requestId: 'bulk-tags-remove-request',
      }),
      engine,
      bulkAdminHandlerOptions(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      modified: 2,
      auditEvent: expect.objectContaining({
        type: 'bulk-operation:audit',
        action: 'tag:remove',
        affectedCount: 2,
        requestId: 'bulk-tags-remove-request',
      }),
    });
    const firstRemovedTagsState = await engine.get('bulk-tags-selected-a');
    const secondRemovedTagsState = await engine.get('bulk-tags-selected-b');
    expect(firstRemovedTagsState?.tags).toEqual(['bulk']);
    expect(secondRemovedTagsState?.tags).toEqual(['bulk']);
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

  it('returns 400 for invalid tag mutation input', async () => {
    const engine = createEngine();

    let response = await handleRequest(
      request({
        filter: {},
        tags: ['bulk'],
        operation: 'add',
      }),
      engine,
      {
        ...bulkAdminHandlerOptions(),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error:
        'Field "filter" must include at least one of status, type, tags, attributes, idPrefix (≥3 chars), or failureCategory paired with status',
    });

    response = await handleRequest(
      request({
        filter: { tags: ['selected'] },
        tags: ['bulk'],
        operation: 'rename',
      }),
      engine,
      {
        ...bulkAdminHandlerOptions(),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Field "operation" must be "add" or "remove"',
    });
  });

  it('masks EngineFailure faults to a 500 with a generic error body', async () => {
    const engine = createEngine();
    const failingOperation = {
      ...bulkMutateWorkflowTagsOperation,
      invoke: async () => {
        const fault: OperationFault = {
          code: 'EngineFailure',
          message: 'tag failed',
          data: {},
        };
        throw fault;
      },
    };
    const failingRegistry = createOperationRegistry([failingOperation]);

    const response = await handleRequest(
      request({
        filter: { tags: ['selected'] },
        tags: ['bulk'],
        operation: 'add',
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

import { describe, expect, it } from 'bun:test';

import { createOperationRegistry } from "../../embedded/backchannel/src/internals.ts";
import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { Engine } from '../../core/engine.ts';
import { handleRequestAsLocalUser as handleRequest } from '../local-user-request.test-support.ts';
import {
  createSingleWorkflowTagMutationOperation,
  createSingleWorkflowTagMutationRestBinding,
} from './single-workflow-tag-mutation.ts';

function request(method: string, path: string, body?: unknown): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return new Request(`http://localhost${path}`, init);
}

describe('single-workflow tag mutation helper', () => {
  it('validates tags once and dispatches them to the configured engine mutation', async () => {
    const calls: Array<{ workflowId: string; tags: string[] }> = [];
    const operation = createSingleWorkflowTagMutationOperation({
      name: 'weft.workflows.tags.test',
      summary: 'Test workflow tag mutation',
      description: 'Test workflow tag mutation, described.',
      destructive: false,
      scope: 'tags:write',
      requiredEngineMethods: [],
      mutateTags: async (_engine, workflowId, tags) => {
        calls.push({ workflowId, tags: [...tags] });
      },
    });
    const binding = createSingleWorkflowTagMutationRestBinding({
      method: 'POST',
      operationName: 'weft.workflows.tags.test',
    });
    await using engine = new Engine({ storage: new MemoryStorage() });

    const response = await handleRequest(
      request('POST', '/v1/workflows/workflow-1/tags', { tags: ['alpha', ' beta '] }),
      engine,
      {
        operationRegistry: createOperationRegistry([operation]),
        restBindings: [binding],
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(calls).toEqual([{ workflowId: 'workflow-1', tags: ['alpha', ' beta '] }]);
  });

  it('maps tag validation failures to 400 with the flat error body', async () => {
    const operation = createSingleWorkflowTagMutationOperation({
      name: 'weft.workflows.tags.test',
      summary: 'Test workflow tag mutation',
      description: 'Test workflow tag mutation, described.',
      destructive: false,
      scope: 'tags:write',
      requiredEngineMethods: [],
      mutateTags: async () => {},
    });
    const binding = createSingleWorkflowTagMutationRestBinding({
      method: 'DELETE',
      operationName: 'weft.workflows.tags.test',
    });
    await using engine = new Engine({ storage: new MemoryStorage() });

    const response = await handleRequest(
      request('DELETE', '/v1/workflows/workflow-1/tags', { tags: [''] }),
      engine,
      {
        operationRegistry: createOperationRegistry([operation]),
        restBindings: [binding],
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Field "tags" must not contain empty tags',
      retryable: false,
    });
  });

  it('maps not-found failures to 404 with the engine message', async () => {
    const operation = createSingleWorkflowTagMutationOperation({
      name: 'weft.workflows.tags.test',
      summary: 'Test workflow tag mutation',
      description: 'Test workflow tag mutation, described.',
      destructive: false,
      scope: 'tags:write',
      requiredEngineMethods: [],
      mutateTags: async () => {
        throw new Error('workflow not found');
      },
    });
    const binding = createSingleWorkflowTagMutationRestBinding({
      method: 'POST',
      operationName: 'weft.workflows.tags.test',
    });
    await using engine = new Engine({ storage: new MemoryStorage() });

    const response = await handleRequest(
      request('POST', '/v1/workflows/missing/tags', { tags: ['alpha'] }),
      engine,
      {
        operationRegistry: createOperationRegistry([operation]),
        restBindings: [binding],
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'workflow not found',
      data: { resource: 'workflow', identifier: 'missing' },
      retryable: false,
    });
  });

  it('masks unexpected engine failures to a 500 generic error body', async () => {
    const operation = createSingleWorkflowTagMutationOperation({
      name: 'weft.workflows.tags.test',
      summary: 'Test workflow tag mutation',
      description: 'Test workflow tag mutation, described.',
      destructive: false,
      scope: 'tags:write',
      requiredEngineMethods: [],
      mutateTags: async () => {
        throw new Error('boom');
      },
    });
    const binding = createSingleWorkflowTagMutationRestBinding({
      method: 'DELETE',
      operationName: 'weft.workflows.tags.test',
    });
    await using engine = new Engine({ storage: new MemoryStorage() });

    const response = await handleRequest(
      request('DELETE', '/v1/workflows/workflow-1/tags', { tags: ['alpha'] }),
      engine,
      {
        operationRegistry: createOperationRegistry([operation]),
        restBindings: [binding],
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error', retryable: false });
  });

  it('does not claim the bulk tag mutation route', async () => {
    const operation = createSingleWorkflowTagMutationOperation({
      name: 'weft.workflows.tags.test',
      summary: 'Test workflow tag mutation',
      description: 'Test workflow tag mutation, described.',
      destructive: false,
      scope: 'tags:write',
      requiredEngineMethods: [],
      mutateTags: async () => {},
    });
    const binding = createSingleWorkflowTagMutationRestBinding({
      method: 'POST',
      operationName: 'weft.workflows.tags.test',
    });
    await using engine = new Engine({ storage: new MemoryStorage() });

    const response = await handleRequest(
      request('PATCH', '/v1/workflows/bulk/tags', { operation: 'add', tags: ['alpha'] }),
      engine,
      {
        operationRegistry: createOperationRegistry([operation]),
        restBindings: [binding],
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found: PATCH /v1/workflows/bulk/tags' });
  });
});

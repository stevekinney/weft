import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
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
      mutateTags: async (_engine, workflowId, tags) => {
        calls.push({ workflowId, tags: [...tags] });
      },
    });
    const binding = createSingleWorkflowTagMutationRestBinding({
      method: 'POST',
      operationName: 'weft.workflows.tags.test',
    });
    const engine = new Engine({ storage: new MemoryStorage() });

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

  it('keeps legacy REST validation failures at 400 with the flat error body', async () => {
    const operation = createSingleWorkflowTagMutationOperation({
      name: 'weft.workflows.tags.test',
      summary: 'Test workflow tag mutation',
      mutateTags: async () => {},
    });
    const binding = createSingleWorkflowTagMutationRestBinding({
      method: 'DELETE',
      operationName: 'weft.workflows.tags.test',
    });
    const engine = new Engine({ storage: new MemoryStorage() });

    const response = await handleRequest(
      request('DELETE', '/v1/workflows/workflow-1/tags', { tags: [''] }),
      engine,
      {
        operationRegistry: createOperationRegistry([operation]),
        restBindings: [binding],
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Field "tags" must not contain empty tags' });
  });
});

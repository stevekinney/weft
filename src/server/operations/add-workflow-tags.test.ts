import { describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { workflow } from '../../core/types/workflow-function.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { addWorkflowTagsOperation, addWorkflowTagsRestBinding } from './add-workflow-tags.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (_ctx, input: unknown) {
  return input;
});

function createEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register(echoWorkflow);
  return engine;
}

const registry = createOperationRegistry([addWorkflowTagsOperation]);
const bindings = [addWorkflowTagsRestBinding];

describe('weft.workflows.tags.add', () => {
  it('adds tags to a workflow and returns the ok response', async () => {
    const engine = createEngine();
    const handle = await engine.start('echo', 'payload', { id: 'add-tags-success' });
    await handle.result();

    const response = await handleRequest(
      request('POST', `/v1/workflows/${handle.id}/tags`, { tags: ['alpha', 'beta'] }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const state = await engine.get(handle.id);
    expect(state?.tags).toEqual(['alpha', 'beta']);
  });

  it('returns 400 when tag validation fails in invoke', async () => {
    const engine = createEngine();
    const handle = await engine.start('echo', 'payload', { id: 'add-tags-invalid' });
    await handle.result();

    const response = await handleRequest(
      request('POST', `/v1/workflows/${handle.id}/tags`, { tags: [''] }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Field "tags" must not contain empty tags' });
  });

  it('returns 404 when the engine reports that the workflow was not found', async () => {
    const engine = createEngine();
    const originalAddTags = engine.addTags.bind(engine);
    engine.addTags = async () => {
      throw new Error('workflow not found');
    };

    try {
      const response = await handleRequest(
        request('POST', '/v1/workflows/missing/tags', { tags: ['alpha'] }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'workflow not found' });
    } finally {
      engine.addTags = originalAddTags;
    }
  });

  it('masks unexpected engine failures to a 500 generic error body', async () => {
    const engine = createEngine();
    const originalAddTags = engine.addTags.bind(engine);
    engine.addTags = async () => {
      throw new Error('boom');
    };

    try {
      const response = await handleRequest(
        request('POST', '/v1/workflows/missing/tags', { tags: ['alpha'] }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
    } finally {
      engine.addTags = originalAddTags;
    }
  });
});

function request(method: string, path: string, body?: unknown): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return new Request(`http://localhost${path}`, init);
}

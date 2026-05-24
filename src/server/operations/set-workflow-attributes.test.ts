import { describe, expect, it } from 'bun:test';

import { decode } from '../../core/codec.ts';
import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import {
  setWorkflowAttributesOperation,
  setWorkflowAttributesRestBinding,
} from './set-workflow-attributes.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

function createEngine(): { engine: Engine; storage: MemoryStorage } {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register(echoWorkflow);
  return { engine, storage };
}

const registry = createOperationRegistry([setWorkflowAttributesOperation]);
const bindings = [setWorkflowAttributesRestBinding];

describe('weft.workflows.attributes.set', () => {
  it('sets attributes on a workflow and returns the ok response', async () => {
    const { engine, storage } = createEngine();

    const response = await handleRequest(
      request('PATCH', '/v1/workflows/workflow-1/attributes', {
        attributes: { priority: 'high', score: 5 },
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const stored = await storage.get(KEYS.attribute('workflow-1'));
    expect(stored).not.toBeNull();
    expect(decode(stored!)).toEqual({ priority: 'high', score: 5 });
  });

  it('defaults to an empty attributes object when the field is missing', async () => {
    const { engine } = createEngine();

    const response = await handleRequest(
      request('PATCH', '/v1/workflows/workflow-2/attributes', {}),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('returns 400 when the request body is invalid JSON', async () => {
    const { engine } = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/workflow-3/attributes', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' });
  });

  it('returns the sanitized 500 body when the engine throws', async () => {
    const { engine } = createEngine();
    const originalSetAttributes = engine.setAttributes.bind(engine);
    engine.setAttributes = async () => {
      throw new Error('secret internal detail');
    };

    try {
      const response = await handleRequest(
        request('PATCH', '/v1/workflows/workflow-4/attributes', {
          attributes: { priority: 'low' },
        }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
    } finally {
      engine.setAttributes = originalSetAttributes;
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

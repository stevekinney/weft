/**
 * `weft.workflows.attributes.get` operation + REST binding — behavior tests.
 */

import { describe, expect, it } from 'bun:test';

import { encode } from '../../core/codec.ts';
import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import {
  getWorkflowAttributesOperation,
  getWorkflowAttributesRestBinding,
} from './get-workflow-attributes.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

function createEngineWithStorage(): { engine: Engine; storage: MemoryStorage } {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register(echoWorkflow);
  return { engine, storage };
}

const registry = createOperationRegistry([getWorkflowAttributesOperation]);
const bindings = [getWorkflowAttributesRestBinding];

describe('weft.workflows.attributes.get', () => {
  it('returns the workflow attributes on the happy path', async () => {
    const { engine, storage } = createEngineWithStorage();
    const attributes = { color: 'blue', count: 42 };
    await storage.put(KEYS.attribute('workflow-attributes-success'), encode(attributes));

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/workflow-attributes-success/attributes', {
        method: 'GET',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual(attributes);
  });

  it('returns 404 with the canonical error body when attributes do not exist', async () => {
    const { engine } = createEngineWithStorage();

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/does-not-exist/attributes', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      error: 'Attributes for workflow "does-not-exist" not found',
    });
  });

  it('masks EngineFailure faults to a 500 with a generic error body', async () => {
    const { engine } = createEngineWithStorage();
    const failingOperation = {
      ...getWorkflowAttributesOperation,
      invoke: async () => {
        const fault: OperationFault = {
          code: 'EngineFailure',
          message: 'secret internal detail',
          data: {},
        };
        throw fault;
      },
    };
    const failingRegistry = createOperationRegistry([failingOperation]);

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/whatever/attributes', { method: 'GET' }),
      engine,
      {
        operationRegistry: failingRegistry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });
});

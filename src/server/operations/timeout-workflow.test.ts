import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { timeoutWorkflowOperation, timeoutWorkflowRestBinding } from './timeout-workflow.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register(echoWorkflow);
  return engine;
}

function request(method: string, path: string): Request {
  return new Request(`http://localhost${path}`, { method });
}

const registry = createOperationRegistry([timeoutWorkflowOperation]);
const bindings = [timeoutWorkflowRestBinding];

describe('weft.workflows.timeout', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('returns 204 on the happy path', async () => {
    engine = createEngine();
    const originalTimeout = engine.timeout.bind(engine);

    try {
      engine.timeout = async () => undefined;

      const response = await handleRequest(
        request('POST', '/v1/workflows/workflow-123/timeout'),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(204);
      expect(await response.text()).toBe('');
    } finally {
      engine.timeout = originalTimeout;
    }
  });

  it('returns 404 when the workflow is not found', async () => {
    engine = createEngine();
    const originalTimeout = engine.timeout.bind(engine);

    try {
      engine.timeout = async () => {
        throw new Error('Workflow "missing-workflow" not found');
      };

      const response = await handleRequest(
        request('POST', '/v1/workflows/missing-workflow/timeout'),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: 'Workflow "missing-workflow" not found',
        data: { resource: 'workflow', identifier: 'missing-workflow' },
      });
    } finally {
      engine.timeout = originalTimeout;
    }
  });

  it('masks unexpected engine failures to a generic 500 (no raw message leak)', async () => {
    engine = createEngine();
    const originalTimeout = engine.timeout.bind(engine);

    try {
      engine.timeout = async () => {
        throw new Error('timeout exploded');
      };

      const response = await handleRequest(
        request('POST', '/v1/workflows/workflow-123/timeout'),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
      expect(response.headers.get('Content-Type')).toContain('application/json');
    } finally {
      engine.timeout = originalTimeout;
    }
  });
});

import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { UpdateTimeoutError, WorkflowTerminalError } from '../../core/updates.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { invalidJsonRequest, jsonRequest } from './operation-test-helpers.test-support.ts';
import { updateWorkflowOperation, updateWorkflowRestBinding } from './update-workflow.ts';

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register('echo', async function* (_ctx: WorkflowContext, input: unknown) {
    return input;
  });
  return engine;
}

const registry = createOperationRegistry([updateWorkflowOperation]);
const bindings = [updateWorkflowRestBinding];

describe('weft.workflows.update', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('returns 200 with the update result on the happy path', async () => {
    engine = createEngine();
    const originalSubmit = engine.submitCoordinatedUpdate.bind(engine);

    try {
      engine.submitCoordinatedUpdate = async (workflowId, updateName, payload, options) => {
        expect(workflowId).toBe('workflow-123');
        expect(updateName).toBe('rename');
        expect(payload).toEqual({ name: 'Alice' });
        expect(options).toEqual({ timeout: 2_000, idempotencyKey: 'update-1' });
        return {
          updateId: 'update-123',
          result: { ok: true },
        } as Awaited<ReturnType<Engine['submitCoordinatedUpdate']>>;
      };

      const response = await handleRequest(
        jsonRequest('POST', '/v1/workflows/workflow-123/update/rename', {
          payload: { name: 'Alice' },
          timeout: 2_000,
          idempotencyKey: 'update-1',
        }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        updateId: 'update-123',
        result: { ok: true },
      });
    } finally {
      engine.submitCoordinatedUpdate = originalSubmit;
    }
  });

  it('silently ignores non-number timeout and non-string idempotencyKey (legacy parity)', async () => {
    // Legacy `handleUpdateWorkflow` only honored `timeout` if `typeof === 'number'`
    // and `idempotencyKey` if `typeof === 'string'`; anything else was ignored
    // and defaults applied. Pin this so JSON-RPC clients hit the same contract
    // as REST (instead of being rejected by Zod for the wrong type).
    engine = createEngine();
    const originalSubmit = engine.submitCoordinatedUpdate.bind(engine);

    try {
      engine.submitCoordinatedUpdate = async (_workflowId, _updateName, _payload, options) => {
        expect(options).toEqual({ timeout: 30_000 });
        return {
          updateId: 'update-mistyped',
          result: null,
        } as Awaited<ReturnType<Engine['submitCoordinatedUpdate']>>;
      };

      const response = await handleRequest(
        jsonRequest('POST', '/v1/workflows/workflow-123/update/rename', {
          timeout: '2000',
          idempotencyKey: 12345,
        }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ updateId: 'update-mistyped', result: null });
    } finally {
      engine.submitCoordinatedUpdate = originalSubmit;
    }
  });

  it('silently ignores invalid JSON bodies and uses the default timeout', async () => {
    engine = createEngine();
    const originalSubmit = engine.submitCoordinatedUpdate.bind(engine);

    try {
      engine.submitCoordinatedUpdate = async (_workflowId, _updateName, payload, options) => {
        expect(payload).toBeUndefined();
        expect(options).toEqual({ timeout: 30_000 });
        return {
          updateId: 'update-invalid-json',
          result: null,
        } as Awaited<ReturnType<Engine['submitCoordinatedUpdate']>>;
      };

      const response = await handleRequest(
        invalidJsonRequest('POST', '/v1/workflows/workflow-123/update/rename', '{'),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ updateId: 'update-invalid-json', result: null });
    } finally {
      engine.submitCoordinatedUpdate = originalSubmit;
    }
  });

  it('returns 422 when the coordinated update result contains an error string', async () => {
    engine = createEngine();
    const originalSubmit = engine.submitCoordinatedUpdate.bind(engine);

    try {
      engine.submitCoordinatedUpdate = async () =>
        ({
          updateId: 'update-error',
          error: 'workflow rejected update',
        }) as Awaited<ReturnType<Engine['submitCoordinatedUpdate']>>;

      const response = await handleRequest(
        jsonRequest('POST', '/v1/workflows/workflow-123/update/rename', { payload: {} }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: 'workflow rejected update' });
    } finally {
      engine.submitCoordinatedUpdate = originalSubmit;
    }
  });

  it('returns 422 when the workflow is already terminal', async () => {
    engine = createEngine();
    const originalSubmit = engine.submitCoordinatedUpdate.bind(engine);

    try {
      engine.submitCoordinatedUpdate = async () => {
        throw new WorkflowTerminalError('workflow-123', 'completed');
      };

      const response = await handleRequest(
        jsonRequest('POST', '/v1/workflows/workflow-123/update/rename', { payload: {} }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error:
          'Cannot send update to workflow "workflow-123": workflow is in terminal state "completed"',
      });
    } finally {
      engine.submitCoordinatedUpdate = originalSubmit;
    }
  });

  it('returns 408 when the coordinated update times out', async () => {
    engine = createEngine();
    const originalSubmit = engine.submitCoordinatedUpdate.bind(engine);

    try {
      engine.submitCoordinatedUpdate = async () => {
        throw new UpdateTimeoutError('update-123', 2_000);
      };

      const response = await handleRequest(
        jsonRequest('POST', '/v1/workflows/workflow-123/update/rename', { payload: {} }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(408);
      expect((await response.json()) as { error: string }).toEqual(
        expect.objectContaining({
          error: expect.stringContaining('timed out'),
        }),
      );
    } finally {
      engine.submitCoordinatedUpdate = originalSubmit;
    }
  });

  it('masks unexpected engine failures to a generic 500 (no raw message leak)', async () => {
    engine = createEngine();
    const originalSubmit = engine.submitCoordinatedUpdate.bind(engine);

    try {
      engine.submitCoordinatedUpdate = async () => {
        throw new Error('update exploded');
      };

      const response = await handleRequest(
        jsonRequest('POST', '/v1/workflows/workflow-123/update/rename', { payload: {} }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
      expect(response.headers.get('Content-Type')).toContain('application/json');
    } finally {
      engine.submitCoordinatedUpdate = originalSubmit;
    }
  });
});

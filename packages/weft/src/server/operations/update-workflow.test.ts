import { afterEach, describe, expect, it } from 'bun:test';

import { principalFromApiKey } from "../../embedded/backchannel/src/index.ts";
import { createOperationRegistry, dispatchJsonRpc } from "../../embedded/backchannel/src/internals.ts";
import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { Engine } from '../../core/engine.ts';
import { type WorkflowContext, workflow } from '../../core/types.ts';
import {
  UpdateTimeoutError,
  UpdateValidationError,
  WorkflowTerminalError,
} from '../../core/updates.ts';
import { handleRequestAsLocalUser as handleRequest } from '../local-user-request.test-support.ts';
import { invalidJsonRequest, jsonRequest } from './operation-test-helpers.test-support.ts';
import { updateWorkflowOperation, updateWorkflowRestBinding } from './update-workflow.ts';

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
        };
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

  it('silently ignores non-number timeout and non-string idempotencyKey', async () => {
    // `timeout` is only honored if `typeof === 'number'`
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
        };
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
        };
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
      engine.submitCoordinatedUpdate = async () => ({
        updateId: 'update-error',
        error: 'workflow rejected update',
      });

      const response = await handleRequest(
        jsonRequest('POST', '/v1/workflows/workflow-123/update/rename', { payload: {} }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: 'workflow rejected update',
        retryable: false,
      });
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
        retryable: false,
      });
    } finally {
      engine.submitCoordinatedUpdate = originalSubmit;
    }
  });

  it('returns the validation diagnostic when an update validator rejects the payload', async () => {
    engine = createEngine();
    const originalSubmit = engine.submitCoordinatedUpdate.bind(engine);

    try {
      engine.submitCoordinatedUpdate = async () => {
        throw new UpdateValidationError('rename', [{ message: 'name must be a string' }]);
      };

      const response = await handleRequest(
        jsonRequest('POST', '/v1/workflows/workflow-123/update/rename', { payload: {} }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: 'Update "rename" rejected by validator: name must be a string',
        retryable: false,
      });
    } finally {
      engine.submitCoordinatedUpdate = originalSubmit;
    }
  });

  it('returns 504 when the coordinated update times out', async () => {
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

      expect(response.status).toBe(504);
      expect((await response.json()) as { error: string }).toEqual(
        expect.objectContaining({
          error: expect.stringContaining('timed out'),
        }),
      );
    } finally {
      engine.submitCoordinatedUpdate = originalSubmit;
    }
  });

  it('carries the update id in the REST 504 body so the caller can read the answer later', async () => {
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

      expect(response.status).toBe(504);
      expect(await response.json()).toEqual({
        error: 'Update update-123 timed out after 2000ms',
        data: { updateId: 'update-123' },
        retryable: true,
      });
    } finally {
      engine.submitCoordinatedUpdate = originalSubmit;
    }
  });

  it('carries the update id in the JSON-RPC timeout error data', async () => {
    engine = createEngine();
    const originalSubmit = engine.submitCoordinatedUpdate.bind(engine);

    try {
      engine.submitCoordinatedUpdate = async () => {
        throw new UpdateTimeoutError('update-123', 2_000);
      };

      const outcome = await dispatchJsonRpc(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'weft.workflows.update',
          params: { workflowId: 'workflow-123', updateName: 'rename', timeout: 2_000 },
          id: 1,
        }),
        {
          principal: principalFromApiKey({ subject: 'svc', scopes: ['updates:write'] }),
          host: engine,
          transport: 'jsonRpcHttp',
          registry,
        },
      );

      if (outcome.kind !== 'single' || !('error' in outcome.response)) {
        throw new Error('expected a JSON-RPC error response');
      }
      expect(outcome.response.error.code).toBe(-32023);
      expect(outcome.response.error.data).toEqual(
        expect.objectContaining({ updateId: 'update-123', weftCode: 'Timeout', httpStatus: 504 }),
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
      expect(await response.json()).toEqual({ error: 'Internal server error', retryable: false });
      expect(response.headers.get('Content-Type')).toContain('application/json');
    } finally {
      engine.submitCoordinatedUpdate = originalSubmit;
    }
  });
});

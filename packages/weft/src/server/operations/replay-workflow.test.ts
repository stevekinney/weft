import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import { principalFromJwtClaims } from '../principal.ts';
import { replayWorkflowOperation, replayWorkflowRestBinding } from './replay-workflow.ts';

async function firstStep() {
  return { phase: 'first' as const };
}

async function secondStep() {
  return { phase: 'second' as const };
}

async function thirdStep() {
  return { phase: 'third' as const };
}

function createReplayEngine(): Engine {
  const engine = new Engine({
    storage: new MemoryStorage(),
    checkpointHistory: 10,
  });

  engine.register(
    workflow({ name: 'three-steps', version: '1.0.0' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.run(firstStep);
      yield* ctx.run(secondStep);
      return yield* ctx.run(thirdStep);
    }),
  );

  return engine;
}

async function createReplayWorkflow(
  engine: Engine,
  workflowId = 'wf-replay-auth',
): Promise<string> {
  const handle = await engine.start('three-steps', null, { id: workflowId });
  await handle.result();
  return handle.id;
}

describe('weft.workflows.replay REST shaping', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
  });

  it('returns msgpack when the Accept header requests it', async () => {
    engine = createReplayEngine();
    const workflowId = await createReplayWorkflow(engine, 'wf-replay-msgpack');

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${workflowId}/replay/2`, {
        method: 'GET',
        headers: { Accept: 'application/msgpack' },
      }),
      engine,
      {
        operationRegistry: createOperationRegistry([replayWorkflowOperation]),
        restBindings: [replayWorkflowRestBinding],
        authContext: {
          method: 'jwt',
          principal: principalFromJwtClaims({ sub: 'reader', scope: 'workflows:read' }),
        },
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/msgpack');
  });

  it("REST passes the run's own pinned revision through unchanged (WFT-21)", async () => {
    engine = createReplayEngine();
    const workflowId = await createReplayWorkflow(engine, 'wf-replay-revision-rest');
    const expectedRevisionSummary = await engine.get(workflowId);
    const expectedRevision = expectedRevisionSummary?.revision;
    expect(expectedRevision).toBeDefined();

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${workflowId}/replay/2`, {
        method: 'GET',
      }),
      engine,
      {
        operationRegistry: createOperationRegistry([replayWorkflowOperation]),
        restBindings: [replayWorkflowRestBinding],
        authContext: {
          method: 'jwt',
          principal: principalFromJwtClaims({ sub: 'reader', scope: 'workflows:read' }),
        },
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ revision: expectedRevision });
  });

  it('returns 400 for an invalid replay step', async () => {
    engine = createReplayEngine();
    const workflowId = await createReplayWorkflow(engine, 'wf-replay-invalid-step');

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${workflowId}/replay/not-a-number`, {
        method: 'GET',
      }),
      engine,
      {
        operationRegistry: createOperationRegistry([replayWorkflowOperation]),
        restBindings: [replayWorkflowRestBinding],
        authContext: {
          method: 'jwt',
          principal: principalFromJwtClaims({ sub: 'reader', scope: 'workflows:read' }),
        },
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid step: not-a-number' });
  });

  it('returns 404 when the replay step does not exist', async () => {
    engine = createReplayEngine();
    const workflowId = await createReplayWorkflow(engine, 'wf-replay-missing-step');

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${workflowId}/replay/99`, { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([replayWorkflowOperation]),
        restBindings: [replayWorkflowRestBinding],
        authContext: {
          method: 'jwt',
          principal: principalFromJwtClaims({ sub: 'reader', scope: 'workflows:read' }),
        },
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: `Replay not found at step 99 for workflow ${workflowId}`,
      data: { resource: 'replay', identifier: `${workflowId}@99` },
    });
  });

  it('maps EngineFailure faults to 500 with a sanitized body', async () => {
    engine = createReplayEngine();

    const failingOperation = defineOperation({
      ...replayWorkflowOperation,
      invoke: async () => {
        throw {
          code: 'EngineFailure',
          message: 'secret internal detail',
          data: {},
        } satisfies OperationFault;
      },
    });

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/wf-replay-engine-failure/replay/2', {
        method: 'GET',
      }),
      engine,
      {
        operationRegistry: createOperationRegistry([failingOperation]),
        restBindings: [replayWorkflowRestBinding],
        authContext: {
          method: 'jwt',
          principal: principalFromJwtClaims({ sub: 'reader', scope: 'workflows:read' }),
        },
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });

  it('uses the fallback HTTP mapper for non-special-cased faults', async () => {
    engine = createReplayEngine();

    const conflictOperation = defineOperation({
      ...replayWorkflowOperation,
      invoke: async () => {
        throw {
          code: 'Conflict',
          message: 'replay conflict',
          data: { reason: 'replay conflict' },
        } satisfies OperationFault;
      },
    });

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/wf-replay-conflict/replay/2', {
        method: 'GET',
      }),
      engine,
      {
        operationRegistry: createOperationRegistry([conflictOperation]),
        restBindings: [replayWorkflowRestBinding],
        authContext: {
          method: 'jwt',
          principal: principalFromJwtClaims({ sub: 'reader', scope: 'workflows:read' }),
        },
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'replay conflict' });
  });
});

import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { ForkSourceReplacedError } from '../../core/engine/fork-source-replaced-error.ts';
import { WorkflowRevisionUnavailableError } from '../../core/engine/revision-errors.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { VersionMismatchError } from '../../core/versioning.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import { anonymousPrincipal } from '../principal.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
import { forkWorkflowOperation, forkWorkflowRestBinding } from './fork-workflow.ts';
import { invalidJsonRequest, jsonRequest } from './operation-test-helpers.test-support.ts';

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

const registry = createOperationRegistry([forkWorkflowOperation]);
const bindings = [forkWorkflowRestBinding];

describe('weft.workflows.fork', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('returns 201 with the forked workflow id on the happy path', async () => {
    engine = createEngine();
    const originalFork = engine.fork.bind(engine);

    try {
      engine.fork = async (workflowId, options) => {
        expect(workflowId).toBe('workflow-123');
        expect(options).toEqual({ fromStep: 3 });
        return { id: 'forked-workflow' } as Awaited<ReturnType<Engine['fork']>>;
      };

      const response = await handleRequest(
        jsonRequest('POST', '/v1/workflows/workflow-123/fork', { fromStep: 3 }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ id: 'forked-workflow' });
    } finally {
      engine.fork = originalFork;
    }
  });

  it('REST threads the revision body field to engine.fork() (WFT-21)', async () => {
    engine = createEngine();
    const originalFork = engine.fork.bind(engine);

    try {
      engine.fork = async (workflowId, options) => {
        expect(workflowId).toBe('workflow-123');
        expect(options).toEqual({ revision: 'a-specific-revision' });
        return { id: 'forked-workflow' } as Awaited<ReturnType<Engine['fork']>>;
      };

      const response = await handleRequest(
        jsonRequest('POST', '/v1/workflows/workflow-123/fork', { revision: 'a-specific-revision' }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ id: 'forked-workflow' });
    } finally {
      engine.fork = originalFork;
    }
  });

  it('JSON-RPC threads the revision field to engine.fork() the same way REST does (WFT-21)', async () => {
    engine = createEngine();
    const originalFork = engine.fork.bind(engine);
    const liveRegistry = createLiveOperationRegistry();

    try {
      engine.fork = async (workflowId, options) => {
        expect(workflowId).toBe('workflow-123');
        expect(options).toEqual({ fromStep: 2, revision: 'a-specific-revision' });
        return { id: 'forked-workflow' } as Awaited<ReturnType<Engine['fork']>>;
      };

      const result = await executeOperation(
        'weft.workflows.fork',
        { workflowId: 'workflow-123', fromStep: 2, revision: 'a-specific-revision' },
        {
          principal: anonymousPrincipal(),
          engine,
          transport: 'jsonRpcStdio',
          registry: liveRegistry,
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected success');
      expect(result.value).toEqual({ id: 'forked-workflow' });
    } finally {
      engine.fork = originalFork;
    }
  });

  it('maps a WorkflowRevisionUnavailableError from engine.fork() to a Conflict (409) fault over REST, not the generic 500 EngineFailure (WFT-21)', async () => {
    engine = createEngine();
    const originalFork = engine.fork.bind(engine);

    try {
      engine.fork = async () => {
        throw new WorkflowRevisionUnavailableError(
          'echo',
          'unresolvable-revision',
          'not-registered',
        );
      };

      const response = await handleRequest(
        jsonRequest('POST', '/v1/workflows/workflow-123/fork', {
          revision: 'unresolvable-revision',
        }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(409);
      const body = (await response.json()) as { error?: string };
      expect(body.error).toContain('unresolvable-revision');
    } finally {
      engine.fork = originalFork;
    }
  });

  it('maps a WorkflowRevisionUnavailableError from engine.fork() to a Conflict fault with data.reason over JSON-RPC (full fidelity, WFT-21)', async () => {
    engine = createEngine();
    const originalFork = engine.fork.bind(engine);
    const liveRegistry = createLiveOperationRegistry();

    try {
      engine.fork = async () => {
        throw new WorkflowRevisionUnavailableError(
          'echo',
          'unresolvable-revision',
          'not-registered',
        );
      };

      const result = await executeOperation(
        'weft.workflows.fork',
        { workflowId: 'workflow-123', revision: 'unresolvable-revision' },
        {
          principal: anonymousPrincipal(),
          engine,
          transport: 'jsonRpcStdio',
          registry: liveRegistry,
        },
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected a fault');
      expect(result.fault.code).toBe('Conflict');
      expect(result.fault.data).toEqual({ reason: 'not-registered' });
    } finally {
      engine.fork = originalFork;
    }
  });

  it('maps a VersionMismatchError from engine.fork() (an explicit-revision fork onto a semver-incompatible registered revision) to a Conflict (409) fault over REST, not the generic 500 EngineFailure (WFT-21, Codex review round 11, P2)', async () => {
    engine = createEngine();
    const originalFork = engine.fork.bind(engine);

    try {
      engine.fork = async () => {
        throw new VersionMismatchError('workflow-123', 'echo', '1.0.0', '2.0.0');
      };

      const response = await handleRequest(
        jsonRequest('POST', '/v1/workflows/workflow-123/fork', {
          revision: 'incompatible-revision',
        }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(409);
    } finally {
      engine.fork = originalFork;
    }
  });

  it('maps a VersionMismatchError from engine.fork() to a Conflict fault with data.weftCode over JSON-RPC (full fidelity, WFT-21, Codex review round 11, P2)', async () => {
    engine = createEngine();
    const originalFork = engine.fork.bind(engine);
    const liveRegistry = createLiveOperationRegistry();

    try {
      engine.fork = async () => {
        throw new VersionMismatchError('workflow-123', 'echo', '1.0.0', '2.0.0');
      };

      const result = await executeOperation(
        'weft.workflows.fork',
        { workflowId: 'workflow-123', revision: 'incompatible-revision' },
        {
          principal: anonymousPrincipal(),
          engine,
          transport: 'jsonRpcStdio',
          registry: liveRegistry,
        },
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected a fault');
      expect(result.fault.code).toBe('Conflict');
      expect(result.fault.data).toMatchObject({ weftCode: 'VersionMismatchError' });
    } finally {
      engine.fork = originalFork;
    }
  });

  it('maps a ForkSourceReplacedError from engine.fork() to a Conflict (409) fault over REST, not the generic 500 EngineFailure (WFT-21, Codex review, item 6)', async () => {
    engine = createEngine();
    const originalFork = engine.fork.bind(engine);

    try {
      engine.fork = async () => {
        throw new ForkSourceReplacedError('workflow-123');
      };

      const response = await handleRequest(
        jsonRequest('POST', '/v1/workflows/workflow-123/fork', {}),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(409);
    } finally {
      engine.fork = originalFork;
    }
  });

  it('maps a ForkSourceReplacedError from engine.fork() to a Conflict fault with data.weftCode over JSON-RPC (full fidelity, WFT-21, Codex review, item 6)', async () => {
    engine = createEngine();
    const originalFork = engine.fork.bind(engine);
    const liveRegistry = createLiveOperationRegistry();

    try {
      engine.fork = async () => {
        throw new ForkSourceReplacedError('workflow-123');
      };

      const result = await executeOperation(
        'weft.workflows.fork',
        { workflowId: 'workflow-123' },
        {
          principal: anonymousPrincipal(),
          engine,
          transport: 'jsonRpcStdio',
          registry: liveRegistry,
        },
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected a fault');
      expect(result.fault.code).toBe('Conflict');
      expect(result.fault.data).toMatchObject({ weftCode: 'ForkSourceReplacedError' });
    } finally {
      engine.fork = originalFork;
    }
  });

  it('returns 400 when the request body is invalid JSON', async () => {
    engine = createEngine();

    const response = await handleRequest(
      invalidJsonRequest('POST', '/v1/workflows/workflow-123/fork', '{'),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' });
  });

  it('returns 400 when the request body is not a JSON object', async () => {
    engine = createEngine();

    const response = await handleRequest(
      jsonRequest('POST', '/v1/workflows/workflow-123/fork', ['not-an-object']),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Request body must be a JSON object' });
  });

  it('returns 400 when fromStep is not a non-negative safe integer', async () => {
    engine = createEngine();

    const response = await handleRequest(
      jsonRequest('POST', '/v1/workflows/workflow-123/fork', { fromStep: -1 }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Field "fromStep" must be a non-negative safe integer',
    });
  });

  it('returns 400 when the engine reports an invalid checkpoint step', async () => {
    engine = createEngine();
    const originalFork = engine.fork.bind(engine);

    try {
      engine.fork = async () => {
        throw new Error('Checkpoint not found at step 7');
      };

      const response = await handleRequest(
        jsonRequest('POST', '/v1/workflows/workflow-123/fork'),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Checkpoint not found at step 7' });
    } finally {
      engine.fork = originalFork;
    }
  });

  it('returns 404 when the current checkpoint is missing', async () => {
    engine = createEngine();
    const originalFork = engine.fork.bind(engine);

    try {
      engine.fork = async () => {
        throw new Error('Checkpoint not found for workflow "workflow-123"');
      };

      const response = await handleRequest(
        jsonRequest('POST', '/v1/workflows/workflow-123/fork'),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: 'Checkpoint not found for workflow "workflow-123"',
        data: { resource: 'checkpoint' },
      });
    } finally {
      engine.fork = originalFork;
    }
  });

  it('returns 404 when the source workflow does not exist', async () => {
    engine = createEngine();

    const response = await handleRequest(
      jsonRequest('POST', '/v1/workflows/missing-workflow/fork'),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'Workflow "missing-workflow" not found',
      data: { resource: 'workflow' },
    });
  });

  it('masks unexpected engine failures to a generic 500 (no raw message leak)', async () => {
    engine = createEngine();
    const originalFork = engine.fork.bind(engine);

    try {
      engine.fork = async () => {
        throw new Error('unexpected fork failure');
      };

      const response = await handleRequest(
        jsonRequest('POST', '/v1/workflows/workflow-123/fork'),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
      expect(response.headers.get('Content-Type')).toContain('application/json');
    } finally {
      engine.fork = originalFork;
    }
  });
});

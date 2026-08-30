import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { resumeWorkflowOperation, resumeWorkflowRestBinding } from './resume-workflow.ts';

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

const registry = createOperationRegistry([resumeWorkflowOperation]);
const bindings = [resumeWorkflowRestBinding];

describe('weft.workflows.resume', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('returns 200 with the resumed workflow id on the happy path', async () => {
    engine = createEngine();
    const originalResume = engine.resume.bind(engine);

    try {
      engine.resume = async () =>
        ({ id: 'resumed-workflow' }) as Awaited<ReturnType<Engine['resume']>>;

      const response = await handleRequest(
        request('POST', '/v1/workflows/workflow-123/resume'),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: 'resumed-workflow' });
    } finally {
      engine.resume = originalResume;
    }
  });

  it('returns 404 when the workflow is not found', async () => {
    engine = createEngine();

    const response = await handleRequest(
      request('POST', '/v1/workflows/missing-workflow/resume'),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'Workflow "missing-workflow" not found in storage',
      data: { resource: 'workflow', identifier: 'missing-workflow' },
    });
  });

  it('returns 409 when the workflow cannot be resumed', async () => {
    engine = createEngine();
    const handle = await engine.start('echo', 'done', { id: 'completed-workflow' });
    await handle.result();

    const response = await handleRequest(
      request('POST', `/v1/workflows/${handle.id}/resume`),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(409);
    expect((await response.json()) as { error: string }).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('Cannot resume'),
      }),
    );
  });

  it('masks unexpected engine failures to a generic 500 (no raw message leak)', async () => {
    engine = createEngine();
    const originalResume = engine.resume.bind(engine);

    try {
      engine.resume = async () => {
        throw new Error('resume exploded');
      };

      const response = await handleRequest(
        request('POST', '/v1/workflows/workflow-123/resume'),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
      expect(response.headers.get('Content-Type')).toContain('application/json');
    } finally {
      engine.resume = originalResume;
    }
  });
});

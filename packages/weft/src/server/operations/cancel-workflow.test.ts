import { describe, expect, it } from 'bun:test';

import { createOperationRegistry } from "../../embedded/backchannel/src/internals.ts";
import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { Engine } from '../../core/engine.ts';
import { type WorkflowContext, workflow } from '../../core/types.ts';
import { statusOf } from '../../testing/run-observation.test-support.ts';
import { handleRequestAsLocalUser as handleRequest } from '../local-user-request.test-support.ts';
import { cancelWorkflowOperation, cancelWorkflowRestBinding } from './cancel-workflow.ts';
import { waitForWorkflowStatus } from './operation-test-helpers.test-support.ts';

const holdWorkflow = workflow({ name: 'hold' }).execute(async function* (ctx: WorkflowContext) {
  return yield* ctx.waitForSignal<string>('release');
});

function createEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register(holdWorkflow);
  return engine;
}

const registry = createOperationRegistry([cancelWorkflowOperation]);
const bindings = [cancelWorkflowRestBinding];

describe('weft.workflows.cancel', () => {
  it('cancels a workflow and returns the durable cancellation outcome', async () => {
    await using engine = createEngine();
    const handle = await engine.start('hold', null, { id: 'cancel-success' });
    await waitForWorkflowStatus(engine, handle.id, 'running');

    const resultPromise = handle.result().catch(() => undefined);
    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}`, { method: 'DELETE' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      workflowId: handle.id,
      status: 'cancel-requested',
    });
    await resultPromise;
    await waitForWorkflowStatus(engine, handle.id, 'cancelled');
  });

  it('DELETE with dry_run=true reports the status and cancellable, and cancels nothing', async () => {
    await using engine = createEngine();
    const handle = await engine.start('hold', null, { id: 'cancel-dry-run' });
    await waitForWorkflowStatus(engine, handle.id, 'running');

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}?dry_run=true`, { method: 'DELETE' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      dryRun: true,
      workflowId: handle.id,
      status: 'running',
      cancellable: true,
    });
    expect(await statusOf(engine, handle.id)).toBe('running');
  });

  it('DELETE with an unrecognised dry_run is a 400 and cancels nothing, never a real cancel', async () => {
    await using engine = createEngine();
    const handle = await engine.start('hold', null, { id: 'cancel-bad-dry-run' });
    await waitForWorkflowStatus(engine, handle.id, 'running');

    for (const value of ['1', 'TRUE', 'yes', '']) {
      const response = await handleRequest(
        new Request(`http://localhost/v1/workflows/${handle.id}?dry_run=${value}`, {
          method: 'DELETE',
        }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status, `dry_run=${value}`).toBe(400);
      expect(await statusOf(engine, handle.id)).toBe('running');
    }
  });

  it('DELETE with dry_run=false is a real cancel', async () => {
    await using engine = createEngine();
    const handle = await engine.start('hold', null, { id: 'cancel-dry-run-false' });
    await waitForWorkflowStatus(engine, handle.id, 'running');
    const resultPromise = handle.result().catch(() => undefined);

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}?dry_run=false`, { method: 'DELETE' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workflowId: handle.id, status: 'cancel-requested' });
    await resultPromise;
    await waitForWorkflowStatus(engine, handle.id, 'cancelled');
  });

  it('a dry run of a finished workflow reports it cannot be cancelled', async () => {
    await using engine = createEngine();
    const completed = workflow({ name: 'completed-dry' }).execute(async function* () {
      return 'done';
    });
    engine.register(completed);
    const handle = await engine.start('completed-dry', null, { id: 'cancel-dry-completed' });
    await handle.result();

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}?dry_run=true`, { method: 'DELETE' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(await response.json()).toEqual({
      dryRun: true,
      workflowId: handle.id,
      status: 'completed',
      cancellable: false,
    });
  });

  it('a dry run of an unknown id is a 404', async () => {
    await using engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/never-started?dry_run=true', {
        method: 'DELETE',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(404);
  });

  it('returns the exact terminal status when cancellation loses the terminal race', async () => {
    await using engine = createEngine();
    const completed = workflow({ name: 'completed' }).execute(async function* () {
      return 'done';
    });
    engine.register(completed);
    const handle = await engine.start('completed', null, { id: 'cancel-completed' });
    await handle.result();

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}`, { method: 'DELETE' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      workflowId: handle.id,
      status: 'already-terminal',
      terminalStatus: 'completed',
    });
  });

  it('returns 404 when the engine reports that the workflow was not found', async () => {
    await using engine = createEngine();
    const originalCancel = engine.cancel.bind(engine);
    engine.cancel = async () => {
      throw new Error('workflow not found');
    };

    try {
      const response = await handleRequest(
        new Request('http://localhost/v1/workflows/missing', { method: 'DELETE' }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: 'workflow not found',
        data: { resource: 'workflow', identifier: 'missing' },
        retryable: false,
      });
    } finally {
      engine.cancel = originalCancel;
    }
  });

  it('returns 404 for an absent workflow without invoking a mutation', async () => {
    await using engine = createEngine();
    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/missing-live', { method: 'DELETE' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(404);
  });

  it('returns a conflict when the captured workflow generation was replaced', async () => {
    await using engine = createEngine();
    const originalCancel = engine.cancel.bind(engine);
    engine.cancel = async () => {
      throw new Error('Workflow "wf-1" was replaced before it was cancelled.');
    };

    try {
      const response = await handleRequest(
        new Request('http://localhost/v1/workflows/wf-1', { method: 'DELETE' }),
        engine,
        { operationRegistry: registry, restBindings: bindings },
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: 'Workflow "wf-1" was replaced before it was cancelled.',
        data: { reason: 'workflow-replaced' },
        retryable: false,
      });
    } finally {
      engine.cancel = originalCancel;
    }
  });

  it('masks unexpected engine failures to a 500 generic error body', async () => {
    await using engine = createEngine();
    const originalCancel = engine.cancel.bind(engine);
    engine.cancel = async () => {
      throw new Error('cancel failed internally');
    };

    try {
      const response = await handleRequest(
        new Request('http://localhost/v1/workflows/wf-1', { method: 'DELETE' }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error', retryable: false });
    } finally {
      engine.cancel = originalCancel;
    }
  });
});

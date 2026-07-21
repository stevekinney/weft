import { describe, expect, it } from 'bun:test';
import { sleepForTesting } from '../../testing/fake-timers.test-support.ts';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { signalWorkflowOperation, signalWorkflowRestBinding } from './signal-workflow.ts';

const holdWorkflow = workflow({ name: 'hold' }).execute(async function* (ctx: WorkflowContext) {
  return yield* ctx.waitForSignal('release');
});

const twoSignalWorkflow = workflow({ name: 'two-signal' }).execute(async function* (
  ctx: WorkflowContext,
) {
  const first = yield* ctx.waitForSignal('release');
  const second = yield* ctx.waitForSignal('release');
  return [first, second];
});

function createEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register(holdWorkflow);
  engine.register(twoSignalWorkflow);
  return engine;
}

async function waitForStatus(
  engine: Engine,
  workflowId: string,
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out',
  timeoutMilliseconds = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const state = await engine.get(workflowId);
    if (state?.status === status) {
      return;
    }
    await sleepForTesting(5);
  }

  throw new Error(`Workflow ${workflowId} did not reach ${status} within ${timeoutMilliseconds}ms`);
}

const registry = createOperationRegistry([signalWorkflowOperation]);
const bindings = [signalWorkflowRestBinding];

describe('weft.workflows.signal', () => {
  it('signals a workflow and returns the ok response', async () => {
    const engine = createEngine();
    const handle = await engine.start('hold', null, { id: 'signal-success' });
    await waitForStatus(engine, handle.id, 'running');

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}/signal/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: { approved: true } }),
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await handle.result()).toEqual({ approved: true });
  });

  it('deduplicates REST signalId retries and returns the accepted response', async () => {
    const engine = createEngine();
    const handle = await engine.start('two-signal', null, { id: 'signal-idempotent-rest' });
    await waitForStatus(engine, handle.id, 'running');

    const first = await handleRequest(
      request('POST', `/v1/workflows/${handle.id}/signal/release`, {
        payload: 'first',
        signalId: 'release-1',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );
    const duplicate = await handleRequest(
      request('POST', `/v1/workflows/${handle.id}/signal/release`, {
        payload: 'duplicate',
        signalId: 'release-1',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );
    const second = await handleRequest(
      request('POST', `/v1/workflows/${handle.id}/signal/release`, {
        payload: 'second',
        signalId: 'release-2',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await duplicate.json()).toEqual({ ok: true });
    expect(await handle.result()).toEqual(['first', 'second']);
  });

  it('rejects malformed REST signalId values instead of falling back to non-idempotent delivery', async () => {
    const engine = createEngine();
    const handle = await engine.start('hold', null, { id: 'signal-invalid-signal-id' });
    await waitForStatus(engine, handle.id, 'running');

    const response = await handleRequest(
      request('POST', `/v1/workflows/${handle.id}/signal/release`, {
        payload: 'first',
        signalId: 123,
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(400);
    expect(await engine.get(handle.id)).toMatchObject({ status: 'running' });
  });

  it('rejects oversize REST signalId values before delivery', async () => {
    const engine = createEngine();
    const handle = await engine.start('hold', null, { id: 'signal-oversize-signal-id' });
    await waitForStatus(engine, handle.id, 'running');

    const response = await handleRequest(
      request('POST', `/v1/workflows/${handle.id}/signal/release`, {
        payload: 'first',
        signalId: 'x'.repeat(129),
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(400);
    expect(await engine.get(handle.id)).toMatchObject({ status: 'running' });
  });

  it('tolerates an invalid or missing JSON body and treats the payload as optional', async () => {
    const engine = createEngine();
    const handle = await engine.start('hold', null, { id: 'signal-invalid-json' });
    await waitForStatus(engine, handle.id, 'running');

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}/signal/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await handle.result()).toBeUndefined();
  });

  it('returns 404 when the engine reports that the workflow was not found', async () => {
    const engine = createEngine();
    const originalSignal = engine.signal.bind(engine);
    engine.signal = async () => {
      throw new Error('Workflow not found');
    };

    try {
      const response = await handleRequest(
        request('POST', '/v1/workflows/missing/signal/release', { payload: 'hello' }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: 'Workflow not found',
        data: { resource: 'workflow', identifier: 'missing' },
      });
    } finally {
      engine.signal = originalSignal;
    }
  });

  it('masks unexpected engine failures to a 500 generic error body', async () => {
    const engine = createEngine();
    const originalSignal = engine.signal.bind(engine);
    engine.signal = async () => {
      throw new Error('unexpected signal error');
    };

    try {
      const response = await handleRequest(
        request('POST', '/v1/workflows/wf-1/signal/release', { payload: 'hello' }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
    } finally {
      engine.signal = originalSignal;
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

import { sleepForTesting } from "../../../test-support/embedded/testing/src/fake-timers.ts";
import { describe, expect, it } from 'bun:test';

import { createOperationRegistry } from "../../embedded/backchannel/src/internals.ts";
import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { awakeTurns } from "../../../test-support/embedded/testing/src/wait-until.ts";
import { Engine } from '../../core/engine.ts';
import { type WorkflowContext, signal, workflow } from '../../core/types.ts';
import { handleRequestAsLocalUser as handleRequest } from '../local-user-request.test-support.ts';
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

const declaredWorkflow = workflow({ name: 'declared' })
  .signals({ release: signal('release') })
  .execute(async function* (ctx: WorkflowContext) {
    return yield* ctx.waitForSignal('release');
  });

function createEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register(holdWorkflow);
  engine.register(twoSignalWorkflow);
  engine.register(declaredWorkflow);
  return engine;
}

async function waitForStatus(
  engine: Engine,
  workflowId: string,
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out',
): Promise<void> {
  for await (const _turn of awakeTurns()) {
    const state = await engine.get(workflowId);
    if (state?.status === status) {
      return;
    }
    await sleepForTesting(5);
  }

  throw new Error(`Workflow ${workflowId} did not reach ${status} before the hang guard elapsed`);
}

const registry = createOperationRegistry([signalWorkflowOperation]);
const bindings = [signalWorkflowRestBinding];

describe('weft.workflows.signal', () => {
  it('answers 422 when the workflow declares its signals and this name is not one of them', async () => {
    await using engine = createEngine();
    const handle = await engine.start('declared', null, { id: 'signal-undeclared' });
    await waitForStatus(engine, handle.id, 'running');

    const response = await handleRequest(
      new Request(`http://localhost/v1/workflows/${handle.id}/signal/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: null }),
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(422);
    const body = (await response.json()) as { error?: string };
    expect(JSON.stringify(body)).toContain('does not declare signal');
  });

  it('signals a workflow and returns the ok response', async () => {
    await using engine = createEngine();
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
    await using engine = createEngine();
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
    await using engine = createEngine();
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
    await using engine = createEngine();
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
    await using engine = createEngine();
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
    await using engine = createEngine();
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
        retryable: false,
      });
    } finally {
      engine.signal = originalSignal;
    }
  });

  it('masks unexpected engine failures to a 500 generic error body', async () => {
    await using engine = createEngine();
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
      expect(await response.json()).toEqual({ error: 'Internal server error', retryable: false });
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

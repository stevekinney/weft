/**
 * `payloadValidation: 'inbound'` rejections reach REST callers as
 * `InvalidParams` (400), with issue paths rooted at the request field.
 */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createOperationRegistry } from "../embedded/backchannel/src/internals.ts";
import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { Engine } from '../core/engine.ts';
import { type WorkflowContext, query, signal, update, workflow } from '../core/types.ts';
import { StandardSchemaValidationError } from '../core/types/standard-schema-validate.ts';
import { handleRequestAsLocalUser as handleRequest } from './local-user-request.test-support.ts';
import { waitForWorkflowStatus } from './operations/operation-test-helpers.test-support.ts';
import {
  queryWorkflowOperation,
  queryWorkflowWithInputRestBinding,
} from './operations/query-workflow.ts';
import {
  signalWorkflowOperation,
  signalWorkflowRestBinding,
} from './operations/signal-workflow.ts';
import {
  startOrSignalWorkflowOperation,
  startOrSignalWorkflowRestBinding,
} from './operations/start-or-signal-workflow.ts';
import { startWorkflowOperation, startWorkflowRestBinding } from './operations/start-workflow.ts';
import {
  updateWorkflowOperation,
  updateWorkflowRestBinding,
} from './operations/update-workflow.ts';
import { standardSchemaValidationFault } from './standard-schema-validation-fault.ts';

const strict = workflow({ name: 'strict', inputSchema: z.object({ id: z.string() }) })
  .signals({ go: signal('go', { inputSchema: z.object({ ok: z.boolean() }) }) })
  .updates({ set: update('set', { inputSchema: z.object({ value: z.number() }) }) })
  .queries({ get: query('get', { inputSchema: z.object({ key: z.string() }) }) })
  .execute(async function* (ctx: WorkflowContext) {
    ctx.onUpdate('set', () => 'set');
    ctx.onQuery('get', () => 'got');
    yield* ctx.waitForSignal('go');
    return 'done';
  });

const registry = createOperationRegistry([
  startWorkflowOperation,
  signalWorkflowOperation,
  updateWorkflowOperation,
  queryWorkflowOperation,
  startOrSignalWorkflowOperation,
]);
const restBindings = [
  startWorkflowRestBinding,
  signalWorkflowRestBinding,
  updateWorkflowRestBinding,
  queryWorkflowWithInputRestBinding,
  startOrSignalWorkflowRestBinding,
];

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage(), payloadValidation: 'inbound' });
  engine.register(strict);
  return engine;
}

async function post(engine: Engine, path: string, body: unknown) {
  const response = await handleRequest(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
    engine,
    { operationRegistry: registry, restBindings },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('standardSchemaValidationFault', () => {
  it('ignores any other error', () => {
    expect(standardSchemaValidationFault(new Error('boom'))).toBeUndefined();
  });

  it('roots issue paths at the field and decodes JSON Pointer escapes', () => {
    const fault = standardSchemaValidationFault(
      new StandardSchemaValidationError({
        fieldName: 'payload',
        operation: 'weft.workflows.signal',
        issues: [
          { message: 'root', path: '' },
          { message: 'nested', path: '/a~1b/c~0d/0' },
        ],
      }),
    );
    expect(fault).toEqual({
      code: 'InvalidParams',
      message: expect.any(String),
      data: {
        issues: [
          { path: ['payload'], message: 'root', code: 'custom' },
          { path: ['payload', 'a/b', 'c~d', '0'], message: 'nested', code: 'custom' },
        ],
        weftCode: 'StandardSchemaValidationError',
      },
    });
  });
});

describe('payload validation over REST', () => {
  it('answers 400 for an invalid start input', async () => {
    await using engine = createEngine();
    const { status, body } = await post(engine, '/v1/workflows', {
      type: 'strict',
      input: { id: 1 },
    });
    expect(status).toBe(400);
    expect(body['weftCode']).toBe('StandardSchemaValidationError');
    expect(body['data']).toEqual({
      issues: [{ path: ['input', 'id'], message: expect.any(String), code: 'custom' }],
    });
  });

  it('answers 400 for an invalid start-or-signal payload', async () => {
    await using engine = createEngine();
    const { status, body } = await post(engine, '/v1/workflows/start-or-signal', {
      type: 'strict',
      input: { id: 'a' },
      signalName: 'go',
      signalPayload: { ok: 'no' },
      signalId: 's-1',
    });
    expect(status).toBe(400);
    expect(body['weftCode']).toBe('StandardSchemaValidationError');
  });

  it('answers 400 for an invalid signal, update, and query', async () => {
    await using engine = createEngine();
    const handle = await engine.start('strict', { id: 'a' });
    await waitForWorkflowStatus(engine, handle.id, 'running');

    const signalled = await post(engine, `/v1/workflows/${handle.id}/signal/go`, {
      payload: { ok: 'no' },
    });
    expect(signalled.status).toBe(400);
    expect(signalled.body['weftCode']).toBe('StandardSchemaValidationError');

    const updated = await post(engine, `/v1/workflows/${handle.id}/update/set`, {
      payload: { value: 'x' },
    });
    expect(updated.status).toBe(400);
    expect(updated.body['weftCode']).toBe('StandardSchemaValidationError');

    const queried = await post(engine, `/v1/workflows/${handle.id}/query/get`, {
      input: { key: 1 },
    });
    expect(queried.status).toBe(400);
    expect(queried.body['weftCode']).toBe('StandardSchemaValidationError');

    await engine.signal(handle.id, 'go', { ok: true });
    await handle.result();
  });
});

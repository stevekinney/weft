import { afterEach, describe, expect, it } from 'bun:test';

import { Engine, WorkflowTypeNotRegisteredForRecoveryError } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { recoverAllOperation, recoverAllRestBinding } from './recover-all.ts';

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

function request(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' },
        }),
  });
}

const registry = createOperationRegistry([recoverAllOperation]);
const bindings = [recoverAllRestBinding];

describe('weft.recover.all', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('returns 200 with the recovered workflow ids on the happy path', async () => {
    engine = createEngine();
    const originalRecoverAll = engine.recoverAll.bind(engine);

    try {
      engine.recoverAll = async () =>
        [{ id: 'wf-recovered-1' }, { id: 'wf-recovered-2' }] as Awaited<
          ReturnType<Engine['recoverAll']>
        >;

      const response = await handleRequest(request('POST', '/v1/recover'), engine, {
        operationRegistry: registry,
        restBindings: bindings,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        recovered: ['wf-recovered-1', 'wf-recovered-2'],
      });
    } finally {
      engine.recoverAll = originalRecoverAll;
    }
  });

  it('masks unexpected engine failures to a generic 500 (no raw message leak)', async () => {
    engine = createEngine();
    const originalRecoverAll = engine.recoverAll.bind(engine);

    try {
      engine.recoverAll = async () => {
        throw new Error('recover all exploded');
      };

      const response = await handleRequest(request('POST', '/v1/recover'), engine, {
        operationRegistry: registry,
        restBindings: bindings,
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
      expect(response.headers.get('Content-Type')).toContain('application/json');
    } finally {
      engine.recoverAll = originalRecoverAll;
    }
  });

  it('maps unknown workflow types to a redacted 409 response by default', async () => {
    engine = createEngine();
    const originalRecoverAll = engine.recoverAll.bind(engine);

    try {
      engine.recoverAll = async () => {
        throw new WorkflowTypeNotRegisteredForRecoveryError({
          registeredTypes: ['echo'],
          missingWorkflows: [
            { workflowId: 'wf-secret-1', type: 'missingAlpha' },
            { workflowId: 'wf-secret-2', type: 'missingBeta' },
          ],
        });
      };

      const response = await handleRequest(request('POST', '/v1/recover'), engine, {
        operationRegistry: registry,
        restBindings: bindings,
      });

      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body).toEqual({
        error: 'workflow_type_not_registered_for_recovery',
        data: {
          missingTypes: ['missingAlpha', 'missingBeta'],
          missingWorkflowCount: 2,
          samplesTruncated: false,
        },
        missingTypes: ['missingAlpha', 'missingBeta'],
        missingWorkflowCount: 2,
        samplesTruncated: false,
      });
      // Belt-and-suspenders against future renames of the test fixture IDs:
      // assert each specific workflow ID is absent from the serialized body.
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('wf-secret-1');
      expect(serialized).not.toContain('wf-secret-2');
      expect(serialized).not.toContain('missingWorkflowSamples');
    } finally {
      engine.recoverAll = originalRecoverAll;
    }
  });

  it('ignores acknowledgeUnknownWorkflowTypes in HTTP request bodies', async () => {
    // Unauthenticated callers MUST NOT be able to opt into the dangerous skip
    // behavior over the public HTTP surface — recoverAll receives no options
    // regardless of what the caller posts. The flag stays available in-process
    // via engine.recoverAll() for code paths that have established intent.
    engine = createEngine();
    const originalRecoverAll = engine.recoverAll.bind(engine);
    let observedOptions: unknown;

    try {
      engine.recoverAll = async (options) => {
        observedOptions = options;
        return [] as Awaited<ReturnType<Engine['recoverAll']>>;
      };

      const response = await handleRequest(
        request('POST', '/v1/recover', { acknowledgeUnknownWorkflowTypes: true }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ recovered: [] });
      expect(observedOptions).toBeUndefined();
    } finally {
      engine.recoverAll = originalRecoverAll;
    }
  });

  it('invoke ignores any input it receives, regardless of transport', async () => {
    // Transport-agnostic guard: if a future transport reintroduces input
    // extraction for this operation, the invoke handler must still drop the
    // dangerous flag. Calling recoverAllOperation.invoke directly bypasses
    // schema validation, so any field that slips past Zod still cannot reach
    // the engine — proving the contract is enforced at two layers (schema
    // + handler).
    engine = createEngine();
    const originalRecoverAll = engine.recoverAll.bind(engine);
    let observedOptions: unknown;

    try {
      engine.recoverAll = async (options) => {
        observedOptions = options;
        return [] as Awaited<ReturnType<Engine['recoverAll']>>;
      };

      const result = await recoverAllOperation.invoke({
        // Cast: we intentionally pass an input shape the schema would reject
        // to prove the handler does not read it.
        input: { acknowledgeUnknownWorkflowTypes: true } as never,
        principal: { method: 'unauthenticated' },
        engine,
        transport: 'jsonRpcWebSocket',
      });

      expect(result).toEqual({ recovered: [] });
      expect(observedOptions).toBeUndefined();
    } finally {
      engine.recoverAll = originalRecoverAll;
    }
  });
});

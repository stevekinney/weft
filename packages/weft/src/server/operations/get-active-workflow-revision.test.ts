/**
 * `weft.workflows.active.get` operation + REST binding — unit tests.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { buildRegistrySnapshot } from '../../core/registry-snapshot.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import { principalFromApiKey } from '../principal.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
import {
  getActiveWorkflowRevisionOperation,
  getActiveWorkflowRevisionRestBinding,
} from './get-active-workflow-revision.ts';

const checkout = workflow({ name: 'checkout', version: '1.0.0' }).execute(async function* (
  _ctx: WorkflowContext,
  input: string,
) {
  return input;
});

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register(checkout);
  return engine;
}

function readerAuthContext() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({ subject: 'reader', scopes: ['workflows:read'] }),
    },
  };
}

const registry = createOperationRegistry([getActiveWorkflowRevisionOperation]);

describe('weft.workflows.active.get', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
  });

  it('returns the active pointer (REST, 200)', async () => {
    engine = createEngine();
    const expected = await engine.workflows.getActive('checkout');

    const response = await handleRequest(
      new Request('http://localhost/v1/registry/workflows/checkout/active', { method: 'GET' }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getActiveWorkflowRevisionRestBinding],
        ...readerAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { revision?: string; generation?: number };
    expect(body.revision).toBe(expected!.revision);
    expect(body.generation).toBe(expected!.generation);
  });

  it('faults with NotFound (404) for a name that was never activated', async () => {
    engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/registry/workflows/never-activated/active', {
        method: 'GET',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getActiveWorkflowRevisionRestBinding],
        ...readerAuthContext(),
      },
    );

    expect(response.status).toBe(404);
  });

  it('requires workflows:read — an unauthenticated request is Unauthorized', async () => {
    engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/registry/workflows/checkout/active', { method: 'GET' }),
      engine,
      { operationRegistry: registry, restBindings: [getActiveWorkflowRevisionRestBinding] },
    );

    expect(response.status).toBe(401);
  });

  it('succeeds over JSON-RPC — REST/JSON-RPC parity', async () => {
    engine = createEngine();
    const expected = await engine.workflows.getActive('checkout');
    const liveRegistry = createLiveOperationRegistry();
    const principal = principalFromApiKey({ subject: 'reader', scopes: ['workflows:read'] });

    const result = await executeOperation(
      'weft.workflows.active.get',
      { name: 'checkout' },
      { principal, engine, transport: 'jsonRpcStdio', registry: liveRegistry },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    const value = result.value as { revision?: string };
    expect(value.revision).toBe(expected!.revision);
  });

  it('agrees with buildRegistrySnapshot(engine).activeRevisions for the same engine — cross-surface consistency', async () => {
    engine = createEngine();
    const snapshot = await buildRegistrySnapshot(engine);
    const liveRegistry = createLiveOperationRegistry();
    const principal = principalFromApiKey({ subject: 'reader', scopes: ['workflows:read'] });

    const result = await executeOperation(
      'weft.workflows.active.get',
      { name: 'checkout' },
      { principal, engine, transport: 'jsonRpcStdio', registry: liveRegistry },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    const value = result.value as { revision?: string };
    expect(value.revision).toBe(snapshot.activeRevisions['checkout']);
  });
});

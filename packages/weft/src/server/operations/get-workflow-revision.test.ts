/**
 * `weft.workflows.revisions.get` operation + REST binding — unit tests.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import { principalFromApiKey } from '../principal.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
import {
  getWorkflowRevisionOperation,
  getWorkflowRevisionRestBinding,
} from './get-workflow-revision.ts';

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

const registry = createOperationRegistry([getWorkflowRevisionOperation]);

describe('weft.workflows.revisions.get', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
  });

  it('returns the installed revision record (REST, 200)', async () => {
    engine = createEngine();
    const active = await engine.workflows.getActive('checkout');

    const response = await handleRequest(
      new Request(`http://localhost/v1/registry/workflows/checkout/revisions/${active!.revision}`, {
        method: 'GET',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getWorkflowRevisionRestBinding],
        ...readerAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { manifest?: { revision?: string } };
    expect(body.manifest?.revision).toBe(active!.revision);
  });

  it('faults with NotFound (404) for an uninstalled revision', async () => {
    engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/registry/workflows/checkout/revisions/nonexistent', {
        method: 'GET',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getWorkflowRevisionRestBinding],
        ...readerAuthContext(),
      },
    );

    expect(response.status).toBe(404);
  });

  it('requires workflows:read — an unauthenticated request is Unauthorized', async () => {
    engine = createEngine();
    const active = await engine.workflows.getActive('checkout');

    const response = await handleRequest(
      new Request(`http://localhost/v1/registry/workflows/checkout/revisions/${active!.revision}`, {
        method: 'GET',
      }),
      engine,
      { operationRegistry: registry, restBindings: [getWorkflowRevisionRestBinding] },
    );

    expect(response.status).toBe(401);
  });

  it('succeeds over JSON-RPC — REST/JSON-RPC parity', async () => {
    engine = createEngine();
    const active = await engine.workflows.getActive('checkout');
    const liveRegistry = createLiveOperationRegistry();
    const principal = principalFromApiKey({ subject: 'reader', scopes: ['workflows:read'] });

    const result = await executeOperation(
      'weft.workflows.revisions.get',
      { name: 'checkout', revision: active!.revision },
      { principal, engine, transport: 'jsonRpcStdio', registry: liveRegistry },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    const value = result.value as { manifest?: { revision?: string } };
    expect(value.manifest?.revision).toBe(active!.revision);
  });
});

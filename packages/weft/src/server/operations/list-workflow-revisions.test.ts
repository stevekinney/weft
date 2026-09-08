/**
 * `weft.workflows.revisions.list` operation + REST binding — unit tests.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { buildWorkflowContract } from '../../core/contract/build.ts';
import { buildWorkflowRevisionManifest } from '../../core/contract/manifest.ts';
import { Engine } from '../../core/engine.ts';
import type { WorkflowContext } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import { principalFromApiKey } from '../principal.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
import {
  installWorkflowRevisionOperation,
  installWorkflowRevisionRestBinding,
} from './install-workflow-revision.ts';
import {
  listWorkflowRevisionsOperation,
  listWorkflowRevisionsRestBinding,
} from './list-workflow-revisions.ts';

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

function adminAuthContext() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({ subject: 'admin', scopes: ['workflows:admin'] }),
    },
  };
}

const registry = createOperationRegistry([
  listWorkflowRevisionsOperation,
  installWorkflowRevisionOperation,
]);
const bindings = [listWorkflowRevisionsRestBinding, installWorkflowRevisionRestBinding];

describe('weft.workflows.revisions.list', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
  });

  it('lists every installed revision, including the one from registration (REST, 200)', async () => {
    engine = createEngine();
    const secondRevision = await buildWorkflowRevisionManifest(
      buildWorkflowContract({ name: 'checkout', version: '1.0.0', description: 'second' }),
    );
    await handleRequest(
      new Request('http://localhost/v1/registry/revisions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: secondRevision }),
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings, ...adminAuthContext() },
    );

    const response = await handleRequest(
      new Request('http://localhost/v1/registry/workflows/checkout/revisions', { method: 'GET' }),
      engine,
      { operationRegistry: registry, restBindings: bindings, ...readerAuthContext() },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<{ manifest: { revision: string } }>;
    expect(body).toHaveLength(2);
    expect(body.map((r) => r.manifest.revision)).toContain(secondRevision.revision);
  });

  it('returns an empty array (not a fault) for a name with no installed revisions', async () => {
    engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/registry/workflows/nonexistent/revisions', {
        method: 'GET',
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings, ...readerAuthContext() },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it('requires workflows:read — an unauthenticated request is Unauthorized', async () => {
    engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/registry/workflows/checkout/revisions', { method: 'GET' }),
      engine,
      { operationRegistry: registry, restBindings: bindings },
    );

    expect(response.status).toBe(401);
  });

  it('succeeds over JSON-RPC — REST/JSON-RPC parity', async () => {
    engine = createEngine();
    const liveRegistry = createLiveOperationRegistry();
    const principal = principalFromApiKey({ subject: 'reader', scopes: ['workflows:read'] });

    const result = await executeOperation(
      'weft.workflows.revisions.list',
      { name: 'checkout' },
      { principal, engine, transport: 'jsonRpcStdio', registry: liveRegistry },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(Array.isArray(result.value)).toBe(true);
  });
});

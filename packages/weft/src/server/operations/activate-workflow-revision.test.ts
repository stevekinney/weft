/**
 * `weft.workflows.revisions.activate` operation + REST binding — unit tests.
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
  activateWorkflowRevisionOperation,
  activateWorkflowRevisionRestBinding,
} from './activate-workflow-revision.ts';
import {
  installWorkflowRevisionOperation,
  installWorkflowRevisionRestBinding,
} from './install-workflow-revision.ts';

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

function adminAuthContext() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({ subject: 'admin', scopes: ['workflows:admin'] }),
    },
  };
}

const registry = createOperationRegistry([
  activateWorkflowRevisionOperation,
  installWorkflowRevisionOperation,
]);
const bindings = [activateWorkflowRevisionRestBinding, installWorkflowRevisionRestBinding];

async function activateRequest(name: string, body: unknown, engine: Engine) {
  return handleRequest(
    new Request(`http://localhost/v1/registry/workflows/${name}/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    engine,
    { operationRegistry: registry, restBindings: bindings, ...adminAuthContext() },
  );
}

describe('weft.workflows.revisions.activate', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
  });

  it('re-stamps (bumps the generation of) the currently active revision — 200 (REST)', async () => {
    engine = createEngine();
    const active = await engine.workflows.getActive('checkout');

    const response = await activateRequest(
      'checkout',
      { revision: active!.revision, expectedGeneration: active!.generation },
      engine,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      applied?: boolean;
      pointer?: { generation?: number };
    };
    expect(body.applied).toBe(true);
    expect(body.pointer?.generation).toBe(active!.generation + 1);
  });

  it('faults with NotFound (404) for a revision that was never installed', async () => {
    engine = createEngine();

    const response = await activateRequest(
      'checkout',
      { revision: 'never-installed', expectedGeneration: 1 },
      engine,
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { weftCode?: string };
    expect(body.weftCode).toBe('WorkflowRevisionNotInstalledError');
  });

  it('faults with Conflict (409, reason expected-generation-required) when expectedGeneration is omitted', async () => {
    engine = createEngine();
    const active = await engine.workflows.getActive('checkout');

    const response = await activateRequest('checkout', { revision: active!.revision }, engine);

    expect(response.status).toBe(409);
  });

  it('faults with Conflict (409) for a stale expectedGeneration', async () => {
    engine = createEngine();
    const active = await engine.workflows.getActive('checkout');

    const response = await activateRequest(
      'checkout',
      { revision: active!.revision, expectedGeneration: active!.generation + 99 },
      engine,
    );

    expect(response.status).toBe(409);
  });

  it('faults with Conflict (409) for an incompatible installed candidate, and reports compatibilityReasons', async () => {
    engine = createEngine();
    const active = await engine.workflows.getActive('checkout');
    const incompatible = await buildWorkflowRevisionManifest(
      buildWorkflowContract({ name: 'checkout', version: '99.0.0' }),
      { revision: 'incompatible-candidate' },
    );
    await handleRequest(
      new Request('http://localhost/v1/registry/revisions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: incompatible }),
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings, ...adminAuthContext() },
    );

    const response = await activateRequest(
      'checkout',
      { revision: 'incompatible-candidate', expectedGeneration: active!.generation },
      engine,
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { data?: { compatibilityReasons?: string[] } };
    expect(body.data?.compatibilityReasons).toContain('workflow-version-incompatible');
  });

  it('faults with InvalidParams (400) for a malformed expectedGeneration', async () => {
    engine = createEngine();
    const active = await engine.workflows.getActive('checkout');

    const response = await activateRequest(
      'checkout',
      { revision: active!.revision, expectedGeneration: -1 },
      engine,
    );

    expect(response.status).toBe(400);
  });

  it('requires workflows:admin — a workflows:read principal is forbidden', async () => {
    engine = createEngine();
    const active = await engine.workflows.getActive('checkout');

    const response = await handleRequest(
      new Request('http://localhost/v1/registry/workflows/checkout/activate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          revision: active!.revision,
          expectedGeneration: active!.generation,
        }),
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
        authContext: {
          method: 'api-key',
          principal: principalFromApiKey({ subject: 'reader', scopes: ['workflows:read'] }),
        },
      },
    );

    expect(response.status).toBe(403);
  });

  it('succeeds over JSON-RPC — REST/JSON-RPC parity', async () => {
    engine = createEngine();
    const active = await engine.workflows.getActive('checkout');
    const liveRegistry = createLiveOperationRegistry();
    const principal = principalFromApiKey({ subject: 'admin', scopes: ['workflows:admin'] });

    const result = await executeOperation(
      'weft.workflows.revisions.activate',
      { name: 'checkout', revision: active!.revision, expectedGeneration: active!.generation },
      { principal, engine, transport: 'jsonRpcStdio', registry: liveRegistry },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    const value = result.value as { applied?: boolean };
    expect(value.applied).toBe(true);
  });

  it('faults with Conflict (409, reason "conflict") when the CAS write itself loses a race', async () => {
    engine = createEngine();
    const active = await engine.workflows.getActive('checkout');
    // Stub AFTER the initial registration's own CAS write has already
    // succeeded, so this activate() call passes the generation and
    // compatibility gates and reaches the write itself.
    engine.storage.conditionalBatch = async () => false;

    const response = await activateRequest(
      'checkout',
      { revision: active!.revision, expectedGeneration: active!.generation },
      engine,
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { data?: { reason?: string } };
    expect(body.data?.reason).toBeUndefined(); // REST withholds `reason` — see the operation's own doc note.
  });

  it('faults with InvalidParams (400) for a malformed policy field', async () => {
    engine = createEngine();
    const active = await engine.workflows.getActive('checkout');

    const response = await activateRequest(
      'checkout',
      {
        revision: active!.revision,
        expectedGeneration: active!.generation,
        policy: { requireExactRevision: 'not-a-boolean' },
      },
      engine,
    );

    expect(response.status).toBe(400);
  });

  it('activating a docs-only-different installed candidate does not change engine.getWorkflowDefinition()', async () => {
    engine = createEngine();
    const originalDefinition = engine.getWorkflowDefinition('checkout');
    const active = await engine.workflows.getActive('checkout');
    const docsVariant = await buildWorkflowRevisionManifest(
      buildWorkflowContract({
        name: 'checkout',
        version: '1.0.0',
        description: 'updated',
      }),
    );
    await handleRequest(
      new Request('http://localhost/v1/registry/revisions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: docsVariant }),
      }),
      engine,
      { operationRegistry: registry, restBindings: bindings, ...adminAuthContext() },
    );

    const response = await activateRequest(
      'checkout',
      {
        revision: docsVariant.revision,
        expectedGeneration: active!.generation,
        policy: { requireExactRevision: false },
      },
      engine,
    );

    expect(response.status).toBe(200);
    expect(engine.getWorkflowDefinition('checkout')).toEqual(originalDefinition);
  });
});

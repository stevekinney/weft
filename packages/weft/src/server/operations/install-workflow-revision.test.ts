/**
 * `weft.workflows.revisions.install` operation + REST binding — unit tests.
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
import { anonymousPrincipal, principalFromApiKey } from '../principal.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
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

const registry = createOperationRegistry([installWorkflowRevisionOperation]);

async function installRequest(body: unknown, engine: Engine) {
  return handleRequest(
    new Request('http://localhost/v1/registry/revisions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    engine,
    {
      operationRegistry: registry,
      restBindings: [installWorkflowRevisionRestBinding],
      ...adminAuthContext(),
    },
  );
}

describe('weft.workflows.revisions.install', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
  });

  it('installs a manifest for an already-registered workflow and returns 201 (REST)', async () => {
    engine = createEngine();
    const manifest = await buildWorkflowRevisionManifest(
      buildWorkflowContract({ name: 'checkout', version: '1.0.0' }),
    );

    const response = await installRequest({ manifest }, engine);

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      manifest?: { revision?: string };
      installedAt?: number;
    };
    expect(body.manifest?.revision).toBe(manifest.revision);
    expect(body.installedAt).toBeGreaterThan(0);
  });

  it('is idempotent on a byte-identical reinstall (still 201)', async () => {
    engine = createEngine();
    const manifest = await buildWorkflowRevisionManifest(
      buildWorkflowContract({ name: 'checkout', version: '1.0.0' }),
    );

    await installRequest({ manifest }, engine);
    const response = await installRequest({ manifest }, engine);

    expect(response.status).toBe(201);
  });

  it('faults with Conflict (409) for a differing-content reinstall under the same revision', async () => {
    engine = createEngine();
    const first = await buildWorkflowRevisionManifest(
      buildWorkflowContract({ name: 'checkout', version: '1.0.0' }),
      { revision: 'pinned-1' },
    );
    const conflicting = await buildWorkflowRevisionManifest(
      buildWorkflowContract({ name: 'checkout', version: '2.0.0' }),
      { revision: 'pinned-1' },
    );
    await installRequest({ manifest: first }, engine);

    const response = await installRequest({ manifest: conflicting }, engine);

    expect(response.status).toBe(409);
    const body = (await response.json()) as { weftCode?: string };
    expect(body.weftCode).toBe('WorkflowCatalogConflictError');
  });

  it('faults with InvalidParams (400) when the workflow has no in-process definition', async () => {
    engine = createEngine();
    const manifest = await buildWorkflowRevisionManifest(
      buildWorkflowContract({ name: 'never-registered', version: '1.0.0' }),
    );

    const response = await installRequest({ manifest }, engine);

    expect(response.status).toBe(400);
    const body = (await response.json()) as { weftCode?: string };
    expect(body.weftCode).toBe('WorkflowNotRegisteredError');
  });

  it('faults with InvalidParams (400) for a manifest that fails validation (not-an-object)', async () => {
    engine = createEngine();

    const response = await installRequest({ manifest: 'not an object' }, engine);

    expect(response.status).toBe(400);
  });

  it('faults with InvalidParams (400) for a manifest with an unsupported manifestVersion', async () => {
    engine = createEngine();
    const manifest = await buildWorkflowRevisionManifest(
      buildWorkflowContract({ name: 'checkout', version: '1.0.0' }),
    );

    const response = await installRequest(
      { manifest: { ...manifest, manifestVersion: 99 } },
      engine,
    );

    expect(response.status).toBe(400);
  });

  it('faults with InvalidParams (400) for a manifest with a tampered contractHash', async () => {
    engine = createEngine();
    const manifest = await buildWorkflowRevisionManifest(
      buildWorkflowContract({ name: 'checkout', version: '1.0.0' }),
    );

    const response = await installRequest(
      { manifest: { ...manifest, contractHash: `${manifest.contractHash.slice(0, -1)}0` } },
      engine,
    );

    expect(response.status).toBe(400);
  });

  it('requires workflows:admin — a workflows:read principal is forbidden', async () => {
    engine = createEngine();
    const manifest = await buildWorkflowRevisionManifest(
      buildWorkflowContract({ name: 'checkout', version: '1.0.0' }),
    );

    const response = await handleRequest(
      new Request('http://localhost/v1/registry/revisions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest }),
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [installWorkflowRevisionRestBinding],
        authContext: {
          method: 'api-key',
          principal: principalFromApiKey({ subject: 'reader', scopes: ['workflows:read'] }),
        },
      },
    );

    expect(response.status).toBe(403);
  });

  it('rejects an unauthenticated principal over JSON-RPC with Unauthorized', async () => {
    engine = createEngine();
    const manifest = await buildWorkflowRevisionManifest(
      buildWorkflowContract({ name: 'checkout', version: '1.0.0' }),
    );
    const liveRegistry = createLiveOperationRegistry();

    const result = await executeOperation(
      'weft.workflows.revisions.install',
      { manifest },
      {
        principal: anonymousPrincipal(),
        engine,
        transport: 'jsonRpcStdio',
        registry: liveRegistry,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.fault.code).toBe('Unauthorized');
  });

  it('succeeds over JSON-RPC with an admin principal — REST/JSON-RPC parity', async () => {
    engine = createEngine();
    const manifest = await buildWorkflowRevisionManifest(
      buildWorkflowContract({ name: 'checkout', version: '1.0.0' }),
    );
    const liveRegistry = createLiveOperationRegistry();
    const principal = principalFromApiKey({ subject: 'admin', scopes: ['workflows:admin'] });

    const result = await executeOperation(
      'weft.workflows.revisions.install',
      { manifest },
      { principal, engine, transport: 'jsonRpcStdio', registry: liveRegistry },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    const value = result.value as { manifest?: { revision?: string } };
    expect(value.manifest?.revision).toBe(manifest.revision);
  });
});

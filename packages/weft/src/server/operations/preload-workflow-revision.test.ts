/**
 * `weft.workflows.revisions.preload` operation + REST binding — unit tests.
 */

import { afterEach, describe, expect, it, mock } from 'bun:test';

import { ActivityRegistry } from '../../core/activity-registry.ts';
import { Engine } from '../../core/engine.ts';
import { copyWorkflowDefinition } from '../../core/engine/construction.ts';
import { buildRegistrationEntry } from '../../core/engine/registration.ts';
import { buildWorkflowManifestFromDefinition } from '../../core/registry-workflow-manifest.ts';
import { workflowSource } from '../../core/source/index.ts';
import type { WorkflowDefinition } from '../../core/types.ts';
import { workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import { principalFromApiKey } from '../principal.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
import {
  preloadWorkflowRevisionOperation,
  preloadWorkflowRevisionRestBinding,
} from './preload-workflow-revision.ts';

const lazyCheckout = workflow({ name: 'lazy-checkout' }).execute(async function* (
  _ctx,
  input: string,
) {
  return input;
});

async function lazyCheckoutRevision(): Promise<string> {
  const entry = buildRegistrationEntry('lazy-checkout', lazyCheckout as WorkflowDefinition);
  const registered = copyWorkflowDefinition('lazy-checkout', entry);
  const manifest = await buildWorkflowManifestFromDefinition(
    registered,
    new ActivityRegistry().listDefinitions(),
  );
  return manifest.revision;
}

function createEngine(): Engine {
  return new Engine({ storage: new MemoryStorage() });
}

function adminAuthContext() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({ subject: 'admin', scopes: ['workflows:admin'] }),
    },
  };
}

const registry = createOperationRegistry([preloadWorkflowRevisionOperation]);
const bindings = [preloadWorkflowRevisionRestBinding];

async function preloadRequest(name: string, body: unknown, engine: Engine) {
  return handleRequest(
    new Request(`http://localhost/v1/registry/workflows/${name}/preload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    engine,
    { operationRegistry: registry, restBindings: bindings, ...adminAuthContext() },
  );
}

describe('weft.workflows.revisions.preload', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
  });

  it('loads, validates, and installs a registered dynamic source revision — 200 (REST)', async () => {
    engine = createEngine();
    const revision = await lazyCheckoutRevision();
    const loader = mock(async () => ({ lazyCheckout }));
    engine.registerSource(
      workflowSource(
        {
          name: 'lazy-checkout',
          location: './lazy-checkout.ts',
          exportName: 'lazyCheckout',
          revision,
        },
        loader,
      ),
    );

    const response = await preloadRequest('lazy-checkout', { revision }, engine);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { manifest?: { name?: string; revision?: string } };
    expect(body.manifest?.name).toBe('lazy-checkout');
    expect(body.manifest?.revision).toBe(revision);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('faults with NotFound (404) for a (name, revision) never registerSource()-registered', async () => {
    engine = createEngine();

    const response = await preloadRequest('never-registered', { revision: 'r1' }, engine);

    expect(response.status).toBe(404);
    const body = (await response.json()) as { weftCode?: string };
    expect(body.weftCode).toBe('WorkflowSourceNotRegisteredError');
  });

  it('faults with Conflict (409) when the loader throws a raw exception (REST)', async () => {
    engine = createEngine();
    const revision = await lazyCheckoutRevision();
    engine.registerSource(
      workflowSource(
        {
          name: 'lazy-checkout',
          location: './lazy-checkout.ts',
          exportName: 'lazyCheckout',
          revision,
        },
        async () => {
          throw new Error('module explode');
        },
      ),
    );

    const response = await preloadRequest('lazy-checkout', { revision }, engine);

    // `Conflict.data.reason` is intentionally not disclosed over REST (see
    // `operation-fault.ts`'s own REST extractor doc) — JSON-RPC gets full
    // fidelity; see the parity test below.
    expect(response.status).toBe(409);
  });

  it('faults with Conflict (reason "load-failed") when the loader throws a raw exception (JSON-RPC)', async () => {
    engine = createEngine();
    const revision = await lazyCheckoutRevision();
    engine.registerSource(
      workflowSource(
        {
          name: 'lazy-checkout',
          location: './lazy-checkout.ts',
          exportName: 'lazyCheckout',
          revision,
        },
        async () => {
          throw new Error('module explode');
        },
      ),
    );
    const liveRegistry = createLiveOperationRegistry();
    const principal = principalFromApiKey({ subject: 'admin', scopes: ['workflows:admin'] });

    const result = await executeOperation(
      'weft.workflows.revisions.preload',
      { name: 'lazy-checkout', revision },
      { principal, engine, transport: 'jsonRpcStdio', registry: liveRegistry },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.fault.code).toBe('Conflict');
    expect((result.fault.data as { reason?: string }).reason).toBe('load-failed');
  });

  it('faults with Conflict (409) when the loaded module fails validation', async () => {
    engine = createEngine();
    const revision = await lazyCheckoutRevision();
    engine.registerSource(
      workflowSource(
        {
          name: 'lazy-checkout',
          location: './lazy-checkout.ts',
          exportName: 'lazyCheckout',
          revision,
        },
        // Missing the expected export — `validateResolvedWorkflowSource()`
        // rejects this with `WorkflowSourceValidationError`.
        async (): Promise<Record<string, unknown>> => ({}),
      ),
    );

    const response = await preloadRequest('lazy-checkout', { revision }, engine);

    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      weftCode?: string;
      data?: { sourceValidationReasons?: string[] };
    };
    expect(body.weftCode).toBe('WorkflowSourceValidationError');
    expect(body.data?.sourceValidationReasons).toBeDefined();
  });

  it('faults with InvalidParams (400) for a missing revision field', async () => {
    engine = createEngine();

    const response = await preloadRequest('lazy-checkout', {}, engine);

    expect(response.status).toBe(400);
  });

  it('requires workflows:admin — a workflows:read principal is forbidden', async () => {
    engine = createEngine();
    const revision = await lazyCheckoutRevision();
    engine.registerSource(
      workflowSource(
        {
          name: 'lazy-checkout',
          location: './lazy-checkout.ts',
          exportName: 'lazyCheckout',
          revision,
        },
        async () => ({ lazyCheckout }),
      ),
    );

    const response = await handleRequest(
      new Request('http://localhost/v1/registry/workflows/lazy-checkout/preload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision }),
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
    const revision = await lazyCheckoutRevision();
    engine.registerSource(
      workflowSource(
        {
          name: 'lazy-checkout',
          location: './lazy-checkout.ts',
          exportName: 'lazyCheckout',
          revision,
        },
        async () => ({ lazyCheckout }),
      ),
    );
    const liveRegistry = createLiveOperationRegistry();
    const principal = principalFromApiKey({ subject: 'admin', scopes: ['workflows:admin'] });

    const result = await executeOperation(
      'weft.workflows.revisions.preload',
      { name: 'lazy-checkout', revision },
      { principal, engine, transport: 'jsonRpcStdio', registry: liveRegistry },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    const value = result.value as { manifest?: { revision?: string } };
    expect(value.manifest?.revision).toBe(revision);
  });

  it('extracts name from the path and revision from the body (REST binding)', async () => {
    expect(preloadWorkflowRevisionRestBinding.method).toBe('POST');
    expect(preloadWorkflowRevisionRestBinding.path).toBe('/v1/registry/workflows/:name/preload');
    expect(preloadWorkflowRevisionRestBinding.operationName).toBe(
      'weft.workflows.revisions.preload',
    );
  });
});

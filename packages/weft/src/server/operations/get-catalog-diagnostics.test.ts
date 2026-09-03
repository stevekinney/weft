/**
 * `weft.catalog.diagnostics` operation + REST binding — unit tests.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { buildWorkflowContract } from '../../core/contract/build.ts';
import { buildWorkflowRevisionManifest } from '../../core/contract/manifest.ts';
import { Engine } from '../../core/engine.ts';
import { activateCatalogRevisionCandidate } from '../../core/engine/catalog-activation.ts';
import { getWorkflowCatalog } from '../../core/engine/index.ts';
import { workflow, type WorkflowContext } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { WorkerRegistry } from '../../worker/registry.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import { principalFromApiKey } from '../principal.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
import { TaskQueue } from '../task-queue.ts';
import {
  getCatalogDiagnosticsOperation,
  getCatalogDiagnosticsRestBinding,
} from './get-catalog-diagnostics.ts';
import {
  assertOperationRejectsInsufficientScope,
  assertOperationRejectsUnauthenticated,
  createOperationTestEngine,
  systemReadAuthContext,
} from './operation-registry-test-helpers.test-support.ts';

function noopWorkflow(name: string, version = '1.0.0') {
  return workflow({ name, version }).execute(async function* (_ctx: WorkflowContext) {
    return 'done';
  });
}

async function manifestFor(name: string, version: string, description?: string) {
  const contract = buildWorkflowContract({
    name,
    version,
    ...(description === undefined ? {} : { description }),
  });
  return buildWorkflowRevisionManifest(contract);
}

const registry = createOperationRegistry([getCatalogDiagnosticsOperation]);

describe('weft.catalog.diagnostics — REST GET /v1/catalog/:name/revisions/:revision/diagnostics', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('returns installed:false, active:false, removable:false for an unknown (name, revision)', async () => {
    engine = createOperationTestEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/catalog/checkout/revisions/unknown-revision/diagnostics', {
        method: 'GET',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getCatalogDiagnosticsRestBinding],
        ...systemReadAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['installed']).toBe(false);
    expect(body['active']).toBe(false);
    expect(body['activeRevision']).toBeUndefined();
    expect(body['removable']).toBe(false);
    expect(body['references']).toEqual({
      registeredDefinitions: 0,
      inFlightStarts: 0,
      nonTerminalRuns: 0,
      pinnedSchedules: 0,
      pendingDispatches: 0,
      activeExecutionRealms: 0,
      retainedRecoveryRecords: 0,
    });
  });

  it('returns installed:true, active:true, removable:false for the active revision', async () => {
    engine = createOperationTestEngine();
    engine.register(noopWorkflow('checkout'));
    await engine.start('checkout', null);
    const revision = getWorkflowCatalog(engine).resolveActive('checkout')!.revision;

    const response = await handleRequest(
      new Request(`http://localhost/v1/catalog/checkout/revisions/${revision}/diagnostics`, {
        method: 'GET',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getCatalogDiagnosticsRestBinding],
        ...systemReadAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['installed']).toBe(true);
    expect(body['active']).toBe(true);
    expect(body['activeRevision']).toBe(revision);
    expect(body['removable']).toBe(false);
  });

  it('returns installed:true, active:false, removable:false for an installed, non-active REFERENCED revision', async () => {
    engine = createOperationTestEngine();
    engine.register(noopWorkflow('checkout'));
    await engine.start('checkout', null);
    const revA = getWorkflowCatalog(engine).resolveActive('checkout')!.revision;
    const manifestB = await manifestFor('checkout', '1.0.0', 'a later revision');
    await activateCatalogRevisionCandidate(engine, 'checkout', manifestB, {
      expectedGeneration: 1,
      policy: { requireExactRevision: false },
    });

    const response = await handleRequest(
      new Request(`http://localhost/v1/catalog/checkout/revisions/${revA}/diagnostics`, {
        method: 'GET',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getCatalogDiagnosticsRestBinding],
        ...systemReadAuthContext(),
      },
    );

    const body = (await response.json()) as Record<string, unknown>;
    expect(body['installed']).toBe(true);
    expect(body['active']).toBe(false);
    // revA is still this process's own registered definition, so it is
    // referenced.
    expect(body['removable']).toBe(false);
    const references = body['references'] as Record<string, number>;
    expect(references['registeredDefinitions']).toBe(1);
  });

  it('returns installed:true, active:false, removable:true for an installed, non-active, UNREFERENCED revision (a second engine over the same store that never registered it)', async () => {
    const storage = new MemoryStorage();
    await using engineA = new Engine({ storage });
    engineA.register(noopWorkflow('checkout'));
    await engineA.start('checkout', null);
    const revA = getWorkflowCatalog(engineA).resolveActive('checkout')!.revision;
    const manifestB = await manifestFor('checkout', '1.0.0', 'a later revision');
    await activateCatalogRevisionCandidate(engineA, 'checkout', manifestB, {
      expectedGeneration: 1,
      policy: { requireExactRevision: false },
    });

    engine = new Engine({ storage });

    const response = await handleRequest(
      new Request(`http://localhost/v1/catalog/checkout/revisions/${revA}/diagnostics`, {
        method: 'GET',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: [getCatalogDiagnosticsRestBinding],
        ...systemReadAuthContext(),
      },
    );

    const body = (await response.json()) as Record<string, unknown>;
    expect(body['installed']).toBe(true);
    expect(body['active']).toBe(false);
    expect(body['removable']).toBe(true);
    const references = body['references'] as Record<string, number>;
    expect(references['registeredDefinitions']).toBe(0);
  });

  it('rejects an empty name or revision at the operation-input layer', async () => {
    engine = createOperationTestEngine();

    const result = await executeOperation(
      'weft.catalog.diagnostics',
      { name: '', revision: 'r1' },
      {
        principal: principalFromApiKey({ subject: 'test', scopes: ['system:read'] }),
        engine,
        transport: 'jsonRpcStdio',
        registry,
      },
    );

    expect(result.ok).toBe(false);
  });

  it('rejects unauthenticated callers with 401', async () => {
    engine = createOperationTestEngine();
    const workerRegistry = new WorkerRegistry();
    const taskQueue = new TaskQueue();

    await assertOperationRejectsUnauthenticated({
      operationName: 'weft.catalog.diagnostics',
      engine,
      liveRegistry: createLiveOperationRegistry({ workerRegistry, taskQueue }),
    });
  });

  it('rejects callers without system:read with 403', async () => {
    engine = createOperationTestEngine();
    const workerRegistry = new WorkerRegistry();
    const taskQueue = new TaskQueue();

    await assertOperationRejectsInsufficientScope({
      operationName: 'weft.catalog.diagnostics',
      engine,
      liveRegistry: createLiveOperationRegistry({ workerRegistry, taskQueue }),
    });
  });
});

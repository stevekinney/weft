import { sleepForTesting } from '../testing/fake-timers.test-support.ts';
/**
 * Operation-catalog live verification — verifies that `serve()` wires the
 * live `OperationRegistry` + `REST_BINDINGS` into `handleRequest`, and that
 * `weft.workflows.get` resolves end-to-end through the shared pipeline.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { encode } from '../core/codec.ts';
import { Engine } from '../core/engine.ts';
import type { WorkflowContext, WorkflowState } from '../core/types.ts';
import { workflow } from '../core/types.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { WorkerDeploymentCatalog } from '../worker/deployment-routing.ts';
import type { WorkerManifest } from '../worker/manifest/types.ts';
import { resolveWorkflowWorkerStartBinding } from '../worker/versioning-policy.ts';
import { signJWT } from './authentication.ts';
import { serve, type WeftServer } from './index.ts';
import { jsonRecord, propertyRecord, record } from './protocol.test-support.ts';
import { createLiveOperationRegistry, REST_BINDINGS } from './rest-bindings.ts';

const holdWorkflow = workflow({ name: 'hold' }).execute(async function* (
  ctx: WorkflowContext,
  _input: unknown,
) {
  return yield* ctx.waitForSignal<string>('release');
});

const TEST_SECRET = 'operation-catalog-live-secret-1234567890';
const WORKER_OVERRIDE_SECRET = 'operation-catalog-worker-override-secret';
const PREVIEW_WORKFLOW_TYPE = 'operation-catalog-preview-workflow';
const PREVIEW_WORKFLOW_REVISION = 'operation-catalog-preview-revision';

function createHoldEngine(): Engine {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register(holdWorkflow);
  return engine;
}

async function waitForStatus(
  engine: Engine,
  workflowId: string,
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out',
  timeoutMilliseconds = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const state = await engine.get(workflowId);
    if (state?.status === status) return;
    await sleepForTesting(5);
  }
  throw new Error(`workflow ${workflowId} did not reach ${status} in time`);
}

async function issueJwt(): Promise<string> {
  return signJWT(
    {
      sub: 'operation-catalog-user',
      scope: ['system:admin', 'workflows:read', 'workflows:write'].join(' '),
    },
    TEST_SECRET,
  );
}

async function postJsonRpc(
  server: WeftServer,
  method: string,
  params: Record<string, unknown>,
  token: string,
): Promise<Response> {
  return fetch(`${server.url}/jsonrpc`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method,
      params,
    }),
  });
}

describe('operation catalog — live operation registry matches REST_BINDINGS', () => {
  it('The runtime API has one transport-neutral operation catalog', async () => {
    const engine = createHoldEngine();
    const getHandle = await engine.start('hold', { track: 'get' }, { id: 'parity-get' });
    const restSignalHandle = await engine.start(
      'hold',
      { track: 'signal-rest' },
      { id: 'parity-signal-rest' },
    );
    const jsonRpcSignalHandle = await engine.start(
      'hold',
      { track: 'signal-jsonrpc' },
      { id: 'parity-signal-jsonrpc' },
    );

    await waitForStatus(engine, getHandle.id, 'running');
    await waitForStatus(engine, restSignalHandle.id, 'running');
    await waitForStatus(engine, jsonRpcSignalHandle.id, 'running');

    const server = serve({
      engine,
      port: 0,
      auth: { jwt: { secret: TEST_SECRET } },
    });
    const token = await issueJwt();

    try {
      const restGet = await fetch(`${server.url}/v1/workflows/${getHandle.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(restGet.status).toBe(200);
      const restGetBody = record(await restGet.json(), 'REST workflow response');

      const jsonRpcGet = await postJsonRpc(
        server,
        'weft.workflows.get',
        { workflowId: getHandle.id },
        token,
      );
      expect(jsonRpcGet.status).toBe(200);
      const jsonRpcGetBody = record(await jsonRpcGet.json(), 'JSON-RPC workflow response');
      const jsonRpcGetResult = propertyRecord(jsonRpcGetBody, 'result');

      expect(jsonRpcGetBody['error']).toBeUndefined();
      expect(restGetBody['id']).toBe(getHandle.id);
      expect(jsonRpcGetResult?.['id']).toBe(getHandle.id);

      const restSignal = await fetch(
        `${server.url}/v1/workflows/${restSignalHandle.id}/signal/release`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ payload: 'rest-release' }),
        },
      );
      expect(restSignal.status).toBe(200);
      expect(await restSignal.json()).toEqual({ ok: true });

      const jsonRpcSignal = await postJsonRpc(
        server,
        'weft.workflows.signal',
        {
          workflowId: jsonRpcSignalHandle.id,
          signalName: 'release',
          payload: 'jsonrpc-release',
        },
        token,
      );
      expect(jsonRpcSignal.status).toBe(200);
      expect(await jsonRpcSignal.json()).toEqual({
        jsonrpc: '2.0',
        id: expect.any(String),
        result: { ok: true },
      });

      expect(restSignalHandle.result()).resolves.toBe('rest-release');
      expect(jsonRpcSignalHandle.result()).resolves.toBe('jsonrpc-release');
    } finally {
      await server.stop();
      engine[Symbol.dispose]();
    }
  });

  it('createLiveOperationRegistry resolves every operation referenced by REST_BINDINGS', () => {
    const registry = createLiveOperationRegistry();
    for (const binding of REST_BINDINGS) {
      const operation = registry.get(binding.operationName);
      expect(operation).toBeDefined();
      expect(operation?.name).toBe(binding.operationName);
    }
  });

  it('REST_BINDINGS mounts weft.workflows.get at GET /v1/workflows/:id', () => {
    const binding = REST_BINDINGS.find((b) => b.method === 'GET' && b.path === '/v1/workflows/:id');
    expect(binding).toBeDefined();
    expect(binding?.operationName).toBe('weft.workflows.get');
  });

  it('REST_BINDINGS mounts the worker start override preview route', () => {
    const binding = REST_BINDINGS.find(
      (candidate) =>
        candidate.method === 'POST' && candidate.path === '/v1/worker-start-overrides/preview',
    );

    expect(binding).toBeDefined();
    expect(binding?.operationName).toBe('weft.worker.startoverrides.preview');
  });
});

describe('operation catalog — end-to-end serve() to REST pipeline', () => {
  let server: WeftServer | undefined;
  let engine: Engine | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('GET /v1/workflows/:id returns the workflow state', async () => {
    engine = createHoldEngine();
    const handle = await engine.start('hold', { track: 8 }, {});
    await waitForStatus(engine, handle.id, 'running');

    server = serve({ engine, port: 0 });
    const response = await fetch(`${server.url}/v1/workflows/${handle.id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    const body = record(await response.json(), 'workflow response');
    expect(body['id']).toBe(handle.id);
  });

  it('GET /openapi.json returns a valid OpenAPI 3.1 document that includes the route', async () => {
    engine = createHoldEngine();
    server = serve({ engine, port: 0 });

    const response = await fetch(`${server.url}/openapi.json`);
    expect(response.status).toBe(200);
    const doc = jsonRecord(await response.text(), 'OpenAPI document');
    expect(doc['openapi']).toMatch(/^3\.1/);
    expect(record(doc['paths'], 'OpenAPI paths')['/api/v1/workflows/{id}']).toBeDefined();
  });

  it('issues worker start override previews through REST and JSON-RPC HTTP', async () => {
    const storage = new MemoryStorage();
    await seedPreviewableWorkerStartOverrideWorkflow(storage, 'preview-rest');
    await seedPreviewableWorkerStartOverrideWorkflow(storage, 'preview-jsonrpc');
    engine = new Engine({ storage });
    server = serve({
      engine,
      port: 0,
      auth: { jwt: { secret: TEST_SECRET } },
      workerStartOverrideSigningSecret: WORKER_OVERRIDE_SECRET,
    });
    const token = await issueJwt();

    const restPreview = await fetch(`${server.url}/v1/worker-start-overrides/preview`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ workflowId: 'preview-rest', ttlMs: 50 }),
    });
    expect(restPreview.status).toBe(200);
    const restBody = record(await restPreview.json(), 'REST preview response');
    expect(propertyRecord(restBody, 'preview')).toMatchObject({
      scope: 'destructive:workflow-worker-version-binding',
      workflowId: 'preview-rest',
    });

    const jsonRpcPreview = await postJsonRpc(
      server,
      'weft.worker.startoverrides.preview',
      { workflowId: 'preview-jsonrpc', ttlMs: 50 },
      token,
    );
    expect(jsonRpcPreview.status).toBe(200);
    const jsonRpcBody = record(await jsonRpcPreview.json(), 'JSON-RPC preview response');
    const result = propertyRecord(jsonRpcBody, 'result');
    if (result === undefined) throw new Error('JSON-RPC preview response did not include result.');
    expect(propertyRecord(result, 'preview')).toMatchObject({
      scope: 'destructive:workflow-worker-version-binding',
      workflowId: 'preview-jsonrpc',
    });
  });
});

async function seedPreviewableWorkerStartOverrideWorkflow(
  storage: MemoryStorage,
  workflowId: string,
): Promise<void> {
  const catalog = new WorkerDeploymentCatalog(storage);
  await registerPreviewManifest(catalog, 'build-1', 'sha256:current-workflow');
  await registerPreviewManifest(catalog, 'build-2', 'sha256:target-workflow');
  await catalog.setRouting({
    deploymentName: 'operation-catalog-preview',
    currentBuildId: 'build-1',
    rampBasisPoints: 10_000,
    updatedAt: 1,
  });
  const currentBinding = await resolveWorkflowWorkerStartBinding(storage, {
    workflowId,
    workflowType: PREVIEW_WORKFLOW_TYPE,
    workflowRevision: PREVIEW_WORKFLOW_REVISION,
    policy: { mode: 'pinned' },
    checkpointId: workflowId,
    boundAt: 1,
  });
  await catalog.setRouting({
    deploymentName: 'operation-catalog-preview',
    currentBuildId: 'build-2',
    rampBasisPoints: 10_000,
    updatedAt: 2,
  });
  const targetBinding = await resolveWorkflowWorkerStartBinding(storage, {
    workflowId,
    workflowType: PREVIEW_WORKFLOW_TYPE,
    workflowRevision: PREVIEW_WORKFLOW_REVISION,
    policy: { mode: 'pinned' },
    checkpointId: workflowId,
    boundAt: 2,
  });
  await storage.put(
    KEYS.workflow(workflowId),
    encode({
      id: workflowId,
      type: PREVIEW_WORKFLOW_TYPE,
      status: 'completed',
      input: null,
      result: 'ok',
      versionTuple: { workflowVersion: '0.0.0' },
      revision: PREVIEW_WORKFLOW_REVISION,
      workflowExecutionToken: `${workflowId}-token`,
      createdAt: 1,
      startedAt: 1,
      updatedAt: 2,
      workerVersioningPolicy: {
        mode: 'auto-upgrade',
        compatibility: {
          deploymentName: targetBinding.deploymentName,
          buildId: targetBinding.buildId,
          artifactDigest: targetBinding.artifactDigest,
          manifestDigest: targetBinding.manifestDigest,
          workflowRevision: targetBinding.workflowRevision,
          activityContractHash: targetBinding.activityContractHash,
        },
      },
      workerBinding: { current: currentBinding, history: [] },
    } satisfies WorkflowState),
  );
}

async function registerPreviewManifest(
  catalog: WorkerDeploymentCatalog,
  buildId: string,
  workflowContractHash: string,
): Promise<void> {
  const manifest: WorkerManifest = {
    manifestVersion: 1,
    protocolVersion: 1,
    sdkVersion: 'test',
    runtime: { name: 'bun', version: 'test' },
    deployment: {
      name: 'operation-catalog-preview',
      buildId,
      artifactDigest: `sha256:${buildId}`,
    },
    workflows: {
      [PREVIEW_WORKFLOW_TYPE]: {
        workflowVersion: '0.0.0',
        workflowRevision: PREVIEW_WORKFLOW_REVISION,
        contractHash: workflowContractHash,
        activities: {
          issuePreview: {
            contractHash: `sha256:issue-preview-${buildId}`,
            implementationRevision: buildId,
          },
        },
      },
    },
    capabilities: {},
  };
  await catalog.registerVersion({
    deploymentName: manifest.deployment.name,
    buildId,
    artifactDigest: manifest.deployment.artifactDigest,
    manifestDigest: `sha256:manifest-${buildId}`,
    manifest,
    state: 'ready',
    firstSeenAt: 1,
  });
}

/**
 * The worker start override over the wire (COR-164): `weft.workflows.startorsignal`
 * accepts the preview token for a terminal run's `start-new` replacement, and a
 * token that cannot authorize a start is a typed `Conflict`, not an engine
 * failure or a bare validation error.
 */
import { describe, expect, it } from 'bun:test';

import { principalFromApiKey } from "../../embedded/backchannel/src/index.ts";
import { createOperationRegistry, executeOperation } from "../../embedded/backchannel/src/internals.ts";
import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { waitForCondition } from "../../../test-support/embedded/testing/src/fake-timers.ts";
import { decode } from '../../core/codec.ts';
import { Engine } from '../../core/engine/index.ts';
import { workflow, type WorkflowState } from '../../core/types.ts';
import { KEYS } from '../../storage/keys.ts';
import { WorkerDeploymentCatalog } from '../../worker/deployment-routing.ts';
import type { WorkerManifest } from '../../worker/manifest/types.ts';
import { issueWorkflowWorkerStartOverridePreview } from '../../worker/start-override-preview.ts';
import { resolveWorkflowWorkerStartBinding } from '../../worker/versioning-policy.ts';
import { createStartOrSignalWorkflowOperation } from './start-or-signal-workflow.ts';
import { createStartWorkflowOperation } from './start-workflow.ts';
import { buildClientBody } from './worker-start-override-wire.test-support.ts';

const SECRET = 'wire-secret';

function manifest(workflowName: string, revision: string, buildId: string): WorkerManifest {
  return {
    manifestVersion: 1,
    protocolVersion: 1,
    sdkVersion: 'test',
    runtime: { name: 'bun', version: 'test' },
    deployment: { name: 'test-deployment', buildId, artifactDigest: `sha256:${buildId}` },
    workflows: {
      [workflowName]: {
        workflowVersion: '0.0.0',
        workflowRevision: revision,
        contractHash: 'sha256:workflow',
        activities: { charge: { contractHash: 'sha256:charge', implementationRevision: buildId } },
      },
    },
    capabilities: {},
  };
}

async function terminalRunWithTargetPreview(engineKnowsSecret = true) {
  const storage = new MemoryStorage();
  const engine = new Engine({
    storage,
    ...(engineKnowsSecret ? { workerStartOverrideSigningSecret: SECRET } : {}),
  });
  engine.register(
    workflow({ name: 'wired-restart', workerVersioningPolicy: { mode: 'pinned' } }).execute(
      async function* () {
        return 'ok';
      },
    ),
  );
  const revisions = await engine.workflows.listRevisions('wired-restart');
  const revision = revisions[0]?.manifest.revision ?? '';
  const catalog = new WorkerDeploymentCatalog(storage);
  for (const buildId of ['build-1', 'build-2']) {
    const buildManifest = manifest('wired-restart', revision, buildId);
    await catalog.registerVersion({
      deploymentName: 'test-deployment',
      buildId,
      artifactDigest: buildManifest.deployment.artifactDigest,
      manifestDigest: `sha256:manifest-${buildId}`,
      manifest: buildManifest,
      state: 'ready',
      firstSeenAt: 1,
    });
  }
  await catalog.setRouting({
    deploymentName: 'test-deployment',
    currentBuildId: 'build-1',
    rampBasisPoints: 10_000,
    updatedAt: 1,
  });
  const first = await engine.start('wired-restart', null, { id: 'wired-restart-1' });
  await first.result();
  const terminal = decode((await storage.get(KEYS.workflow(first.id)))!) as WorkflowState;
  await catalog.setRouting({
    deploymentName: 'test-deployment',
    currentBuildId: 'build-2',
    rampBasisPoints: 10_000,
    updatedAt: 2,
    expectedGeneration: 1,
  });
  const targetBinding = await resolveWorkflowWorkerStartBinding(storage, {
    workflowId: first.id,
    workflowType: 'wired-restart',
    workflowRevision: revision,
    policy: { mode: 'pinned' },
    checkpointId: first.id,
    boundAt: Date.now(),
  });
  const preview = issueWorkflowWorkerStartOverridePreview({
    workflowId: first.id,
    previousBinding: terminal.workerBinding!.current,
    targetBinding,
    serverSecret: SECRET,
  });
  return { engine, storage, id: first.id, preview };
}

async function waitForTerminal(storage: MemoryStorage, id: string): Promise<void> {
  await waitForCondition(
    async () => {
      const bytes = await storage.get(KEYS.workflow(id));
      return bytes !== null && (decode(bytes) as WorkflowState).status === 'completed';
    },
    { label: 'the restarted run to finish' },
  );
}

function call(
  engine: Engine,
  registry: ReturnType<typeof createOperationRegistry>,
  name: string,
  input: unknown,
) {
  return executeOperation(name, input, {
    principal: principalFromApiKey({ subject: 'op', scopes: ['workflows:write', 'signals:write'] }),
    host: engine,
    transport: 'jsonRpcStdio',
    registry,
  });
}

describe('weft.workflows.startorsignal with a worker start override', () => {
  it('replaces a terminal run on the previewed build, once, and refuses the same token again as a Conflict', async () => {
    const { engine, storage, id, preview } = await terminalRunWithTargetPreview();
    const registry = createOperationRegistry([
      createStartOrSignalWorkflowOperation({ workerStartOverrideSigningSecret: SECRET }),
    ]);
    const input = {
      type: 'wired-restart',
      input: null,
      id,
      signalName: 'go',
      signalId: 'sig-1',
      onTerminalConflict: 'start-new',
      workerStartOverridePreview: preview,
    };

    const first = await call(engine, registry, 'weft.workflows.startorsignal', input);
    expect(first.ok).toBe(true);
    const restarted = decode((await storage.get(KEYS.workflow(id)))!) as WorkflowState;
    expect(restarted.workerBinding?.current.buildId).toBe('build-2');

    // The fresh run finishes, then the spent token is refused, with a reason a client can branch on.
    await waitForTerminal(storage, id);
    const second = await call(engine, registry, 'weft.workflows.startorsignal', {
      ...input,
      signalId: 'sig-2',
    });
    engine[Symbol.dispose]();
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('expected a fault');
    expect(second.fault).toMatchObject({
      code: 'Conflict',
      data: { reason: 'override-token-rejected' },
    });
  });

  it('refuses an expired or tampered token as a Conflict, and a malformed one as InvalidParams', async () => {
    const { engine, id, preview } = await terminalRunWithTargetPreview();
    const registry = createOperationRegistry([
      createStartOrSignalWorkflowOperation({ workerStartOverrideSigningSecret: SECRET }),
    ]);
    const base = {
      type: 'wired-restart',
      input: null,
      id,
      signalName: 'go',
      onTerminalConflict: 'start-new',
    };

    const tampered = await call(engine, registry, 'weft.workflows.startorsignal', {
      ...base,
      signalId: 'sig-a',
      workerStartOverridePreview: { ...preview, token: 'forged' },
    });
    const expired = await call(engine, registry, 'weft.workflows.startorsignal', {
      ...base,
      signalId: 'sig-b',
      workerStartOverridePreview: { ...preview, expiresAt: 1 },
    });
    const malformed = await call(engine, registry, 'weft.workflows.startorsignal', {
      ...base,
      signalId: 'sig-c',
      workerStartOverridePreview: { token: 'x' },
    });
    engine[Symbol.dispose]();

    for (const result of [tampered, expired]) {
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected a fault');
      expect(result.fault).toMatchObject({
        code: 'Conflict',
        data: { reason: 'override-token-rejected' },
      });
    }
    expect(malformed.ok).toBe(false);
    if (malformed.ok) throw new Error('expected a fault');
    expect(malformed.fault.code).toBe('InvalidParams');
  });

  it('refuses a token when the server has no signing secret to verify it', async () => {
    const { engine, id, preview } = await terminalRunWithTargetPreview(false);
    const registry = createOperationRegistry([createStartOrSignalWorkflowOperation()]);
    const result = await call(engine, registry, 'weft.workflows.startorsignal', {
      type: 'wired-restart',
      input: null,
      id,
      signalName: 'go',
      signalId: 'sig-d',
      onTerminalConflict: 'start-new',
      workerStartOverridePreview: preview,
    });
    engine[Symbol.dispose]();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a fault');
    expect(result.fault).toMatchObject({
      code: 'Conflict',
      data: { reason: 'override-token-rejected' },
    });
  });
});

describe('weft.workflows.start with a worker start override', () => {
  it('refuses a token that does not match a terminal replacement as a Conflict', async () => {
    const { engine, preview } = await terminalRunWithTargetPreview();
    const registry = createOperationRegistry([
      createStartWorkflowOperation({ workerStartOverrideSigningSecret: SECRET }),
    ]);
    const result = await call(engine, registry, 'weft.workflows.start', {
      type: 'wired-restart',
      input: null,
      id: 'a-different-workflow',
      workerStartOverridePreview: preview,
    });
    engine[Symbol.dispose]();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a fault');
    expect(result.fault).toMatchObject({
      code: 'Conflict',
      data: { reason: 'override-token-rejected' },
    });
  });
});

describe('the HTTP client sends the override token', () => {
  it('carries workerStartOverridePreview on start and start-or-signal bodies', () => {
    const preview = { token: 't', scope: 'destructive:workflow-worker-version-binding' } as never;
    const bodies = buildClientBody(preview);
    expect(bodies.start).toMatchObject({ workerStartOverridePreview: preview });
    expect(bodies.startOrSignal).toMatchObject({ workerStartOverridePreview: preview });
  });
});

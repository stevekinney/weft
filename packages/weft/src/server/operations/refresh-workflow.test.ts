/**
 * `weft.workflows.refresh` operation + REST binding: unit tests.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { principalFromApiKey } from "../../embedded/backchannel/src/index.ts";
import { executeOperation } from "../../embedded/backchannel/src/internals.ts";
import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { WorkflowRevisionTombstonedError } from '../../core/catalog/errors.ts';
import { WorkflowCatalog } from '../../core/catalog/index.ts';
import { Engine } from '../../core/engine.ts';
import { handleRequest } from '../handler.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
import {
  REFRESH_TEST_WORKFLOW,
  refreshArtifact,
  refreshSource,
} from './refresh-workflow.test-support.ts';

function createEngine(): Engine {
  return new Engine({ storage: new MemoryStorage() });
}

const registry = createLiveOperationRegistry();

async function refresh(
  engine: Engine,
  input: Record<string, unknown>,
  scopes: readonly ('workflows:admin' | 'workflows:read')[] = ['workflows:admin'],
) {
  return executeOperation('weft.workflows.refresh', input, {
    principal: principalFromApiKey({ subject: 'operator', scopes: [...scopes] }),
    host: engine,
    transport: 'jsonRpcStdio',
    registry,
  });
}

async function refreshRest(engine: Engine, name: string, body: unknown) {
  return handleRequest(
    new Request(`http://localhost/v1/registry/workflows/${name}/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    engine,
    {
      authContext: {
        method: 'api-key' as const,
        principal: principalFromApiKey({ subject: 'operator', scopes: ['workflows:admin'] }),
      },
    },
  );
}

describe('weft.workflows.refresh', () => {
  let engine: Engine | undefined;

  afterEach(async () => {
    await engine?.[Symbol.asyncDispose]();
    engine = undefined;
  });

  it('installs a candidate without activating it by default', async () => {
    engine = createEngine();
    const artifact = await refreshArtifact('r1');
    await engine.workflows.registerRefreshSource(
      REFRESH_TEST_WORKFLOW,
      refreshSource(() => artifact),
    );

    const result = await refresh(engine, { name: REFRESH_TEST_WORKFLOW });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value).toEqual({
      status: 'installed',
      etag: artifact.digest,
      revision: 'r1',
      contractHash: artifact.manifest.contractHash,
    });
    expect(await engine.workflows.getActive(REFRESH_TEST_WORKFLOW)).toBeNull();
  });

  it('reports not-modified after a 304 on the next check', async () => {
    engine = createEngine();
    const artifact = await refreshArtifact('r1');
    await engine.workflows.registerRefreshSource(
      REFRESH_TEST_WORKFLOW,
      refreshSource(() => artifact),
    );
    await refresh(engine, { name: REFRESH_TEST_WORKFLOW });

    const result = await refresh(engine, { name: REFRESH_TEST_WORKFLOW });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value).toEqual({ status: 'not-modified', etag: artifact.digest });
  });

  it('activates under the generation fence with activate "if-compatible"', async () => {
    engine = createEngine();
    const artifact = await refreshArtifact('r1');
    await engine.workflows.registerRefreshSource(
      REFRESH_TEST_WORKFLOW,
      refreshSource(() => artifact),
    );

    const result = await refresh(engine, {
      name: REFRESH_TEST_WORKFLOW,
      activate: 'if-compatible',
      expectedGeneration: 0,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value).toMatchObject({
      status: 'activated',
      revision: 'r1',
      activation: { applied: true, pointer: { revision: 'r1', generation: 1 } },
    });
    const active = await engine.workflows.getActive(REFRESH_TEST_WORKFLOW);
    expect(active?.revision).toBe('r1');
  });

  it('returns the structured stale-generation refusal as data, with the candidate installed', async () => {
    engine = createEngine();
    let current = await refreshArtifact('r1');
    await engine.workflows.registerRefreshSource(
      REFRESH_TEST_WORKFLOW,
      refreshSource(() => current, { fetch: async () => ({ status: 200, artifact: current }) }),
    );
    await refresh(engine, {
      name: REFRESH_TEST_WORKFLOW,
      activate: 'if-compatible',
      expectedGeneration: 0,
    });
    current = await refreshArtifact('r2');

    const result = await refresh(engine, {
      name: REFRESH_TEST_WORKFLOW,
      activate: 'if-compatible',
      expectedGeneration: 0,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value).toMatchObject({
      status: 'installed',
      revision: 'r2',
      activation: { applied: false, reason: 'stale-generation', currentGeneration: 1 },
    });
    expect(await engine.workflows.getRevision(REFRESH_TEST_WORKFLOW, 'r2')).not.toBeNull();
  });

  it('returns the incompatible refusal with every compatibility reason', async () => {
    engine = createEngine();
    let current = await refreshArtifact('r1', '1.0.0');
    await engine.workflows.registerRefreshSource(
      REFRESH_TEST_WORKFLOW,
      refreshSource(() => current, { fetch: async () => ({ status: 200, artifact: current }) }),
    );
    await refresh(engine, {
      name: REFRESH_TEST_WORKFLOW,
      activate: 'if-compatible',
      expectedGeneration: 0,
    });
    current = await refreshArtifact('r2', '2.0.0');

    const result = await refresh(engine, {
      name: REFRESH_TEST_WORKFLOW,
      activate: 'if-compatible',
      expectedGeneration: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    const activation = (
      result.value as { activation?: { reason?: string; compatibilityReasons?: string[] } }
    ).activation;
    expect(activation?.reason).toBe('incompatible');
    expect(activation?.compatibilityReasons).toContain('workflow-version-incompatible');
  });

  it('returns the activation-conflict and generation-required refusals as data too', async () => {
    engine = createEngine();
    const artifact = await refreshArtifact('r1');
    await engine.workflows.registerRefreshSource(
      REFRESH_TEST_WORKFLOW,
      refreshSource(() => artifact, { fetch: async () => ({ status: 200, artifact }) }),
    );
    // The catalog's own refusals are injected: reaching each one for real is the catalog's tests.
    const activate = spyOn(WorkflowCatalog.prototype, 'activateCandidate')
      .mockResolvedValueOnce({ applied: false, reason: 'conflict' })
      .mockResolvedValueOnce({
        applied: false,
        reason: 'expected-generation-required',
        currentGeneration: 4,
      });

    try {
      const conflict = await refresh(engine, {
        name: REFRESH_TEST_WORKFLOW,
        activate: 'if-compatible',
      });
      const required = await refresh(engine, {
        name: REFRESH_TEST_WORKFLOW,
        activate: 'if-compatible',
      });

      expect(conflict.ok && conflict.value).toMatchObject({
        status: 'installed',
        activation: { applied: false, reason: 'conflict' },
      });
      expect(required.ok && required.value).toMatchObject({
        activation: {
          applied: false,
          reason: 'expected-generation-required',
          currentGeneration: 4,
        },
      });
    } finally {
      activate.mockRestore();
    }
  });

  const refusals: ReadonlyArray<
    readonly [
      string,
      'Conflict',
      (artifact: Awaited<ReturnType<typeof refreshArtifact>>) => unknown,
    ]
  > = [
    ['refresh-integrity', 'Conflict', (artifact) => ({ ...artifact, digest: 'sha256:wrong' })],
    [
      'refresh-identity',
      'Conflict',
      (artifact) => ({
        ...artifact,
        identity: { name: artifact.identity.name, revision: 'other' },
      }),
    ],
    [
      'refresh-contract',
      'Conflict',
      async (artifact) => {
        const broken = { ...artifact.manifest, contractHash: 'sha256:not-the-contract-hash' };
        const bytes = new TextEncoder().encode(
          JSON.stringify({
            manifest: broken,
            identity: artifact.identity,
            runtime: artifact.runtime,
          }),
        );
        const digestBytes = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
        const digest = `sha256:${[...new Uint8Array(digestBytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
        return { ...artifact, manifest: broken, bytes, digest };
      },
    ],
  ];

  for (const [reason, code, corrupt] of refusals) {
    it(`faults ${code} with reason "${reason}" for a refused candidate, installing nothing`, async () => {
      engine = createEngine();
      const good = await refreshArtifact('r1');
      const bad = (await corrupt(good)) as typeof good;
      await engine.workflows.registerRefreshSource(
        REFRESH_TEST_WORKFLOW,
        refreshSource(() => bad, { fetch: async () => ({ status: 200, artifact: bad }) }),
      );

      const result = await refresh(engine, { name: REFRESH_TEST_WORKFLOW });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.fault.code).toBe(code);
      expect((result.fault.data as { reason?: string }).reason).toBe(reason);
      expect(await engine.workflows.getRevision(REFRESH_TEST_WORKFLOW, 'r1')).toBeNull();
    });
  }

  it('faults Conflict "refresh-runtime" and "refresh-warming" without leaking the host message', async () => {
    engine = createEngine();
    const artifact = await refreshArtifact('r1');
    await engine.workflows.registerRefreshSource(
      REFRESH_TEST_WORKFLOW,
      refreshSource(() => artifact, {
        validateRuntime: () => {
          throw new Error('runtime check failed at /srv/secret/path');
        },
      }),
    );

    const runtime = await refresh(engine, { name: REFRESH_TEST_WORKFLOW });

    expect(runtime.ok).toBe(false);
    if (runtime.ok) throw new Error('expected failure');
    expect((runtime.fault.data as { reason?: string }).reason).toBe('refresh-runtime');
    expect(JSON.stringify(runtime.fault)).not.toContain('/srv/secret/path');

    await engine.workflows.registerRefreshSource(
      REFRESH_TEST_WORKFLOW,
      refreshSource(() => artifact, {
        warm: async () => {
          throw new Error('warm failed for https://user:pass@registry.example/x');
        },
      }),
    );
    const warming = await refresh(engine, { name: REFRESH_TEST_WORKFLOW });

    expect(warming.ok).toBe(false);
    if (warming.ok) throw new Error('expected failure');
    expect((warming.fault.data as { reason?: string }).reason).toBe('refresh-warming');
    expect(JSON.stringify(warming.fault)).not.toContain('user:pass');
  });

  it('faults Unavailable "refresh-source" when the source cannot be reached', async () => {
    engine = createEngine();
    const artifact = await refreshArtifact('r1');
    await engine.workflows.registerRefreshSource(
      REFRESH_TEST_WORKFLOW,
      refreshSource(() => artifact, {
        fetch: async () => {
          throw new Error('connect ECONNREFUSED 10.0.0.7:443');
        },
      }),
    );

    const result = await refresh(engine, { name: REFRESH_TEST_WORKFLOW });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.fault.code).toBe('Unavailable');
    expect((result.fault.data as { reason?: string }).reason).toBe('refresh-source');
    expect(JSON.stringify(result.fault)).not.toContain('10.0.0.7');
  });

  it('faults Conflict, not a masked failure, when the served revision was removed (tombstoned)', async () => {
    engine = createEngine();
    const artifact = await refreshArtifact('r1');
    await engine.workflows.registerRefreshSource(
      REFRESH_TEST_WORKFLOW,
      refreshSource(() => artifact),
    );
    // The catalog raises this only after losing an install race to a removal; reproducing the race
    // would test the storage layer, so the catalog's own error is injected.
    const install = spyOn(WorkflowCatalog.prototype, 'install').mockRejectedValueOnce(
      new WorkflowRevisionTombstonedError(REFRESH_TEST_WORKFLOW, 'r1'),
    );

    try {
      const result = await refresh(engine, { name: REFRESH_TEST_WORKFLOW });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.fault.code).toBe('Conflict');
    } finally {
      install.mockRestore();
    }
    expect(engine.workflows.refreshDiagnostics(REFRESH_TEST_WORKFLOW)[0]?.reason).toBe('conflict');
  });

  it('faults NotFound when no refresh source is registered for the name', async () => {
    engine = createEngine();

    const result = await refresh(engine, { name: 'never-registered' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.fault.code).toBe('NotFound');
  });

  it('faults InvalidParams for an unknown activate mode, a bad generation, and a bad name', async () => {
    engine = createEngine();

    for (const input of [
      { name: REFRESH_TEST_WORKFLOW, activate: 'always' },
      { name: REFRESH_TEST_WORKFLOW, expectedGeneration: -1 },
      { name: '' },
    ]) {
      const result = await refresh(engine, input);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected failure');
      expect(result.fault.code).toBe('InvalidParams');
    }
  });

  it('requires workflows:admin — a workflows:read principal is forbidden', async () => {
    engine = createEngine();

    const result = await refresh(engine, { name: REFRESH_TEST_WORKFLOW }, ['workflows:read']);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.fault.code).toBe('Forbidden');
  });

  it('is reachable over REST at POST /v1/registry/workflows/:name/refresh — 200', async () => {
    engine = createEngine();
    const artifact = await refreshArtifact('r1');
    await engine.workflows.registerRefreshSource(
      REFRESH_TEST_WORKFLOW,
      refreshSource(() => artifact),
    );

    const response = await refreshRest(engine, REFRESH_TEST_WORKFLOW, {});

    expect(response.status).toBe(200);
    expect(((await response.json()) as { status?: string }).status).toBe('installed');
  });

  it('REST faults NotFound (404) for a name with no source and 400 for a bad mode', async () => {
    engine = createEngine();

    const unregistered = await refreshRest(engine, 'never-registered', {});
    const badMode = await refreshRest(engine, REFRESH_TEST_WORKFLOW, { activate: 'sometimes' });

    expect(unregistered.status).toBe(404);
    expect(badMode.status).toBe(400);
  });
});

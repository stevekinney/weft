/**
 * `weft.workflows.refresh.diagnostics` operation + REST binding: unit tests.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { principalFromApiKey } from "../../embedded/backchannel/src/index.ts";
import { executeOperation } from "../../embedded/backchannel/src/internals.ts";
import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { Engine } from '../../core/engine.ts';
import { handleRequest } from '../handler.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
import {
  REFRESH_TEST_WORKFLOW,
  refreshArtifact,
  refreshSource,
} from './refresh-workflow.test-support.ts';

const registry = createLiveOperationRegistry();

function createEngine(): Engine {
  return new Engine({ storage: new MemoryStorage() });
}

async function diagnostics(
  engine: Engine,
  input: Record<string, unknown> = {},
  scopes: readonly ('workflows:admin' | 'workflows:read')[] = ['workflows:read'],
) {
  return executeOperation('weft.workflows.refresh.diagnostics', input, {
    principal: principalFromApiKey({ subject: 'reader', scopes: [...scopes] }),
    host: engine,
    transport: 'jsonRpcStdio',
    registry,
  });
}

describe('weft.workflows.refresh.diagnostics', () => {
  let engine: Engine | undefined;

  afterEach(async () => {
    await engine?.[Symbol.asyncDispose]();
    engine = undefined;
  });

  it('is empty, with no polling, when no source is registered', async () => {
    engine = createEngine();

    const result = await diagnostics(engine);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value).toEqual({ sources: [] });
  });

  it('lists a registered, never-checked source as idle with no candidate', async () => {
    engine = createEngine();
    const artifact = await refreshArtifact('r1');
    await engine.workflows.registerRefreshSource(
      REFRESH_TEST_WORKFLOW,
      refreshSource(() => artifact),
    );

    const result = await diagnostics(engine);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value).toEqual({ sources: [{ name: REFRESH_TEST_WORKFLOW, state: 'idle' }] });
  });

  it('shows the candidate next to the active revision, with the digest of what refresh activated', async () => {
    engine = createEngine();
    let current = await refreshArtifact('r1');
    await engine.workflows.registerRefreshSource(
      REFRESH_TEST_WORKFLOW,
      refreshSource(() => current, { fetch: async () => ({ status: 200, artifact: current }) }),
    );
    const first = current;
    await engine.workflows.refresh(REFRESH_TEST_WORKFLOW, {
      activate: 'if-compatible',
      expectedGeneration: 0,
    });
    current = await refreshArtifact('r2');
    await engine.workflows.refresh(REFRESH_TEST_WORKFLOW);

    const result = await diagnostics(engine);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value).toMatchObject({
      sources: [
        {
          name: REFRESH_TEST_WORKFLOW,
          state: 'installed',
          candidate: {
            revision: 'r2',
            digest: current.digest,
            contractHash: current.manifest.contractHash,
          },
          current: {
            revision: 'r1',
            generation: 1,
            contractHash: first.manifest.contractHash,
            digest: first.digest,
          },
        },
      ],
    });
  });

  it('omits the current digest for an active revision refresh did not activate', async () => {
    engine = createEngine();
    const artifact = await refreshArtifact('r1');
    await engine.workflows.registerRefreshSource(
      REFRESH_TEST_WORKFLOW,
      refreshSource(() => artifact),
    );
    await engine.workflows.refresh(REFRESH_TEST_WORKFLOW);
    await engine.workflows.activate(REFRESH_TEST_WORKFLOW, 'r1', { expectedGeneration: 0 });

    const result = await diagnostics(engine);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    const [source] = (result.value as { sources: Array<{ current?: Record<string, unknown> }> })
      .sources;
    expect(source?.current).toEqual({
      revision: 'r1',
      generation: 1,
      contractHash: artifact.manifest.contractHash,
    });
  });

  it('reports a failed check as a bounded reason and never the host message', async () => {
    engine = createEngine();
    const artifact = await refreshArtifact('r1');
    await engine.workflows.registerRefreshSource(
      REFRESH_TEST_WORKFLOW,
      refreshSource(() => artifact, {
        warm: async () => {
          throw new Error('warm failed for https://user:pass@registry.example/x');
        },
      }),
    );
    await engine.workflows.refresh(REFRESH_TEST_WORKFLOW).catch(() => undefined);

    const result = await diagnostics(engine);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value).toMatchObject({
      sources: [{ state: 'failed', reason: 'warming' }],
    });
    expect(JSON.stringify(result.value)).not.toContain('user:pass');
  });

  it('reports the polling policy only while polling runs', async () => {
    engine = createEngine();
    const artifact = await refreshArtifact('r1');
    await engine.workflows.registerRefreshSource(
      REFRESH_TEST_WORKFLOW,
      refreshSource(() => artifact),
    );

    const manual = await diagnostics(engine);
    expect(manual.ok).toBe(true);
    if (!manual.ok) throw new Error('expected success');
    expect(manual.value).not.toHaveProperty('polling');

    await engine.workflows.startRefreshPolling();
    const polling = await diagnostics(engine);

    expect(polling.ok).toBe(true);
    if (!polling.ok) throw new Error('expected success');
    expect((polling.value as { polling?: { intervalMilliseconds: number } }).polling).toMatchObject(
      {
        intervalMilliseconds: 60_000,
        maxBackoffMilliseconds: 900_000,
        backoffMilliseconds: 60_000,
      },
    );
  });

  it('filters to one workflow name', async () => {
    engine = createEngine();
    const artifact = await refreshArtifact('r1');
    await engine.workflows.registerRefreshSource(
      REFRESH_TEST_WORKFLOW,
      refreshSource(() => artifact),
    );
    await engine.workflows.registerRefreshSource(
      'billing',
      refreshSource(() => artifact),
    );

    const result = await diagnostics(engine, { name: 'billing' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value).toEqual({ sources: [{ name: 'billing', state: 'idle' }] });
  });

  it('faults InvalidParams for a malformed name', async () => {
    engine = createEngine();

    const result = await diagnostics(engine, { name: '' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.fault.code).toBe('InvalidParams');
  });

  it('requires workflows:read — a principal without it is forbidden', async () => {
    engine = createEngine();

    const result = await executeOperation(
      'weft.workflows.refresh.diagnostics',
      {},
      {
        principal: principalFromApiKey({ subject: 'nobody', scopes: ['system:read'] }),
        host: engine,
        transport: 'jsonRpcStdio',
        registry,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.fault.code).toBe('Forbidden');
  });

  it('is reachable over REST at GET /v1/registry/refresh-diagnostics, with an optional name', async () => {
    engine = createEngine();
    const artifact = await refreshArtifact('r1');
    await engine.workflows.registerRefreshSource(
      REFRESH_TEST_WORKFLOW,
      refreshSource(() => artifact),
    );
    const authContext = {
      method: 'api-key' as const,
      principal: principalFromApiKey({ subject: 'reader', scopes: ['workflows:read'] }),
    };

    const all = await handleRequest(
      new Request('http://localhost/v1/registry/refresh-diagnostics'),
      engine,
      { authContext },
    );
    const none = await handleRequest(
      new Request('http://localhost/v1/registry/refresh-diagnostics?name=billing'),
      engine,
      { authContext },
    );

    expect(all.status).toBe(200);
    expect(await all.json()).toEqual({ sources: [{ name: REFRESH_TEST_WORKFLOW, state: 'idle' }] });
    expect(await none.json()).toEqual({ sources: [] });
  });
});

import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { rejectionOf, throwingRejectionOf } from '../../testing/promise-outcome.test-support.ts';
import { buildWorkflowContract } from '../contract/build.ts';
import { buildWorkflowRevisionManifest } from '../contract/manifest.ts';
import type { WorkflowRevisionManifest } from '../contract/types.ts';
import { Engine } from '../engine.ts';
import type { RegisteredWorkflowDefinition } from '../types/workflow-registry.ts';
import { WorkflowCatalog } from './workflow-catalog.ts';
import { WorkflowRefreshCoordinator, type WorkflowRefreshArtifact } from './workflow-refresh.ts';

const definition: RegisteredWorkflowDefinition = { type: 'checkout', version: '1.0.0', tags: [] };

async function manifest(revision = 'r1', version = '1.0.0'): Promise<WorkflowRevisionManifest> {
  return buildWorkflowRevisionManifest(buildWorkflowContract({ name: 'checkout', version }), {
    revision,
  });
}

async function artifact(value: WorkflowRevisionManifest): Promise<WorkflowRefreshArtifact> {
  const identity = { name: value.name, revision: value.revision };
  const runtime = 'bun@1.4.2';
  const bytes = new TextEncoder().encode(JSON.stringify({ manifest: value, identity, runtime }));
  const digestBytes = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  const digest = `sha256:${[...new Uint8Array(digestBytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  return { manifest: value, bytes, digest, identity, runtime };
}

describe('WorkflowRefreshCoordinator', () => {
  it('is exposed through the engine workflow lifecycle and maintenance API', async () => {
    const current = await manifest();
    const currentArtifact = await artifact(current);
    const engine = new Engine();
    const source = {
      fetch: async () => ({ status: 200 as const, artifact: currentArtifact }),
      warm: async () => definition,
      validateRuntime: () => {},
    };

    try {
      await engine.workflows.registerRefreshSource('checkout', source);
      expect(engine.workflows.refreshDiagnostics()).toEqual([]);
      const refreshed = await engine.workflows.refresh('checkout');
      expect(refreshed.status).toBe('installed');
      expect(engine.workflows.refreshDiagnostics('checkout')[0]?.state).toBe('installed');
      expect(await engine.workflows.runRefreshMaintenance()).toHaveLength(1);
      await engine.workflows.startRefreshPolling();
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('coalesces concurrent checks and sends the cached etag on the next check', async () => {
    const current = await manifest();
    const currentArtifact = await artifact(current);
    let fetches = 0;
    const coordinator = new WorkflowRefreshCoordinator({
      catalog: new WorkflowCatalog(new MemoryStorage()),
      sources: new Map([
        [
          'checkout',
          {
            fetch: async ({ etag }) => {
              fetches++;
              if (etag !== undefined) return { status: 304 as const, etag };
              return { status: 200 as const, etag: 'v1', artifact: currentArtifact };
            },
            warm: async () => definition,
            validateRuntime: () => {},
          },
        ],
      ]),
    });

    const [first, second] = await Promise.all([
      coordinator.refresh('checkout'),
      coordinator.refresh('checkout'),
    ]);
    expect(first.status).toBe('installed');
    expect(second.status).toBe('installed');
    expect(fetches).toBe(1);
    const unchanged = await coordinator.refresh('checkout');
    expect(unchanged.status).toBe('not-modified');
    expect(fetches).toBe(2);
  });

  it('installs and warms without activating, then activates only with a generation fence', async () => {
    const first = await manifest('r1');
    const second = await manifest('r2');
    let next = await artifact(first);
    const catalog = new WorkflowCatalog(new MemoryStorage());
    const coordinator = new WorkflowRefreshCoordinator({
      catalog,
      sources: new Map([
        [
          'checkout',
          {
            fetch: async () => ({ status: 200 as const, artifact: next }),
            warm: async () => definition,
            validateRuntime: () => {},
          },
        ],
      ]),
    });

    await coordinator.refresh('checkout');
    expect(catalog.resolveActive('checkout')).toBeUndefined();
    next = await artifact(second);
    const activated = await coordinator.refresh('checkout', {
      activate: 'if-compatible',
      expectedGeneration: 0,
    });
    expect(activated.status).toBe('activated');
    expect(catalog.resolveActive('checkout')?.revision).toBe('r2');
  });

  it('keeps an incompatible generation candidate installed without changing the active pointer', async () => {
    const first = await manifest('r1');
    const second = await manifest('r2', '2.0.0');
    let next = await artifact(first);
    const catalog = new WorkflowCatalog(new MemoryStorage());
    const coordinator = new WorkflowRefreshCoordinator({
      catalog,
      sources: new Map([
        [
          'checkout',
          {
            fetch: async () => ({ status: 200 as const, artifact: next }),
            warm: async () => definition,
            validateRuntime: () => {},
          },
        ],
      ]),
    });

    await coordinator.refresh('checkout', { activate: 'if-compatible', expectedGeneration: 0 });
    const active = catalog.resolveActive('checkout');
    next = await artifact(second);
    const stale = await coordinator.refresh('checkout', {
      activate: 'if-compatible',
      expectedGeneration: 1,
    });

    expect(stale.status).toBe('installed');
    expect(stale.activation?.applied).toBe(false);
    expect(
      stale.activation && 'reason' in stale.activation ? stale.activation.reason : undefined,
    ).toBe('incompatible');
    expect(catalog.resolveActive('checkout')).toEqual(active);
    expect(await catalog.listInstalledRevisions('checkout')).toHaveLength(2);
  });

  it('reports stale generation separately while preserving the active pointer', async () => {
    const first = await manifest('r1');
    const second = await manifest('r2');
    let next = await artifact(first);
    const catalog = new WorkflowCatalog(new MemoryStorage());
    const coordinator = new WorkflowRefreshCoordinator({
      catalog,
      sources: new Map([
        [
          'checkout',
          {
            fetch: async () => ({ status: 200 as const, artifact: next }),
            warm: async () => definition,
            validateRuntime: () => {},
          },
        ],
      ]),
    });

    await coordinator.refresh('checkout', { activate: 'if-compatible', expectedGeneration: 0 });
    const active = catalog.resolveActive('checkout');
    next = await artifact(second);
    const stale = await coordinator.refresh('checkout', {
      activate: 'if-compatible',
      expectedGeneration: 0,
    });

    expect(stale.status).toBe('installed');
    expect(stale.activation).toEqual({
      applied: false,
      reason: 'stale-generation',
      currentGeneration: 1,
    });
    expect(catalog.resolveActive('checkout')).toEqual(active);
  });

  it('rejects a mismatched immutable artifact digest before warming or installing', async () => {
    const current = await manifest();
    const currentArtifact = await artifact(current);
    let warmed = false;
    const catalog = new WorkflowCatalog(new MemoryStorage());
    const coordinator = new WorkflowRefreshCoordinator({
      catalog,
      sources: new Map([
        [
          'checkout',
          {
            fetch: async () => ({
              status: 200 as const,
              artifact: { ...currentArtifact, digest: 'sha256:wrong' },
            }),
            warm: async () => {
              warmed = true;
              return definition;
            },
            validateRuntime: () => {},
          },
        ],
      ]),
    });

    expect(await throwingRejectionOf(coordinator.refresh('checkout'))).toThrow('digest');
    expect(warmed).toBe(false);
    expect(await catalog.listInstalledRevisions('checkout')).toHaveLength(0);
    expect(coordinator.diagnostics('checkout')[0]?.state).toBe('failed');
  });

  it('rejects a first-check 304 and keeps conflicting activation requests separate', async () => {
    const current = await manifest();
    const currentArtifact = await artifact(current);
    const catalog = new WorkflowCatalog(new MemoryStorage());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const coordinator = new WorkflowRefreshCoordinator({
      catalog,
      sources: new Map([
        [
          'checkout',
          {
            fetch: async () => {
              await gate;
              return { status: 304 as const };
            },
            warm: async () => definition,
            validateRuntime: () => {},
          },
        ],
      ]),
    });
    const installed = coordinator.refresh('checkout', { activate: 'never' });
    release();
    expect(await throwingRejectionOf(installed)).toThrow('304');
    const secondCoordinator = new WorkflowRefreshCoordinator({
      catalog,
      sources: new Map([
        [
          'checkout',
          {
            fetch: async () => ({ status: 200 as const, artifact: currentArtifact }),
            warm: async () => definition,
            validateRuntime: () => {},
          },
        ],
      ]),
    });
    const never = secondCoordinator.refresh('checkout', { activate: 'never' });
    const activating = secondCoordinator.refresh('checkout', {
      activate: 'if-compatible',
      expectedGeneration: 0,
    });
    expect(never).not.toBe(activating);
    const activated = await activating;
    expect(activated.status).toBe('activated');
  });

  it('aborts blocked fetches during async disposal', async () => {
    let observedAbort = false;
    const caller = new AbortController();
    const coordinator = new WorkflowRefreshCoordinator({
      catalog: new WorkflowCatalog(new MemoryStorage()),
      sources: new Map([
        [
          'checkout',
          {
            fetch: async ({ signal }) =>
              await new Promise<never>((_resolve, reject) => {
                signal?.addEventListener(
                  'abort',
                  () => {
                    observedAbort = true;
                    reject(new Error('aborted'));
                  },
                  { once: true },
                );
              }),
            warm: async () => definition,
            validateRuntime: () => {},
          },
        ],
      ]),
    });
    const pending = coordinator.refresh('checkout', { signal: caller.signal });
    await coordinator[Symbol.asyncDispose]();
    expect(observedAbort).toBe(true);
    expect(await throwingRejectionOf(pending)).toThrow('aborted');
  });

  it('does not coalesce callers with different cancellation signals', async () => {
    const current = await manifest();
    const currentArtifact = await artifact(current);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const coordinator = new WorkflowRefreshCoordinator({
      catalog: new WorkflowCatalog(new MemoryStorage()),
      sources: new Map([
        [
          'checkout',
          {
            fetch: async ({ signal }) => {
              await gate;
              if (signal?.aborted) throw signal.reason;
              return { status: 200 as const, artifact: currentArtifact };
            },
            warm: async () => definition,
            validateRuntime: () => {},
          },
        ],
      ]),
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = coordinator.refresh('checkout', { signal: firstController.signal });
    const second = coordinator.refresh('checkout', { signal: secondController.signal });
    expect(first).not.toBe(second);
    firstController.abort(new Error('first caller cancelled'));
    release();
    expect(await throwingRejectionOf(first)).toThrow('first caller cancelled');
    const secondResult = await second;
    expect(secondResult.status).toBe('installed');
    await coordinator[Symbol.asyncDispose]();
  });

  it('settles refresh work before engine disposal resolves without installing afterward', async () => {
    const current = await manifest();
    const currentArtifact = await artifact(current);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let abortedResolve!: () => void;
    const aborted = new Promise<void>((resolve) => {
      abortedResolve = resolve;
    });
    let warmStartedResolve!: () => void;
    const warmStarted = new Promise<void>((resolve) => {
      warmStartedResolve = resolve;
    });
    const engine = new Engine();
    const source = {
      fetch: async () => ({ status: 200 as const, artifact: currentArtifact }),
      warm: async (_artifact: WorkflowRefreshArtifact, signal: AbortSignal) => {
        warmStartedResolve();
        await Promise.race([
          gate,
          new Promise<never>((_resolve, reject) =>
            signal.addEventListener(
              'abort',
              () => {
                abortedResolve();
                reject(signal.reason);
              },
              { once: true },
            ),
          ),
        ]);
        return definition;
      },
      validateRuntime: () => {},
    };

    await engine.workflows.registerRefreshSource('checkout', source);
    const pending = engine.workflows.refresh('checkout', {
      activate: 'if-compatible',
      expectedGeneration: 0,
    });
    await warmStarted;
    const disposal = engine[Symbol.asyncDispose]();
    await aborted;
    release();
    await disposal;
    expect(await rejectionOf(pending)).toBeDefined();
    expect(await engine.workflows.getRevision('checkout', current.revision)).toBeNull();
  });

  it('refuses synchronous disposal while activation CAS is blocked', async () => {
    const current = await manifest();
    const currentArtifact = await artifact(current);
    let activationResolve!: () => void;
    const activationEntered = new Promise<void>((resolve) => {
      activationResolve = resolve;
    });
    let releaseActivation!: () => void;
    const activationGate = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    const engine = new Engine();
    const storage = engine.storage;
    const conditionalBatch = storage.conditionalBatch!.bind(storage);
    storage.conditionalBatch = async (conditions, operations) => {
      if (conditions.length === 2 && operations.length === 1) {
        activationResolve();
        await activationGate;
      }
      return conditionalBatch(conditions, operations);
    };
    const source = {
      fetch: async () => ({ status: 200 as const, artifact: currentArtifact }),
      warm: async () => definition,
      validateRuntime: () => {},
    };

    await engine.workflows.registerRefreshSource('checkout', source);
    const pending = engine.workflows.refresh('checkout', {
      activate: 'if-compatible',
      expectedGeneration: 0,
    });
    await activationEntered;
    expect(() => engine[Symbol.dispose]()).toThrow('Cannot synchronously dispose');
    releaseActivation();
    const result = await pending;
    expect(result.status).toBe('activated');
    const active = await engine.workflows.getActive('checkout');
    expect(active?.revision).toBe(current.revision);
    await engine[Symbol.asyncDispose]();
  });

  it('runs one bounded polling tick and reschedules it before shutdown', async () => {
    const current = await manifest();
    const currentArtifact = await artifact(current);
    let fetchedResolve!: () => void;
    const fetched = new Promise<void>((resolve) => {
      fetchedResolve = resolve;
    });
    let warmedResolve!: () => void;
    const warmed = new Promise<void>((resolve) => {
      warmedResolve = resolve;
    });
    const coordinator = new WorkflowRefreshCoordinator({
      catalog: new WorkflowCatalog(new MemoryStorage()),
      pollIntervalMs: 1,
      sources: new Map([
        [
          'checkout',
          {
            fetch: async () => {
              fetchedResolve();
              return { status: 200 as const, artifact: currentArtifact };
            },
            warm: async () => {
              warmedResolve();
              return definition;
            },
            validateRuntime: () => {},
          },
        ],
      ]),
    });

    coordinator.startPolling();
    await fetched;
    await warmed;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(coordinator.diagnostics('checkout')[0]?.state).toBe('installed');
    await coordinator[Symbol.asyncDispose]();
  });

  it('backs off after a polling failure and still shuts down cleanly', async () => {
    const coordinator = new WorkflowRefreshCoordinator({
      catalog: new WorkflowCatalog(new MemoryStorage()),
      pollIntervalMs: 1,
      maxBackoffMs: 2,
      sources: new Map([
        [
          'checkout',
          {
            fetch: async () => {
              throw new Error('temporary refresh failure');
            },
            warm: async () => definition,
            validateRuntime: () => {},
          },
        ],
      ]),
    });

    coordinator.startPolling();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(coordinator.diagnostics('checkout')[0]?.state).toBe('failed');
    await coordinator[Symbol.asyncDispose]();
  });
});

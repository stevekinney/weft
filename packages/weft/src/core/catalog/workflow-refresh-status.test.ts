import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { rejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { buildWorkflowContract } from '../contract/build.ts';
import { buildWorkflowRevisionManifest } from '../contract/manifest.ts';
import type { WorkflowRevisionManifest } from '../contract/types.ts';
import { Engine } from '../engine.ts';
import type { RegisteredWorkflowDefinition } from '../types/workflow-registry.ts';
import { WorkflowCatalogConflictError } from './errors.ts';
import { WorkflowCatalog } from './workflow-catalog.ts';
import {
  WorkflowRefreshError,
  type WorkflowRefreshFailureReason,
} from './workflow-refresh-failure.ts';
import type { WorkflowRefreshArtifact, WorkflowRefreshSource } from './workflow-refresh-types.ts';
import { WorkflowRefreshCoordinator } from './workflow-refresh.ts';

const definition: RegisteredWorkflowDefinition = { type: 'checkout', version: '1.0.0', tags: [] };

async function manifest(revision = 'r1', version = '1.0.0'): Promise<WorkflowRevisionManifest> {
  return buildWorkflowRevisionManifest(buildWorkflowContract({ name: 'checkout', version }), {
    revision,
  });
}

async function artifactFor(value: WorkflowRevisionManifest): Promise<WorkflowRefreshArtifact> {
  const identity = { name: value.name, revision: value.revision };
  const runtime = 'bun@1.4.2';
  const bytes = new TextEncoder().encode(JSON.stringify({ manifest: value, identity, runtime }));
  const digestBytes = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  const digest = `sha256:${[...new Uint8Array(digestBytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  return { manifest: value, bytes, digest, identity, runtime };
}

function sourceOf(
  artifact: () => Promise<WorkflowRefreshArtifact> | WorkflowRefreshArtifact,
  overrides: Partial<WorkflowRefreshSource> = {},
): WorkflowRefreshSource {
  return {
    fetch: async () => ({ status: 200 as const, artifact: await artifact() }),
    warm: async () => definition,
    validateRuntime: () => {},
    ...overrides,
  };
}

function coordinatorFor(
  source: WorkflowRefreshSource,
  options: { catalog?: WorkflowCatalog; now?: () => number } = {},
): WorkflowRefreshCoordinator {
  return new WorkflowRefreshCoordinator({
    catalog: options.catalog ?? new WorkflowCatalog(new MemoryStorage()),
    sources: new Map([['checkout', source]]),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

async function failureOf(coordinator: WorkflowRefreshCoordinator) {
  const error = await rejectionOf(coordinator.refresh('checkout'));
  return { error, diagnostics: coordinator.diagnostics('checkout')[0] };
}

describe('WorkflowRefreshError reasons', () => {
  const cases: ReadonlyArray<
    readonly [WorkflowRefreshFailureReason, () => Promise<WorkflowRefreshSource>]
  > = [
    [
      'integrity',
      async () => {
        const good = await artifactFor(await manifest());
        return sourceOf(() => ({ ...good, digest: 'sha256:wrong' }));
      },
    ],
    [
      'integrity',
      async () => {
        const good = await artifactFor(await manifest());
        return sourceOf(() => ({ ...good, runtime: 'a different runtime' }));
      },
    ],
    [
      'identity',
      async () => {
        const good = await artifactFor(await manifest());
        return sourceOf(() => ({ ...good, identity: { name: 'checkout', revision: 'other' } }));
      },
    ],
    [
      'contract',
      async () => {
        const good = await manifest();
        const broken = { ...good, contractHash: 'sha256:not-the-contract-hash' };
        return sourceOf(() => artifactFor(broken));
      },
    ],
    [
      'runtime',
      async () =>
        sourceOf(async () => artifactFor(await manifest()), {
          validateRuntime: () => {
            throw new Error('runtime refused at /srv/secret/path');
          },
        }),
    ],
    [
      'warming',
      async () =>
        sourceOf(async () => artifactFor(await manifest()), {
          warm: async () => {
            throw new Error('warm failed for https://user:pass@registry.example/x');
          },
        }),
    ],
    [
      'source',
      async () =>
        sourceOf(async () => artifactFor(await manifest()), {
          fetch: async () => {
            throw new Error('connection reset');
          },
        }),
    ],
    [
      'source',
      async () =>
        sourceOf(async () => artifactFor(await manifest()), {
          fetch: async () => ({ status: 200 as const }),
        }),
    ],
    [
      'source',
      async () =>
        sourceOf(async () => artifactFor(await manifest()), {
          fetch: async () => ({ status: 304 as const }),
        }),
    ],
  ];

  for (const [reason, build] of cases) {
    it(`classifies a ${reason} failure as a typed error and records the reason`, async () => {
      const { error, diagnostics } = await failureOf(coordinatorFor(await build()));

      expect(error).toBeInstanceOf(WorkflowRefreshError);
      expect((error as WorkflowRefreshError).reason).toBe(reason);
      expect(diagnostics?.state).toBe('failed');
      expect(diagnostics?.reason).toBe(reason);
    });
  }

  it('keeps the host error as the cause and its message for in-process callers', async () => {
    const original = new Error('warm failed');
    const { error } = await failureOf(
      coordinatorFor(
        sourceOf(async () => artifactFor(await manifest()), {
          warm: async () => {
            throw original;
          },
        }),
      ),
    );

    expect((error as WorkflowRefreshError).message).toBe('warm failed');
    expect((error as WorkflowRefreshError).cause).toBe(original);
  });

  it('reports not-registered for a name with no source', async () => {
    const coordinator = coordinatorFor(sourceOf(async () => artifactFor(await manifest())));

    const error = await rejectionOf(coordinator.refresh('unknown'));

    expect((error as WorkflowRefreshError).reason).toBe('not-registered');
  });

  it('reports conflict when the catalog refuses a different artifact under an installed revision', async () => {
    const catalog = new WorkflowCatalog(new MemoryStorage());
    const first = await manifest('r1', '1.0.0');
    const second = await manifest('r1', '2.0.0');
    let next = await artifactFor(first);
    const coordinator = coordinatorFor(
      sourceOf(() => next),
      { catalog },
    );
    await coordinator.refresh('checkout');
    next = await artifactFor(second);

    const { error, diagnostics } = await failureOf(coordinator);

    expect(error).toBeInstanceOf(WorkflowCatalogConflictError);
    expect(diagnostics?.reason).toBe('conflict');
  });

  it('reports cancelled, with the caller error untouched, when the caller aborts', async () => {
    const controller = new AbortController();
    const coordinator = coordinatorFor(
      sourceOf(async () => artifactFor(await manifest()), {
        fetch: async ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      }),
    );

    const pending = rejectionOf(coordinator.refresh('checkout', { signal: controller.signal }));
    controller.abort(new Error('caller gave up'));
    const error = await pending;

    expect(error).not.toBeInstanceOf(WorkflowRefreshError);
    expect(coordinator.diagnostics('checkout')[0]?.reason).toBe('cancelled');
  });

  it('reports stopped after disposal', async () => {
    const coordinator = coordinatorFor(sourceOf(async () => artifactFor(await manifest())));
    coordinator.dispose();

    const error = await rejectionOf(coordinator.refresh('checkout'));

    expect((error as WorkflowRefreshError).reason).toBe('stopped');
  });
});

describe('WorkflowRefreshDiagnostics', () => {
  it('records the candidate contract hash with its revision and digest', async () => {
    const current = await manifest('r1');
    const currentArtifact = await artifactFor(current);
    const coordinator = coordinatorFor(sourceOf(() => currentArtifact));

    await coordinator.refresh('checkout');

    expect(coordinator.diagnostics('checkout')[0]).toMatchObject({
      state: 'installed',
      revision: 'r1',
      digest: currentArtifact.digest,
      contractHash: current.contractHash,
    });
  });

  it('records the activated revision and digest only when activation applies', async () => {
    const first = await artifactFor(await manifest('r1'));
    const second = await artifactFor(await manifest('r2'));
    let next = first;
    const coordinator = coordinatorFor(sourceOf(() => next));

    await coordinator.refresh('checkout', { activate: 'if-compatible', expectedGeneration: 0 });
    expect(coordinator.diagnostics('checkout')[0]).toMatchObject({
      state: 'activated',
      activatedRevision: 'r1',
      activatedDigest: first.digest,
    });

    next = second;
    await coordinator.refresh('checkout');
    expect(coordinator.diagnostics('checkout')[0]).toMatchObject({
      state: 'installed',
      revision: 'r2',
      activatedRevision: 'r1',
      activatedDigest: first.digest,
    });
  });

  it('clears the last failure once a later check succeeds', async () => {
    const good = await artifactFor(await manifest('r1'));
    let failing = true;
    const coordinator = coordinatorFor(
      sourceOf(() => good, {
        fetch: async () => {
          if (failing) throw new Error('temporary');
          return { status: 200 as const, artifact: good };
        },
      }),
    );
    await rejectionOf(coordinator.refresh('checkout'));
    expect(coordinator.diagnostics('checkout')[0]?.reason).toBe('source');

    failing = false;
    await coordinator.refresh('checkout');

    const after = coordinator.diagnostics('checkout')[0];
    expect(after?.state).toBe('installed');
    expect(after?.reason).toBeUndefined();
    expect(after?.error).toBeUndefined();
  });
});

describe('a candidate is recorded only once it is installed', () => {
  async function corrupted(revision: string): Promise<WorkflowRefreshArtifact> {
    const good = await manifest(revision);
    const broken = { ...good, contractHash: 'sha256:not-the-contract-hash' };
    return artifactFor(broken);
  }

  it('keeps the last installed artifact whole when a later check fails after the digest check', async () => {
    const first = await artifactFor(await manifest('r1'));
    let next = first;
    const coordinator = coordinatorFor(sourceOf(() => next));
    await coordinator.refresh('checkout');

    next = await corrupted('r2');
    await rejectionOf(coordinator.refresh('checkout'));

    expect(coordinator.diagnostics('checkout')[0]).toMatchObject({
      state: 'failed',
      reason: 'contract',
      revision: 'r1',
      digest: first.digest,
      contractHash: first.manifest.contractHash,
    });
  });

  it('keeps the last installed artifact whole when the runtime refuses a later one', async () => {
    const first = await artifactFor(await manifest('r1'));
    const second = await artifactFor(await manifest('r2'));
    let next = first;
    let refuse = false;
    const coordinator = coordinatorFor(
      sourceOf(() => next, {
        validateRuntime: () => {
          if (refuse) throw new Error('refused');
        },
      }),
    );
    await coordinator.refresh('checkout');

    next = second;
    refuse = true;
    await rejectionOf(coordinator.refresh('checkout'));

    expect(coordinator.diagnostics('checkout')[0]).toMatchObject({
      reason: 'runtime',
      revision: 'r1',
      digest: first.digest,
    });
  });

  it('records no candidate when the first candidate fails before it is installed', async () => {
    const artifact = await artifactFor(await manifest('r1'));
    const coordinator = coordinatorFor(
      sourceOf(() => artifact, {
        warm: async () => {
          throw new Error('warm failed');
        },
      }),
    );

    await rejectionOf(coordinator.refresh('checkout'));

    const diagnostics = coordinator.diagnostics('checkout')[0];
    expect(diagnostics?.state).toBe('failed');
    expect(diagnostics?.revision).toBeUndefined();
    expect(diagnostics?.digest).toBeUndefined();
    expect(diagnostics?.contractHash).toBeUndefined();
    expect(diagnostics?.etag).toBeUndefined();
  });

  it('re-fetches, without an ETag, after a warm failure instead of answering 304 for a candidate never installed', async () => {
    const artifact = await artifactFor(await manifest('r1'));
    let warmFails = true;
    const etags: Array<string | undefined> = [];
    const catalog = new WorkflowCatalog(new MemoryStorage());
    const coordinator = coordinatorFor(
      sourceOf(() => artifact, {
        fetch: async ({ etag }) => {
          etags.push(etag);
          return etag === undefined
            ? { status: 200 as const, etag: 'v1', artifact }
            : { status: 304 as const, etag };
        },
        warm: async () => {
          if (warmFails) throw new Error('warm failed');
          return definition;
        },
      }),
      { catalog },
    );
    await rejectionOf(coordinator.refresh('checkout'));
    warmFails = false;

    const result = await coordinator.refresh('checkout');

    expect(etags).toEqual([undefined, undefined]);
    expect(result.status).toBe('installed');
    expect(await catalog.listInstalledRevisions('checkout')).toHaveLength(1);
  });

  it('still answers 304 for a candidate that was installed', async () => {
    const artifact = await artifactFor(await manifest('r1'));
    const coordinator = coordinatorFor(
      sourceOf(() => artifact, {
        fetch: async ({ etag }) =>
          etag === undefined
            ? { status: 200 as const, etag: 'v1', artifact }
            : { status: 304 as const, etag },
      }),
    );
    await coordinator.refresh('checkout');

    const result = await coordinator.refresh('checkout');

    expect(result.status).toBe('not-modified');
    expect(coordinator.diagnostics('checkout')[0]).toMatchObject({
      state: 'not-modified',
      revision: 'r1',
      digest: artifact.digest,
    });
  });

  it('keeps the ETag of the installed artifact when a later artifact fails to warm', async () => {
    const first = await artifactFor(await manifest('r1'));
    const second = await artifactFor(await manifest('r2'));
    let next = first;
    let warmFails = false;
    const etags: Array<string | undefined> = [];
    const coordinator = coordinatorFor(
      sourceOf(() => next, {
        fetch: async ({ etag }) => {
          etags.push(etag);
          return { status: 200 as const, etag: `etag-${next.manifest.revision}`, artifact: next };
        },
        warm: async () => {
          if (warmFails) throw new Error('warm failed');
          return definition;
        },
      }),
    );
    await coordinator.refresh('checkout');
    next = second;
    warmFails = true;
    await rejectionOf(coordinator.refresh('checkout'));

    await rejectionOf(coordinator.refresh('checkout'));

    expect(etags).toEqual([undefined, 'etag-r1', 'etag-r1']);
  });
});

describe('WorkflowRefreshCoordinator options', () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a maxBackoffMs of %p so a poll cannot spin',
    (maxBackoffMs) => {
      expect(
        () =>
          new WorkflowRefreshCoordinator({
            catalog: new WorkflowCatalog(new MemoryStorage()),
            sources: new Map(),
            maxBackoffMs,
          }),
      ).toThrow(RangeError);
    },
  );
});

describe('WorkflowRefreshCoordinator.status', () => {
  it('lists a registered source that was never checked as idle, while diagnostics() does not', async () => {
    const coordinator = new WorkflowRefreshCoordinator({
      catalog: new WorkflowCatalog(new MemoryStorage()),
      sources: new Map([
        ['zeta', sourceOf(async () => artifactFor(await manifest()))],
        ['alpha', sourceOf(async () => artifactFor(await manifest()))],
      ]),
    });

    expect(coordinator.diagnostics()).toEqual([]);
    expect(coordinator.status().sources).toEqual([
      { name: 'alpha', state: 'idle' },
      { name: 'zeta', state: 'idle' },
    ]);
  });

  it('reports no polling policy until polling starts (manual maintenance)', () => {
    const coordinator = coordinatorFor(sourceOf(async () => artifactFor(await manifest())));

    expect(coordinator.status().polling).toBeUndefined();
  });

  it('reports the polling policy and next check while polling runs, and drops them when it stops', () => {
    const coordinator = new WorkflowRefreshCoordinator({
      catalog: new WorkflowCatalog(new MemoryStorage()),
      sources: new Map([['checkout', sourceOf(async () => artifactFor(await manifest()))]]),
      pollIntervalMs: 60_000,
      maxBackoffMs: 600_000,
      now: () => 1_000,
    });

    coordinator.startPolling();
    try {
      expect(coordinator.status().polling).toEqual({
        intervalMilliseconds: 60_000,
        maxBackoffMilliseconds: 600_000,
        backoffMilliseconds: 60_000,
        nextCheckAt: 61_000,
      });
    } finally {
      coordinator.stopPolling();
    }
    expect(coordinator.status().polling).toBeUndefined();
  });

  it('shows the grown backoff after a failed check', async () => {
    const coordinator = new WorkflowRefreshCoordinator({
      catalog: new WorkflowCatalog(new MemoryStorage()),
      sources: new Map([
        [
          'checkout',
          sourceOf(async () => artifactFor(await manifest()), {
            fetch: async () => {
              throw new Error('down');
            },
          }),
        ],
      ]),
      pollIntervalMs: 60_000,
      maxBackoffMs: 600_000,
    });
    coordinator.startPolling();
    try {
      await rejectionOf(coordinator.refresh('checkout'));

      expect(coordinator.status().polling?.backoffMilliseconds).toBe(120_000);
    } finally {
      coordinator.stopPolling();
    }
  });
});

describe('engine.workflows.refreshStatus', () => {
  it('is empty before any source registers, then lists a registered source as idle', async () => {
    const engine = new Engine();
    try {
      expect(engine.workflows.refreshStatus()).toEqual({ sources: [], polling: undefined });

      await engine.workflows.registerRefreshSource(
        'checkout',
        sourceOf(async () => artifactFor(await manifest())),
      );

      expect(engine.workflows.refreshStatus()).toEqual({
        sources: [{ name: 'checkout', state: 'idle' }],
        polling: undefined,
      });
      expect(engine.workflows.refreshDiagnostics()).toEqual([]);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });
});

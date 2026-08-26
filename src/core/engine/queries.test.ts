import { describe, expect, it, mock } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { encode } from '../codec.ts';
import { workflow, type WorkflowContext, type WorkflowState } from '../types.ts';
import { Engine } from './index.ts';
import {
  isWorkflowClaimedByAnotherEngine,
  isWorkflowLocallyTerminalOrMissing,
  query,
  WorkflowNotLocallyOwnedError,
} from './queries.ts';
import { encodeWorkflowClaimHolder } from './workflow-claim-codec.ts';

/** Minimal valid `WorkflowState` fixture for `KEYS.workflow(id)` records. */
function createWorkflowState(
  workflowId: string,
  overrides: Partial<WorkflowState> = {},
): WorkflowState {
  return {
    createdAt: 1_000,
    id: workflowId,
    input: null,
    result: 'done',
    startedAt: 1_000,
    status: 'completed',
    type: 'workflow',
    updatedAt: 1_000,
    versionTuple: { workflowVersion: '1' },
    ...overrides,
  };
}

/** Minimal stand-in for `WorkflowClaimRegistry` — only `currentEpoch` is read here. */
function fakeClaimRegistry(epoch: number | null): { currentEpoch: (id: string) => number | null } {
  return { currentEpoch: () => epoch };
}

describe('isWorkflowClaimedByAnotherEngine', () => {
  it('is false when no claim registry is installed (ownership: "none"/"lease")', async () => {
    const internals = { workflowClaimRegistry: null } as unknown as Parameters<
      typeof isWorkflowClaimedByAnotherEngine
    >[0];
    expect(await isWorkflowClaimedByAnotherEngine(internals, 'wf-1')).toBe(false);
  });

  it('is false when this engine already tracks the claim locally', async () => {
    const internals = { workflowClaimRegistry: fakeClaimRegistry(3) } as unknown as Parameters<
      typeof isWorkflowClaimedByAnotherEngine
    >[0];
    expect(await isWorkflowClaimedByAnotherEngine(internals, 'wf-1')).toBe(false);
  });

  it('is false when no durable holder record exists (terminal, purged, or unknown workflow)', async () => {
    const storage = new MemoryStorage();
    const internals = {
      workflowClaimRegistry: fakeClaimRegistry(null),
      storage,
    } as unknown as Parameters<typeof isWorkflowClaimedByAnotherEngine>[0];
    expect(await isWorkflowClaimedByAnotherEngine(internals, 'wf-1')).toBe(false);
  });

  it('is false when the durable holder bytes do not decode', async () => {
    const storage = new MemoryStorage();
    await storage.batch([
      { type: 'put', key: KEYS.workflowOwnerHolder('wf-1'), value: new Uint8Array([1, 2, 3]) },
    ]);
    const internals = {
      workflowClaimRegistry: fakeClaimRegistry(null),
      storage,
    } as unknown as Parameters<typeof isWorkflowClaimedByAnotherEngine>[0];
    expect(await isWorkflowClaimedByAnotherEngine(internals, 'wf-1')).toBe(false);
  });

  it('is true when a decodable durable holder names a different engine', async () => {
    const storage = new MemoryStorage();
    await storage.batch([
      {
        type: 'put',
        key: KEYS.workflowOwnerHolder('wf-1'),
        value: encodeWorkflowClaimHolder({
          engineId: 'engine-b',
          epoch: 1,
          expiresAt: Date.now() + 1_000,
          claimedAt: Date.now(),
        }),
      },
    ]);
    const internals = {
      workflowClaimRegistry: fakeClaimRegistry(null),
      storage,
    } as unknown as Parameters<typeof isWorkflowClaimedByAnotherEngine>[0];
    expect(await isWorkflowClaimedByAnotherEngine(internals, 'wf-1')).toBe(true);
  });
});

describe('query()', () => {
  it('returns the built-in activityProgress heartbeat regardless of ownership', async () => {
    const internals = {
      heartbeatDetails: new Map([['wf-1', { detail: 'x' }]]),
    } as unknown as Parameters<typeof query>[0];
    expect(await query(internals, 'wf-1', 'activityProgress')).toEqual({ detail: 'x' });
  });

  it('throws when no inline strategy is configured (worker execution mode)', async () => {
    const internals = {
      heartbeatDetails: new Map(),
      inlineStrategy: null,
    } as unknown as Parameters<typeof query>[0];
    await expect(query(internals, 'wf-1', 'custom')).rejects.toThrow(
      'Workflow queries are not supported when using the worker execution strategy.',
    );
  });

  it('returns undefined when no context exists and no other engine claims the workflow', async () => {
    const internals = {
      heartbeatDetails: new Map(),
      inlineStrategy: { getContext: () => undefined, getParkedContext: () => undefined },
      workflowClaimRegistry: null,
    } as unknown as Parameters<typeof query>[0];
    expect(await query(internals, 'wf-1', 'custom')).toBeUndefined();
  });

  it('throws WorkflowNotLocallyOwnedError when a durable claim names another engine', async () => {
    const storage = new MemoryStorage();
    await storage.batch([
      {
        type: 'put',
        key: KEYS.workflowOwnerHolder('wf-1'),
        value: encodeWorkflowClaimHolder({
          engineId: 'engine-b',
          epoch: 1,
          expiresAt: Date.now() + 1_000,
          claimedAt: Date.now(),
        }),
      },
      // A real durable holder implies a started (at least persisted, and
      // here still-active) WorkflowState — see the F2 regression describe
      // block below for the "terminal workflow, stale holder" counterpart.
      {
        type: 'put',
        key: KEYS.workflow('wf-1'),
        value: encode(createWorkflowState('wf-1', { status: 'running', result: undefined })),
      },
    ]);
    const internals = {
      heartbeatDetails: new Map(),
      inlineStrategy: { getContext: () => undefined, getParkedContext: () => undefined },
      workflowClaimRegistry: fakeClaimRegistry(null),
      storage,
    } as unknown as Parameters<typeof query>[0];

    const rejection = expect(query(internals, 'wf-1', 'custom')).rejects;
    await rejection.toBeInstanceOf(WorkflowNotLocallyOwnedError);
    await rejection.toMatchObject({ workflowId: 'wf-1' });
  });

  it('invokes a registered query handler when a live context exists', async () => {
    const handler = mock((input: unknown) => `handled:${String(input)}`);
    const internals = {
      heartbeatDetails: new Map(),
      inlineStrategy: {
        getContext: () => ({
          queryHandlers: new Map([['q', handler]]),
          exposedAccessors: new Map(),
        }),
        getParkedContext: () => undefined,
      },
      // EngineInternals types this as `WorkflowClaimRegistry | null`, never
      // undefined; omitting it made the ownership guard read undefined and throw.
      workflowClaimRegistry: null,
    } as unknown as Parameters<typeof query>[0];
    expect(await query(internals, 'wf-1', 'q', 'in')).toBe('handled:in');
    expect(handler).toHaveBeenCalledWith('in');
  });

  it('invokes an exposed accessor when no query handler matches', async () => {
    const accessor = mock(() => 'accessor-value');
    const internals = {
      heartbeatDetails: new Map(),
      inlineStrategy: {
        getContext: () => ({
          queryHandlers: new Map(),
          exposedAccessors: new Map([['a', accessor]]),
        }),
        getParkedContext: () => undefined,
      },
      workflowClaimRegistry: null,
    } as unknown as Parameters<typeof query>[0];
    expect(await query(internals, 'wf-1', 'a')).toBe('accessor-value');
  });

  it('returns undefined when a live context has neither a handler nor accessor for the name', async () => {
    const internals = {
      heartbeatDetails: new Map(),
      inlineStrategy: {
        getContext: () => ({ queryHandlers: new Map(), exposedAccessors: new Map() }),
        getParkedContext: () => undefined,
      },
      workflowClaimRegistry: null,
    } as unknown as Parameters<typeof query>[0];
    expect(await query(internals, 'wf-1', 'missing')).toBeUndefined();
  });

  it('invokes the handler without any ownership read when no claim registry is installed', async () => {
    const handler = mock((input: unknown) => `handled:${String(input)}`);
    const internals = {
      heartbeatDetails: new Map(),
      inlineStrategy: {
        getContext: () => ({
          queryHandlers: new Map([['q', handler]]),
          exposedAccessors: new Map(),
        }),
        getParkedContext: () => undefined,
      },
      workflowClaimRegistry: null,
    } as unknown as Parameters<typeof query>[0];
    expect(await query(internals, 'wf-1', 'q', 'in')).toBe('handled:in');
    expect(handler).toHaveBeenCalledWith('in');
  });

  it('throws WorkflowNotLocallyOwnedError instead of serving a stale live context when a durable claim names another engine', async () => {
    const storage = new MemoryStorage();
    await storage.batch([
      {
        type: 'put',
        key: KEYS.workflowOwnerHolder('wf-1'),
        value: encodeWorkflowClaimHolder({
          engineId: 'engine-b',
          epoch: 2,
          expiresAt: Date.now() + 1_000,
          claimedAt: Date.now(),
        }),
      },
    ]);
    const handler = mock((input: unknown) => `handled:${String(input)}`);
    const internals = {
      heartbeatDetails: new Map(),
      inlineStrategy: {
        // A deposed engine keeps its live Context until some later fenced
        // write unwinds the execution — this simulates that stale Context.
        getContext: () => ({
          queryHandlers: new Map([['q', handler]]),
          exposedAccessors: new Map(),
        }),
        getParkedContext: () => undefined,
      },
      // This engine's local tracking already lost the claim (e.g. a `renew`
      // self-deposition already cleared it), so the check must fall through
      // to the durable read rather than trusting a stale local epoch.
      workflowClaimRegistry: fakeClaimRegistry(null),
      storage,
    } as unknown as Parameters<typeof query>[0];

    const rejection = expect(query(internals, 'wf-1', 'q', 'in')).rejects;
    await rejection.toBeInstanceOf(WorkflowNotLocallyOwnedError);
    await rejection.toMatchObject({ workflowId: 'wf-1' });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('isWorkflowLocallyTerminalOrMissing', () => {
  it('is true when no persisted WorkflowState exists (never existed or purged)', async () => {
    const storage = new MemoryStorage();
    const internals = { storage } as unknown as Parameters<
      typeof isWorkflowLocallyTerminalOrMissing
    >[0];
    expect(await isWorkflowLocallyTerminalOrMissing(internals, 'wf-1')).toBe(true);
  });

  it('is true when the persisted WorkflowState is terminal', async () => {
    const storage = new MemoryStorage();
    await storage.batch([
      { type: 'put', key: KEYS.workflow('wf-1'), value: encode(createWorkflowState('wf-1')) },
    ]);
    const internals = { storage } as unknown as Parameters<
      typeof isWorkflowLocallyTerminalOrMissing
    >[0];
    expect(await isWorkflowLocallyTerminalOrMissing(internals, 'wf-1')).toBe(true);
  });

  it('is false when the persisted WorkflowState is still active', async () => {
    const storage = new MemoryStorage();
    await storage.batch([
      {
        type: 'put',
        key: KEYS.workflow('wf-1'),
        value: encode(createWorkflowState('wf-1', { status: 'running', result: undefined })),
      },
    ]);
    const internals = { storage } as unknown as Parameters<
      typeof isWorkflowLocallyTerminalOrMissing
    >[0];
    expect(await isWorkflowLocallyTerminalOrMissing(internals, 'wf-1')).toBe(false);
  });
});

describe('query() F1: re-reads the context after ownership validation', () => {
  it('serves the fresh context installed by a same-owner signal resume that raced the ownership read, not the stale pre-await context', async () => {
    const staleHandler = mock(() => 'stale');
    const freshHandler = mock(() => 'fresh');
    const parkedContext = {
      queryHandlers: new Map<string, (input: unknown) => unknown>([['q', staleHandler]]),
      exposedAccessors: new Map<string, () => unknown>(),
    };
    let freshContext: typeof parkedContext | undefined;

    const storage = {
      // Simulate a signal resuming the parked workflow — installing a fresh
      // Context — while this ownership-validation storage read is pending.
      get: mock(async () => {
        freshContext = {
          queryHandlers: new Map([['q', freshHandler]]),
          exposedAccessors: new Map(),
        };
        return null;
      }),
    };
    const internals = {
      heartbeatDetails: new Map(),
      inlineStrategy: {
        getContext: () => freshContext,
        getParkedContext: () => parkedContext,
      },
      workflowClaimRegistry: fakeClaimRegistry(null),
      storage,
    } as unknown as Parameters<typeof query>[0];

    expect(await query(internals, 'wf-1', 'q', 'in')).toBe('fresh');
    expect(freshHandler).toHaveBeenCalledWith('in');
    expect(staleHandler).not.toHaveBeenCalled();
  });

  it('returns undefined when the same-owner context is torn down (terminal cleanup) while the ownership read was pending', async () => {
    const staleHandler = mock(() => 'stale');
    const parkedContext = {
      queryHandlers: new Map<string, (input: unknown) => unknown>([['q', staleHandler]]),
      exposedAccessors: new Map<string, () => unknown>(),
    };
    let contextTornDown = false;

    const storage = {
      get: mock(async () => {
        contextTornDown = true;
        return null;
      }),
    };
    const internals = {
      heartbeatDetails: new Map(),
      inlineStrategy: {
        getContext: () => undefined,
        getParkedContext: () => (contextTornDown ? undefined : parkedContext),
      },
      workflowClaimRegistry: fakeClaimRegistry(null),
      storage,
    } as unknown as Parameters<typeof query>[0];

    expect(await query(internals, 'wf-1', 'q', 'in')).toBeUndefined();
    expect(staleHandler).not.toHaveBeenCalled();
  });
});

describe('query() F2: ignores a stale durable holder for a locally terminal workflow', () => {
  it('returns undefined (not WorkflowNotLocallyOwnedError) when the persisted workflow is terminal but the durable holder still names another engine', async () => {
    const storage = new MemoryStorage();
    await storage.batch([
      {
        type: 'put',
        key: KEYS.workflowOwnerHolder('wf-1'),
        value: encodeWorkflowClaimHolder({
          engineId: 'engine-b',
          epoch: 1,
          expiresAt: Date.now() + 1_000,
          claimedAt: Date.now(),
        }),
      },
      { type: 'put', key: KEYS.workflow('wf-1'), value: encode(createWorkflowState('wf-1')) },
    ]);
    const internals = {
      heartbeatDetails: new Map(),
      inlineStrategy: { getContext: () => undefined, getParkedContext: () => undefined },
      workflowClaimRegistry: fakeClaimRegistry(null),
      storage,
    } as unknown as Parameters<typeof query>[0];

    expect(await query(internals, 'wf-1', 'custom')).toBeUndefined();
  });

  it('still throws WorkflowNotLocallyOwnedError when the persisted workflow is active and the durable holder names another engine', async () => {
    const storage = new MemoryStorage();
    await storage.batch([
      {
        type: 'put',
        key: KEYS.workflowOwnerHolder('wf-1'),
        value: encodeWorkflowClaimHolder({
          engineId: 'engine-b',
          epoch: 1,
          expiresAt: Date.now() + 1_000,
          claimedAt: Date.now(),
        }),
      },
      {
        type: 'put',
        key: KEYS.workflow('wf-1'),
        value: encode(createWorkflowState('wf-1', { status: 'running', result: undefined })),
      },
    ]);
    const internals = {
      heartbeatDetails: new Map(),
      inlineStrategy: { getContext: () => undefined, getParkedContext: () => undefined },
      workflowClaimRegistry: fakeClaimRegistry(null),
      storage,
    } as unknown as Parameters<typeof query>[0];

    const rejection = expect(query(internals, 'wf-1', 'custom')).rejects;
    await rejection.toBeInstanceOf(WorkflowNotLocallyOwnedError);
    await rejection.toMatchObject({ workflowId: 'wf-1' });
  });
});

describe('query() performance: no storage read for ownership: "none"/"lease"', () => {
  it('never calls storage.get when no claim registry is installed', async () => {
    const handler = mock((input: unknown) => `handled:${String(input)}`);
    const getSpy = mock(async () => null);
    const internals = {
      heartbeatDetails: new Map(),
      inlineStrategy: {
        getContext: () => ({
          queryHandlers: new Map([['q', handler]]),
          exposedAccessors: new Map(),
        }),
        getParkedContext: () => undefined,
      },
      workflowClaimRegistry: null,
      storage: { get: getSpy },
    } as unknown as Parameters<typeof query>[0];

    expect(await query(internals, 'wf-1', 'q', 'in')).toBe('handled:in');
    expect(getSpy).not.toHaveBeenCalled();
  });
});

describe('WFT-79: cross-engine query() ownership signal', () => {
  it('engine.query() throws WorkflowNotLocallyOwnedError when a different engine holds the claim', async () => {
    const storage = new MemoryStorage();
    const parkedWorkflow = workflow({ name: 'query-claim-parked' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.waitForSignal('go');
      return 'done';
    });
    const workflows = { 'query-claim-parked': parkedWorkflow };

    // Seed a durably running, signal-parked workflow with a plain
    // `ownership: 'none'` engine — no claim exists yet either way.
    await using seedEngine = await Engine.create({ storage, workflows, recover: false });
    await seedEngine.start('query-claim-parked', null, { id: 'query-claim-1' });
    await waitForCondition(
      async () => (await storage.get(KEYS.checkpoint('query-claim-1'))) !== null,
      { label: 'checkpoint for parked workflow' },
    );

    await using engineOwner = await Engine.create({
      storage,
      workflows,
      ownership: 'workflow-lease',
      workflowClaimTtl: '1m',
      workflowClaimRenewInterval: '5s',
      recover: false,
    });
    await engineOwner.resume('query-claim-1');

    await using engineOutsider = await Engine.create({
      storage,
      workflows,
      ownership: 'workflow-lease',
      workflowClaimTtl: '1m',
      workflowClaimRenewInterval: '5s',
      recover: false,
    });

    const rejection = expect(engineOutsider.query('query-claim-1', 'anything')).rejects;
    await rejection.toBeInstanceOf(WorkflowNotLocallyOwnedError);
    await rejection.toMatchObject({ workflowId: 'query-claim-1' });

    // Sanity: the OWNING engine's query for an unregistered name still
    // returns plain `undefined` (the pre-existing, unrelated ambiguity this
    // fix deliberately leaves alone) — proving the throw is scoped to the
    // non-owning engine, not a blanket change to `query()`'s behavior.
    expect(await engineOwner.query('query-claim-1', 'anything')).toBeUndefined();
  });
});

import { describe, expect, it } from 'bun:test';

import type { Storage } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { rejectionOf, throwingRejectionOf } from '../../testing/promise-outcome.test-support.ts';
import { encode } from '../codec.ts';
import type { ScheduleState, WorkflowState } from '../types.ts';
import { encodeEpoch } from './lease-codec.ts';
import { encodeWorkflowStartHeaders } from './state-utilities.ts';
import {
  buildExternalTerminalRotationFragment,
  commitExternalTerminalWorkflowStateOperations,
  commitSelfWorkflowStateOperations,
  loadScheduleState,
  loadWorkflowResult,
  loadWorkflowStartHeaders,
  requireScheduleState,
  writeScheduleState,
} from './storage-io.ts';
import { decodeEpoch } from './workflow-claim-codec.ts';
import { WorkflowClaimRegistry } from './workflow-claim-registry.ts';

/**
 * Wrap `base` as an explicit delegating {@link Storage}, overriding only the
 * given hooks. Mirrors `fenced-write-workflow-scope.test.ts`'s
 * `withStorageHooks` — a plain object spread does not work because `base` is
 * a class instance whose methods live on its prototype.
 */
function withStorageHooks(base: Storage, hooks: Partial<Pick<Storage, 'get'>>): Storage {
  return {
    capabilities: () => base.capabilities(),
    get: hooks.get ?? ((key) => base.get(key)),
    put: (key, value) => base.put(key, value),
    delete: (key) => base.delete(key),
    scan: (prefix, options) => base.scan(prefix, options),
    batch: (operations) => base.batch(operations),
    conditionalBatch: (conditions, operations) => base.conditionalBatch!(conditions, operations),
    [Symbol.dispose]: () => base[Symbol.dispose](),
  };
}

function createWorkflowState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    createdAt: 1_000,
    id: 'workflow-storage-io',
    input: null,
    startedAt: 1_000,
    status: 'running',
    type: 'workflow',
    updatedAt: 1_000,
    versionTuple: { workflowVersion: '1' },
    ...overrides,
  };
}

function createScheduleState(overrides: Partial<ScheduleState> = {}): ScheduleState {
  return {
    backfill: false,
    createdAt: 1_000,
    id: 'schedule-1',
    input: null,
    intervalMs: 1_000,
    missedFireCount: 0,
    skippedCount: 0,
    nextFireAt: 2_000,
    overlap: 'skip',
    queuedRuns: [],
    revisionPolicy: 'active-at-fire',
    status: 'active',
    updatedAt: 1_000,
    workflowType: 'workflow',
    ...overrides,
  };
}

describe('storage I/O helpers', () => {
  it('rejects loadWorkflowResult for non-terminal workflows', async () => {
    const storage = new MemoryStorage();
    const state = createWorkflowState({ id: 'workflow-still-running' });
    await storage.put(KEYS.workflow(state.id), encode(state));

    expect(
      await throwingRejectionOf(loadWorkflowResult({ storage } as never, 'workflow-still-running')),
    ).toThrow('Workflow "workflow-still-running" is still running');
  });

  it('restores failed, cancelled, timed-out, and missing workflow results distinctly', async () => {
    const storage = new MemoryStorage();

    await storage.put(
      KEYS.workflow('workflow-failed'),
      encode(
        createWorkflowState({
          error: 'boom',
          errorStack: 'stack-trace',
          id: 'workflow-failed',
          status: 'failed',
        }),
      ),
    );
    await storage.put(
      KEYS.workflow('workflow-cancelled'),
      encode(createWorkflowState({ id: 'workflow-cancelled', status: 'cancelled' })),
    );
    await storage.put(
      KEYS.workflow('workflow-timeout'),
      encode(
        createWorkflowState({
          executionDeadline: 1_050,
          id: 'workflow-timeout',
          startedAt: 1_000,
          status: 'timed-out',
        }),
      ),
    );

    expect(
      await throwingRejectionOf(loadWorkflowResult({ storage } as never, 'workflow-missing')),
    ).toThrow('Workflow "workflow-missing" not found');

    expect(
      await rejectionOf(loadWorkflowResult({ storage } as never, 'workflow-failed')),
    ).toMatchObject({
      message: 'boom',
      stack: 'stack-trace',
    });

    expect(
      await throwingRejectionOf(loadWorkflowResult({ storage } as never, 'workflow-cancelled')),
    ).toThrow('Workflow cancelled');

    expect(
      await throwingRejectionOf(loadWorkflowResult({ storage } as never, 'workflow-timeout')),
    ).toThrow('Workflow "workflow-timeout" exceeded execution timeout after 50ms');
  });

  it('loads, requires, writes, and fences schedule state plus workflow start headers', async () => {
    const storage = new MemoryStorage();
    const scheduleState = createScheduleState();
    const headers = new Map([
      ['x-request-id', 'request-1'],
      ['x-trace-id', 'trace-1'],
    ]);

    await storage.put(KEYS.schedule(scheduleState.id), encode(scheduleState));
    await storage.put(
      KEYS.workflowHeaders('workflow-with-headers'),
      encodeWorkflowStartHeaders(headers),
    );

    expect(await loadScheduleState({ storage } as never, scheduleState.id)).toEqual(scheduleState);
    expect(await requireScheduleState({ storage } as never, scheduleState.id)).toEqual(
      scheduleState,
    );
    expect(
      await throwingRejectionOf(requireScheduleState({ storage } as never, 'missing-schedule')),
    ).toThrow('Schedule "missing-schedule" not found');
    expect(await loadWorkflowStartHeaders({ storage } as never, 'workflow-with-headers')).toEqual(
      headers,
    );
    expect(await loadWorkflowStartHeaders({ storage } as never, 'missing-headers')).toBe(undefined);

    await writeScheduleState(
      {
        deposed: false,
        leaseManager: null,
        options: { ownershipMode: 'none' },
        storage,
      } as never,
      createScheduleState({ id: 'schedule-write', nextFireAt: 3_000 }),
    );

    expect(await storage.get(KEYS.schedule('schedule-write'))).not.toBeNull();
  });

  it('surfaces lost lease preconditions while writing schedule state', async () => {
    const storage = new MemoryStorage();
    const epochBytes = encodeEpoch(1);
    await storage.put(KEYS.leaseEpoch(), epochBytes);
    storage.conditionalBatch = async () => false;

    expect(
      await throwingRejectionOf(
        writeScheduleState(
          {
            deposed: false,
            leaseManager: { currentEpochBytes: () => epochBytes },
            options: { ownershipMode: 'lease' },
            storage,
            tearDownAfterDeposition: null,
          } as never,
          createScheduleState({ id: 'schedule-fenced' }),
        ),
      ),
    ).toThrow('Schedule state commit for schedule "schedule-fenced" lost its precondition.');
  });

  // WFT-20: writeScheduleState's `extraConditions` branch.
  it('applies the caller-supplied extraConditions fence and reports the typed error when they disagree on re-read', async () => {
    const storage = new MemoryStorage();
    storage.conditionalBatch = async () => false;

    const rejection = await writeScheduleState(
      { deposed: false, leaseManager: null, options: { ownershipMode: 'none' }, storage } as never,
      createScheduleState({ id: 'schedule-extra-fenced' }),
      {
        extraConditions: [{ key: 'catalog-entry:checkout:rev-a', expectedValue: encode('was') }],
        onExtraConditionsLost: () => new Error('typed revision-unavailable error'),
      },
    ).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe('typed revision-unavailable error');
  });

  it('falls back to the generic lost-precondition error when no extra condition itself disagrees on re-read', async () => {
    const storage = new MemoryStorage();
    storage.conditionalBatch = async () => false;

    expect(
      await throwingRejectionOf(
        writeScheduleState(
          {
            deposed: false,
            leaseManager: null,
            options: { ownershipMode: 'none' },
            storage,
          } as never,
          createScheduleState({ id: 'schedule-extra-fenced-2' }),
          {
            // The key is genuinely absent, and `expectedValue: null` matches
            // that — the re-check finds nothing stale, so the lost CAS must
            // have come from some OTHER precondition (e.g. a lease-epoch
            // fence), and the generic error is correct.
            extraConditions: [{ key: 'catalog-entry:checkout:rev-b', expectedValue: null }],
          },
        ),
      ),
    ).toThrow(
      'Schedule state commit for schedule "schedule-extra-fenced-2" lost its precondition.',
    );
  });
});

/** Minimal internals stub covering exactly what commit paths under test read. */
function createCommitInternals(
  storage: Storage,
  ownershipMode: 'none' | 'lease' | 'workflow-lease',
  overrides: Record<string, unknown> = {},
) {
  return {
    deposed: false,
    leaseManager: null,
    workflowClaimRegistry: null,
    options: { ownershipMode },
    storage,
    ...overrides,
  } as never;
}

const rotationTestWorkflowState = createWorkflowState({ id: 'wf-rotation' });

describe('ADR 0002 self vs. external-terminal workflow-state commits', () => {
  it('commitSelfWorkflowStateOperations under "none"/"lease" leaves wf-owner-epoch untouched (byte-for-byte unchanged)', async () => {
    const storage = new MemoryStorage();
    await commitSelfWorkflowStateOperations(
      createCommitInternals(storage, 'none'),
      rotationTestWorkflowState,
      [
        {
          type: 'put',
          key: KEYS.workflow(rotationTestWorkflowState.id),
          value: new Uint8Array([1]),
        },
      ],
    );
    expect(await storage.get(KEYS.workflowOwnerEpoch(rotationTestWorkflowState.id))).toBeNull();
  });

  it('commitExternalTerminalWorkflowStateOperations under "none" performs no wf-owner-epoch read and commits a plain batch', async () => {
    const storage = new MemoryStorage();
    let getCalls = 0;
    const trackedStorage = withStorageHooks(storage, {
      get: async (key) => {
        getCalls += 1;
        return storage.get(key);
      },
    });

    await commitExternalTerminalWorkflowStateOperations(
      createCommitInternals(trackedStorage, 'none'),
      rotationTestWorkflowState,
      [
        {
          type: 'put',
          key: KEYS.workflow(rotationTestWorkflowState.id),
          value: new Uint8Array([2]),
        },
      ],
    );

    expect(getCalls).toBe(0);
    expect(await storage.get(KEYS.workflow(rotationTestWorkflowState.id))).toEqual(
      new Uint8Array([2]),
    );
    expect(await storage.get(KEYS.workflowOwnerEpoch(rotationTestWorkflowState.id))).toBeNull();
  });

  it('commitExternalTerminalWorkflowStateOperations surfaces the lost-race error on a same-epoch atomic side-effect precondition failure', async () => {
    const { stageAtomicWorkflowCommitSideEffects } = await import('./checkpoint-side-effects.ts');
    const storage = new MemoryStorage();
    await storage.put('present-key', new Uint8Array([1]));

    const internals = createCommitInternals(storage, 'none', {
      pendingAtomicWorkflowCommitSideEffects: new Map(),
    });
    stageAtomicWorkflowCommitSideEffects(internals, rotationTestWorkflowState.id, {
      operations: [{ type: 'put', key: 'race-effect', value: new Uint8Array([2]) }],
      conditions: [{ key: 'present-key', expectedValue: null }],
    });

    expect(
      await throwingRejectionOf(
        commitExternalTerminalWorkflowStateOperations(
          internals,
          rotationTestWorkflowState,
          [
            {
              type: 'put',
              key: KEYS.workflow(rotationTestWorkflowState.id),
              value: new Uint8Array([9]),
            },
          ],
          { includePendingAtomicSideEffects: true },
        ),
      ),
    ).toThrow(/lost a commit precondition/);
  });

  it('commitExternalTerminalWorkflowStateOperations under "lease" fences on the global lease epoch, never the workflow epoch', async () => {
    const storage = new MemoryStorage();
    const epochBytes = encodeEpoch(1);
    await storage.put(KEYS.leaseEpoch(), epochBytes);

    await commitExternalTerminalWorkflowStateOperations(
      createCommitInternals(storage, 'lease', {
        leaseManager: { currentEpochBytes: () => epochBytes },
      }),
      rotationTestWorkflowState,
      [
        {
          type: 'put',
          key: KEYS.workflow(rotationTestWorkflowState.id),
          value: new Uint8Array([3]),
        },
      ],
    );

    expect(await storage.get(KEYS.workflow(rotationTestWorkflowState.id))).toEqual(
      new Uint8Array([3]),
    );
    expect(await storage.get(KEYS.workflowOwnerEpoch(rotationTestWorkflowState.id))).toBeNull();
  });

  it('commitExternalTerminalWorkflowStateOperations under "workflow-lease" mints epoch 1 for a never-claimed workflow', async () => {
    const storage = new MemoryStorage();

    await commitExternalTerminalWorkflowStateOperations(
      createCommitInternals(storage, 'workflow-lease'),
      rotationTestWorkflowState,
      [
        {
          type: 'put',
          key: KEYS.workflow(rotationTestWorkflowState.id),
          value: new Uint8Array([4]),
        },
      ],
    );

    const epoch = decodeEpoch(
      (await storage.get(KEYS.workflowOwnerEpoch(rotationTestWorkflowState.id)))!,
    );
    expect(epoch).toBe(1);
    expect(await storage.get(KEYS.workflowOwnerHolder(rotationTestWorkflowState.id))).toBeNull();
  });

  it('commitExternalTerminalWorkflowStateOperations under "workflow-lease" rotates the epoch and deletes the holder for a claimed workflow, deposing the previous owner', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'wf-rotation-claimed';
    const state = createWorkflowState({ id: workflowId });

    const previousOwnerRegistry = new WorkflowClaimRegistry({
      storage,
      engineId: 'previous-owner',
      getNow: () => 1_000,
      claimTtlMs: 30_000,
      claimRenewIntervalMs: 5_000,
    });
    const acquireResult = await previousOwnerRegistry.acquire(workflowId);
    expect(acquireResult.status).toBe('acquired');
    const cachedEpochBytes = previousOwnerRegistry.currentEpochBytes(workflowId);
    expect(cachedEpochBytes).not.toBeNull();
    expect(decodeEpoch(cachedEpochBytes!)).toBe(1);

    // Another engine — holding no claim of its own — cancels this workflow.
    await commitExternalTerminalWorkflowStateOperations(
      createCommitInternals(storage, 'workflow-lease'),
      state,
      [{ type: 'put', key: KEYS.workflow(workflowId), value: new Uint8Array([5]) }],
    );

    const rotatedEpoch = decodeEpoch((await storage.get(KEYS.workflowOwnerEpoch(workflowId)))!);
    expect(rotatedEpoch).toBe(2);
    expect(await storage.get(KEYS.workflowOwnerHolder(workflowId))).toBeNull();

    // The deposed previous owner's next SELF-transition write, still fenced on
    // its stale cached epoch (1), loses its CAS and is deposed for just this
    // workflow (never a global halt — EngineDeposedError carries the id).
    expect(
      await rejectionOf(
        commitSelfWorkflowStateOperations(
          createCommitInternals(storage, 'workflow-lease', {
            workflowClaimRegistry: previousOwnerRegistry,
          }),
          state,
          [{ type: 'put', key: KEYS.workflow(workflowId), value: new Uint8Array([6]) }],
        ),
      ),
    ).toMatchObject({
      code: 'EngineDeposedError',
      workflowId,
    });
  });

  it('commitSelfWorkflowStateOperations under "workflow-lease" with a valid claim never rotates the epoch or deletes the holder', async () => {
    const storage = new MemoryStorage();
    const workflowId = 'wf-self-no-rotation';
    const state = createWorkflowState({ id: workflowId });

    const registry = new WorkflowClaimRegistry({
      storage,
      engineId: 'owning-engine',
      getNow: () => 1_000,
      claimTtlMs: 30_000,
      claimRenewIntervalMs: 5_000,
    });
    const acquireResult = await registry.acquire(workflowId);
    expect(acquireResult.status).toBe('acquired');

    const epochBeforeCommit = await storage.get(KEYS.workflowOwnerEpoch(workflowId));
    const holderBeforeCommit = await storage.get(KEYS.workflowOwnerHolder(workflowId));

    await commitSelfWorkflowStateOperations(
      createCommitInternals(storage, 'workflow-lease', { workflowClaimRegistry: registry }),
      state,
      [{ type: 'put', key: KEYS.workflow(workflowId), value: new Uint8Array([7]) }],
    );

    expect(await storage.get(KEYS.workflowOwnerEpoch(workflowId))).toEqual(epochBeforeCommit);
    expect(await storage.get(KEYS.workflowOwnerHolder(workflowId))).toEqual(holderBeforeCommit);
  });

  it('buildExternalTerminalRotationFragment short-circuits with an empty fragment and NO storage read under "none"/"lease"', async () => {
    const explodingStorage = withStorageHooks(new MemoryStorage(), {
      get: async () => {
        throw new Error('must not read storage outside workflow-lease');
      },
    });

    expect(
      await buildExternalTerminalRotationFragment(
        createCommitInternals(explodingStorage, 'none'),
        'wf-short-circuit',
      ),
    ).toEqual({ conditions: [], operations: [] });
    expect(
      await buildExternalTerminalRotationFragment(
        createCommitInternals(explodingStorage, 'lease'),
        'wf-short-circuit',
      ),
    ).toEqual({ conditions: [], operations: [] });
  });
});

import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { encode } from '../codec.ts';
import type { ScheduleState, WorkflowState } from '../types.ts';
import { encodeEpoch } from './lease-codec.ts';
import { encodeWorkflowStartHeaders } from './state-utilities.ts';
import {
  loadScheduleState,
  loadWorkflowResult,
  loadWorkflowStartHeaders,
  requireScheduleState,
  writeScheduleState,
} from './storage-io.ts';

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
    nextFireAt: 2_000,
    overlap: 'skip',
    queuedRuns: [],
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

    await expect(
      loadWorkflowResult({ storage } as never, 'workflow-still-running'),
    ).rejects.toThrow('Workflow "workflow-still-running" is still running');
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

    await expect(loadWorkflowResult({ storage } as never, 'workflow-missing')).rejects.toThrow(
      'Workflow "workflow-missing" not found',
    );

    await expect(loadWorkflowResult({ storage } as never, 'workflow-failed')).rejects.toMatchObject(
      {
        message: 'boom',
        stack: 'stack-trace',
      },
    );

    await expect(loadWorkflowResult({ storage } as never, 'workflow-cancelled')).rejects.toThrow(
      'Workflow cancelled',
    );

    await expect(loadWorkflowResult({ storage } as never, 'workflow-timeout')).rejects.toThrow(
      'Workflow "workflow-timeout" exceeded execution timeout after 50ms',
    );
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

    await expect(loadScheduleState({ storage } as never, scheduleState.id)).resolves.toEqual(
      scheduleState,
    );
    await expect(requireScheduleState({ storage } as never, scheduleState.id)).resolves.toEqual(
      scheduleState,
    );
    await expect(requireScheduleState({ storage } as never, 'missing-schedule')).rejects.toThrow(
      'Schedule "missing-schedule" not found',
    );
    await expect(
      loadWorkflowStartHeaders({ storage } as never, 'workflow-with-headers'),
    ).resolves.toEqual(headers);
    await expect(loadWorkflowStartHeaders({ storage } as never, 'missing-headers')).resolves.toBe(
      undefined,
    );

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

    await expect(
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
    ).rejects.toThrow(
      'Schedule state commit for schedule "schedule-fenced" lost its precondition.',
    );
  });
});

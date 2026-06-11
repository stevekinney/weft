import { describe, expect, it } from 'bun:test';

import { encode } from '../core/codec.ts';
import type { WorkflowState } from '../core/types.ts';
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import type { WorkflowRegistration } from './validate.ts';
import { runVersionCheck } from './version-check.ts';

function makeWorkflowState(
  overrides: Partial<Omit<WorkflowState, 'versionTuple'>> & {
    id: string;
    type: string;
    version?: string;
  },
): WorkflowState {
  const { version = '1.0.0', ...rest } = overrides;
  return {
    status: 'running',
    input: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...rest,
    versionTuple: { workflowVersion: version },
  };
}

async function seedWorkflow(storage: MemoryStorage, state: WorkflowState): Promise<void> {
  await storage.put(KEYS.workflow(state.id), encode(state));
}

function dummyHandler(): AsyncGenerator<unknown, unknown, unknown> {
  return (async function* () {
    return null;
  })();
}

describe('runVersionCheck', () => {
  it('returns empty workflowTypes and safe verdict for an empty database', async () => {
    const storage = new MemoryStorage();
    const registrations: Record<string, WorkflowRegistration> = {};

    const report = await runVersionCheck(storage, registrations);

    expect(report.workflowTypes).toEqual([]);
    expect(report.overallVerdict).toBe('safe');
  });

  it('ignores wf: side-records (timeline) when scanning for running workflows', async () => {
    const storage = new MemoryStorage();
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-1', type: 'order', version: '1.0.0', status: 'running' }),
    );
    // A timeline side-record under the `wf:` prefix with a `status: 'running'`
    // field would, without the top-level-key filter, decode as a WorkflowState and
    // form a spurious group (e.g. `type === undefined`).
    await storage.put(
      KEYS.timeline('wf-1', 1),
      encode({
        step: 1,
        operationType: 'activity',
        operationLabel: 'charge',
        inputSummary: '{}',
        timestamp: 1,
        status: 'running',
      }),
    );

    const registrations: Record<string, WorkflowRegistration> = {
      order: { version: '1.0.0', handler: () => dummyHandler() },
    };

    const report = await runVersionCheck(storage, registrations);

    expect(report.workflowTypes).toHaveLength(1);
    expect(report.workflowTypes[0]!.type).toBe('order');
  });

  it('returns safe when all running workflows match registered versions', async () => {
    const storage = new MemoryStorage();
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-1', type: 'order', version: '1.0.0', status: 'running' }),
    );
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-2', type: 'order', version: '1.0.0', status: 'pending' }),
    );

    const registrations: Record<string, WorkflowRegistration> = {
      order: { version: '1.0.0', handler: () => dummyHandler() },
    };

    const report = await runVersionCheck(storage, registrations);

    expect(report.overallVerdict).toBe('safe');
    expect(report.workflowTypes).toHaveLength(1);
    expect(report.workflowTypes[0]!.type).toBe('order');
    expect(report.workflowTypes[0]!.storedVersion).toBe('1.0.0');
    expect(report.workflowTypes[0]!.registeredVersion).toBe('1.0.0');
    expect(report.workflowTypes[0]!.runningCount).toBe(2);
    expect(report.workflowTypes[0]!.compatibility).toBe('compatible');
  });

  it('returns unsafe when versions differ', async () => {
    const storage = new MemoryStorage();
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-1', type: 'order', version: '1.0.0', status: 'running' }),
    );

    const registrations: Record<string, WorkflowRegistration> = {
      order: {
        version: '2.0.0',
        handler: () => dummyHandler(),
      },
    };

    const report = await runVersionCheck(storage, registrations);

    expect(report.overallVerdict).toBe('unsafe');
    expect(report.workflowTypes).toHaveLength(1);
    expect(report.workflowTypes[0]!.compatibility).toBe('incompatible');
    expect(report.workflowTypes[0]!.storedVersion).toBe('1.0.0');
    expect(report.workflowTypes[0]!.registeredVersion).toBe('2.0.0');
  });

  it('uses the worst-case verdict when multiple workflow types have different compatibility', async () => {
    const storage = new MemoryStorage();

    // order: compatible
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-1', type: 'order', version: '1.0.0', status: 'running' }),
    );

    // onboard: incompatible
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-2', type: 'onboard', version: '1.0.0', status: 'pending' }),
    );

    // payment: incompatible
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-3', type: 'payment', version: '1.0.0', status: 'pending' }),
    );

    const registrations: Record<string, WorkflowRegistration> = {
      order: { version: '1.0.0', handler: () => dummyHandler() },
      onboard: { version: '2.0.0', handler: () => dummyHandler() },
      payment: { version: '3.0.0', handler: () => dummyHandler() },
    };

    const report = await runVersionCheck(storage, registrations);

    expect(report.overallVerdict).toBe('unsafe');
    expect(report.workflowTypes).toHaveLength(3);
  });

  it('skips unregistered workflow types gracefully', async () => {
    const storage = new MemoryStorage();
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-1', type: 'legacy', version: '1.0.0', status: 'running' }),
    );
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-2', type: 'order', version: '1.0.0', status: 'running' }),
    );

    const registrations: Record<string, WorkflowRegistration> = {
      order: { version: '1.0.0', handler: () => dummyHandler() },
    };

    const report = await runVersionCheck(storage, registrations);

    // Only the registered type should appear in the report
    expect(report.workflowTypes).toHaveLength(1);
    expect(report.workflowTypes[0]!.type).toBe('order');
    expect(report.overallVerdict).toBe('safe');
  });

  it('excludes completed and other non-resumable workflows', async () => {
    const storage = new MemoryStorage();
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-1', type: 'order', version: '1.0.0', status: 'completed' }),
    );
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-2', type: 'order', version: '1.0.0', status: 'failed' }),
    );
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-3', type: 'order', version: '1.0.0', status: 'cancelled' }),
    );
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-4', type: 'order', version: '1.0.0', status: 'timed-out' }),
    );

    const registrations: Record<string, WorkflowRegistration> = {
      order: { version: '2.0.0', handler: () => dummyHandler() },
    };

    const report = await runVersionCheck(storage, registrations);

    // No running/pending workflows, so no type reports
    expect(report.workflowTypes).toEqual([]);
    expect(report.overallVerdict).toBe('safe');
  });

  it('skips checkpoint keys when scanning storage', async () => {
    const storage = new MemoryStorage();
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-1', type: 'order', version: '1.0.0', status: 'running' }),
    );
    // Manually add a checkpoint entry that should be skipped
    await storage.put(KEYS.checkpoint('wf-1'), encode({ step: 1 }));

    const registrations: Record<string, WorkflowRegistration> = {
      order: { version: '1.0.0', handler: () => dummyHandler() },
    };

    const report = await runVersionCheck(storage, registrations);

    expect(report.workflowTypes).toHaveLength(1);
    expect(report.workflowTypes[0]!.runningCount).toBe(1);
  });

  it('uses DEFAULT_WORKFLOW_VERSION when registration has no version', async () => {
    const storage = new MemoryStorage();
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-1', type: 'order', version: '0.0.0', status: 'running' }),
    );

    const registrations: Record<string, WorkflowRegistration> = {
      order: { handler: () => dummyHandler() },
    };

    const report = await runVersionCheck(storage, registrations);

    expect(report.overallVerdict).toBe('safe');
    expect(report.workflowTypes[0]!.registeredVersion).toBe('0.0.0');
    expect(report.workflowTypes[0]!.compatibility).toBe('compatible');
  });

  it('picks the most common version when workflows of the same type have different stored versions', async () => {
    const storage = new MemoryStorage();
    // Three at 1.0.0, one at 0.9.0
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-1', type: 'order', version: '1.0.0', status: 'running' }),
    );
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-2', type: 'order', version: '1.0.0', status: 'running' }),
    );
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-3', type: 'order', version: '1.0.0', status: 'running' }),
    );
    await seedWorkflow(
      storage,
      makeWorkflowState({ id: 'wf-4', type: 'order', version: '0.9.0', status: 'running' }),
    );

    const registrations: Record<string, WorkflowRegistration> = {
      order: { version: '1.0.0', handler: () => dummyHandler() },
    };

    const report = await runVersionCheck(storage, registrations);

    expect(report.workflowTypes[0]!.storedVersion).toBe('1.0.0');
    expect(report.workflowTypes[0]!.runningCount).toBe(4);
  });
});

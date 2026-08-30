import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { decode, encode } from '../codec.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import { Engine } from './index.ts';

const WORKFLOW_TYPE = 'version-mismatch-waiter';

function createWaiterWorkflow(version: string) {
  return workflow({ name: WORKFLOW_TYPE, version }).execute(async function* (ctx: WorkflowContext) {
    const value = yield* ctx.waitForSignal<string>('continue');
    return `resumed:${value}`;
  });
}

async function waitForCheckpoint(storage: MemoryStorage, workflowId: string): Promise<void> {
  await waitForCondition(async () => (await storage.get(KEYS.checkpoint(workflowId))) !== null, {
    label: `checkpoint for ${workflowId}`,
  });
}

/**
 * Rewrite a persisted workflow's `versionTuple.workflowVersion` so the next
 * `recoverAll()` sees drift against the registered `WorkflowDefinition.version`.
 */
async function driftStoredWorkflowVersion(
  storage: MemoryStorage,
  workflowId: string,
  staleVersion: string,
): Promise<void> {
  const stateBytes = await storage.get(KEYS.workflow(workflowId));
  expect(stateBytes).not.toBeNull();
  const persisted = decode(stateBytes!) as Record<string, unknown>;
  persisted['versionTuple'] = { workflowVersion: staleVersion };
  await storage.put(KEYS.workflow(workflowId), encode(persisted));
}

describe('recoverAll() version mismatch policies', () => {
  it('fails only the mismatched sibling and recovers the matching one under the default fail-run policy', async () => {
    const storage = new MemoryStorage();

    {
      await using original = new Engine({ storage });
      original.register(createWaiterWorkflow('1.0.0'));
      await original.start(WORKFLOW_TYPE, null, { id: 'sibling-a-mismatched' });
      await original.start(WORKFLOW_TYPE, null, { id: 'sibling-b-matched' });
      await waitForCheckpoint(storage, 'sibling-a-mismatched');
      await waitForCheckpoint(storage, 'sibling-b-matched');
    }

    await driftStoredWorkflowVersion(storage, 'sibling-a-mismatched', '0.9.0');

    await using recovered = new Engine({ storage });
    recovered.register(createWaiterWorkflow('1.0.0'));

    const handles = await recovered.recoverAll();

    expect(handles.map((handle) => handle.id)).toEqual(['sibling-b-matched']);

    const mismatchedSummary = await recovered.get('sibling-a-mismatched');
    expect(mismatchedSummary?.status).toBe('failed');
    expect(mismatchedSummary?.failureCategory).toBe('system');
    expect(mismatchedSummary?.error).toContain('Version mismatch');

    const matchedHandle = handles[0]!;
    await matchedHandle.signal('continue', 'continue');
    await expect(matchedHandle.result()).resolves.toBe('resumed:continue');
  });

  it('does not resolve services or invoke onRecoveredWorkflow for the mismatched run', async () => {
    const storage = new MemoryStorage();

    {
      await using original = new Engine({ storage });
      original.register(createWaiterWorkflow('1.0.0'));
      await original.start(WORKFLOW_TYPE, null, { id: 'mismatch-no-hook' });
      await waitForCheckpoint(storage, 'mismatch-no-hook');
    }

    await driftStoredWorkflowVersion(storage, 'mismatch-no-hook', '0.9.0');

    await using recovered = new Engine({ storage });
    recovered.register(createWaiterWorkflow('1.0.0'));

    const recoveredWorkflowIds: string[] = [];
    const handles = await recovered.recoverAll({
      onRecoveredWorkflow: (info) => {
        recoveredWorkflowIds.push(info.workflowId);
      },
    });

    expect(handles).toEqual([]);
    expect(recoveredWorkflowIds).toEqual([]);

    const summary = await recovered.get('mismatch-no-hook');
    expect(summary?.status).toBe('failed');
  });

  it('fails fast and leaves later workflows unresumed when versionMismatchPolicy is "throw"', async () => {
    const storage = new MemoryStorage();

    {
      await using original = new Engine({ storage });
      original.register(createWaiterWorkflow('1.0.0'));
      // Lexicographically first so preflight/scan order processes it before
      // the healthy sibling, proving the throw aborts the still-unprocessed
      // rest of the batch.
      await original.start(WORKFLOW_TYPE, null, { id: 'sibling-a-mismatched-throw' });
      await original.start(WORKFLOW_TYPE, null, { id: 'sibling-b-matched-throw' });
      await waitForCheckpoint(storage, 'sibling-a-mismatched-throw');
      await waitForCheckpoint(storage, 'sibling-b-matched-throw');
    }

    await driftStoredWorkflowVersion(storage, 'sibling-a-mismatched-throw', '0.9.0');

    await using recovered = new Engine({ storage });
    recovered.register(createWaiterWorkflow('1.0.0'));

    await expect(recovered.recoverAll({ versionMismatchPolicy: 'throw' })).rejects.toThrow(
      'Version mismatch',
    );

    // The mismatched run's checkpoint/state is left untouched by the throw path.
    const mismatchedSummary = await recovered.get('sibling-a-mismatched-throw');
    expect(mismatchedSummary?.status).toBe('running');

    // The healthy sibling, later in scan order, never got a chance to resume.
    const matchedSummary = await recovered.get('sibling-b-matched-throw');
    expect(matchedSummary?.status).toBe('running');
  });
});

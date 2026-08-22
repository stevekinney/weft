import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { Engine } from './index.ts';
import type { EngineInternals } from './internals.ts';
import { getInternals } from './internals.ts';
import {
  acknowledgeSupersededSleepTimers,
  createSleepTimerAcknowledgement,
  handleSleepTimerWithAcknowledgement,
  recordDurableInlineOperation,
  rejectAllSleepTimerAcknowledgements,
  rejectSleepTimerAcknowledgements,
  settleSleepTimerAcknowledgements,
} from './sleep-timer-acknowledgements.ts';

function createInternals(): EngineInternals {
  return {
    durableInlineOperations: new Map(),
    sleepTimerAcknowledgementWaiters: new Map(),
  } as EngineInternals;
}

describe('sleep timer durable acknowledgements', () => {
  it('waits through the matching sleep checkpoint and settles on later durable progress', async () => {
    const internals = createInternals();
    const acknowledgement = createSleepTimerAcknowledgement(
      internals,
      'workflow',
      'workflow:0',
      1_000,
    );
    let settled = false;
    void acknowledgement.promise.then(() => {
      settled = true;
    });

    recordDurableInlineOperation(internals, 'workflow', {
      type: 'sleep',
      operationId: 'workflow:0',
      duration: 1_000,
      scheduledFireAt: 1_000,
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    recordDurableInlineOperation(internals, 'workflow', {
      type: 'wait-signal',
      operationId: 'workflow:1',
      signalName: 'continue',
    });
    await acknowledgement.promise;

    expect(internals.sleepTimerAcknowledgementWaiters.size).toBe(0);
  });

  it('settles a timer superseded by a later deadline for the same replayed sleep', async () => {
    const internals = createInternals();
    const acknowledgement = createSleepTimerAcknowledgement(
      internals,
      'workflow',
      'workflow:0',
      1_000,
    );

    recordDurableInlineOperation(internals, 'workflow', {
      type: 'sleep',
      operationId: 'workflow:0',
      duration: 1_000,
      scheduledFireAt: 2_000,
    });

    await acknowledgement.promise;
    expect(internals.sleepTimerAcknowledgementWaiters.size).toBe(0);
  });

  it('settles only acknowledgements older than the current sleep deadline', async () => {
    const internals = createInternals();
    const older = createSleepTimerAcknowledgement(internals, 'workflow', 'workflow:0', 1_000);
    const current = createSleepTimerAcknowledgement(internals, 'workflow', 'workflow:0', 2_000);

    acknowledgeSupersededSleepTimers(internals, 'workflow', 2_000);

    await older.promise;
    expect(internals.sleepTimerAcknowledgementWaiters.get('workflow')?.size).toBe(1);
    current.cancel();
  });

  it('resolves all pending acknowledgements after terminal progress', async () => {
    const internals = createInternals();
    const acknowledgement = createSleepTimerAcknowledgement(
      internals,
      'workflow',
      'workflow:0',
      1_000,
    );

    settleSleepTimerAcknowledgements(internals, 'workflow', 'terminal');

    await acknowledgement.promise;
    expect(internals.sleepTimerAcknowledgementWaiters.size).toBe(0);
  });

  it('rejects one workflow or every workflow without stranding waiters', async () => {
    const internals = createInternals();
    const first = createSleepTimerAcknowledgement(internals, 'first', 'first:0', 1_000);
    rejectSleepTimerAcknowledgements(internals, 'first', 'checkpoint failed');
    await expect(first.promise).rejects.toThrow('checkpoint failed');

    const second = createSleepTimerAcknowledgement(internals, 'second', 'second:0', 2_000);
    const third = createSleepTimerAcknowledgement(internals, 'third', 'third:0', 3_000);
    const disposalError = new Error('engine disposed');
    rejectAllSleepTimerAcknowledgements(internals, disposalError);

    await expect(second.promise).rejects.toBe(disposalError);
    await expect(third.promise).rejects.toBe(disposalError);
    expect(internals.sleepTimerAcknowledgementWaiters.size).toBe(0);
  });
});

describe('handleSleepTimerWithAcknowledgement: ADR 0002 "sleep" wake kind ownership check', () => {
  it('discards a fired timer for a workflow this engine holds no tracked claim for, without loading state', async () => {
    await using engine = await Engine.create({
      storage: new MemoryStorage(),
      ownership: 'workflow-lease',
      workflows: {},
    });
    const internals = getInternals(engine);
    // The workflow-lease bootstrap installs a registry, but this engine never
    // acquired a claim for this particular workflow id.
    expect(internals.workflowClaimRegistry).not.toBeNull();

    let stateLoaded = false;
    const loadWorkflowState = async (): Promise<null> => {
      stateLoaded = true;
      return null;
    };

    await handleSleepTimerWithAcknowledgement(
      internals,
      { id: 'sleep:wf-unowned:0', workflowId: 'wf-unowned', fireAt: 0, kind: 'sleep' },
      loadWorkflowState,
    );

    // The ownership check runs BEFORE shouldIgnoreUnclaimedSleepTimer ever
    // loads workflow state — see this function's doc comment for why that
    // ordering matters (it would otherwise risk the "fired before ready"
    // spurious throw for a workflow this engine never owned).
    expect(stateLoaded).toBe(false);
  });
});

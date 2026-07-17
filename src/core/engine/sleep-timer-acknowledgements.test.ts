import { describe, expect, it } from 'bun:test';

import type { EngineInternals } from './internals.ts';
import {
  acknowledgeSupersededSleepTimers,
  createSleepTimerAcknowledgement,
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

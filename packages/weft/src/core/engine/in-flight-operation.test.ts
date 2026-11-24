/**
 * The record of the operation an inline run's handler turn is processing (COR-1597): each turn
 * clears only its own record, a deferral clears only the operation that deferred, and the turn a
 * termination captures also settles when its activity defers.
 */
import { describe, expect, it } from 'bun:test';

import type { ContextOperationRequest } from '../context.ts';
import {
  beginInFlightOperation,
  captureInFlightActivityTurn,
  clearDeferredInFlightOperation,
  endInFlightOperation,
} from './in-flight-operation.ts';
import type { EngineInternals } from './internals.ts';
import { macrotasks } from './terminal-in-flight-activity.test-support.ts';

const activityOperation = (operationId: string) =>
  ({ type: 'activity', operationId, activityName: 'work', input: null }) as ContextOperationRequest;

function stubInternals(turn?: Promise<void>) {
  return {
    inFlightOperations: new Map(),
    inlineStrategy: { waitForWorkflowTurn: () => turn },
  } as never as EngineInternals;
}

describe('the in-flight operation record', () => {
  it("a turn's end does not erase the record of the turn that followed it", () => {
    const internals = stubInternals();
    const first = beginInFlightOperation(internals, 'wf', activityOperation('first'));
    const second = beginInFlightOperation(internals, 'wf', activityOperation('second'));

    endInFlightOperation(internals, 'wf', first);
    expect(internals.inFlightOperations.get('wf')).toBe(second);

    endInFlightOperation(internals, 'wf', second);
    expect(internals.inFlightOperations.has('wf')).toBe(false);
  });

  it('a deferral clears only the operation that deferred', () => {
    const internals = stubInternals();
    const record = beginInFlightOperation(internals, 'wf', activityOperation('current'));

    clearDeferredInFlightOperation(internals, 'wf', 'some-other-operation');
    expect(internals.inFlightOperations.get('wf')).toBe(record);

    clearDeferredInFlightOperation(internals, 'wf', 'current');
    expect(internals.inFlightOperations.has('wf')).toBe(false);
  });

  it('captures a turn only for an activity, and that turn settles when the activity defers', async () => {
    const neverSettles = new Promise<void>(() => {});
    const internals = stubInternals(neverSettles);

    beginInFlightOperation(internals, 'signal-wf', {
      type: 'wait-signal',
      signalName: 'go',
    } as ContextOperationRequest);
    expect(captureInFlightActivityTurn(internals, 'signal-wf')).toBeUndefined();

    beginInFlightOperation(internals, 'wf', activityOperation('deferring'));
    const captured = captureInFlightActivityTurn(internals, 'wf');
    expect(captured).toBeDefined();
    let settled = false;
    void captured!.then(() => {
      settled = true;
    });
    await macrotasks(2);
    expect(settled).toBe(false);

    clearDeferredInFlightOperation(internals, 'wf', 'deferring');
    await macrotasks(2);
    expect(settled).toBe(true);
  });
});

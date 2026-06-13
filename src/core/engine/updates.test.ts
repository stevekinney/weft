import { describe, expect, it, mock } from 'bun:test';

import type { UpdateRequest } from '../updates.ts';
import {
  deliverCoordinatedUpdateToWaiterIfAvailable,
  extractStandardSchemaIssues,
  processWaitUpdateOperation,
  update,
} from './updates.ts';

function createUpdateRequest(overrides: Partial<UpdateRequest> = {}): UpdateRequest {
  return {
    updateId: 'update-1',
    workflowId: 'workflow-1',
    name: 'rename',
    payload: { value: 'patched' },
    createdAt: 123,
    ...overrides,
  };
}

describe('engine update helpers', () => {
  it('throws the coordinated response error returned by update()', async () => {
    const internals = {
      inlineStrategy: null,
      updateWaiters: new Map(),
      updateWaitersByWorkflow: new Map(),
      updateCoordinator: {
        createRequest: mock(async () => 'update-1'),
        waitForResponse: mock(async () => ({ updateId: 'update-1', error: 'coordinated boom' })),
      },
    } as any;

    const callbacks = {
      guardTerminalWorkflow: mock(async () => {}),
      guardTerminalWorkflowAfterCoordinatedRequest: mock(async () => {}),
      schedulePendingInlineUpdateDrain: mock(() => {}),
      dispatchEvent: mock(() => true),
      broadcast: mock(() => {}),
      completeOperation: mock(() => {}),
      persistCoordinatedUpdateResponse: mock(async () => {}),
      deliverCoordinatedUpdateToWaiterIfAvailable: mock(async () => false),
      dispatchPendingUpdateReceived: mock(() => {}),
      createCoordinatedUpdateResponder: mock(() => () => {}),
      findPendingUpdateByName: mock(async () => undefined),
    } as any;

    await expect(
      update(internals, 'workflow-1', 'rename', { value: 'patched' }, undefined, callbacks),
    ).rejects.toThrow('coordinated boom');
  });

  it('delivers a pending update found after waiter registration', async () => {
    const deleteRequest = mock(async () => {});
    const internals = {
      updateCoordinator: { deleteRequest },
      updateWaiters: new Map(),
      updateWaitersByWorkflow: new Map<string, Set<string>>(),
    } as any;
    const updateRequest = createUpdateRequest();
    const responder = () => {};
    const completeOperation = mock(() => {});
    const dispatchPendingUpdateReceived = mock(() => {});
    const createCoordinatedUpdateResponder = mock(() => responder);
    let lookupCount = 0;
    const findPendingUpdateByName = mock(async (): Promise<UpdateRequest | undefined> => {
      lookupCount++;
      return lookupCount === 1 ? undefined : updateRequest;
    });

    await processWaitUpdateOperation(
      internals,
      'workflow-1',
      { type: 'wait-update', operationId: 'op-1', updateName: 'rename', callerStack: 'stack' },
      {
        dispatchEvent: mock(() => true),
        broadcast: mock(() => {}),
        completeOperation,
        guardTerminalWorkflow: mock(async () => {}),
        guardTerminalWorkflowAfterCoordinatedRequest: mock(async () => {}),
        persistCoordinatedUpdateResponse: mock(async () => {}),
        deliverCoordinatedUpdateToWaiterIfAvailable: mock(async () => false),
        dispatchPendingUpdateReceived,
        createCoordinatedUpdateResponder,
        findPendingUpdateByName,
        schedulePendingInlineUpdateDrain: mock(() => {}),
      } as any,
    );

    expect(deleteRequest).toHaveBeenCalledWith('workflow-1', 'update-1');
    expect(dispatchPendingUpdateReceived).toHaveBeenCalledWith(
      'workflow-1',
      'rename',
      updateRequest,
    );
    expect(createCoordinatedUpdateResponder).toHaveBeenCalledWith(
      'workflow-1',
      'rename',
      updateRequest,
    );
    expect(completeOperation).toHaveBeenCalledWith('workflow-1', {
      payload: updateRequest.payload,
      respond: responder,
    });
    expect(internals.updateWaiters.size).toBe(0);
  });

  it('returns false when a waiter exists for a different pending update', async () => {
    const waiter = mock(() => {});
    const waiterKey = 'workflow-1:rename';
    const internals = {
      updateCoordinator: { deleteRequest: mock(async () => {}) },
      updateWaiters: new Map([[waiterKey, waiter]]),
      updateWaitersByWorkflow: new Map<string, Set<string>>([['workflow-1', new Set([waiterKey])]]),
    } as any;

    const delivered = await deliverCoordinatedUpdateToWaiterIfAvailable(
      internals,
      'workflow-1',
      createUpdateRequest(),
      false,
      {
        dispatchEvent: mock(() => true),
        broadcast: mock(() => {}),
        completeOperation: mock(() => {}),
        guardTerminalWorkflow: mock(async () => {}),
        guardTerminalWorkflowAfterCoordinatedRequest: mock(async () => {}),
        persistCoordinatedUpdateResponse: mock(async () => {}),
        deliverCoordinatedUpdateToWaiterIfAvailable: mock(async () => false),
        dispatchPendingUpdateReceived: mock(() => {}),
        createCoordinatedUpdateResponder: mock(() => () => {}),
        findPendingUpdateByName: mock(async () =>
          createUpdateRequest({ updateId: 'other-update' }),
        ),
        schedulePendingInlineUpdateDrain: mock(() => {}),
      } as any,
    );

    expect(delivered).toBe(false);
    expect(waiter).not.toHaveBeenCalled();
  });

  it('dispatches the pending-update received hook when waiter delivery requests it', async () => {
    const waiter = mock(() => {});
    const deleteRequest = mock(async () => {});
    const dispatchPendingUpdateReceived = mock(() => {});
    const createCoordinatedUpdateResponder = mock(() => () => {});
    const waiterKey = 'workflow-1:rename';
    const updateRequest = createUpdateRequest();
    const internals = {
      updateCoordinator: { deleteRequest },
      updateWaiters: new Map([[waiterKey, waiter]]),
      updateWaitersByWorkflow: new Map<string, Set<string>>([['workflow-1', new Set([waiterKey])]]),
    } as any;

    const delivered = await deliverCoordinatedUpdateToWaiterIfAvailable(
      internals,
      'workflow-1',
      updateRequest,
      true,
      {
        dispatchEvent: mock(() => true),
        broadcast: mock(() => {}),
        completeOperation: mock(() => {}),
        guardTerminalWorkflow: mock(async () => {}),
        guardTerminalWorkflowAfterCoordinatedRequest: mock(async () => {}),
        persistCoordinatedUpdateResponse: mock(async () => {}),
        deliverCoordinatedUpdateToWaiterIfAvailable: mock(async () => false),
        dispatchPendingUpdateReceived,
        createCoordinatedUpdateResponder,
        findPendingUpdateByName: mock(async () => updateRequest),
        schedulePendingInlineUpdateDrain: mock(() => {}),
      } as any,
    );

    expect(delivered).toBe(true);
    expect(deleteRequest).toHaveBeenCalledWith('workflow-1', 'update-1');
    expect(dispatchPendingUpdateReceived).toHaveBeenCalledWith(
      'workflow-1',
      'rename',
      updateRequest,
    );
    expect(waiter).toHaveBeenCalledWith({
      payload: updateRequest.payload,
      respond: expect.any(Function),
    });
  });

  it('formats Standard Schema issue paths as RFC 6901 pointers', () => {
    expect(
      extractStandardSchemaIssues({
        issues: [
          {
            message: 'bad field',
            path: ['items', 0, { key: 'name/with~chars' }],
          },
        ],
      }),
    ).toEqual([{ message: 'bad field', path: '/items/0/name~1with~0chars' }]);
  });
});

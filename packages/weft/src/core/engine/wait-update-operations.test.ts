import { describe, expect, it, mock } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import type { UpdateRequest } from '../updates.ts';
import type { EngineInternals } from './internals.ts';
import type { UpdateCallbacks } from './updates.ts';
import { processWaitUpdateOperation } from './wait-update-operations.ts';

const PENDING_UPDATE = {
  updateId: 'update-1',
  name: 'approve',
  payload: { approved: true },
  createdAt: 1,
} as unknown as UpdateRequest;

describe('processWaitUpdateOperation', () => {
  it('leaves the wait pending when the pending update was already removed from storage', async () => {
    // The request was answered, and so deleted, between finding it and staging its deletion. The
    // wait must not complete with an update nobody can respond to.
    const internals = {
      durableInlineOperations: undefined,
      storage: new MemoryStorage(),
    } as unknown as EngineInternals;
    const completeOperation = mock(() => {});
    const dispatchPendingUpdateReceived = mock(() => {});
    const callbacks = {
      findPendingUpdateByName: async () => PENDING_UPDATE,
      completeOperation,
      dispatchPendingUpdateReceived,
    } as unknown as UpdateCallbacks;

    await processWaitUpdateOperation(
      internals,
      'waiting-run',
      { type: 'wait-update', operationId: 'wait-1', updateName: 'approve' } as never,
      callbacks,
    );

    expect(completeOperation).not.toHaveBeenCalled();
    expect(dispatchPendingUpdateReceived).not.toHaveBeenCalled();
  });
});

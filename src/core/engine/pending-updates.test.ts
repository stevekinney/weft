import { describe, expect, it, mock } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { sleepForTesting, waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { decode } from '../codec.ts';
import { UpdateCompletedEvent, UpdateReceivedEvent } from '../events.ts';
import { UpdateCoordinator } from '../updates.ts';
import type { EngineInternals } from './internals.ts';
import {
  invokeUpdateHandler,
  processPendingUpdatesAfterInlineAdvance,
  processPendingUpdatesForHandlers,
  schedulePendingInlineUpdateDrain,
} from './pending-updates.ts';

function createInternals(storage = new MemoryStorage()) {
  const updateCoordinator = new UpdateCoordinator(storage);
  const deliveredPendingUpdateIds = new Map<string, Set<string>>();
  const broadcasts: Array<{ type: 'update:completed'; workflowId: string; updateId: string }> = [];
  const events: Event[] = [];

  const internals = {
    conditionWaiters: new Map(),
    deliveredPendingUpdateIds,
    deposed: false,
    inlineStrategy: null,
    leaseManager: null,
    options: { ownershipMode: 'none' as const },
    storage,
    updateCoordinator,
  } as unknown as EngineInternals;

  return {
    broadcasts,
    callbacks: {
      broadcast: (message: { type: 'update:completed'; workflowId: string; updateId: string }) => {
        broadcasts.push(message);
      },
      dispatchEvent: (event: Event) => {
        events.push(event);
        return true;
      },
    },
    events,
    internals,
    storage,
    updateCoordinator,
  };
}

describe('pending update helpers', () => {
  it('invokes update handlers through the exported helper', async () => {
    const harness = createInternals();
    const handler = mock((payload: unknown) => (payload as { approved: boolean }).approved);

    await expect(
      invokeUpdateHandler(harness.internals, 'approve', handler, { approved: true }),
    ).resolves.toBe(true);
    expect(handler).toHaveBeenCalledWith({ approved: true });
  });

  it('waits for inline handlers after advance and persists validator rejections', async () => {
    const harness = createInternals();
    const workflowId = 'pending-inline-advance';
    const updateId = await harness.updateCoordinator.createRequest(workflowId, 'approve', {
      approved: false,
    });

    let handlerRegistered = false;
    harness.internals.inlineStrategy = {
      getContext: () =>
        handlerRegistered
          ? {
              updateHandlers: new Map([['approve', mock(() => 'ok')]]),
              updateValidators: new Map([
                [
                  'approve',
                  () => ({ issues: [{ message: 'approval required', path: '/approved' }] }),
                ],
              ]),
            }
          : { updateHandlers: new Map() },
      waitForWorkflowAdvance: () =>
        Promise.resolve().then(() => {
          handlerRegistered = true;
        }),
    } as never;

    await processPendingUpdatesAfterInlineAdvance(harness.internals, workflowId, harness.callbacks);

    expect(harness.broadcasts).toEqual([{ type: 'update:completed', workflowId, updateId }]);
    expect(harness.events).toEqual([]);

    const responseBytes = await harness.storage.get(KEYS.updateResponse(updateId));
    expect(responseBytes).not.toBeNull();
    expect(decode(responseBytes!)).toEqual(
      expect.objectContaining({
        error: 'Update "approve" rejected by validator: approval required',
        updateId,
      }),
    );
  });

  it('drains pending updates once, even when scheduled twice concurrently', async () => {
    const harness = createInternals();
    const workflowId = 'pending-inline-drain';
    const handler = mock((payload: { count: number }) => payload.count + 1);
    const updateId = await harness.updateCoordinator.createRequest(workflowId, 'increment', {
      count: 1,
    });

    harness.internals.inlineStrategy = {
      getContext: () => ({
        updateHandlers: new Map([['increment', handler]]),
      }),
      waitForWorkflowAdvance: () => null,
    } as never;

    schedulePendingInlineUpdateDrain(harness.internals, workflowId, harness.callbacks);
    schedulePendingInlineUpdateDrain(harness.internals, workflowId, harness.callbacks);

    await waitForCondition(async () => harness.broadcasts.length === 1, {
      label: 'scheduled pending update drain',
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(harness.broadcasts).toEqual([{ type: 'update:completed', workflowId, updateId }]);
    expect(harness.events).toEqual([
      expect.any(UpdateReceivedEvent),
      expect.any(UpdateCompletedEvent),
    ]);

    const responseBytes = await harness.storage.get(KEYS.updateResponse(updateId));
    expect(responseBytes).not.toBeNull();
    expect(decode(responseBytes!)).toEqual(
      expect.objectContaining({
        result: 2,
        updateId,
      }),
    );
  });

  it('records handler failures in the update response and skips scheduling without inline strategy', async () => {
    const harness = createInternals();
    const workflowId = 'pending-inline-handler-failure';
    const updateId = await harness.updateCoordinator.createRequest(workflowId, 'explode', {
      explode: true,
    });

    schedulePendingInlineUpdateDrain(harness.internals, workflowId, harness.callbacks);
    await sleepForTesting(0);
    expect(harness.broadcasts).toEqual([]);

    harness.internals.inlineStrategy = {
      getContext: () => ({
        updateHandlers: new Map([
          [
            'explode',
            () => {
              throw new Error('boom');
            },
          ],
        ]),
      }),
      waitForWorkflowAdvance: () => null,
    } as never;

    await processPendingUpdatesForHandlers(harness.internals, workflowId, harness.callbacks);

    const responseBytes = await harness.storage.get(KEYS.updateResponse(updateId));
    expect(responseBytes).not.toBeNull();
    expect(decode(responseBytes!)).toEqual(
      expect.objectContaining({
        error: 'boom',
        updateId,
      }),
    );
    expect(harness.broadcasts).toEqual([{ type: 'update:completed', workflowId, updateId }]);
    expect(harness.events).toEqual([
      expect.any(UpdateReceivedEvent),
      expect.any(UpdateCompletedEvent),
    ]);
  });

  it('polls across macrotasks until handlers register when no advance promise is available', async () => {
    const harness = createInternals();
    const workflowId = 'pending-macrotask-poll';
    const updateId = await harness.updateCoordinator.createRequest(workflowId, 'approve', {
      approved: true,
    });

    let handlerRegistered = false;
    setTimeout(() => {
      handlerRegistered = true;
    }, 0);
    harness.internals.inlineStrategy = {
      getContext: () =>
        handlerRegistered
          ? { updateHandlers: new Map([['approve', () => 'ready']]) }
          : { updateHandlers: new Map() },
      waitForWorkflowAdvance: () => null,
    } as never;

    await processPendingUpdatesAfterInlineAdvance(harness.internals, workflowId, harness.callbacks);

    expect(harness.broadcasts).toEqual([{ type: 'update:completed', workflowId, updateId }]);
    const responseBytes = await harness.storage.get(KEYS.updateResponse(updateId));
    expect(responseBytes).not.toBeNull();
    expect(decode(responseBytes!)).toEqual(
      expect.objectContaining({
        result: 'ready',
        updateId,
      }),
    );
  });

  it('gives up after bounded polling when handlers never register', async () => {
    const harness = createInternals();
    const workflowId = 'pending-no-handlers';
    await harness.updateCoordinator.createRequest(workflowId, 'approve', { approved: true });

    harness.internals.inlineStrategy = {
      getContext: () => ({ updateHandlers: new Map() }),
      waitForWorkflowAdvance: () => null,
    } as never;

    await processPendingUpdatesAfterInlineAdvance(harness.internals, workflowId, harness.callbacks);

    expect(harness.broadcasts).toEqual([]);
    expect(harness.events).toEqual([]);
  });

  it('converts validator throws into update validation errors', async () => {
    const harness = createInternals();
    const workflowId = 'pending-validator-throw';
    const updateId = await harness.updateCoordinator.createRequest(workflowId, 'approve', {
      approved: false,
    });

    harness.internals.inlineStrategy = {
      getContext: () => ({
        updateHandlers: new Map([['approve', mock(() => 'unused')]]),
        updateValidators: new Map([
          [
            'approve',
            () => {
              throw new Error('validator exploded');
            },
          ],
        ]),
      }),
      waitForWorkflowAdvance: () => null,
    } as never;

    await processPendingUpdatesForHandlers(harness.internals, workflowId, harness.callbacks);

    expect(harness.broadcasts).toEqual([{ type: 'update:completed', workflowId, updateId }]);
    const responseBytes = await harness.storage.get(KEYS.updateResponse(updateId));
    expect(responseBytes).not.toBeNull();
    expect(decode(responseBytes!)).toEqual(
      expect.objectContaining({
        error: 'Update "approve" rejected by validator: validator exploded',
        updateId,
      }),
    );
  });

  it('swallows scheduled drain failures after the timeout callback fires', async () => {
    const harness = createInternals();
    const workflowId = 'pending-scheduled-drain-failure';
    await harness.updateCoordinator.createRequest(workflowId, 'approve', { approved: true });

    const realStorage = harness.storage;
    harness.internals.storage = {
      batch: async () => {
        throw new Error('scheduled drain failed');
      },
      capabilities: realStorage.capabilities.bind(realStorage),
      conditionalBatch: realStorage.conditionalBatch?.bind(realStorage),
      delete: realStorage.delete.bind(realStorage),
      get: realStorage.get.bind(realStorage),
      put: realStorage.put.bind(realStorage),
      scan: realStorage.scan.bind(realStorage),
      [Symbol.dispose]: () => realStorage[Symbol.dispose](),
    } as never;
    harness.internals.inlineStrategy = {
      getContext: () => ({
        updateHandlers: new Map([['approve', () => 'ok']]),
      }),
      waitForWorkflowAdvance: () => null,
    } as never;

    schedulePendingInlineUpdateDrain(harness.internals, workflowId, harness.callbacks);
    await sleepForTesting(0);

    expect(harness.broadcasts).toEqual([]);
  });
});

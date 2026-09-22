/**
 * Unit tests for `installRemoteActivityEventBridges`'s residual catch-and-log
 * branches: both listeners are documented best-effort hints that must log
 * and continue rather than throw when their underlying operation fails —
 * the immediate dispatch (`RemoteActivityQueuedEvent`) relies on the
 * periodic reconciliation sweep as a fallback, and the cancellation request
 * (`RemoteActivityCancellationRequestedEvent`) is itself only a hint on top
 * of the ledger's own eventual settlement.
 */
import { describe, expect, it, spyOn } from 'bun:test';

import {
  RemoteActivityCancellationRequestedEvent,
  RemoteActivityQueuedEvent,
} from '../../core/events.ts';
import { waitForParityCondition as waitFor } from '../../core/parity/real-timer-wait.test-support.ts';
import type { RemoteTaskQueued } from '../../core/task-ledger/task-ledger.ts';
import { encodeRemoteTaskRecord, taskLedgerKey } from '../../core/task-ledger/task-ledger.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import type { ServeOptions } from '../index.ts';
import { installRemoteActivityEventBridges } from './remote-activity-event-bridges.ts';
import { minimalServerContext } from './server-context.test-support.ts';

function queuedFixture(overrides: Partial<RemoteTaskQueued> = {}): RemoteTaskQueued {
  const now = Date.now();
  return {
    recordVersion: 1,
    operationId: 'op-1',
    workflowType: 'test',
    activityName: 'test.charge',
    queue: 'default',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: now,
    generation: 0,
    state: 'queued',
    attempt: 1,
    availableAt: now,
    firstQueuedAt: now,
    lastQueuedAt: now,
    retryCount: 0,
    requeueCount: 0,
    ...overrides,
  };
}

/** A minimal `ServeOptions['engine']` that is a real EventTarget (so
 * `addEventListener`/`dispatchEvent` behave normally) plus the storage
 * surface these handlers read. */
function engineOptions(storage: MemoryStorage): ServeOptions {
  const engine = Object.assign(new EventTarget(), { storage });
  return { engine, port: 0 } as unknown as ServeOptions;
}

describe('installRemoteActivityEventBridges — dispatch-failure logging', () => {
  it('logs and continues when the immediate dispatch attempt fails', async () => {
    class FailingLedgerReadStorage extends MemoryStorage {
      override async get(key: string): Promise<Uint8Array | null> {
        if (key === taskLedgerKey('op-dispatch-fails')) {
          throw new Error('storage unavailable');
        }
        return super.get(key);
      }
    }

    const context = minimalServerContext();
    const options = engineOptions(new FailingLedgerReadStorage());
    const dispose = installRemoteActivityEventBridges(context, options);

    using errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    options.engine.dispatchEvent(
      new RemoteActivityQueuedEvent('op-dispatch-fails', 'wf-1', 'default'),
    );

    await waitFor(() => errorSpy.mock.calls.length > 0, {
      label: 'immediate-dispatch failure to be logged',
    });

    expect(errorSpy).toHaveBeenCalledWith(
      '[weft] Immediate dispatch of remote activity task "op-dispatch-fails" failed — ' +
        'the periodic reconciliation scan will retry it:',
      expect.any(Error),
    );

    dispose();
  });
});

describe('installRemoteActivityEventBridges — cancellation-failure logging', () => {
  it('logs and continues when the cancellation request fails', async () => {
    class FailingLedgerReadStorage extends MemoryStorage {
      override async get(key: string): Promise<Uint8Array | null> {
        if (key === taskLedgerKey('op-cancel-fails')) {
          throw new Error('storage unavailable');
        }
        return super.get(key);
      }
    }

    const storage = new FailingLedgerReadStorage();
    await storage.put(
      taskLedgerKey('op-cancel-fails'),
      encodeRemoteTaskRecord(queuedFixture({ operationId: 'op-cancel-fails' })),
    );
    // The put above succeeded because it targeted the real MemoryStorage
    // write path, not the overridden `get`; the record is only used to
    // prove the failure path is a storage-read failure, not a "no record"
    // no-op — cancelTask's own `get` on this key is what throws.

    const context = minimalServerContext();
    const options = engineOptions(storage);
    const dispose = installRemoteActivityEventBridges(context, options);

    using errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    options.engine.dispatchEvent(
      new RemoteActivityCancellationRequestedEvent('op-cancel-fails', 'wf-1'),
    );

    await waitFor(() => errorSpy.mock.calls.length > 0, {
      label: 'cancellation-request failure to be logged',
    });

    expect(errorSpy).toHaveBeenCalledWith(
      '[weft] Cancellation request for remote activity task "op-cancel-fails" failed:',
      expect.any(Error),
    );

    dispose();
  });
});

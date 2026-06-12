import { describe, expect, it, mock } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { sleepForTesting } from '../../testing/fake-timers.test-support.ts';
import { encode } from '../codec.ts';
import type { SignalReceivedInterception } from '../interceptor/interception-contexts.ts';
import type { WorkflowState } from '../types.ts';
import {
  bufferSignalPayloads,
  consumeSignal,
  releaseSignalWaiter,
  signal,
  trackWaiterKey,
  untrackWaiterKey,
  type SignalCallbacks,
} from './signals.ts';

function createWorkflowState(workflowId: string, status: WorkflowState['status']): WorkflowState {
  return {
    createdAt: 1,
    id: workflowId,
    input: null,
    startedAt: 1,
    status,
    type: 'workflow',
    updatedAt: 1,
    versionTuple: { workflowVersion: '1' },
  };
}

function createSignalInternals(storage = new MemoryStorage()) {
  return {
    options: { payloadSizePolicy: { maxBytes: null } },
    parkedInlineWorkflows: new Set<string>(),
    signalWaiters: new Map<string, () => void>(),
    signalWaitersByWorkflow: new Map(),
    conditionWaiters: new Map<string, () => void>(),
    deliveredPendingUpdateIds: new Map<string, Set<string>>(),
    storage,
    workflowsNeedingTerminalCleanup: new Set<string>(),
  };
}

function createSignalCallbacks(
  overrides: Partial<SignalCallbacks> = {},
  state: WorkflowState | null = null,
): SignalCallbacks {
  return {
    broadcast: mock(() => {}),
    dispatchEvent: mock(() => true),
    getComposedInterceptor: () => null,
    loadWorkflowState: async () => state,
    resumeParkedInlineWorkflow: mock(async () => {}),
    ...overrides,
  };
}

class NoConditionalBatchMemoryStorage extends MemoryStorage {
  override capabilities() {
    return { ...super.capabilities(), conditionalBatch: false };
  }
}

describe('engine signals', () => {
  it('lets a signalReceived interceptor block delivery by omitting next', async () => {
    const storage = new MemoryStorage();
    const internals = createSignalInternals(storage);

    await signal(internals as never, 'workflow-blocked', 'release', 'payload', {
      ...createSignalCallbacks(),
      getComposedInterceptor: () =>
        ({
          signalReceived: mock(() => {}),
        }) as never,
    });

    expect(await consumeSignal(internals as never, 'workflow-blocked', 'release')).toEqual({
      found: false,
    });
  });

  it('awaits delivery before rethrowing interceptor failures after next', async () => {
    const storage = new MemoryStorage();
    const internals = createSignalInternals(storage);

    await expect(
      signal(internals as never, 'workflow-delivered-before-throw', 'release', 'payload', {
        ...createSignalCallbacks(),
        getComposedInterceptor: () =>
          ({
            signalReceived: (
              _interception: SignalReceivedInterception,
              next: (interception: SignalReceivedInterception) => void,
            ) => {
              next({
                headers: new Map<string, string>(),
                payload: 'changed',
                signalName: 'release',
                workflowId: 'workflow-delivered-before-throw',
              });
              throw new Error('interceptor failed');
            },
          }) as never,
      }),
    ).rejects.toThrow('interceptor failed');

    expect(
      await consumeSignal(internals as never, 'workflow-delivered-before-throw', 'release'),
    ).toEqual({
      found: true,
      payload: 'changed',
    });
  });

  it('rejects signal interceptors that call next more than once', async () => {
    const internals = createSignalInternals();

    await expect(
      signal(internals as never, 'workflow-double-next', 'release', 'payload', {
        ...createSignalCallbacks(),
        getComposedInterceptor: () =>
          ({
            signalReceived: (
              interception: SignalReceivedInterception,
              next: (interception: SignalReceivedInterception) => void,
            ) => {
              next(interception);
              next(interception);
            },
          }) as never,
      }),
    ).rejects.toThrow('signalReceived interceptor called next() more than once');
  });

  it('ignores empty and terminal signal deliveries', async () => {
    const storage = new MemoryStorage();
    const internals = createSignalInternals(storage);

    await bufferSignalPayloads(internals as never, 'workflow-empty', [], createSignalCallbacks());
    await bufferSignalPayloads(
      internals as never,
      'workflow-terminal',
      [{ payload: 'late', signalName: 'release' }],
      createSignalCallbacks({}, createWorkflowState('workflow-terminal', 'completed')),
    );

    expect(await storage.get(KEYS.terminalCleanupNeeded('workflow-empty'))).toBeNull();
    expect(await storage.get(KEYS.terminalCleanupNeeded('workflow-terminal'))).toBeNull();
  });

  it('deduplicates signal deliveries with the same signalId and persists the accepted response', async () => {
    const storage = new MemoryStorage();
    const internals = createSignalInternals(storage);
    const callbacks = createSignalCallbacks();

    await signal(internals as never, 'workflow-idempotent', 'release', 'first', callbacks, {
      signalId: 'signal-1',
    });
    await signal(internals as never, 'workflow-idempotent', 'release', 'second', callbacks, {
      signalId: 'signal-1',
    });

    expect(callbacks.dispatchEvent).toHaveBeenCalledTimes(1);
    expect(await consumeSignal(internals as never, 'workflow-idempotent', 'release')).toEqual({
      found: true,
      payload: 'first',
    });
    expect(await consumeSignal(internals as never, 'workflow-idempotent', 'release')).toEqual({
      found: false,
    });
    expect(
      await storage.get(KEYS.signalAcceptedResponse('workflow-idempotent', 'release', 'signal-1')),
    ).not.toBeNull();
  });

  it('keeps signalId retries idempotent after the buffered signal is consumed', async () => {
    const storage = new MemoryStorage();
    const internals = createSignalInternals(storage);
    const callbacks = createSignalCallbacks();

    await signal(internals as never, 'workflow-consumed', 'release', 'first', callbacks, {
      signalId: 'signal:1',
    });
    expect(await consumeSignal(internals as never, 'workflow-consumed', 'release')).toEqual({
      found: true,
      payload: 'first',
    });
    expect(callbacks.dispatchEvent).toHaveBeenCalledTimes(1);

    await signal(internals as never, 'workflow-consumed', 'release', 'duplicate', callbacks, {
      signalId: 'signal:1',
    });

    expect(callbacks.dispatchEvent).toHaveBeenCalledTimes(1);
    expect(await consumeSignal(internals as never, 'workflow-consumed', 'release')).toEqual({
      found: false,
    });
  });

  it('rejects signalId delivery before tracking cleanup when conditionalBatch is unavailable', async () => {
    const storage = new NoConditionalBatchMemoryStorage();
    const internals = createSignalInternals(storage);
    const callbacks = createSignalCallbacks();

    await expect(
      signal(internals as never, 'workflow-no-conditional-batch', 'release', 'first', callbacks, {
        signalId: 'no-conditional-batch',
      }),
    ).rejects.toThrow('requires storage capability "conditionalBatch"');

    expect(internals.workflowsNeedingTerminalCleanup.has('workflow-no-conditional-batch')).toBe(
      false,
    );
    expect(
      await storage.get(KEYS.terminalCleanupNeeded('workflow-no-conditional-batch')),
    ).toBeNull();
    expect(
      await consumeSignal(internals as never, 'workflow-no-conditional-batch', 'release'),
    ).toEqual({
      found: false,
    });
  });

  it('buffers anonymous signals when conditionalBatch is unavailable', async () => {
    const storage = new NoConditionalBatchMemoryStorage();
    const internals = createSignalInternals(storage);
    const callbacks = createSignalCallbacks();

    await signal(
      internals as never,
      'workflow-anonymous-no-conditional',
      'release',
      'first',
      callbacks,
    );
    await signal(
      internals as never,
      'workflow-anonymous-no-conditional',
      'release',
      'second',
      callbacks,
    );

    expect(
      await consumeSignal(internals as never, 'workflow-anonymous-no-conditional', 'release'),
    ).toEqual({
      found: true,
      payload: 'first',
    });
    expect(
      await consumeSignal(internals as never, 'workflow-anonymous-no-conditional', 'release'),
    ).toEqual({
      found: true,
      payload: 'second',
    });
  });

  it('serializes anonymous sequence allocation when conditionalBatch is unavailable', async () => {
    class SlowSequenceStorage extends NoConditionalBatchMemoryStorage {
      override async get(key: string): Promise<Uint8Array | null> {
        if (key === KEYS.signalSequence('workflow-anonymous-concurrent')) {
          await sleepForTesting(5);
        }

        return super.get(key);
      }
    }

    const storage = new SlowSequenceStorage();
    const internals = createSignalInternals(storage);
    const callbacks = createSignalCallbacks();

    await Promise.all([
      signal(internals as never, 'workflow-anonymous-concurrent', 'release', 'first', callbacks),
      signal(internals as never, 'workflow-anonymous-concurrent', 'release', 'second', callbacks),
    ]);

    const signalKeys: string[] = [];
    for await (const [key] of storage.scan('sig:workflow-anonymous-concurrent:release:')) {
      signalKeys.push(key);
    }

    expect(signalKeys).toHaveLength(2);
    expect(signalKeys[0]).toContain('anonymous%3A0000000000000000%3A');
    expect(signalKeys[1]).toContain('anonymous%3A0000000000000001%3A');
  });

  it('scans anonymous signal keys only while bootstrapping the sequence key', async () => {
    class ScanCountingStorage extends MemoryStorage {
      signalScanCount = 0;

      override scan(prefix: string) {
        if (prefix === 'sig:workflow-anonymous-scan-bootstrap:') {
          this.signalScanCount += 1;
        }

        return super.scan(prefix);
      }
    }

    const storage = new ScanCountingStorage();
    const internals = createSignalInternals(storage);
    const callbacks = createSignalCallbacks();

    await signal(
      internals as never,
      'workflow-anonymous-scan-bootstrap',
      'release',
      'first',
      callbacks,
    );
    await signal(
      internals as never,
      'workflow-anonymous-scan-bootstrap',
      'release',
      'second',
      callbacks,
    );

    expect(storage.signalScanCount).toBe(1);
  });

  it('rejects oversize signalIds before persistence', async () => {
    const storage = new MemoryStorage();
    const internals = createSignalInternals(storage);
    const callbacks = createSignalCallbacks();
    const oversizeSignalId = 'x'.repeat(129);

    await expect(
      signal(internals as never, 'workflow-oversize-signal-id', 'release', 'first', callbacks, {
        signalId: oversizeSignalId,
      }),
    ).rejects.toThrow('signalId must be at most 128 bytes');
    expect(
      await storage.get(
        KEYS.signalAcceptedResponse('workflow-oversize-signal-id', 'release', oversizeSignalId),
      ),
    ).toBeNull();
    expect(
      await consumeSignal(internals as never, 'workflow-oversize-signal-id', 'release'),
    ).toEqual({
      found: false,
    });
  });

  it('rejects oversize default signalIds before buffering multiple deliveries', async () => {
    const storage = new MemoryStorage();
    const internals = createSignalInternals(storage);
    const callbacks = createSignalCallbacks();
    const oversizeSignalId = 'x'.repeat(129);

    await expect(
      bufferSignalPayloads(
        internals as never,
        'workflow-oversize-default-signal-id',
        [
          { signalName: 'first', payload: 'one' },
          { signalName: 'second', payload: 'two' },
        ],
        callbacks,
        { signalId: oversizeSignalId },
      ),
    ).rejects.toThrow('signalId must be at most 128 bytes');
    expect(
      await consumeSignal(internals as never, 'workflow-oversize-default-signal-id', 'first'),
    ).toEqual({
      found: false,
    });
    expect(
      await consumeSignal(internals as never, 'workflow-oversize-default-signal-id', 'second'),
    ).toEqual({
      found: false,
    });
  });

  it('does not redeliver when the signal exists but the accepted response must be repaired', async () => {
    const storage = new MemoryStorage();
    const internals = createSignalInternals(storage);
    const callbacks = createSignalCallbacks();
    await storage.put(KEYS.signal('workflow-repair', 'release', 'signal-1'), encode('first'));

    await signal(internals as never, 'workflow-repair', 'release', 'second', callbacks, {
      signalId: 'signal-1',
    });

    expect(callbacks.dispatchEvent).not.toHaveBeenCalled();
    expect(
      await storage.get(KEYS.signalAcceptedResponse('workflow-repair', 'release', 'signal-1')),
    ).not.toBeNull();
    expect(await consumeSignal(internals as never, 'workflow-repair', 'release')).toEqual({
      found: true,
      payload: 'first',
    });
  });

  it('releases only matching signal waiters', () => {
    const internals = createSignalInternals();
    const firstWaiter = mock(() => {});
    const secondWaiter = mock(() => {});
    const waiterKey = 'workflow-waiter:release';
    internals.signalWaiters.set(waiterKey, firstWaiter);
    internals.signalWaitersByWorkflow.set('workflow-waiter', waiterKey);

    releaseSignalWaiter(internals as never, 'workflow-waiter', waiterKey, secondWaiter);
    expect(internals.signalWaiters.has(waiterKey)).toBe(true);

    releaseSignalWaiter(internals as never, 'workflow-waiter', waiterKey, firstWaiter);
    expect(internals.signalWaiters.has(waiterKey)).toBe(false);

    releaseSignalWaiter(internals as never, 'workflow-waiter', waiterKey);
  });

  it('promotes and compacts workflow-keyed waiter indexes', () => {
    const reverseIndex = new Map();

    trackWaiterKey(reverseIndex, 'workflow-indexed', 'a');
    trackWaiterKey(reverseIndex, 'workflow-indexed', 'a');
    expect(reverseIndex.get('workflow-indexed')).toBe('a');

    trackWaiterKey(reverseIndex, 'workflow-indexed', 'b');
    expect(reverseIndex.get('workflow-indexed')).toEqual(new Set(['a', 'b']));

    trackWaiterKey(reverseIndex, 'workflow-indexed', 'c');
    expect(reverseIndex.get('workflow-indexed')).toEqual(new Set(['a', 'b', 'c']));

    untrackWaiterKey(reverseIndex, 'workflow-indexed', 'missing');
    expect(reverseIndex.get('workflow-indexed')).toEqual(new Set(['a', 'b', 'c']));

    untrackWaiterKey(reverseIndex, 'workflow-indexed', 'b');
    expect(reverseIndex.get('workflow-indexed')).toEqual(new Set(['a', 'c']));

    untrackWaiterKey(reverseIndex, 'workflow-indexed', 'c');
    expect(reverseIndex.get('workflow-indexed')).toBe('a');

    untrackWaiterKey(reverseIndex, 'workflow-indexed', 'a');
    expect(reverseIndex.has('workflow-indexed')).toBe(false);

    untrackWaiterKey(reverseIndex, 'workflow-indexed', 'a');

    reverseIndex.set('workflow-single-set', new Set(['only']));
    untrackWaiterKey(reverseIndex, 'workflow-single-set', 'only');
    expect(reverseIndex.has('workflow-single-set')).toBe(false);
  });
});

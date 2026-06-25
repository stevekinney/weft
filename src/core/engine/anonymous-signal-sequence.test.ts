import { describe, expect, it } from 'bun:test';

import type { StorageCapabilities } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { decode, encode } from '../codec.ts';
import { commitAnonymousSignalOperations } from './anonymous-signal-sequence.ts';
import type { EngineInternals } from './internals.ts';

class NonConditionalMemoryStorage extends MemoryStorage {
  override capabilities(): StorageCapabilities {
    return {
      ...super.capabilities(),
      conditionalBatch: false,
    };
  }
}

class NeverCommitConditionalStorage extends MemoryStorage {
  override async conditionalBatch(): Promise<boolean> {
    return false;
  }
}

function createInternals(storage: MemoryStorage): EngineInternals {
  return {
    options: {
      payloadSizePolicy: { maxBytes: null },
    },
    storage,
  } as unknown as EngineInternals;
}

describe('anonymous signal sequence', () => {
  it('scans existing anonymous signal keys, ignoring malformed ids when conditional batches are unavailable', async () => {
    const storage = new NonConditionalMemoryStorage();
    const workflowId = 'anonymous-signal-workflow';
    const internals = createInternals(storage);

    await storage.put(
      KEYS.signal(workflowId, 'continue', 'anonymous:0000000000000003:existing'),
      encode('old'),
    );
    await storage.put(
      KEYS.signal(workflowId, 'continue', 'anonymous:missing-separator'),
      encode('ignored'),
    );
    await storage.put(
      KEYS.signal(workflowId, 'continue', 'anonymous:not-a-number:ignored'),
      encode('ignored'),
    );

    const cleanupOperations: string[] = [];
    let trackedCleanup = 0;

    await commitAnonymousSignalOperations(
      internals,
      workflowId,
      [{ signalName: 'continue', payload: { ok: true } }],
      (operations) => {
        cleanupOperations.push(String(operations.length));
      },
      () => {
        trackedCleanup += 1;
      },
    );

    expect(cleanupOperations).toEqual(['2']);
    expect(trackedCleanup).toBe(1);
    expect(decode((await storage.get(KEYS.signalSequence(workflowId)))!)).toBe(5);
  });

  it('fails closed when the stored sequence value is invalid', async () => {
    const storage = new NonConditionalMemoryStorage();
    const workflowId = 'anonymous-invalid-sequence';
    await storage.put(KEYS.signalSequence(workflowId), encode('bad-sequence'));

    await expect(
      commitAnonymousSignalOperations(
        createInternals(storage),
        workflowId,
        [{ signalName: 'continue', payload: null }],
        () => {},
        () => {},
      ),
    ).rejects.toThrow('Stored anonymous signal sequence must be a non-negative safe integer');
  });

  it('rejects anonymous signal sequence overflow discovered during a scan', async () => {
    const storage = new NonConditionalMemoryStorage();
    const workflowId = 'anonymous-overflow-sequence';
    await storage.put(
      KEYS.signal(
        workflowId,
        'continue',
        `anonymous:${String(Number.MAX_SAFE_INTEGER).padStart(16, '0')}:existing`,
      ),
      encode('old'),
    );

    await expect(
      commitAnonymousSignalOperations(
        createInternals(storage),
        workflowId,
        [{ signalName: 'continue', payload: null }],
        () => {},
        () => {},
      ),
    ).rejects.toThrow(`Anonymous signal sequence overflow for workflow "${workflowId}"`);
  });

  it('throws after exhausting compare-and-set attempts', async () => {
    const storage = new NeverCommitConditionalStorage();
    const workflowId = 'anonymous-retry-exhaustion';

    await expect(
      commitAnonymousSignalOperations(
        createInternals(storage),
        workflowId,
        [{ signalName: 'continue', payload: null }],
        () => {},
        () => {},
      ),
    ).rejects.toThrow(`Could not allocate anonymous signal sequence for workflow "${workflowId}"`);
  });
});

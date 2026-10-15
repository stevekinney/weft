import { describe, expect, it } from 'bun:test';

import { KEYS, type BatchOperation } from '../../../storage/interface.ts';
import { MemoryStorage } from '../../../storage/memory.ts';
import {
  beginExecutionAttempt,
  captureExecutionAttemptIdentity,
  recordExecutionAttemptIdentity,
} from '../execution-attempts.ts';
import type { EngineInternals } from '../internals.ts';
import {
  bytesEqual,
  captureOrReadTerminalFence,
  commitFencedTeardownBatch,
  deleteKeysInGuardedChunks,
  warnUnknownRunIdentity,
  type TerminalFence,
} from './terminal-fence.ts';

const generation = new Uint8Array([1, 2, 3]);
const fence: TerminalFence = { identity: { generation, holderMarker: null } };

/** A storage that reports no `conditionalBatch` capability, like a custom adapter without CAS. */
function storageWithoutConditionalBatch(): MemoryStorage {
  const storage = new MemoryStorage();
  return new Proxy(storage, {
    get(target, property, receiver) {
      if (property === 'capabilities') {
        return () => ({ ...target.capabilities(), conditionalBatch: false });
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const put = (key: string): BatchOperation[] => [{ type: 'put', key, value: new Uint8Array([9]) }];

describe('commitFencedTeardownBatch', () => {
  it('without conditionalBatch, applies the batch while the same-engine guard holds', async () => {
    const storage = storageWithoutConditionalBatch();
    const internals = { storage } as unknown as EngineInternals;
    expect(await commitFencedTeardownBatch(internals, 'w', fence, put('k'), () => false)).toBe(
      true,
    );
    expect(await storage.get('k')).not.toBeNull();
  });

  it('without conditionalBatch, skips the batch once the same-engine guard reports a replacement', async () => {
    const storage = storageWithoutConditionalBatch();
    const internals = { storage } as unknown as EngineInternals;
    expect(await commitFencedTeardownBatch(internals, 'w', fence, put('k'), () => true)).toBe(
      false,
    );
    expect(await storage.get('k')).toBeNull();
  });

  it('with conditionalBatch, applies only while the committed state is still stored', async () => {
    const storage = new MemoryStorage();
    const internals = { storage } as unknown as EngineInternals;
    await storage.put(KEYS.workflowGeneration('w'), generation);
    expect(await commitFencedTeardownBatch(internals, 'w', fence, put('a'), () => false)).toBe(
      true,
    );
    await storage.put(KEYS.workflowGeneration('w'), new Uint8Array([7]));
    expect(await commitFencedTeardownBatch(internals, 'w', fence, put('b'), () => false)).toBe(
      false,
    );
    expect(await storage.get('b')).toBeNull();
  });
});

describe('bytesEqual', () => {
  it('compares contents and treats null as an absent key', () => {
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1]))).toBe(true);
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([2]))).toBe(false);
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
    expect(bytesEqual(null, null)).toBe(true);
    expect(bytesEqual(null, new Uint8Array())).toBe(false);
  });
});

describe('captureOrReadTerminalFence', () => {
  const identity = { generation: new Uint8Array([3]), holderMarker: null };

  it("returns a held run's known identity synchronously", () => {
    const internals = { storage: new MemoryStorage() } as unknown as EngineInternals;
    beginExecutionAttempt(internals, 'w', 'token-a');
    recordExecutionAttemptIdentity(internals, 'w', 'token-a', identity);
    const fence = captureOrReadTerminalFence(internals, 'w', 'token-a');
    expect(fence).not.toBeInstanceOf(Promise);
    expect(fence).toEqual({ identity });
  });

  it('waits for an adoption read that is still in flight, then uses its pre-commit value', async () => {
    const storage = new MemoryStorage();
    await storage.put(KEYS.workflowGeneration('w'), new Uint8Array([5]));
    const internals = { storage } as unknown as EngineInternals;
    beginExecutionAttempt(internals, 'w', 'token-a');
    captureExecutionAttemptIdentity(internals, 'w');
    const fence = captureOrReadTerminalFence(internals, 'w', 'token-a');
    expect(fence).toBeInstanceOf(Promise);
    const settled = await fence;
    expect(settled.identity?.generation).toEqual(new Uint8Array([5]));
  });

  it('reads the identity for a run another engine holds, and has none for an unlearned attempt', async () => {
    const storage = new MemoryStorage();
    await storage.put(KEYS.workflowGeneration('w'), new Uint8Array([7]));
    const internals = { storage } as unknown as EngineInternals;
    const remote = await captureOrReadTerminalFence(internals, 'w', 'token-a');
    expect(remote.identity?.generation).toEqual(new Uint8Array([7]));

    beginExecutionAttempt(internals, 'v', 'token-b');
    expect(captureOrReadTerminalFence(internals, 'v', 'token-b')).toEqual({ identity: undefined });
  });
});

describe('warnUnknownRunIdentity', () => {
  it('reports a missing identity once per call and stays quiet when it is known', () => {
    const reports: unknown[][] = [];
    const report = (...args: unknown[]) => void reports.push(args);
    warnUnknownRunIdentity({ identity: undefined }, 'w', report);
    warnUnknownRunIdentity({ identity: { generation: null, holderMarker: null } }, 'w', report);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.[0]).toBe('terminal-teardown-fence');
    expect(reports[0]?.[2]).toBe('w');
  });
});

describe('deleteKeysInGuardedChunks', () => {
  const keysOf = async function* (count: number): AsyncGenerator<string> {
    for (let index = 0; index < count; index += 1) yield `k:${String(index)}`;
  };

  it('commits the initial deletes and the listed keys in chunks of 500', async () => {
    const sizes: number[] = [];
    const applied = await deleteKeysInGuardedChunks(
      keysOf(1_200),
      async (operations) => {
        sizes.push(operations.length);
        return true;
      },
      [{ type: 'delete', key: 'first' }],
    );
    expect(applied).toBe(true);
    expect(sizes).toEqual([500, 500, 201]);
  });

  it('stops at the first chunk the fence rejects', async () => {
    const sizes: number[] = [];
    const applied = await deleteKeysInGuardedChunks(keysOf(1_200), async (operations) => {
      sizes.push(operations.length);
      return sizes.length < 2;
    });
    expect(applied).toBe(false);
    expect(sizes).toEqual([500, 500]);
  });

  it('commits nothing when there is nothing to delete', async () => {
    let calls = 0;
    expect(
      await deleteKeysInGuardedChunks(keysOf(0), async () => {
        calls += 1;
        return true;
      }),
    ).toBe(true);
    expect(calls).toBe(0);
  });
});

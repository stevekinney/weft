import { describe, expect, it } from 'bun:test';

import type { Storage } from './interface.ts';
import {
  decodeStorageKeyComponent,
  encodeStorageKeyComponent,
  KEYS,
  matchesScanOptions,
  resolvePrefixRangeEnd,
  storageConditionalBatch,
  storageCount,
  storageDeletePrefix,
  storageHas,
  storageKeys,
  storageValuesEqual,
  tryDecodeStorageKeyComponent,
} from './interface.ts';
import { MemoryStorage } from './memory.ts';

function createCoreStorageAdapter(): Storage {
  const storage = new MemoryStorage();

  return {
    // Core-five adapter: omits the optional methods AND honestly reports the
    // capabilities it lacks (no compare-and-swap, no bounded range delete).
    capabilities: () => ({
      readAfterWrite: 'linearizable',
      scanConsistency: 'snapshot',
      atomicBatch: true,
      conditionalBatch: false,
      boundedRangeDelete: false,
    }),
    get: storage.get.bind(storage),
    put: storage.put.bind(storage),
    delete: storage.delete.bind(storage),
    scan: storage.scan.bind(storage),
    batch: storage.batch.bind(storage),
    [Symbol.dispose]: storage[Symbol.dispose].bind(storage),
  };
}

describe('storageDeletePrefix', () => {
  it('returns 0 when the fallback path finds no matching keys', async () => {
    const storage = createCoreStorageAdapter();

    expect(await storageDeletePrefix(storage, 'missing:')).toBe(0);
  });

  it('deletes matching keys through the fallback batch path', async () => {
    const storage = createCoreStorageAdapter();

    await storage.put('jobs:1', new Uint8Array([1]));
    await storage.put('jobs:2', new Uint8Array([2]));
    await storage.put('other:1', new Uint8Array([3]));

    expect(await storageDeletePrefix(storage, 'jobs:')).toBe(2);
    expect(await storage.get('jobs:1')).toBeNull();
    expect(await storage.get('jobs:2')).toBeNull();
    expect(await storage.get('other:1')).not.toBeNull();
  });
});

describe('tryDecodeStorageKeyComponent', () => {
  it('returns null for malformed encoded input instead of throwing', () => {
    expect(tryDecodeStorageKeyComponent('%E0%A4%A')).toBeNull();
  });
});

describe('decodeStorageKeyComponent', () => {
  it('decodes components encoded for storage keys', () => {
    const original = 'workflow/with spaces?and=delimiters';
    const encoded = encodeStorageKeyComponent(original);

    expect(decodeStorageKeyComponent(encoded)).toBe(original);
  });
});

describe('encodeStorageKeyComponent prefix preservation', () => {
  // The visibility-index design relies on prefix-preserving encoding for the
  // `idPrefix` filter: a `wf:{enc(prefix)}` scan is sound only when
  // encode(a + b) === encode(a) + encode(b) for any inputs drawn from the
  // safe subset. ListFilter validation restricts idPrefix to /^[A-Za-z0-9_-]+$/,
  // so the encoder must be both identity-on and concatenation-preserving over
  // that subset. If this test ever fails the engine path that depends on it
  // has to switch to a broader `wf:` scan with a post-filter — see
  // documentation in src/core/list-filter-validation.ts.
  const SAFE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

  it('is the identity function on each character of the idPrefix safe subset', () => {
    for (const character of SAFE_CHARS) {
      expect(encodeStorageKeyComponent(character)).toBe(character);
    }
  });

  it('is concatenation-preserving on safe-subset strings', () => {
    const samples = ['abc', 'A_b-1', 'order-', '_-_', '0', SAFE_CHARS];
    for (const a of samples) {
      for (const b of samples) {
        expect(encodeStorageKeyComponent(a + b)).toBe(
          encodeStorageKeyComponent(a) + encodeStorageKeyComponent(b),
        );
      }
    }
  });

  it('encodes the full safe-subset string to itself (prefix-scan soundness)', () => {
    expect(encodeStorageKeyComponent(SAFE_CHARS)).toBe(SAFE_CHARS);
  });
});

describe('scan utilities', () => {
  it('computes lexicographic prefix bounds and applies scan filters', () => {
    expect(resolvePrefixRangeEnd('job:')).toBe('job;');
    expect(resolvePrefixRangeEnd('')).toBe('\xff');

    expect(matchesScanOptions('b', { gt: 'a', lt: 'c' })).toBe(true);
    expect(matchesScanOptions('a', { gt: 'a' })).toBe(false);
    expect(matchesScanOptions('`', { gte: 'a' })).toBe(false);
    expect(matchesScanOptions('a', { gte: 'a' })).toBe(true);
    expect(matchesScanOptions('c', { lt: 'c' })).toBe(false);
    expect(matchesScanOptions('c', { lte: 'c' })).toBe(true);
    expect(matchesScanOptions('d', { lte: 'c' })).toBe(false);
  });
});

describe('storage helper fallbacks', () => {
  it('uses core storage operations when optional helpers are absent', async () => {
    const storage = createCoreStorageAdapter();

    await storage.put('jobs:1', new Uint8Array([1]));
    await storage.put('jobs:2', new Uint8Array([2]));
    await storage.put('logs:1', new Uint8Array([3]));

    expect(await storageHas(storage, 'jobs:1')).toBe(true);
    expect(await storageHas(storage, 'jobs:missing')).toBe(false);
    expect(await Array.fromAsync(storageKeys(storage, 'jobs:'))).toEqual(['jobs:1', 'jobs:2']);
    expect(await storageCount(storage, 'jobs:')).toBe(2);
  });

  it('prefers adapter shortcuts when optional helper methods are present', async () => {
    let hasCalls = 0;
    let keysCalls = 0;
    let countCalls = 0;
    let deletePrefixCalls = 0;

    const storage: Storage = {
      capabilities: () => ({
        readAfterWrite: 'linearizable',
        scanConsistency: 'snapshot',
        atomicBatch: true,
        conditionalBatch: true,
        boundedRangeDelete: true,
      }),
      get: async () => {
        throw new Error('storage.get should not be used when has() is available');
      },
      put: async () => {},
      delete: async () => {},
      scan: async function* () {
        throw new Error('storage.scan should not be used when keys() is available');
      },
      batch: async () => {
        throw new Error('storage.batch should not be used when deletePrefix() is available');
      },
      has: async (key: string) => {
        hasCalls++;
        return key === 'jobs:1';
      },
      keys: async function* (prefix: string) {
        keysCalls++;
        yield `${prefix}1`;
        yield `${prefix}2`;
      },
      count: async (prefix: string) => {
        countCalls++;
        return prefix === 'jobs:' ? 2 : 0;
      },
      deletePrefix: async (prefix: string) => {
        deletePrefixCalls++;
        return prefix === 'jobs:' ? 2 : 0;
      },
      [Symbol.dispose]: () => {},
    };

    expect(await storageHas(storage, 'jobs:1')).toBe(true);
    expect(await Array.fromAsync(storageKeys(storage, 'jobs:'))).toEqual(['jobs:1', 'jobs:2']);
    expect(await storageCount(storage, 'jobs:')).toBe(2);
    expect(await storageDeletePrefix(storage, 'jobs:')).toBe(2);

    expect(hasCalls).toBe(1);
    expect(keysCalls).toBe(1);
    expect(countCalls).toBe(1);
    expect(deletePrefixCalls).toBe(1);
  });
});

describe('storageValuesEqual', () => {
  it('compares nulls, length mismatches, and byte mismatches correctly', () => {
    expect(storageValuesEqual(null, null)).toBe(true);
    expect(storageValuesEqual(new Uint8Array([1]), null)).toBe(false);
    expect(storageValuesEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
    expect(storageValuesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(storageValuesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
  });
});

describe('storageConditionalBatch', () => {
  it('throws when the backend declares no conditionalBatch capability', async () => {
    // createCoreStorageAdapter reports capabilities().conditionalBatch === false.
    const storage = createCoreStorageAdapter();

    await expect(storageConditionalBatch(storage, [], [])).rejects.toThrow(
      'Feature "storageConditionalBatch" requires storage capability "conditionalBatch", but this storage backend does not provide it.',
    );
  });

  it('throws when capability is declared but the method is missing', async () => {
    // A dishonest adapter: claims the capability without implementing it.
    const storage: Storage = {
      ...createCoreStorageAdapter(),
      capabilities: () => ({
        readAfterWrite: 'linearizable',
        scanConsistency: 'snapshot',
        atomicBatch: true,
        conditionalBatch: true,
        boundedRangeDelete: false,
      }),
    };

    await expect(storageConditionalBatch(storage, [], [])).rejects.toThrow(
      'This storage backend reports conditionalBatch capability but does not implement the conditionalBatch() method.',
    );
  });

  it('delegates to the adapter when conditionalBatch is available', async () => {
    const storage: Storage = {
      ...createCoreStorageAdapter(),
      capabilities: () => ({
        readAfterWrite: 'linearizable',
        scanConsistency: 'snapshot',
        atomicBatch: true,
        conditionalBatch: true,
        boundedRangeDelete: false,
      }),
      conditionalBatch: async (conditions, operations) =>
        conditions.length === 1 && operations.length === 1,
    };

    await expect(
      storageConditionalBatch(
        storage,
        [{ key: 'wf:1', expectedValue: null }],
        [{ type: 'delete', key: 'wf:1' }],
      ),
    ).resolves.toBe(true);
  });
});

describe('KEYS', () => {
  it('builds storage keys with encoded workflow ids and padded numeric segments', () => {
    const workflowId = 'workflow/id with spaces?';
    const encodedWorkflowId = encodeStorageKeyComponent(workflowId);

    expect(KEYS.workflow(workflowId)).toBe(`wf:${encodedWorkflowId}`);
    expect(KEYS.checkpoint(workflowId)).toBe(`wf:${encodedWorkflowId}:ckpt`);
    expect(KEYS.checkpointHistory(workflowId, 42)).toBe(`wf:${encodedWorkflowId}:ckpt:0000000042`);
    expect(KEYS.operation('queue-name', 1_234, 'operation-1')).toBe(
      'op:queue-name:0000000000001234:operation-1',
    );
    expect(KEYS.operationInflight('operation-1')).toBe('op:inflight:operation-1');
    expect(KEYS.operationQueued('operation-1')).toBe('op:queued:operation-1');
    expect(KEYS.operationResolved('operation-1')).toBe('op:resolved:operation-1');
    expect(KEYS.operationResolvedByTimePrefix()).toBe('op:resolved-by-time:');
    expect(KEYS.operationResolvedByTime(1_234, workflowId)).toBe(
      `op:resolved-by-time:0000000000001234:${encodedWorkflowId}`,
    );
    expect(KEYS.eventPrefix(workflowId)).toBe(`ev:${encodedWorkflowId}:`);
    expect(KEYS.event(workflowId, 9)).toBe(`ev:${encodedWorkflowId}:0000000009`);
    expect(KEYS.eventHead(workflowId)).toBe(`ev:${encodedWorkflowId}:head`);
    expect(KEYS.signal(workflowId, 'approve', 'signal-1')).toBe(
      `sig:${encodedWorkflowId}:approve:signal-1`,
    );
    expect(KEYS.deadline(5_000, workflowId)).toBe(
      `wf-deadline:0000000000005000:${encodedWorkflowId}`,
    );
    expect(KEYS.delayedStart(6_000, workflowId)).toBe(
      `wf-delayed:0000000000006000:${encodedWorkflowId}`,
    );
    expect(KEYS.attribute(workflowId)).toBe(`attr:${encodedWorkflowId}`);
    expect(KEYS.attributeIndex('status', 'running', workflowId)).toBe(
      `idx:status:running:${encodedWorkflowId}`,
    );
    expect(KEYS.updatePrefix(workflowId)).toBe(`upd:${encodedWorkflowId}:`);
    expect(KEYS.update(workflowId, 'update-1')).toBe(`upd:${encodedWorkflowId}:update-1`);
    expect(KEYS.updateResponse('update-1')).toBe('upr:update-1');
    expect(KEYS.updateIdempotency(workflowId, 'idem-1')).toBe(`upk:${encodedWorkflowId}:idem-1`);
    expect(KEYS.budget('account-a', 'daily', '2026-04-14')).toBe(
      'budget:account-a:daily:2026-04-14',
    );
    expect(KEYS.review(workflowId, 'review-1')).toBe(`review:${encodedWorkflowId}:review-1`);
    expect(KEYS.workflowHeaders(workflowId)).toBe(`wf-headers:${encodedWorkflowId}`);
    expect(KEYS.offload(workflowId, 'payload')).toBe(`offload:${encodedWorkflowId}:payload`);
    expect(KEYS.archive(workflowId, 'payload')).toBe(`archive:${encodedWorkflowId}:payload`);
    expect(KEYS.stateExecution(workflowId, 'cursor:1')).toBe(
      `state:execution:${encodedWorkflowId}:cursor%3A1`,
    );
    expect(KEYS.stateWorkflow('invoice:review', 'cursor:1')).toBe(
      'state:workflow-scope:default:invoice%3Areview:cursor%3A1',
    );
    expect(KEYS.streamChunk(workflowId, 'stream', 7)).toBe(
      `blob:${encodedWorkflowId}:stream:chunk:0000000007`,
    );
    expect(KEYS.streamMetadata(workflowId, 'stream')).toBe(`blob:${encodedWorkflowId}:stream:meta`);
    expect(KEYS.budgetCharged('operation-1')).toBe('budget-charged:operation-1');
    expect(KEYS.toolEffect(workflowId, 'agent-1', 'semantic-hash')).toBe(
      `tool-effect:${encodedWorkflowId}:agent-1:semantic-hash`,
    );
  });

  it('builds visibility-index keys with encoded dynamic segments and padded timestamps', () => {
    const workflowId = 'workflow/id with spaces?';
    const encodedWorkflowId = encodeStorageKeyComponent(workflowId);

    expect(KEYS.workflowVisibilityStatus('running', workflowId)).toBe(
      `wf-idx-status:running:${encodedWorkflowId}`,
    );
    expect(KEYS.workflowVisibilityType('order:fulfillment', workflowId)).toBe(
      `wf-idx-type:order%3Afulfillment:${encodedWorkflowId}`,
    );
    expect(KEYS.workflowVisibilityCreated(1_700_000_000_000, workflowId)).toBe(
      `wf-idx-created:0001700000000000:${encodedWorkflowId}`,
    );
    expect(KEYS.workflowVisibilityUpdated(1_700_000_000_001, workflowId)).toBe(
      `wf-idx-updated:0001700000000001:${encodedWorkflowId}`,
    );
    expect(KEYS.workflowVisibilityDeadline(5_000, workflowId)).toBe(
      `wf-idx-deadline:0000000000005000:${encodedWorkflowId}`,
    );
    expect(KEYS.workflowVisibilityManifest(workflowId)).toBe(
      `wf-idx-manifest:${encodedWorkflowId}`,
    );
    expect(KEYS.workflowVisibilityMetaVersion()).toBe('wf-idx-meta:version');
    expect(KEYS.workflowVisibilityMetaBuiltAt()).toBe('wf-idx-meta:built-at');
    expect(KEYS.workflowVisibilityMetaCursor()).toBe('wf-idx-meta:cursor');
  });
});

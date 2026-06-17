import { describe, expect, it } from 'bun:test';

import {
  createDiskBackedTestFixture,
  sqliteDatabaseSidecarSuffixes,
} from '../testing/storage-backends.test-support.ts';
import { BunSQLiteStorage } from './bun-sql.ts';
import { normalizeDeleteRangeOptions, storageDeleteRange } from './delete-range.ts';
import { HTTPStorage } from './http.ts';
import type { Storage } from './interface.ts';
import {
  assertDurableStorageForRecovery,
  decodeStorageKeyComponent,
  encodeStorageKeyComponent,
  KEYS,
  matchesScanOptions,
  MAX_BATCH_OPERATIONS,
  resolvePrefixRangeEnd,
  StorageBatchOperationLimitExceededError,
  storageConditionalBatch,
  storageCount,
  storageDeletePrefix,
  storageHas,
  storageKeys,
  storageValuesEqual,
  tryDecodeStorageKeyComponent,
  WEFT_RESERVED_KEY_PREFIXES,
} from './interface.ts';
import { MemoryStorage } from './memory.ts';
import { TursoStorage } from './turso.ts';

function createCoreStorageAdapter(): Storage {
  const storage = new MemoryStorage();

  return {
    // Core-five adapter: omits the optional methods AND honestly reports the
    // capabilities it lacks (no compare-and-swap, no bounded range delete).
    capabilities: () => ({
      readAfterWrite: 'linearizable',
      scanConsistency: 'snapshot',
      persistence: 'ephemeral',
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

function createDeleteOperations(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    type: 'delete' as const,
    key: `key:${index}`,
  }));
}

function createAbsentConditions(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    key: `key:${index}`,
    expectedValue: null,
  }));
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

describe('WEFT_RESERVED_KEY_PREFIXES', () => {
  it('covers the storage prefixes Weft currently writes through KEYS', () => {
    const representativeKeys = [
      KEYS.workflow('workflow-id'),
      KEYS.checkpoint('workflow-id'),
      KEYS.checkpointHistory('workflow-id', 1),
      KEYS.timeline('workflow-id', 1),
      KEYS.schedule('schedule-id'),
      KEYS.scheduleTick(1, 'schedule-id'),
      KEYS.scheduleRun('workflow-id'),
      KEYS.operation('default', 1, 'operation-id'),
      KEYS.operationInflight('operation-id'),
      KEYS.operationQueued('operation-id'),
      KEYS.operationResolved('operation-id'),
      KEYS.bulkOperationAudit(1, 'request-id', 'token'),
      KEYS.operationResolvedByTime(1, 'operation-id'),
      KEYS.asyncActivity('workflow-id', 'token'),
      KEYS.activityReconciliation('workflow-id', 'activity', 'digest'),
      KEYS.event('workflow-id', 1),
      KEYS.eventHead('workflow-id'),
      KEYS.eventWatermark('workflow-id'),
      KEYS.fleetEvent(1),
      KEYS.fleetEventTail(),
      KEYS.fleetEventByWorkflow('workflow-id', 1),
      KEYS.signal('workflow-id', 'signal-name', 'signal-id'),
      KEYS.signalSequence('workflow-id'),
      KEYS.signalAcceptedResponse('workflow-id', 'signal-name', 'signal-id'),
      KEYS.deadline(1, 'workflow-id'),
      KEYS.terminalCleanup(1, 'timer-id'),
      KEYS.delayedStart(1, 'workflow-id'),
      KEYS.terminalWorkflow(1, 'workflow-id'),
      KEYS.attribute('workflow-id'),
      KEYS.attributeIndex('attribute', 'value', 'workflow-id'),
      KEYS.tagIndex('tag', 'workflow-id'),
      KEYS.update('workflow-id', 'update-id'),
      KEYS.updateResponse('update-id'),
      KEYS.updateIdempotency('workflow-id', 'idempotency-key'),
      KEYS.startIdempotency('idempotency-key'),
      KEYS.liveness('instance-id'),
      KEYS.budget('namespace', 'period', 'date'),
      KEYS.review('workflow-id', 'review-id'),
      KEYS.workflowHeaders('workflow-id'),
      KEYS.terminalCleanupNeeded('workflow-id'),
      KEYS.workflowConcurrency('workflow-type', 'partition:key'),
      KEYS.workflowConcurrencyHolder('workflow-id'),
      KEYS.workflowHasServices('workflow-id'),
      KEYS.finalizerState('workflow-id'),
      KEYS.teardownOwed('workflow-id'),
      KEYS.teardownDeadLetter('workflow-id'),
      KEYS.teardownTimer(1000, 'timer-id'),
      KEYS.offload('workflow-id', 'key'),
      KEYS.archive('workflow-id', 'key'),
      KEYS.stateExecution('workflow-id', 'key'),
      KEYS.stateWorkflow('workflow-type', 'key'),
      KEYS.streamChunk('workflow-id', 'key', 1),
      KEYS.streamMetadata('workflow-id', 'key'),
      KEYS.budgetCharged('operation-id'),
      KEYS.toolEffect('workflow-id', 'agent-id', 'digest'),
      KEYS.workflowVisibilityStatus('running', 'workflow-id'),
      KEYS.workflowVisibilityType('workflow-type', 'workflow-id'),
      KEYS.workflowVisibilityCreated(1, 'workflow-id'),
      KEYS.workflowVisibilityUpdated(1, 'workflow-id'),
      KEYS.workflowVisibilityDeadline(1, 'workflow-id'),
      KEYS.workflowVisibilityManifest('workflow-id'),
      KEYS.workflowVisibilityMetaVersion(),
      KEYS.workflowVisibilityMetaBuiltAt(),
      KEYS.workflowVisibilityMetaCursor(),
      KEYS.leaseEpoch(),
      KEYS.leaseHolder(),
    ];

    for (const key of representativeKeys) {
      expect(
        WEFT_RESERVED_KEY_PREFIXES.some((reservedPrefix) => key.startsWith(reservedPrefix)),
        key,
      ).toBe(true);
    }
  });

  it('leaves the recommended application namespace outside the Weft reserved keyspace', () => {
    expect(
      WEFT_RESERVED_KEY_PREFIXES.some((reservedPrefix) =>
        'app:my-service:session:1'.startsWith(reservedPrefix),
      ),
    ).toBe(false);
  });
});

describe('assertDurableStorageForRecovery', () => {
  it('accepts the conservative durable recovery capability row', () => {
    const storage = createCoreStorageAdapter();
    storage.capabilities = () => ({
      readAfterWrite: 'linearizable',
      scanConsistency: 'snapshot',
      persistence: 'local',
      atomicBatch: true,
      conditionalBatch: true,
      boundedRangeDelete: false,
    });

    expect(() => assertDurableStorageForRecovery(storage)).not.toThrow();
  });

  it('rejects ephemeral, eventual, best-effort, non-atomic, and non-CAS backends', () => {
    const storage = createCoreStorageAdapter();
    storage.capabilities = () => ({
      readAfterWrite: 'eventual',
      scanConsistency: 'best-effort',
      persistence: 'ephemeral',
      atomicBatch: false,
      conditionalBatch: false,
      boundedRangeDelete: false,
    });

    expect(() => assertDurableStorageForRecovery(storage)).toThrow(
      /persistence must be "local" or "remote".*readAfterWrite must be "linearizable".*scanConsistency must be "snapshot".*atomicBatch must be true.*conditionalBatch must be true/s,
    );
  });

  it('accepts a remote backend that meets every other axis at its strongest', () => {
    // Neon Postgres reports persistence "remote" with linearizable/snapshot/
    // atomic/CAS. Remote durability is acceptable for recovery precisely because
    // the other four axes are still required at full strength.
    const storage = createCoreStorageAdapter();
    storage.capabilities = () => ({
      readAfterWrite: 'linearizable',
      scanConsistency: 'snapshot',
      persistence: 'remote',
      atomicBatch: true,
      conditionalBatch: true,
      boundedRangeDelete: true,
    });

    expect(() => assertDurableStorageForRecovery(storage)).not.toThrow();
  });

  it('rejects a remote backend whose read-after-write is only eventual', () => {
    // Remote persistence passes, but eventual read-after-write does not — the
    // rejection comes from the consistency axis, not the persistence scope.
    const storage = createCoreStorageAdapter();
    storage.capabilities = () => ({
      readAfterWrite: 'eventual',
      scanConsistency: 'snapshot',
      persistence: 'remote',
      atomicBatch: true,
      conditionalBatch: true,
      boundedRangeDelete: true,
    });

    expect(() => assertDurableStorageForRecovery(storage)).toThrow(
      /readAfterWrite must be "linearizable"/,
    );
    expect(() => assertDurableStorageForRecovery(storage)).not.toThrow(/persistence must be/);
  });

  it('rejects MemoryStorage because it is ephemeral', () => {
    expect(() => assertDurableStorageForRecovery(new MemoryStorage())).toThrow(
      /persistence must be "local" or "remote"/,
    );
  });

  it('accepts file-backed BunSQLiteStorage', () => {
    const fixture = createDiskBackedTestFixture({
      prefix: 'durable-assertion-bun-sqlite',
      suffix: '.db',
      sidecarSuffixes: sqliteDatabaseSidecarSuffixes,
    });
    const storage = new BunSQLiteStorage(fixture.path);

    try {
      expect(() => assertDurableStorageForRecovery(storage)).not.toThrow();
    } finally {
      storage[Symbol.dispose]();
      fixture.cleanup();
    }
  });

  it('rejects in-memory BunSQLiteStorage because it is ephemeral', () => {
    using storage = new BunSQLiteStorage(':memory:');

    expect(() => assertDurableStorageForRecovery(storage)).toThrow(
      /persistence must be "local" or "remote"/,
    );
  });

  it('rejects file-backed TursoStorage because read-after-write is session-scoped', () => {
    const fixture = createDiskBackedTestFixture({
      prefix: 'durable-assertion-turso',
      suffix: '.db',
      sidecarSuffixes: sqliteDatabaseSidecarSuffixes,
    });
    const storage = new TursoStorage({ url: `file:${fixture.path}` });

    try {
      expect(() => assertDurableStorageForRecovery(storage)).toThrow(
        /readAfterWrite must be "linearizable"/,
      );
    } finally {
      storage[Symbol.dispose]();
      fixture.cleanup();
    }
  });

  it('rejects HTTPStorage because its consistency is too weak for recovery', () => {
    // Remote persistence is now acceptable, so the rejection comes from the
    // consistency axes: HTTPStorage is eventual / best-effort / non-CAS by default.
    const storage = new HTTPStorage({ baseUrl: 'https://weft.example.invalid' });

    expect(() => assertDurableStorageForRecovery(storage)).toThrow(
      /readAfterWrite must be "linearizable".*scanConsistency must be "snapshot".*conditionalBatch must be true/s,
    );
    expect(() => assertDurableStorageForRecovery(storage)).not.toThrow(/persistence must be/);
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
        persistence: 'local',
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

describe('normalizeDeleteRangeOptions', () => {
  it('throws when no bound is present', () => {
    expect(() => normalizeDeleteRangeOptions({})).toThrow(/at least one of gt\/gte\/lt\/lte/);
    expect(() => normalizeDeleteRangeOptions({ limit: 5 })).toThrow(
      /at least one of gt\/gte\/lt\/lte/,
    );
  });

  it('throws when a bound is not a string', () => {
    for (const bound of ['gt', 'gte', 'lt', 'lte'] as const) {
      expect(() => normalizeDeleteRangeOptions({ [bound]: 3 } as never)).toThrow(
        'deleteRange bounds must be strings',
      );
    }
  });

  it('throws when limit is not a finite non-negative integer', () => {
    const message = 'deleteRange limit must be a finite non-negative integer';
    for (const limit of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '2' as never,
      null as never,
    ]) {
      expect(() => normalizeDeleteRangeOptions({ lt: 'z', limit })).toThrow(message);
    }
  });

  it('accepts limit 0 and normalizes -0 to 0', () => {
    expect(normalizeDeleteRangeOptions({ lt: 'z', limit: 0 }).limit).toBe(0);
    expect(Object.is(normalizeDeleteRangeOptions({ lt: 'z', limit: -0 }).limit, 0)).toBe(true);
  });

  it('copies only the five accepted fields, dropping reverse and unknown keys', () => {
    const normalized = normalizeDeleteRangeOptions({
      gt: 'a',
      lte: 'z',
      limit: 4,
      reverse: true,
      extra: 'nope',
    } as never);
    expect(normalized).toEqual({ gt: 'a', lte: 'z', limit: 4 } as never);
    expect('reverse' in normalized).toBe(false);
  });
});

describe('storageDeleteRange', () => {
  it('deletes only in-range keys through the fallback and returns the count', async () => {
    const storage = createCoreStorageAdapter();
    for (const sequence of [1, 2, 3, 4, 5]) {
      await storage.put(`ev:wf:${String(sequence).padStart(2, '0')}`, new Uint8Array([sequence]));
    }

    // Strictly below sequence 3 → deletes 01 and 02.
    expect(await storageDeleteRange(storage, 'ev:wf:', { lt: 'ev:wf:03' })).toBe(2);
    expect(await storage.get('ev:wf:01')).toBeNull();
    expect(await storage.get('ev:wf:02')).toBeNull();
    expect(await storage.get('ev:wf:03')).not.toBeNull();
    expect(await storage.get('ev:wf:05')).not.toBeNull();
  });

  it('returns 0 when nothing matches', async () => {
    const storage = createCoreStorageAdapter();
    await storage.put('ev:wf:05', new Uint8Array([5]));
    expect(await storageDeleteRange(storage, 'ev:wf:', { lt: 'ev:wf:03' })).toBe(0);
    expect(await storage.get('ev:wf:05')).not.toBeNull();
  });

  it('respects inclusive vs exclusive bounds', async () => {
    const seed = async (storage: Storage) => {
      for (const sequence of [1, 2, 3]) {
        await storage.put(`k:${sequence}`, new Uint8Array([sequence]));
      }
    };

    const exclusive = createCoreStorageAdapter();
    await seed(exclusive);
    expect(await storageDeleteRange(exclusive, 'k:', { gt: 'k:1', lt: 'k:3' })).toBe(1); // only k:2
    expect(await exclusive.get('k:1')).not.toBeNull();
    expect(await exclusive.get('k:3')).not.toBeNull();

    const inclusive = createCoreStorageAdapter();
    await seed(inclusive);
    expect(await storageDeleteRange(inclusive, 'k:', { gte: 'k:1', lte: 'k:3' })).toBe(3);
  });

  it('deletes the lowest keys first when limit caps the delete', async () => {
    const storage = createCoreStorageAdapter();
    for (const sequence of [1, 2, 3, 4]) {
      await storage.put(`k:${sequence}`, new Uint8Array([sequence]));
    }
    expect(await storageDeleteRange(storage, 'k:', { gte: 'k:1', limit: 2 })).toBe(2);
    expect(await storage.get('k:1')).toBeNull();
    expect(await storage.get('k:2')).toBeNull();
    expect(await storage.get('k:3')).not.toBeNull();
    expect(await storage.get('k:4')).not.toBeNull();
  });

  it('returns 0 for limit 0 and deletes nothing', async () => {
    const storage = createCoreStorageAdapter();
    await storage.put('k:1', new Uint8Array([1]));
    expect(await storageDeleteRange(storage, 'k:', { gte: 'k:', limit: 0 })).toBe(0);
    expect(await storage.get('k:1')).not.toBeNull();
  });

  it('returns 0 for an impossible range', async () => {
    const storage = createCoreStorageAdapter();
    await storage.put('k:1', new Uint8Array([1]));
    expect(await storageDeleteRange(storage, 'k:', { gt: 'k:c', lt: 'k:a' })).toBe(0);
    expect(await storage.get('k:1')).not.toBeNull();
  });

  it('ignores a reverse flag smuggled through a wider options object', async () => {
    const storage = createCoreStorageAdapter();
    for (const sequence of [1, 2, 3, 4]) {
      await storage.put(`k:${sequence}`, new Uint8Array([sequence]));
    }
    // reverse must not flip which keys the limit selects: still the lowest two.
    await storageDeleteRange(storage, 'k:', { gte: 'k:1', limit: 2, reverse: true } as never);
    expect(await storage.get('k:1')).toBeNull();
    expect(await storage.get('k:2')).toBeNull();
    expect(await storage.get('k:3')).not.toBeNull();
    expect(await storage.get('k:4')).not.toBeNull();
  });

  it('throws on invalid options (empty bounds, non-string bound, bad limit)', async () => {
    const storage = createCoreStorageAdapter();
    await expect(storageDeleteRange(storage, 'k:', {})).rejects.toThrow(
      /at least one of gt\/gte\/lt\/lte/,
    );
    await expect(storageDeleteRange(storage, 'k:', { lt: 3 } as never)).rejects.toThrow(
      'deleteRange bounds must be strings',
    );
    await expect(storageDeleteRange(storage, 'k:', { lt: 'z', limit: -1 })).rejects.toThrow(
      'deleteRange limit must be a finite non-negative integer',
    );
  });

  it('uses the adapter native deleteRange when present', async () => {
    let deleteRangeCalls = 0;
    const storage: Storage = {
      capabilities: () => ({
        readAfterWrite: 'linearizable',
        scanConsistency: 'snapshot',
        persistence: 'local',
        atomicBatch: true,
        conditionalBatch: true,
        boundedRangeDelete: true,
      }),
      get: async () => null,
      put: async () => {},
      delete: async () => {},
      scan: async function* () {
        throw new Error('scan should not run when native deleteRange is available');
      },
      batch: async () => {
        throw new Error('batch should not run when native deleteRange is available');
      },
      deleteRange: async (prefix: string) => {
        deleteRangeCalls++;
        return prefix === 'ev:wf:' ? 2 : 0;
      },
      [Symbol.dispose]: () => {},
    };

    expect(await storageDeleteRange(storage, 'ev:wf:', { lt: 'ev:wf:03' })).toBe(2);
    expect(deleteRangeCalls).toBe(1);
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
        persistence: 'local',
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
        persistence: 'local',
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

  it('rejects too many conditionalBatch operations before calling the adapter', async () => {
    let adapterCalled = false;
    const storage: Storage = {
      ...createCoreStorageAdapter(),
      capabilities: () => ({
        readAfterWrite: 'linearizable',
        scanConsistency: 'snapshot',
        persistence: 'local',
        atomicBatch: true,
        conditionalBatch: true,
        boundedRangeDelete: false,
      }),
      conditionalBatch: async () => {
        adapterCalled = true;
        return true;
      },
    };

    await expect(
      storageConditionalBatch(storage, [], createDeleteOperations(MAX_BATCH_OPERATIONS + 1)),
    ).rejects.toBeInstanceOf(StorageBatchOperationLimitExceededError);
    expect(adapterCalled).toBe(false);
  });

  it('rejects too many conditionalBatch conditions before calling the adapter', async () => {
    let adapterCalled = false;
    const storage: Storage = {
      ...createCoreStorageAdapter(),
      capabilities: () => ({
        readAfterWrite: 'linearizable',
        scanConsistency: 'snapshot',
        persistence: 'local',
        atomicBatch: true,
        conditionalBatch: true,
        boundedRangeDelete: false,
      }),
      conditionalBatch: async () => {
        adapterCalled = true;
        return true;
      },
    };

    await expect(
      storageConditionalBatch(storage, createAbsentConditions(MAX_BATCH_OPERATIONS + 1), []),
    ).rejects.toMatchObject({
      cap: MAX_BATCH_OPERATIONS,
      count: MAX_BATCH_OPERATIONS + 1,
      target: 'conditionalBatch conditions',
    });
    expect(adapterCalled).toBe(false);
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
    expect(KEYS.fleetEventPrefix()).toBe('fleet-event:');
    expect(KEYS.fleetEvent(9)).toBe('fleet-event:0000000009');
    expect(KEYS.fleetEventTail()).toBe('fleet-event-tail');
    expect(KEYS.fleetEventByWorkflowPrefix(workflowId)).toBe(
      `fleet-event-by-workflow:${encodedWorkflowId}:`,
    );
    expect(KEYS.fleetEventByWorkflow(workflowId, 9)).toBe(
      `fleet-event-by-workflow:${encodedWorkflowId}:0000000009`,
    );
    expect(KEYS.signal(workflowId, 'approve', 'signal:1')).toBe(
      `sig:${encodedWorkflowId}:approve:1:signal%3A1`,
    );
    expect(KEYS.startSignal(workflowId, 'approve', 'signal:1')).toBe(
      `sig:${encodedWorkflowId}:approve:0:signal%3A1`,
    );
    // The signal name is encoded too (consistent with signalAcceptedResponse), so a
    // name containing `:` cannot prefix-collide with another name on the scan path.
    expect(KEYS.signal(workflowId, 'order:placed', 'x')).toBe(
      `sig:${encodedWorkflowId}:order%3Aplaced:1:x`,
    );
    expect(KEYS.signal(workflowId, 'approve:now', 'signal:1')).toBe(
      `sig:${encodedWorkflowId}:approve%3Anow:1:signal%3A1`,
    );
    expect(KEYS.signalSequence(workflowId)).toBe(`sigseq:v1:${encodedWorkflowId}`);
    expect(KEYS.signalAcceptedResponsePrefix(workflowId)).toBe(`sigres:v1:${encodedWorkflowId}:`);
    expect(KEYS.signalAcceptedResponse(workflowId, 'approve', 'signal:1')).toBe(
      `sigres:v1:${encodedWorkflowId}:approve:signal%3A1`,
    );
    expect(KEYS.signalAcceptedResponse(workflowId, 'approve:now', 'signal:1')).toBe(
      `sigres:v1:${encodedWorkflowId}:approve%3Anow:signal%3A1`,
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
    expect(KEYS.startIdempotency('idem-1')).toBe('start-idem:idem-1');
    expect(KEYS.startIdempotency('a:b')).toBe('start-idem:a%3Ab');
    expect(KEYS.leasePrefix()).toBe('lease:');
    expect(KEYS.budget('account-a', 'daily', '2026-04-14')).toBe(
      'budget:account-a:daily:2026-04-14',
    );
    expect(KEYS.review(workflowId, 'review-1')).toBe(`review:${encodedWorkflowId}:review-1`);
    expect(KEYS.workflowHeaders(workflowId)).toBe(`wf-headers:${encodedWorkflowId}`);
    expect(KEYS.childCancellationPrefix(workflowId)).toBe(`child-cancel:${encodedWorkflowId}:`);
    expect(KEYS.childCancellation(workflowId, 'child:1')).toBe(
      `child-cancel:${encodedWorkflowId}:child%3A1`,
    );
    expect(KEYS.workflowConcurrency('invoice:review', 'customer:1')).toBe(
      'wf-concurrency:invoice%3Areview:customer%3A1',
    );
    expect(KEYS.workflowConcurrencyHolder(workflowId)).toBe(
      `wf-concurrency-holder:${encodedWorkflowId}`,
    );
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
    expect(KEYS.streamTail(workflowId, 'stream')).toBe(`blob:${encodedWorkflowId}:stream:tail`);
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

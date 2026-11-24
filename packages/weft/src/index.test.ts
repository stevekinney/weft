import { describe, expect, it } from 'bun:test';

import * as storageProtocol from "./embedded/storage/src/index.ts";
import { MemoryStorage } from "./embedded/storage/src/index.ts";
import { rejectionOf } from "../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { workflow } from './core/types/workflow-function.ts';
import {
  type WorkflowOperation,
  type WorkflowReplay,
  type WorkflowTimelineEntry,
  Engine,
  IdempotencyKeyPurgedError,
  isWeftErrorLike,
  normalizeScheduleSpec,
  StartOrSignalConflictError,
  WorkflowAlreadyExistsError,
  WorkflowTeardownPendingError,
} from './index.ts';

/** The runtime exports that moved from Weft to `@lostgradient/storage` (COR-1766). */
const MOVED_STORAGE_VALUES = [
  'MAX_BATCH_OPERATIONS',
  'MAX_SCAN_LIMIT',
  'MemoryStorage',
  'ScopedStorage',
  'StorageBatchOperationLimitExceededError',
  'assertDurableStorageForRecovery',
  'assertStorageBatchOperationCount',
  'copyTextKeyValueRowsToStorage',
  'decodeStorageKeyComponent',
  'encodeStorageKeyComponent',
  'formatSortableStorageTimestamp',
  'matchesScanOptions',
  'requireStorageCapability',
  'resolvePrefixRangeEnd',
  'scopedStorage',
  'storageBatch',
  'storageConditionalBatch',
  'storageCount',
  'storageDeletePrefix',
  'storageDeleteRange',
  'storageHas',
  'storageKeys',
  'storageValuesEqual',
  'textValueStore',
  'tryDecodeStorageKeyComponent',
] as const;

describe('weft', () => {
  it('leaves the storage protocol to @lostgradient/storage, at the root and in its storage barrel', async () => {
    const root = await import('./index.ts');
    const storageBarrel = await import('./storage/index.ts');
    for (const name of MOVED_STORAGE_VALUES) {
      expect(Reflect.has(storageProtocol, name), name).toBe(true);
      expect(Reflect.has(root, name), name).toBe(false);
      expect(Reflect.has(storageBarrel, name), name).toBe(false);
    }
    expect(Reflect.has(root, 'KEYS')).toBe(true);
    expect(Reflect.has(storageBarrel, 'KEYS')).toBe(true);
  });
  it('exports normalizeScheduleSpec, which accepts what schedule() accepts and rejects what it rejects', () => {
    expect(normalizeScheduleSpec('*/5 * * * *')).toEqual({
      kind: 'cron',
      cronExpression: '*/5 * * * *',
    });
    expect(normalizeScheduleSpec({ every: '1s' })).toEqual({ kind: 'interval', intervalMs: 1000 });
    expect(() => normalizeScheduleSpec('not a cron')).toThrow();
    expect(() => normalizeScheduleSpec({ every: 'soon' })).toThrow();
  });

  it('exports Engine class', () => {
    expect(Engine).toBeDefined();
  });

  it('exports timeline and replay types', () => {
    const timelineEntry: WorkflowTimelineEntry = {
      step: 1,
      operationType: 'run',
      operationLabel: 'run',
      inputSummary: '{"value":"ok"}',
      timestamp: 1_000,
      status: 'completed',
    };
    const replay: WorkflowReplay = {
      checkpoint: {
        step: 1,
        locals: { value: 'ok' },
        searchAttributes: {},
        version: '1.0.0',
        createdAt: 1_000,
      },
      accumulatedResults: [[0, { value: 'ok' }]],
      events: [],
    };

    expect(timelineEntry.operationType).toBe('run');
    expect(replay.checkpoint.step).toBe(1);
  });

  it('exports WorkflowOperation type', () => {
    const operation: WorkflowOperation<string> | undefined = undefined;
    expect(operation).toBeUndefined();
  });

  it('exports WorkflowAlreadyExistsError for duplicate workflow ids', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const duplicate = workflow({ name: 'duplicate-id' }).execute(async function* () {
      return 'ok';
    });
    engine.register(duplicate);

    try {
      await engine.start('duplicate-id', null, { id: 'duplicate-id' });
      expect(
        await rejectionOf(engine.start('duplicate-id', null, { id: 'duplicate-id' })),
      ).toBeInstanceOf(WorkflowAlreadyExistsError);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('exports StartOrSignalConflictError for startOrSignal against a terminal run', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const done = workflow({ name: 'startorsignal-terminal' }).execute(async function* () {
      return 'ok';
    });
    engine.register(done);

    try {
      const handle = await engine.start('startorsignal-terminal', null, { id: 'sos-export' });
      await handle.result();
      expect(
        await rejectionOf(
          engine.startOrSignal(
            'startorsignal-terminal',
            null,
            { name: 'noop', signalId: 'x' },
            { id: 'sos-export' },
          ),
        ),
      ).toBeInstanceOf(StartOrSignalConflictError);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('exports IdempotencyKeyPurgedError for a spent key whose run was purged', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const done = workflow({ name: 'idempotency-purged' }).execute(async function* () {
      return 'ok';
    });
    engine.register(done);

    try {
      // First start with the key creates the run and the durable mapping.
      const handle = await engine.start('idempotency-purged', null, {
        idempotencyKey: 'spent-key',
      });
      await handle.result();
      // Purge the run while the `start-idem:` mapping intentionally lives on.
      await engine.purge({ idPrefix: handle.id });
      // The key now maps to a workflow that no longer exists.
      expect(
        await rejectionOf(
          engine.start('idempotency-purged', null, { idempotencyKey: 'spent-key' }),
        ),
      ).toBeInstanceOf(IdempotencyKeyPurgedError);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('registers startOrSignal conflict errors as public codes', () => {
    // These errors are public exports, so isWeftErrorLike (the cross-realm/duplicate-
    // module discriminant) must recognize them — which only holds if their codes are
    // in PUBLIC_WEFT_ERROR_CODES. A consumer routing faults to HTTP status by code
    // would otherwise fall through to a 500 handler instead of the intended 409.
    expect(isWeftErrorLike(new StartOrSignalConflictError('wf-1', 'completed'))).toBe(true);
    expect(isWeftErrorLike(new WorkflowTeardownPendingError('wf-1'))).toBe(true);
    expect(isWeftErrorLike(new IdempotencyKeyPurgedError('wf-1'))).toBe(true);
  });
});

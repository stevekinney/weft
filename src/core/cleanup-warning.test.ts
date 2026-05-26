import { afterEach, describe, expect, it } from 'bun:test';
import { waitForever } from '../testing/fake-timers.ts';

import type { Storage as WeftStorage } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { flush } from '../testing/storage-backends.ts';
import { Engine } from './engine.ts';
import { CleanupWarningEvent } from './events.ts';
import type { WorkflowContext } from './types.ts';
import { workflow } from './types/workflow-function.ts';

const resumableWorkflow = workflow({ name: 'resumable' }).execute(async function* (
  ctx: WorkflowContext,
) {
  ctx.onUpdate('validate', (payload) => `validated: ${String(payload)}`);
  await waitForever();
  return 'done';
});

const updaterWorkflow = workflow({ name: 'updater' }).execute(async function* (
  ctx: WorkflowContext,
) {
  const { payload, respond } = yield* ctx.waitForUpdate<string>('process');
  respond(`processed: ${payload}`);
  return payload;
});

// ---------------------------------------------------------------------------
// A5: Fire-and-forget cleanup errors dispatch CleanupWarningEvent
//
// Instead of silently discarding cleanup errors, the engine should dispatch
// a CleanupWarningEvent so callers can observe them (for logging, metrics,
// alerting) without affecting the workflow result.
// ---------------------------------------------------------------------------

describe('CleanupWarningEvent', () => {
  it('has correct type and properties', () => {
    const error = new Error('batch failed');
    const event = new CleanupWarningEvent('cleanupExpiredResponses', error, 'wf-123');

    expect(event).toBeInstanceOf(Event);
    expect(event.type).toBe('cleanup:warning');
    expect(event.source).toBe('cleanupExpiredResponses');
    expect(event.error).toBe(error);
    expect(event.workflowId).toBe('wf-123');
  });

  it('workflowId is optional', () => {
    const error = new Error('global cleanup failed');
    const event = new CleanupWarningEvent('cleanupExpiredResponses', error);

    expect(event.workflowId).toBeUndefined();
  });
});

describe('Engine dispatches CleanupWarningEvent on cleanup errors', () => {
  let engine: Engine;

  afterEach(() => {
    engine?.[Symbol.dispose]();
  });

  it('dispatches CleanupWarningEvent when processPendingUpdates fails', async () => {
    // Create a storage that throws on scan (used by processPendingUpdates)
    const realStorage = new MemoryStorage();
    const scanError = new Error('scan exploded');

    // We need a storage proxy that fails when scanning for updates
    const storage: WeftStorage = {
      capabilities: realStorage.capabilities.bind(realStorage),
      get: realStorage.get.bind(realStorage),
      put: realStorage.put.bind(realStorage),
      delete: realStorage.delete.bind(realStorage),
      batch: realStorage.batch.bind(realStorage),
      async *scan(prefix: string) {
        // Let workflow state and checkpoint writes succeed, but fail on update scan
        if (prefix.startsWith('upd:')) {
          throw scanError;
        }
        yield* realStorage.scan(prefix);
      },
      [Symbol.dispose]() {
        realStorage[Symbol.dispose]();
      },
    };

    engine = new Engine({ storage });

    const warnings: CleanupWarningEvent[] = [];
    engine.addEventListener(CleanupWarningEvent.type, (event) => {
      warnings.push(event as CleanupWarningEvent);
    });

    engine.register(resumableWorkflow);

    // Start the workflow -- the resume path triggers processPendingUpdates
    const handle = await engine.start('resumable', undefined);
    handle.result().catch(() => {});
    await flush();

    // Resume triggers the pending update path which will scan for 'upd:' prefix
    try {
      await engine.resume(handle.id);
    } catch {
      // resume may throw; we only care about cleanup events
    }
    await flush();
    await flush();

    // The scan should have thrown, dispatching a CleanupWarningEvent
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0]!.source).toBe('processPendingUpdates');
    expect(warnings[0]!.error.message).toBe('scan exploded');
  });

  it('dispatches CleanupWarningEvent when coordinated update response write fails', async () => {
    const realStorage = new MemoryStorage();

    // Count batch calls to fail only after the initial workflow setup
    let batchCallCount = 0;
    const originalBatch = realStorage.batch.bind(realStorage);

    const storage: WeftStorage = {
      capabilities: realStorage.capabilities.bind(realStorage),
      get: realStorage.get.bind(realStorage),
      put: realStorage.put.bind(realStorage),
      delete: realStorage.delete.bind(realStorage),
      batch: async (operations) => {
        batchCallCount++;
        // Fail batch calls that contain update response writes (upr: prefix)
        const hasUpdateResponse = operations.some(
          (op) => 'key' in op && typeof op.key === 'string' && op.key.startsWith('upr:'),
        );
        if (hasUpdateResponse) {
          throw new Error('batch write failed');
        }
        return originalBatch(operations);
      },
      scan: realStorage.scan.bind(realStorage),
      [Symbol.dispose]() {
        realStorage[Symbol.dispose]();
      },
    };

    engine = new Engine({ storage });

    const warnings: CleanupWarningEvent[] = [];
    engine.addEventListener(CleanupWarningEvent.type, (event) => {
      warnings.push(event as CleanupWarningEvent);
    });

    engine.register(updaterWorkflow);

    // Pre-seed a coordinated update in storage so the workflow picks it up
    const { encode } = await import('./codec.ts');
    const { KEYS } = await import('../storage/interface.ts');
    const workflowId = 'wf-cleanup-test';
    const pendingUpdate = {
      updateId: 'cleanup-upd-1',
      workflowId,
      name: 'process',
      payload: 'test-data',
      createdAt: Date.now(),
    };
    await realStorage.put(KEYS.update(workflowId, 'cleanup-upd-1'), encode(pendingUpdate));

    const handle = await engine.start('updater', undefined, { id: workflowId });
    // The workflow should complete (respond was called successfully)
    const result = await handle.result();
    expect(result).toBe('test-data');

    await flush();
    await flush();

    // The update response write (upr:) should have triggered a CleanupWarningEvent
    const responseWarnings = warnings.filter((w) => w.source === 'writeCoordinatedUpdateResponse');
    expect(responseWarnings.length).toBeGreaterThanOrEqual(1);
    expect(responseWarnings[0]!.error.message).toBe('batch write failed');
  });
});

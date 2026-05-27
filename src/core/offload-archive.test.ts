import { describe, expect, it } from 'bun:test';
import { sleepForTesting } from '../testing/fake-timers.test-support.ts';

import { KEYS } from '../storage/interface';
import { MemoryStorage } from '../storage/memory';
import { TestEngine } from '../testing/test-engine';
import { decode, encode } from './codec';
import type { OffloadReference } from './context';
import { Engine } from './engine';
import type { WorkflowContext } from './types';
import { workflow } from './types';

describe('offload, load, and archive', () => {
  it('round-trips data through offload and load', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    const payload = { items: [1, 2, 3], nested: { flag: true } };

    const testWorkflow = workflow({ name: 'test' }).execute(async function* (ctx: WorkflowContext) {
      const c = ctx;
      const reference = yield* c.offload('big-data', async () => payload);
      const loaded = yield* c.load<typeof payload>(reference);
      return loaded;
    });
    engine.register(testWorkflow);

    const handle = await engine.start('test', {});
    const result = await handle.result();
    expect(result).toEqual(payload);
  });

  it('returns correct sizeBytes on OffloadReference', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    const payload = { message: 'hello world', numbers: [1, 2, 3, 4, 5] };
    const expectedSize = encode(payload).byteLength;

    let capturedReference: OffloadReference | undefined;

    const testWorkflow2 = workflow({ name: 'test' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const c = ctx;
      const reference = yield* c.offload('sized-data', async () => payload);
      capturedReference = reference;
      return reference;
    });
    engine.register(testWorkflow2);

    const handle = await engine.start('test', {});
    await handle.result();

    expect(capturedReference).toBeDefined();
    expect(capturedReference!.sizeBytes).toBe(expectedSize);
  });

  it('throws when loading a reference with a missing key', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    const testWorkflow3 = workflow({ name: 'test' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const c = ctx;
      const fakeReference: OffloadReference = {
        key: 'nonexistent-key',
        workflowId: ctx.workflowId,
        sizeBytes: 0,
      };
      const loaded = yield* c.load(fakeReference);
      return loaded;
    });
    engine.register(testWorkflow3);

    const handle = await engine.start('test', {});
    await expect(handle.result()).rejects.toThrow('Offloaded data not found');
  });

  it('rejects forged cross-workflow offload references', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    let trustedReference: OffloadReference | undefined;

    const producerWorkflow = workflow({ name: 'producer' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const c = ctx;
      trustedReference = yield* c.offload('cross-workflow', async () => ({ ok: true }));
      return trustedReference;
    });
    engine.register(producerWorkflow);

    const consumerWorkflow = workflow({ name: 'consumer' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const c = ctx;
      return yield* c.load(trustedReference!);
    });
    engine.register(consumerWorkflow);

    await engine.start('producer', {}).then((handle) => handle.result());
    const consumerHandle = await engine.start('consumer', {});

    await expect(consumerHandle.result()).rejects.toThrow(
      'ctx.load() can only read offloaded data from the current workflow',
    );
  });

  it('rejects malformed offload references with deterministic validation errors', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    const testWorkflow4 = workflow({ name: 'test' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const c = ctx;
      const malformedReference = {
        workflowId: ctx.workflowId,
        key: 123,
        sizeBytes: 1,
      } as unknown as OffloadReference;
      return yield* c.load(malformedReference);
    });
    engine.register(testWorkflow4);

    const handle = await engine.start('test', {});

    await expect(handle.result()).rejects.toThrow(
      'ctx.load() requires a non-empty offload reference key',
    );
  });

  it('persists archived data to storage', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    const archivePayload = { report: 'quarterly', values: [100, 200, 300] };

    const testWorkflow5 = workflow({ name: 'test' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const c = ctx;
      yield* c.archive('report-q1', archivePayload);
      return 'done';
    });
    engine.register(testWorkflow5);

    const handle = await engine.start('test', {});
    const result = await handle.result();
    expect(result).toBe('done');

    // Read directly from storage to verify the data was persisted
    const stored = await storage.get(KEYS.archive(handle.id, 'report-q1'));
    expect(stored).not.toBeNull();
    const decoded = decode(stored!);
    expect(decoded).toEqual(archivePayload);
  });

  it('offloaded data survives engine recovery', async () => {
    const engine = new TestEngine();

    const payload = { large: 'data', count: 42 };
    let offloadRuns = 0;

    const offloadStepWorkflow = workflow({ name: 'offload-step' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const c = ctx;
      const reference = yield* c.offload('recovery-data', async () => {
        offloadRuns++;
        return payload;
      });
      // Signal to pause so we can recover
      yield* c.waitForSignal('continue');
      return yield* c.load<typeof payload>(reference);
    });
    engine.register(offloadStepWorkflow);

    const handle = await engine.start('offload-step', {});
    // Let the offload complete and the workflow pause at waitForSignal
    await sleepForTesting(10);

    // Recover engine (simulates process restart)
    const recovered = engine.recover();

    // Register same workflow on recovered engine
    const offloadStepWorkflow2 = workflow({ name: 'offload-step' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const c = ctx;
      const reference = yield* c.offload('recovery-data', async () => {
        offloadRuns++;
        return payload;
      });
      yield* c.waitForSignal('continue');
      return yield* c.load<typeof payload>(reference);
    });
    recovered.register(offloadStepWorkflow2);

    const resumedHandle = await recovered.resume(handle.id);
    await resumedHandle.signal('continue');
    const result = await resumedHandle.result();
    expect(result).toEqual(payload);
    expect(offloadRuns).toBe(1);
  });

  it('propagates errors from offload fn to the workflow', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    const testWorkflow6 = workflow({ name: 'test' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const c = ctx;
      try {
        yield* c.offload('failing', async () => {
          throw new Error('computation failed');
        });
        return 'should not reach here';
      } catch (error) {
        return `caught: ${(error as Error).message}`;
      }
    });
    engine.register(testWorkflow6);

    const handle = await engine.start('test', {});
    const result = await handle.result();
    expect(result).toBe('caught: computation failed');
  });
});

/**
 * Out-of-band ("async") activity completion.
 *
 * An activity calls `ctx.completeAsync()` from its {@link ActivityContext} to
 * hand control to an external system (webhook, human callback, third-party job)
 * and obtain a durable, deterministic task token. The workflow stays suspended
 * at that step until something outside the engine completes it via
 * `engine.completeAsyncActivity(token, result)` or fails it via
 * `engine.failAsyncActivity(token, error)`.
 */

import { describe, expect, it } from 'bun:test';

import { LocalClient } from '../client/local.ts';
import { KEYS, type BatchOperation, type ConditionalBatchCondition } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { nextAsyncPendingToken } from '../testing/async-activity.test-support.ts';
import { encode } from './codec.ts';
import { AsyncActivityTokenNotFoundError, Engine } from './engine.ts';
import type { ActivityContext, WorkflowContext } from './types.ts';
import { activity, workflow } from './types.ts';

const awaitCallback = activity({
  name: 'awaitCallback',
  // Takes no input and returns whatever the out-of-band completion supplies;
  // `completeAsync()` throws to suspend, so the body never returns normally.
  execute: (_input: void, context?: ActivityContext): unknown => context!.completeAsync(),
});

class DeleteRejectingMemoryStorage extends MemoryStorage {
  override async delete(key: string): Promise<void> {
    throw new Error(`unexpected direct delete for ${key}`);
  }
}

/** A parked durable write captured by {@link WriteBarrierMemoryStorage}. */
type ParkedWrite = { release: () => void; reject: (error: Error) => void };

/**
 * MemoryStorage with two crash-simulation controls:
 *
 * - `armBarrier(key)` parks the next `batch`/`conditionalBatch` whose operations
 *   touch `key`, handing the test a deterministic {@link ParkedWrite} to release
 *   or reject. This is condition-based (no sleeps): the returned promise resolves
 *   exactly when the engine attempts the write under test.
 * - `rejectAllWrites` simulates a hard crash boundary: every subsequent write
 *   fails, so nothing after the flag flips can become durable.
 */
class WriteBarrierMemoryStorage extends MemoryStorage {
  #barrierKey: string | null = null;
  #onParked: ((parked: ParkedWrite) => void) | null = null;
  rejectAllWrites = false;

  armBarrier(key: string): Promise<ParkedWrite> {
    this.#barrierKey = key;
    return new Promise((resolve) => {
      this.#onParked = resolve;
    });
  }

  #gate(operations: BatchOperation[]): Promise<void> | null {
    if (this.rejectAllWrites) {
      return Promise.reject(new Error('simulated crash: storage unavailable'));
    }
    if (this.#barrierKey === null) return null;
    const key = this.#barrierKey;
    if (!operations.some((operation) => operation.key === key)) return null;
    // One-shot: disarm so a retry after rejection proceeds unimpeded.
    this.#barrierKey = null;
    return new Promise<void>((resolve, reject) => {
      this.#onParked?.({ release: resolve, reject });
      this.#onParked = null;
    });
  }

  override async batch(operations: BatchOperation[]): Promise<void> {
    const gate = this.#gate(operations);
    if (gate) await gate;
    return super.batch(operations);
  }

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    const gate = this.#gate(operations);
    if (gate) await gate;
    return super.conditionalBatch(conditions, operations);
  }
}

describe('async activity completion', () => {
  it('defers an activity and resumes the workflow when completed by token', async () => {
    await using storage = new MemoryStorage();
    const engine = new Engine({ storage });

    const orderWorkflow = workflow({ name: 'order' })
      .activities({ awaitCallback })
      .execute(async function* (ctx: WorkflowContext) {
        const approval = yield* ctx.run(awaitCallback);
        return { approval };
      });

    engine.register(orderWorkflow);

    const tokenPromise = nextAsyncPendingToken(engine);
    const handle = await engine.start('order', null);
    const token = await tokenPromise;

    // The workflow has not finished — it is parked on the async activity.
    const beforeState = await engine.get(handle.id);
    expect(beforeState?.status).toBe('running');
    expect(await engine.listPendingAsyncActivities(handle.id)).toEqual({
      items: [
        expect.objectContaining({
          token,
          activityName: 'awaitCallback',
          attempt: 1,
          step: 0,
        }),
      ],
    });

    // Complete the activity out-of-band.
    await engine.completeAsyncActivity(token, { decision: 'approved' });

    expect(await engine.listPendingAsyncActivities(handle.id)).toEqual({ items: [] });

    await expect(handle.result()).resolves.toEqual({
      approval: { decision: 'approved' },
    });

    engine[Symbol.dispose]();
  });

  it('completes a deferred activity through the LocalClient activity surface', async () => {
    await using storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const client = new LocalClient(engine);

    const greet = workflow({ name: 'greet' })
      .activities({ awaitCallback })
      .execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.run(awaitCallback);
      });

    engine.register(greet);

    const tokenPromise = nextAsyncPendingToken(engine);
    const handle = await client.start('greet', null);
    const token = await tokenPromise;

    await client.activity.complete(token, 'callback-result');

    await expect(handle.result()).resolves.toBe('callback-result');

    engine[Symbol.dispose]();
  });

  it('fails the activity when completed exceptionally so the workflow catch sees the error', async () => {
    await using storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const client = new LocalClient(engine);

    const orderWorkflow = workflow({ name: 'order-fail' })
      .activities({ awaitCallback })
      .execute(async function* (ctx: WorkflowContext) {
        try {
          yield* ctx.run(awaitCallback);
          return 'should-not-reach';
        } catch (error) {
          return `caught:${(error as Error).message}`;
        }
      });

    engine.register(orderWorkflow);

    const tokenPromise = nextAsyncPendingToken(engine);
    const handle = await engine.start('order-fail', null);
    const token = await tokenPromise;

    await client.activity.completeExceptionally(token, new Error('callback rejected'));

    await expect(handle.result()).resolves.toBe('caught:callback rejected');

    engine[Symbol.dispose]();
  });

  it('throws AsyncActivityTokenNotFoundError for an unknown or already-consumed token', async () => {
    await using storage = new MemoryStorage();
    const engine = new Engine({ storage });

    await expect(
      engine.completeAsyncActivity('async-act:v1:nope:0:1', 'value'),
    ).rejects.toBeInstanceOf(AsyncActivityTokenNotFoundError);

    const wf = workflow({ name: 'once' })
      .activities({ awaitCallback })
      .execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.run(awaitCallback);
      });
    engine.register(wf);

    const tokenPromise = nextAsyncPendingToken(engine);
    const handle = await engine.start('once', null);
    const token = await tokenPromise;

    await engine.completeAsyncActivity(token, 'first');
    await handle.result();

    // A consumed token is single-use and cannot be completed again.
    await expect(engine.completeAsyncActivity(token, 'second')).rejects.toBeInstanceOf(
      AsyncActivityTokenNotFoundError,
    );

    engine[Symbol.dispose]();
  });

  it('deletes async activity tokens through the checkpoint commit batch', async () => {
    await using storage = new DeleteRejectingMemoryStorage();
    const engine = new Engine({ storage });

    const orderWorkflow = workflow({ name: 'atomic-delete-order' })
      .activities({ awaitCallback })
      .execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.run(awaitCallback);
      });

    engine.register(orderWorkflow);

    const tokenPromise = nextAsyncPendingToken(engine);
    const handle = await engine.start('atomic-delete-order', null);
    const token = await tokenPromise;

    await engine.completeAsyncActivity(token, 'batched');

    await expect(handle.result()).resolves.toBe('batched');
    expect(await storage.get(KEYS.asyncActivity(handle.id, token))).toBeNull();

    engine[Symbol.dispose]();
  });

  it('keeps the token valid across engine restart so a late callback still resumes the workflow', async () => {
    await using storage = new MemoryStorage();

    const orderWorkflow = workflow({ name: 'durable-order' })
      .activities({ awaitCallback })
      .execute(async function* (ctx: WorkflowContext) {
        const approval = yield* ctx.run(awaitCallback);
        return { approval };
      });

    let workflowId: string;
    let firstToken: string;

    // First engine: start the workflow, let the activity defer, then crash
    // (dispose) before any out-of-band completion arrives.
    {
      const firstEngine = new Engine({ storage });
      firstEngine.register(orderWorkflow);
      const tokenPromise = nextAsyncPendingToken(firstEngine);
      const handle = await firstEngine.start('durable-order', null);
      workflowId = handle.id;
      firstToken = await tokenPromise;
      // The durable record must exist independently of the in-memory map.
      expect(await storage.get(KEYS.asyncActivity(workflowId, firstToken))).not.toBeNull();
      firstEngine[Symbol.dispose]();
    }

    // Second engine: query the same storage before recovery. Listing reads the
    // durable source of truth directly rather than depending on recovery having
    // repopulated the in-memory completion map.
    const recoveredEngine = new Engine({ storage });
    recoveredEngine.register(orderWorkflow);
    expect(await recoveredEngine.listPendingAsyncActivities(workflowId)).toEqual({
      items: [expect.objectContaining({ token: firstToken })],
    });

    // Recover the deferred activity. The deferred activity
    // re-runs during replay and re-registers the SAME deterministic token.
    // The activity:async-pending event is NOT re-emitted on replay (idempotency
    // guard) — the token is already registered by recoverPendingAsyncActivities
    // before the workflow replays. Callers that need the token after a restart
    // should read it from the persisted storage record or from the first run.
    const handles = await recoveredEngine.recoverAll();
    expect(handles.map((handle) => handle.id)).toContain(workflowId);

    // The token remains valid and resolvable via the original token value.
    expect(await storage.get(KEYS.asyncActivity(workflowId, firstToken))).not.toBeNull();

    // The callback arriving after the restart, using the original token,
    // completes the right activity and resumes the workflow.
    await recoveredEngine.completeAsyncActivity(firstToken, { decision: 'approved-late' });

    const handle = recoveredEngine.getHandle(workflowId);
    await expect(handle.result()).resolves.toEqual({
      approval: { decision: 'approved-late' },
    });

    recoveredEngine[Symbol.dispose]();
  });

  it('paginates durable records deterministically while skipping malformed and resolved entries', async () => {
    await using storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const workflowId = 'pending-pagination';

    const pendingRecord = (token: string, step: number) => ({
      version: 1,
      token,
      workflowId,
      activityName: `activity-${step}`,
      operationId: `operation-${step}`,
      step,
      attempt: 1,
      createdAt: 1_000 + step,
    });

    await storage.put(
      KEYS.asyncActivity(workflowId, 'token-a'),
      encode(pendingRecord('token-a', 0)),
    );
    await storage.put(
      KEYS.asyncActivity(workflowId, 'token-b'),
      encode({ version: 99, token: 'malformed' }),
    );
    await storage.put(
      KEYS.asyncActivity(workflowId, 'token-c'),
      encode(pendingRecord('token-c', 2)),
    );
    await storage.put(
      KEYS.asyncActivityResolution(workflowId, 'token-d'),
      encode({
        version: 1,
        kind: 'resolution',
        token: 'token-d',
        workflowId,
        outcome: { status: 'completed', value: 'done' },
      }),
    );
    await storage.put(
      KEYS.asyncActivity(workflowId, 'token-e'),
      encode(pendingRecord('token-e', 4)),
    );

    const first = await engine.listPendingAsyncActivities(workflowId, { limit: 2 });
    expect(first.items.map((item) => item.token)).toEqual(['token-a']);
    expect(first.nextCursor).toBeString();
    if (first.nextCursor === undefined) throw new Error('expected a second page');

    const second = await engine.listPendingAsyncActivities(workflowId, {
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((item) => item.token)).toEqual(['token-c']);
    expect(second.nextCursor).toBeString();
    if (second.nextCursor === undefined) throw new Error('expected a third page');

    const third = await engine.listPendingAsyncActivities(workflowId, {
      limit: 2,
      cursor: second.nextCursor,
    });
    expect(third).toEqual({ items: [expect.objectContaining({ token: 'token-e' })] });

    engine[Symbol.dispose]();
  });

  it('rejects cursors that were not issued by the pending-activity query', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });

    await expect(
      engine.listPendingAsyncActivities('pending-invalid-cursor', { cursor: 'not-a-cursor' }),
    ).rejects.toThrow('Invalid pending async activity cursor');
    await expect(
      engine.listPendingAsyncActivities('pending-invalid-cursor', {
        cursor: 'pending-async:v1:%',
      }),
    ).rejects.toThrow('Invalid pending async activity cursor');
    await expect(
      engine.listPendingAsyncActivities('pending-invalid-cursor', { limit: 0 }),
    ).rejects.toThrow('Pending async activity limit must be an integer between 1 and 200');
  });

  it('skips undecodable and internally inconsistent pending records', async () => {
    await using storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const workflowId = 'pending-corrupt-records';
    const record = (token: string, step: number) => ({
      version: 1,
      token,
      workflowId,
      activityName: 'callback',
      operationId: `operation-${token}`,
      step,
      attempt: 1,
      createdAt: 1_000,
    });

    await storage.put(KEYS.asyncActivity(workflowId, 'bad-bytes'), new Uint8Array([0xc1]));
    await storage.put(
      KEYS.asyncActivity(workflowId, 'mismatched-key'),
      encode(record('different-token', 0)),
    );
    await storage.put(
      KEYS.asyncActivity(workflowId, 'invalid-step'),
      encode(record('invalid-step', -1)),
    );
    await storage.put(
      KEYS.asyncActivity(workflowId, 'valid-token'),
      encode(record('valid-token', 2)),
    );

    await expect(engine.listPendingAsyncActivities(workflowId)).resolves.toEqual({
      items: [
        {
          token: 'valid-token',
          operationId: 'operation-valid-token',
          activityName: 'callback',
          step: 2,
          attempt: 1,
          createdAt: 1_000,
        },
      ],
    });
  });

  it('removes a parked token when terminal cancellation cleans up the workflow', async () => {
    await using storage = new MemoryStorage();
    const engine = new Engine({ storage });
    engine.register(
      workflow({ name: 'cancel-pending' })
        .activities({ awaitCallback })
        .execute(async function* (ctx: WorkflowContext) {
          return yield* ctx.run(awaitCallback);
        }),
    );

    const tokenPromise = nextAsyncPendingToken(engine);
    const handle = await engine.start('cancel-pending', null);
    const token = await tokenPromise;
    const pendingBeforeCancel = await engine.listPendingAsyncActivities(handle.id);
    expect(pendingBeforeCancel.items[0]?.token).toBe(token);

    await engine.cancel(handle.id);

    expect(await engine.listPendingAsyncActivities(handle.id)).toEqual({ items: [] });
    expect(await storage.get(KEYS.asyncActivity(handle.id, token))).toBeNull();
    engine[Symbol.dispose]();
  });
});

describe('async activity completion acknowledgement durability', () => {
  const approvalWorkflow = workflow({ name: 'ack-durability-order' })
    .activities({ awaitCallback })
    .execute(async function* (ctx: WorkflowContext) {
      const approval = yield* ctx.run(awaitCallback);
      return { approval };
    });

  const catchingWorkflow = workflow({ name: 'ack-durability-catch' })
    .activities({ awaitCallback })
    .execute(async function* (ctx: WorkflowContext) {
      try {
        yield* ctx.run(awaitCallback);
        return 'should-not-reach';
      } catch (error) {
        return `caught:${(error as Error).message}`;
      }
    });

  it('does not acknowledge a completion before its durable write commits', async () => {
    await using storage = new WriteBarrierMemoryStorage();
    const engine = new Engine({ storage });
    engine.register(approvalWorkflow);

    const tokenPromise = nextAsyncPendingToken(engine);
    const handle = await engine.start('ack-durability-order', null);
    const token = await tokenPromise;

    // Park the first write that consumes the durable token record, then complete.
    const parkedPromise = storage.armBarrier(KEYS.asyncActivity(handle.id, token));
    let ackSettled = false;
    const ack = engine.completeAsyncActivity(token, { decision: 'approved' });
    void ack
      .then(() => {
        ackSettled = true;
      })
      .catch(() => {
        ackSettled = true;
      });

    // Deterministic rendezvous: the engine is now attempting the durable write
    // that consumes the token. The acknowledgement must still be pending —
    // resolving earlier would tell the caller the completion is durable when
    // nothing has been written.
    const parked = await parkedPromise;
    expect(ackSettled).toBe(false);

    parked.release();
    await ack;

    // Once acknowledged, the single-use consumption is durable.
    expect(await storage.get(KEYS.asyncActivity(handle.id, token))).toBeNull();
    await expect(handle.result()).resolves.toEqual({ approval: { decision: 'approved' } });

    engine[Symbol.dispose]();
  });

  it('rejects the acknowledgement when its durable write fails and leaves the token completable', async () => {
    await using storage = new WriteBarrierMemoryStorage();
    const engine = new Engine({ storage });
    engine.register(approvalWorkflow);

    const tokenPromise = nextAsyncPendingToken(engine);
    const handle = await engine.start('ack-durability-order', null);
    const token = await tokenPromise;

    const parkedPromise = storage.armBarrier(KEYS.asyncActivity(handle.id, token));
    const ack = engine.completeAsyncActivity(token, { decision: 'first' });
    const parked = await parkedPromise;
    parked.reject(new Error('simulated storage failure'));

    // The caller must learn the completion did NOT stick, so it can retry.
    await expect(ack).rejects.toThrow();
    const pendingAfterFailure = await engine.listPendingAsyncActivities(handle.id);
    expect(pendingAfterFailure.items[0]?.token).toBe(token);

    // The token must remain completable: the failed acknowledgement consumed nothing.
    await engine.completeAsyncActivity(token, { decision: 'second' });
    await expect(handle.result()).resolves.toEqual({ approval: { decision: 'second' } });

    engine[Symbol.dispose]();
  });

  it('surfaces same-epoch acknowledgement precondition loss under lease ownership', async () => {
    await using storage = new MemoryStorage();
    const engine = await Engine.create({ storage, ownership: 'lease' });
    const originalConditionalBatch = storage.conditionalBatch.bind(storage);
    try {
      engine.register(approvalWorkflow);

      const tokenPromise = nextAsyncPendingToken(engine);
      const handle = await engine.start('ack-durability-order', null);
      const token = await tokenPromise;

      storage.conditionalBatch = async () => false;

      await expect(engine.completeAsyncActivity(token, { decision: 'approved' })).rejects.toThrow(
        `Async activity acknowledgement for token "${token}" lost its precondition.`,
      );

      expect(await storage.get(KEYS.asyncActivity(handle.id, token))).not.toBeNull();
    } finally {
      storage.conditionalBatch = originalConditionalBatch;
      await engine.shutdown();
    }
  });

  it('resumes the workflow with the acked result after a crash that follows the acknowledgement', async () => {
    const storage = new WriteBarrierMemoryStorage();

    let workflowId: string;
    let token: string;
    {
      const engine = new Engine({ storage });
      engine.register(approvalWorkflow);
      const tokenPromise = nextAsyncPendingToken(engine);
      const handle = await engine.start('ack-durability-order', null);
      workflowId = handle.id;
      token = await tokenPromise;

      await engine.completeAsyncActivity(token, { decision: 'approved' });

      // Crash boundary: nothing after the acknowledgement becomes durable.
      storage.rejectAllWrites = true;
      engine[Symbol.dispose]();
    }

    storage.rejectAllWrites = false;
    const recovered = new Engine({ storage });
    recovered.register(approvalWorkflow);
    await recovered.recoverAll();

    // The acknowledged completion must have consumed the token durably — recovery
    // must not re-park the workflow waiting on a delivery that already happened.
    expect(await storage.get(KEYS.asyncActivity(workflowId, token))).toBeNull();
    const handle = recovered.getHandle(workflowId);
    await expect(handle.result()).resolves.toEqual({ approval: { decision: 'approved' } });

    recovered[Symbol.dispose]();
    storage[Symbol.dispose]();
  });

  it('resumes the workflow with the acked failure after a crash that follows the acknowledgement', async () => {
    const storage = new WriteBarrierMemoryStorage();

    let workflowId: string;
    let token: string;
    {
      const engine = new Engine({ storage });
      engine.register(catchingWorkflow);
      const tokenPromise = nextAsyncPendingToken(engine);
      const handle = await engine.start('ack-durability-catch', null);
      workflowId = handle.id;
      token = await tokenPromise;

      await engine.failAsyncActivity(token, new Error('callback rejected'));

      storage.rejectAllWrites = true;
      engine[Symbol.dispose]();
    }

    storage.rejectAllWrites = false;
    const recovered = new Engine({ storage });
    recovered.register(catchingWorkflow);
    await recovered.recoverAll();

    expect(await storage.get(KEYS.asyncActivity(workflowId, token))).toBeNull();
    const handle = recovered.getHandle(workflowId);
    await expect(handle.result()).resolves.toBe('caught:callback rejected');

    recovered[Symbol.dispose]();
    storage[Symbol.dispose]();
  });
});

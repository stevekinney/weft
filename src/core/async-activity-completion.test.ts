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
import { KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { nextAsyncPendingToken } from '../testing/async-activity.test-support.ts';
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

    // Complete the activity out-of-band.
    await engine.completeAsyncActivity(token, { decision: 'approved' });

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

    // Second engine: recover from the same storage. The deferred activity
    // re-runs during replay and re-registers the SAME deterministic token.
    // The activity:async-pending event is NOT re-emitted on replay (idempotency
    // guard) — the token is already registered by recoverPendingAsyncActivities
    // before the workflow replays. Callers that need the token after a restart
    // should read it from the persisted storage record or from the first run.
    const recoveredEngine = new Engine({ storage });
    recoveredEngine.register(orderWorkflow);

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
});

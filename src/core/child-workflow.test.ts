import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../storage/memory';
import { waitForCondition } from '../testing/fake-timers.test-support';
import { Engine } from './engine';
import type { WorkflowContext } from './types';
import { workflow } from './types';

async function waitForWorkflowStatus(
  engine: Engine,
  workflowId: string,
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed-out' | 'suspended',
): Promise<void> {
  await waitForCondition(
    async () => {
      const state = await engine.get(workflowId);
      return state?.status === status;
    },
    {
      label: `${workflowId} status ${status}`,
    },
  );
}

describe('child workflows', () => {
  it('parent starts child and gets result', async () => {
    const engine = new Engine();

    const childWorkflow = workflow({ name: 'child' }).execute(async function* (
      _ctx: WorkflowContext,
      input: unknown,
    ) {
      const { value } = input as { value: number };
      return value * 2;
    });
    engine.register(childWorkflow);

    const parentWorkflow = workflow({ name: 'parent' }).execute(async function* (
      ctx: WorkflowContext,
      input: unknown,
    ) {
      const context = ctx;
      const { value } = input as { value: number };
      const childResult = yield* context.startChild<number>('child', { value });
      return { doubled: childResult };
    });
    engine.register(parentWorkflow);

    const handle = await engine.start('parent', { value: 21 });
    const result = await handle.result();
    expect(result).toEqual({ doubled: 42 });
  });

  it('child failure propagates to parent', async () => {
    const engine = new Engine();

    const failingChildWorkflow = workflow({ name: 'failing-child' }).execute(async function* () {
      throw new Error('child exploded');
    });
    engine.register(failingChildWorkflow);

    const parentCatchesWorkflow = workflow({ name: 'parent-catches' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const context = ctx;
      try {
        yield* context.startChild('failing-child', {});
        return { caught: false };
      } catch (error) {
        return { caught: true, message: (error as Error).message };
      }
    });
    engine.register(parentCatchesWorkflow);

    const handle = await engine.start('parent-catches', {});
    const result = (await handle.result()) as { caught: boolean; message: string };
    expect(result.caught).toBe(true);
    expect(result.message).toBe('child exploded');
  });

  it('nesting depth limit is enforced at default depth (10)', async () => {
    const engine = new Engine();

    // Register a recursive workflow that calls itself as a child
    const recursiveWorkflow = workflow({ name: 'recursive' }).execute(async function* (
      ctx: WorkflowContext,
      input: unknown,
    ) {
      const context = ctx;
      const { depth } = input as { depth: number };
      if (depth > 0) {
        return yield* context.startChild<number>('recursive', { depth: depth - 1 });
      }
      return depth;
    });
    engine.register(recursiveWorkflow);

    // Start with depth 15, which will nest 15 levels deep (exceeding default limit of 10)
    const handle = await engine.start('recursive', { depth: 15 });

    // The parent should fail because nesting depth is exceeded
    await expect(handle.result()).rejects.toThrow('nesting depth exceeded');
  });

  it('custom maxNestingDepth limits nesting', async () => {
    const engine = new Engine({ maxNestingDepth: 2 });

    const nestedWorkflow = workflow({ name: 'nested' }).execute(async function* (
      ctx: WorkflowContext,
      input: unknown,
    ) {
      const context = ctx;
      const { level } = input as { level: number };
      if (level < 3) {
        return yield* context.startChild<string>('nested', { level: level + 1 });
      }
      return `reached level ${level}`;
    });
    engine.register(nestedWorkflow);

    // Starting at level 0, it will try to nest: 0 -> 1 -> 2 -> 3
    // At depth 0->1 (depth 1), 1->2 (depth 2), 2->3 (depth 3 > max 2) should fail
    const handle = await engine.start('nested', { level: 0 });
    await expect(handle.result()).rejects.toThrow('nesting depth exceeded');
  });

  it('succeeds within custom maxNestingDepth', async () => {
    const engine = new Engine({ maxNestingDepth: 3 });

    const nestedOkWorkflow = workflow({ name: 'nested-ok' }).execute(async function* (
      ctx: WorkflowContext,
      input: unknown,
    ) {
      const context = ctx;
      const { level } = input as { level: number };
      if (level < 3) {
        return yield* context.startChild<string>('nested-ok', { level: level + 1 });
      }
      return `reached level ${level}`;
    });
    engine.register(nestedOkWorkflow);

    // 0 -> 1 (depth 1), 1 -> 2 (depth 2), 2 -> 3 (depth 3) = exactly at limit
    const handle = await engine.start('nested-ok', { level: 0 });
    const result = await handle.result();
    expect(result).toBe('reached level 3');
  });

  it('child is independently stored', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    const storedChildWorkflow = workflow({ name: 'stored-child' }).execute(async function* (
      _ctx: WorkflowContext,
      input: unknown,
    ) {
      return `child result: ${(input as { data: string }).data}`;
    });
    engine.register(storedChildWorkflow);

    const storedParentWorkflow = workflow({ name: 'stored-parent' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const context = ctx;
      const result = yield* context.startChild<string>('stored-child', { data: 'test' });
      return result;
    });
    engine.register(storedParentWorkflow);

    const handle = await engine.start('stored-parent', {});
    await handle.result();

    // Scan storage for all workflow entries
    const workflowKeys: string[] = [];
    for await (const [key] of storage.scan('wf:')) {
      if (!key.includes(':ckpt')) {
        workflowKeys.push(key);
      }
    }

    // There should be at least 2 workflow state entries: parent and child
    expect(workflowKeys.length).toBeGreaterThanOrEqual(2);
  });

  it('cached result on recovery path', async () => {
    const engine = new Engine();

    let childCallCount = 0;

    const countingChildWorkflow = workflow({ name: 'counting-child' }).execute(async function* (
      _ctx: WorkflowContext,
      input: unknown,
    ) {
      childCallCount++;
      return `result-${(input as { id: number }).id}`;
    });
    engine.register(countingChildWorkflow);

    const recoveryParentWorkflow = workflow({ name: 'recovery-parent' }).execute(async function* (
      ctx: WorkflowContext,
      input: unknown,
    ) {
      const context = ctx;
      const { count } = input as { count: number };
      const results: string[] = [];
      for (let i = 0; i < count; i++) {
        const result = yield* context.startChild<string>('counting-child', { id: i });
        results.push(result);
      }
      return results;
    });
    engine.register(recoveryParentWorkflow);

    const handle = await engine.start('recovery-parent', { count: 3 });
    const result = await handle.result();
    expect(result).toEqual(['result-0', 'result-1', 'result-2']);
    expect(childCallCount).toBe(3);
  });

  it('abandoned child survives parent completion without parent execution ownership', async () => {
    const engine = new Engine();
    const childWorkflowId = 'abandoned-completion-child';

    engine.register(
      workflow({ name: 'abandoned-completion-child-workflow' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        const signalPayload = yield* ctx.waitForSignal<string>('finish');
        return `child:${signalPayload}`;
      }),
    );

    engine.register(
      workflow({ name: 'abandoned-completion-parent' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        return yield* ctx.startChild('abandoned-completion-child-workflow', null, {
          id: childWorkflowId,
          parentClosePolicy: 'abandon',
        });
      }),
    );

    const parentHandle = await engine.start('abandoned-completion-parent', null, {
      id: 'abandoned-completion-parent',
    });

    await expect(parentHandle.result()).resolves.toEqual({ id: childWorkflowId });
    await waitForWorkflowStatus(engine, childWorkflowId, 'running');

    const childState = await engine.get(childWorkflowId);
    expect(childState?.executionStateOwnerId).toBeUndefined();

    await engine.signal(childWorkflowId, 'finish', 'completed');
    await expect(engine.getHandle(childWorkflowId).result()).resolves.toBe('child:completed');
  });

  it('abandoned child survives parent cancellation without parent execution ownership', async () => {
    const engine = new Engine();
    const childWorkflowId = 'abandoned-cancel-child';

    engine.register(
      workflow({ name: 'abandoned-cancel-child-workflow' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        const signalPayload = yield* ctx.waitForSignal<string>('finish');
        return `child:${signalPayload}`;
      }),
    );

    engine.register(
      workflow({ name: 'abandoned-cancel-parent' }).execute(async function* (ctx: WorkflowContext) {
        yield* ctx.startChild('abandoned-cancel-child-workflow', null, {
          id: childWorkflowId,
          parentClosePolicy: 'abandon',
        });
        return yield* ctx.waitForSignal('release-parent');
      }),
    );

    const parentHandle = await engine.start('abandoned-cancel-parent', null, {
      id: 'abandoned-cancel-parent',
    });

    await waitForWorkflowStatus(engine, childWorkflowId, 'running');
    await parentHandle.cancel();
    await expect(parentHandle.result()).rejects.toThrow('Workflow cancelled');

    const childStateAfterParentCancel = await engine.get(childWorkflowId);
    expect(childStateAfterParentCancel?.status).toBe('running');
    expect(childStateAfterParentCancel?.executionStateOwnerId).toBeUndefined();

    await engine.signal(childWorkflowId, 'finish', 'after-parent-cancel');
    await expect(engine.getHandle(childWorkflowId).result()).resolves.toBe(
      'child:after-parent-cancel',
    );
  });

  it('request-cancel child receives cancellation when the parent cancels', async () => {
    const engine = new Engine();
    const childWorkflowId = 'request-cancel-child';

    engine.register(
      workflow({ name: 'request-cancel-child-workflow' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        return yield* ctx.waitForSignal('finish');
      }),
    );

    engine.register(
      workflow({ name: 'request-cancel-parent' }).execute(async function* (ctx: WorkflowContext) {
        yield* ctx.startChild('request-cancel-child-workflow', null, {
          id: childWorkflowId,
          parentClosePolicy: 'request-cancel',
        });
        return yield* ctx.waitForSignal('release-parent');
      }),
    );

    const parentHandle = await engine.start('request-cancel-parent', null, {
      id: 'request-cancel-parent',
    });

    await waitForWorkflowStatus(engine, childWorkflowId, 'running');
    await parentHandle.cancel();
    await expect(parentHandle.result()).rejects.toThrow('Workflow cancelled');
    await waitForWorkflowStatus(engine, childWorkflowId, 'cancelled');
    await expect(engine.getHandle(childWorkflowId).result()).rejects.toThrow('Workflow cancelled');
  });

  it('request-cancel child receives cancellation after parent recovery', async () => {
    const storage = new MemoryStorage();
    const childWorkflowId = 'recovered-request-cancel-child';
    const parentWorkflowId = 'recovered-request-cancel-parent';

    const childWorkflow = workflow({ name: 'recovered-request-cancel-child-workflow' }).execute(
      async function* (ctx: WorkflowContext) {
        return yield* ctx.waitForSignal('finish');
      },
    );
    const parentWorkflow = workflow({ name: 'recovered-request-cancel-parent-workflow' }).execute(
      async function* (ctx: WorkflowContext) {
        yield* ctx.startChild('recovered-request-cancel-child-workflow', null, {
          id: childWorkflowId,
          parentClosePolicy: 'request-cancel',
        });
        return yield* ctx.waitForSignal('release-parent');
      },
    );

    const engine = new Engine({ storage });
    engine.register(childWorkflow);
    engine.register(parentWorkflow);
    const parentHandle = await engine.start('recovered-request-cancel-parent-workflow', null, {
      id: parentWorkflowId,
    });
    void parentHandle.result().catch(() => {});
    await waitForWorkflowStatus(engine, childWorkflowId, 'running');
    await engine[Symbol.asyncDispose]();

    const recoveredEngine = new Engine({ storage });
    recoveredEngine.register(childWorkflow);
    recoveredEngine.register(parentWorkflow);
    await recoveredEngine.recoverAll();

    await recoveredEngine.cancel(parentWorkflowId);
    await waitForWorkflowStatus(recoveredEngine, parentWorkflowId, 'cancelled');
    await waitForWorkflowStatus(recoveredEngine, childWorkflowId, 'cancelled');
    await expect(recoveredEngine.getHandle(childWorkflowId).result()).rejects.toThrow(
      'Workflow cancelled',
    );
    await recoveredEngine[Symbol.asyncDispose]();
  });

  it('await parent-close policy preserves child result and parent execution ownership', async () => {
    const engine = new Engine();
    const childWorkflowId = 'await-policy-child';
    const parentWorkflowId = 'await-policy-parent';

    engine.register(
      workflow({ name: 'await-policy-child-workflow' }).execute(async function* () {
        return 'child-result';
      }),
    );

    engine.register(
      workflow({ name: 'await-policy-parent-workflow' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        return yield* ctx.startChild<string>('await-policy-child-workflow', null, {
          id: childWorkflowId,
          parentClosePolicy: 'await',
        });
      }),
    );

    const parentHandle = await engine.start('await-policy-parent-workflow', null, {
      id: parentWorkflowId,
    });

    await expect(parentHandle.result()).resolves.toBe('child-result');
    const childState = await engine.get(childWorkflowId);
    expect(childState?.executionStateOwnerId).toBe(parentWorkflowId);
  });
});

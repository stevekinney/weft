import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { TestEngine } from '../../testing/test-engine.ts';
import { decode, encode } from '../codec.ts';
import { Engine } from '../engine.ts';
import type { TimerEntry, WorkflowContext, WorkflowState } from '../types.ts';
import { workflow } from '../types.ts';

async function collectDelayedEntries(
  storage: MemoryStorage,
): Promise<Array<{ key: string; entry: TimerEntry }>> {
  const entries: Array<{ key: string; entry: TimerEntry }> = [];

  for await (const [key, value] of storage.scan('wf-delayed:')) {
    entries.push({
      key,
      entry: decode(value) as TimerEntry,
    });
  }

  return entries;
}

describe('delayed workflow start', () => {
  it('keeps a workflow pending until startAt and then runs it', async () => {
    const engine = new TestEngine({ startTime: 1_000 });
    let executions = 0;

    const delayedWorkflow = workflow({ name: 'delayed' }).execute(async function* (
      _ctx: WorkflowContext,
      input: unknown,
    ) {
      executions += 1;
      return input;
    });
    engine.register(delayedWorkflow);

    const handle = await engine.start('delayed', 'hello', {
      id: 'wf-delayed-start-at',
      startAt: engine.now + 5_000,
    });

    expect(await engine.get(handle.id)).toMatchObject({
      id: handle.id,
      status: 'pending',
      type: 'delayed',
    });
    expect(await engine.list()).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ id: handle.id, status: 'pending', type: 'delayed' })],
    });
    expect(await engine.list({ status: 'pending' })).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ id: handle.id, status: 'pending' })],
    });
    expect(executions).toBe(0);

    await engine.advanceTime('4s');

    expect(await engine.get(handle.id)).toMatchObject({ status: 'pending' });
    expect(executions).toBe(0);

    await engine.advanceTime('1s');

    expect(await handle.result()).toBe('hello');
    expect(executions).toBe(1);
    expect(await engine.get(handle.id)).toMatchObject({
      status: 'completed',
      result: 'hello',
    });

    engine[Symbol.dispose]();
  });

  it('persists startAfter as a wf-delayed timer entry', async () => {
    const engine = new TestEngine({ startTime: 10_000 });

    const delayedWorkflow2 = workflow({ name: 'delayed' }).execute(async function* () {
      return 'done';
    });
    engine.register(delayedWorkflow2);

    await engine.start('delayed', null, {
      id: 'wf-start-after',
      startAfter: '5s',
    });

    const entries = await collectDelayedEntries(engine.storage);

    expect(entries).toEqual([
      {
        key: KEYS.delayedStart(15_000, 'wf-start-after'),
        entry: {
          id: 'delayed-start:wf-start-after',
          workflowId: 'wf-start-after',
          fireAt: 15_000,
          kind: 'delayed-start',
        },
      },
    ]);

    engine[Symbol.dispose]();
  });

  it('rejects start() when both startAt and startAfter are provided', async () => {
    const engine = new TestEngine({ startTime: 1_000 });

    const delayedWorkflow3 = workflow({ name: 'delayed' }).execute(async function* () {
      return 'done';
    });
    engine.register(delayedWorkflow3);

    await expect(
      engine.start('delayed', null, {
        startAt: 2_000,
        startAfter: '1s',
      }),
    ).rejects.toThrow('Provide only one of startAt or startAfter');

    engine[Symbol.dispose]();
  });

  it('rejects startAt values that are negative, non-finite, or fractional', async () => {
    const engine = new TestEngine({ startTime: 1_000 });

    const delayedWorkflow4 = workflow({ name: 'delayed' }).execute(async function* () {
      return 'done';
    });
    engine.register(delayedWorkflow4);

    await expect(
      engine.start('delayed', null, {
        startAt: -1,
      }),
    ).rejects.toThrow('options.startAt must be a non-negative integer millisecond timestamp');

    await expect(
      engine.start('delayed', null, {
        startAt: Number.POSITIVE_INFINITY,
      }),
    ).rejects.toThrow('options.startAt must be a non-negative integer millisecond timestamp');

    await expect(
      engine.start('delayed', null, {
        startAt: 1_500.5,
      }),
    ).rejects.toThrow('options.startAt must be a non-negative integer millisecond timestamp');

    engine[Symbol.dispose]();
  });

  it('rejects startAfter values that are not finite or non-negative durations', async () => {
    const engine = new TestEngine({ startTime: 1_000 });

    const delayedWorkflow5 = workflow({ name: 'delayed' }).execute(async function* () {
      return 'done';
    });
    engine.register(delayedWorkflow5);

    await expect(
      engine.start('delayed', null, {
        startAfter: -1,
      }),
    ).rejects.toThrow(
      'options.startAfter must be a finite, non-negative number or a valid duration string',
    );

    engine[Symbol.dispose]();
  });

  it('rounds fractional startAfter durations up before persisting delayed starts', async () => {
    const engine = new TestEngine({ startTime: 1_000 });

    const delayedWorkflow6 = workflow({ name: 'delayed' }).execute(async function* () {
      return 'done';
    });
    engine.register(delayedWorkflow6);

    await engine.start('delayed', null, {
      id: 'wf-fractional-start-after',
      startAfter: '0.1ms',
    });

    const entries = await collectDelayedEntries(engine.storage);

    expect(entries).toEqual([
      {
        key: KEYS.delayedStart(1_001, 'wf-fractional-start-after'),
        entry: {
          id: 'delayed-start:wf-fractional-start-after',
          workflowId: 'wf-fractional-start-after',
          fireAt: 1_001,
          kind: 'delayed-start',
        },
      },
    ]);

    engine[Symbol.dispose]();
  });

  it('rejects delayed executionTimeout values that are not finite, non-negative durations', async () => {
    const engine = new TestEngine({ startTime: 1_000 });

    const delayedWorkflow7 = workflow({ name: 'delayed' }).execute(async function* () {
      return 'done';
    });
    engine.register(delayedWorkflow7);

    await expect(
      engine.start('delayed', null, {
        startAfter: '5s',
        executionTimeout: -1,
      }),
    ).rejects.toThrow(
      'options.executionTimeout must be a finite, non-negative number or a valid duration string',
    );

    engine[Symbol.dispose]();
  });

  it('survives restart and fires from persisted wf-delayed storage', async () => {
    let now = 1_000;
    const storage = new MemoryStorage();
    let executions = 0;

    const registerDelayedWorkflow = (engine: Engine) => {
      const delayedWorkflow8 = workflow({ name: 'delayed' }).execute(async function* (
        _ctx: WorkflowContext,
        input: unknown,
      ) {
        executions += 1;
        return `done:${input as string}`;
      });
      engine.register(delayedWorkflow8);
    };

    const firstEngine = new Engine({
      storage,
      getNow: () => now,
    });
    registerDelayedWorkflow(firstEngine);

    await firstEngine.start('delayed', 'work', {
      id: 'wf-restart',
      startAt: now + 5_000,
    });

    expect(await firstEngine.get('wf-restart')).toMatchObject({ status: 'pending' });

    firstEngine[Symbol.dispose]();

    const secondEngine = new Engine({
      storage,
      getNow: () => now,
    });
    registerDelayedWorkflow(secondEngine);

    now += 5_000;
    const recoveredHandle = secondEngine.getHandle('wf-restart');
    await secondEngine.scheduler.tick(now);

    await expect(recoveredHandle.result()).resolves.toBe('done:work');
    expect(executions).toBe(1);

    secondEngine[Symbol.dispose]();
  });

  it('restores only persistable workflow start headers after restart before launching child workflows', async () => {
    let now = 1_000;
    const storage = new MemoryStorage();
    const capturedParentHeaders: Map<string, string>[] = [];

    const registerWorkflows = (engine: Engine) => {
      engine.addInterceptor({
        workflowStart(interception, next) {
          interception.headers.set(
            'traceparent',
            '00-abcd1234abcd1234abcd1234abcd1234-ef56ef56ef56ef56-01',
          );
          interception.headers.set('tracestate', 'vendor=value');
          interception.headers.set('x-auth', 'secret-token');
          next(interception);
        },
        async childWorkflow(interception, next) {
          capturedParentHeaders.push(new Map(interception.parentHeaders));
          return next(interception);
        },
      });

      const childWorkflow2 = workflow({ name: 'child' }).execute(async function* () {
        return 'child-complete';
      });
      engine.register(childWorkflow2);

      const parentWorkflow = workflow({ name: 'parent' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        return yield* ctx.startChild<string>('child', null);
      });
      engine.register(parentWorkflow);
    };

    const firstEngine = new Engine({
      storage,
      getNow: () => now,
    });
    registerWorkflows(firstEngine);

    await firstEngine.start('parent', null, {
      id: 'wf-restart-headers',
      startAt: now + 5_000,
    });

    firstEngine[Symbol.dispose]();

    const secondEngine = new Engine({
      storage,
      getNow: () => now,
    });
    registerWorkflows(secondEngine);

    now += 5_000;
    await secondEngine.scheduler.tick(now);

    await expect(secondEngine.getHandle('wf-restart-headers').result()).resolves.toBe(
      'child-complete',
    );
    expect(capturedParentHeaders).toHaveLength(1);
    expect(capturedParentHeaders[0]?.get('traceparent')).toBe(
      '00-abcd1234abcd1234abcd1234abcd1234-ef56ef56ef56ef56-01',
    );
    expect(capturedParentHeaders[0]?.get('tracestate')).toBe('vendor=value');
    expect(capturedParentHeaders[0]?.has('x-auth')).toBe(false);

    secondEngine[Symbol.dispose]();
  });

  it('recoverAll includes pending delayed workflows after restart', async () => {
    let now = 1_000;
    const storage = new MemoryStorage();

    const registerDelayedWorkflow = (engine: Engine) => {
      const delayedWorkflow9 = workflow({ name: 'delayed' }).execute(async function* (
        _ctx: WorkflowContext,
        input: unknown,
      ) {
        return `done:${input as string}`;
      });
      engine.register(delayedWorkflow9);
    };

    const firstEngine = new Engine({
      storage,
      getNow: () => now,
    });
    registerDelayedWorkflow(firstEngine);

    await firstEngine.start('delayed', 'recover-all', {
      id: 'wf-recover-all',
      startAfter: '5s',
    });

    firstEngine[Symbol.dispose]();

    const secondEngine = new Engine({
      storage,
      getNow: () => now,
    });
    registerDelayedWorkflow(secondEngine);

    const recoveredHandles = await secondEngine.recoverAll();
    expect(recoveredHandles.map((handle) => handle.id)).toEqual(['wf-recover-all']);

    now += 5_000;
    await secondEngine.scheduler.tick(now);

    await expect(recoveredHandles[0]!.result()).resolves.toBe('done:recover-all');

    secondEngine[Symbol.dispose]();
  });

  it('cancels a pending delayed workflow before it starts', async () => {
    const engine = new TestEngine({ startTime: 1_000 });
    let executions = 0;

    const delayedWorkflow10 = workflow({ name: 'delayed' }).execute(async function* () {
      executions += 1;
      return 'done';
    });
    engine.register(delayedWorkflow10);

    const handle = await engine.start('delayed', null, {
      id: 'wf-cancel-before-start',
      startAfter: '5s',
    });

    await handle.cancel();

    await expect(handle.result()).rejects.toThrow('Workflow cancelled');
    expect(await engine.get(handle.id)).toMatchObject({ status: 'cancelled' });
    expect(await collectDelayedEntries(engine.storage)).toEqual([]);

    await engine.advanceTime('5s');
    expect(executions).toBe(0);

    engine[Symbol.dispose]();
  });

  it('cleans up pending reviews for delayed workflows with encoded workflow ids when cancelled', async () => {
    const engine = new TestEngine({ startTime: 1_000 });
    const workflowId = 'wf:review/cleanup';

    const delayedWorkflow11 = workflow({ name: 'delayed' }).execute(async function* () {
      return 'done';
    });
    engine.register(delayedWorkflow11);

    const handle = await engine.start('delayed', null, {
      id: workflowId,
      startAfter: '5s',
    });
    await engine.storage.put(
      KEYS.review(workflowId, 'review-1'),
      encode({ workflowId, reviewId: 'review-1' }),
    );

    await handle.cancel();
    await expect(handle.result()).rejects.toThrow('Workflow cancelled');

    expect(await engine.storage.get(KEYS.review(workflowId, 'review-1'))).toBeNull();

    engine[Symbol.dispose]();
  });

  it('starts execution timeouts when the delayed workflow begins running', async () => {
    const engine = new TestEngine({ startTime: 1_000 });

    const timeoutDelayedWorkflow = workflow({ name: 'timeout-delayed' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) {
          resolve();
          return;
        }

        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });

      return 'never';
    });
    engine.register(timeoutDelayedWorkflow);

    const handle = await engine.start('timeout-delayed', null, {
      id: 'wf-delayed-timeout',
      startAfter: '5s',
      executionTimeout: '3s',
    });

    await engine.advanceTime('5s');
    expect(await engine.get(handle.id)).toMatchObject({ status: 'running' });

    await engine.advanceTime('2s');
    expect(await engine.get(handle.id)).toMatchObject({ status: 'running' });

    const resultPromise = handle.result();
    void resultPromise.catch(() => {});
    await engine.advanceTime('1s');
    await expect(resultPromise).rejects.toThrow('execution timeout');
    expect(await engine.get(handle.id)).toMatchObject({ status: 'timed-out' });

    engine[Symbol.dispose]();
  });

  it('persists the pending workflow state before the delayed start fires', async () => {
    const engine = new TestEngine({ startTime: 1_000 });

    const delayedWorkflow12 = workflow({ name: 'delayed' }).execute(async function* () {
      return 'done';
    });
    engine.register(delayedWorkflow12);

    const handle = await engine.start('delayed', null, {
      id: 'wf-persisted-pending',
      startAfter: '5s',
    });

    const stateBytes = await engine.storage.get(KEYS.workflow(handle.id));
    expect(stateBytes).not.toBeNull();

    const state = decode(stateBytes!) as WorkflowState;
    expect(state.status).toBe('pending');

    engine[Symbol.dispose]();
  });
});

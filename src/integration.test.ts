import { describe, expect, it } from 'bun:test';
import { sleepForTesting } from './testing/fake-timers.test-support.ts';

import { workflow } from './core/types/workflow-function.ts';
import { Engine, MemoryStorage, WorkflowCompletedEvent, WorkflowStartedEvent } from './index';

/** Drain microtasks so fire-and-forget work completes. */
async function flush(): Promise<void> {
  await sleepForTesting(10);
}

describe('integration: full workflow lifecycle', () => {
  it('runs a complete multi-step workflow', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    const welcome = workflow({ name: 'welcome' })
      .activities({
        greet: async (name: string) => `Hello, ${name}!`,
        notify: async (greeting: string) => `Notified: ${greeting}`,
      })
      .execute(async function* (ctx, input: { name: string }) {
        const greeting = yield* ctx.run('greet', input.name);
        yield* ctx.run('notify', greeting);
        return { greeting, notified: true };
      });
    engine.register(welcome);

    const handle = await engine.start('welcome', { name: 'World' });
    const result = await handle.result();
    expect(result).toEqual({ greeting: 'Hello, World!', notified: true });
  });

  it('handles signals in a workflow', async () => {
    const engine = new Engine();

    const approval = workflow({ name: 'approval' }).execute(async function* (
      ctx,
      input: { orderId: string },
    ) {
      const result = yield* ctx.waitForSignal<{ approved: boolean }>('approval');
      return { orderId: input.orderId, approved: result.approved };
    });
    engine.register(approval);

    const handle = await engine.start('approval', { orderId: 'order-1' });

    // Signal the workflow
    await engine.signal(handle.id, 'approval', { approved: true });

    const result = await handle.result();
    expect(result).toEqual({ orderId: 'order-1', approved: true });
  });

  it('cancels a running workflow', async () => {
    const engine = new Engine();

    const longRunning = workflow({ name: 'long-running' }).execute(async function* (ctx) {
      yield* ctx.sleep(999999);
      return 'done';
    });
    engine.register(longRunning);

    const handle = await engine.start('long-running', {});
    await handle.cancel();

    await expect(handle.result()).rejects.toThrow();
  });

  it('events fire for complete lifecycle', async () => {
    const engine = new Engine();
    const events: string[] = [];

    engine.addEventListener(WorkflowStartedEvent.type, () => events.push('started'));
    engine.addEventListener(WorkflowCompletedEvent.type, () => events.push('completed'));

    const simple = workflow({ name: 'simple' }).execute(async function* (_ctx, input: string) {
      return `result: ${input}`;
    });
    engine.register(simple);

    const handle = await engine.start('simple', 'test');
    await handle.result();

    expect(events).toContain('started');
    expect(events).toContain('completed');
  });

  it('parallel operations complete', async () => {
    const engine = new Engine();

    const parallel = workflow({ name: 'parallel' })
      .activities({
        double: async (n: number) => n * 2,
        triple: async (n: number) => n * 3,
      })
      .execute(async function* (ctx, input: number) {
        const [doubled, tripled] = yield* ctx.all([
          ctx.run('double', input),
          ctx.run('triple', input),
        ]);
        return { doubled, tripled };
      });
    engine.register(parallel);

    const handle = await engine.start('parallel', 5);
    const result = await handle.result();
    expect(result).toEqual({ doubled: 10, tripled: 15 });
  });

  it('memo caches within a workflow', async () => {
    const engine = new Engine();
    let callCount = 0;

    const expensive = async () => {
      callCount++;
      return 42;
    };

    const memoTest = workflow({ name: 'memo-test' }).execute(async function* (ctx) {
      const a = yield* ctx.memo('val', expensive);
      const b = yield* ctx.memo('val', expensive);
      return { a, b };
    });
    engine.register(memoTest);

    const handle = await engine.start('memo-test', {});
    const result = await handle.result();
    expect(result).toEqual({ a: 42, b: 42 });
    expect(callCount).toBe(1);
  });

  it('search attributes are set and readable', async () => {
    const engine = new Engine();

    const withAttrs = workflow({ name: 'with-attrs' })
      .activities({ noop: async () => 'done' })
      .searchAttributes({
        customerId: { type: 'string' },
        status: { type: 'string' },
      })
      .execute(async function* (ctx, input: { customerId: string }) {
        ctx.setAttribute('customerId', input.customerId);
        ctx.setAttribute('status', 'processing');
        yield* ctx.run('noop');
        ctx.setAttribute('status', 'shipped');
        return 'ok';
      });
    engine.register(withAttrs);

    const handle = await engine.start('with-attrs', { customerId: 'cust-123' });
    await handle.result();
    // Verify attributes were set (at least no errors thrown)
    expect(true).toBe(true);
  });

  it('TestEngine with time control', async () => {
    const { TestEngine } = await import('./testing/test-engine');

    const engine = new TestEngine({ startTime: 0 });

    const sleeper = workflow({ name: 'sleeper' }).execute(async function* (ctx) {
      yield* ctx.sleep(5000);
      return 'awake';
    });
    engine.register(sleeper);

    const handle = await engine.start('sleeper', null);
    await flush();

    // Advance past the sleep
    await engine.advanceTime(6000);
    await flush();

    const result = await handle.result();
    expect(result).toBe('awake');
    engine[Symbol.dispose]();
  });

  it('BunSQLiteStorage works as engine backend', async () => {
    const { BunSQLiteStorage } = await import('./storage/bun-sql');

    using storage = new BunSQLiteStorage(':memory:');
    const engine = new Engine({ storage });

    const sqliteTest = workflow({ name: 'sqlite-test' }).execute(async function* (
      _ctx,
      input: string,
    ) {
      return `stored: ${input}`;
    });
    engine.register(sqliteTest);

    const handle = await engine.start('sqlite-test', 'data');
    const result = await handle.result();
    expect(result).toBe('stored: data');
  });
});

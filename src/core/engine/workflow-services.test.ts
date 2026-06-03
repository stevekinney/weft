/**
 * Per-run, non-serialized `services` channel.
 *
 * A workflow can be handed host-supplied capabilities (live clients, closures,
 * tool registries) at launch via `engine.start(type, input, { services })`,
 * readable inside the body as `ctx.services`. The value is NEVER checkpointed;
 * on a fresh-process recovery it is re-provided by the engine's
 * `resolveWorkflowServices` resolver before the generator advances. This is the
 * supported replacement for hand-rolled module-global per-run dependency
 * registries.
 */

import { describe, expect, it } from 'bun:test';
import { sleepForTesting } from '../../testing/fake-timers.test-support.ts';

import { MemoryStorage } from '../../storage/memory.ts';
import type { WorkflowContext } from '../types.ts';
import { workflow } from '../types.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';

/** Drain microtasks so fire-and-forget inline work completes. */
async function flush(): Promise<void> {
  await sleepForTesting(10);
}

describe('ctx.services — launch path (inline)', () => {
  it('exposes the services object passed at start to the workflow body', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    const greet = (name: string): string => `hello, ${name}`;

    const wf = workflow({ name: 'uses-services' }).execute(async function* (ctx: WorkflowContext) {
      const services = ctx.services as { greet: (name: string) => string };
      return services.greet('world');
    });
    engine.register(wf);

    const handle = await engine.start('uses-services', null, { services: { greet } });
    expect(await handle.result()).toBe('hello, world');
  });

  it('defaults ctx.services to undefined when none is provided', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    const wf = workflow({ name: 'no-services' }).execute(async function* (ctx: WorkflowContext) {
      return ctx.services === undefined ? 'absent' : 'present';
    });
    engine.register(wf);

    const handle = await engine.start('no-services', null);
    expect(await handle.result()).toBe('absent');
  });

  it('does not leak one run’s services into another run', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    const wf = workflow({ name: 'leak-check' }).execute(async function* (ctx: WorkflowContext) {
      return (ctx.services as { tag: string } | undefined)?.tag ?? 'none';
    });
    engine.register(wf);

    const a = await engine.start('leak-check', null, { id: 'run-a', services: { tag: 'A' } });
    const b = await engine.start('leak-check', null, { id: 'run-b' });
    expect(await a.result()).toBe('A');
    expect(await b.result()).toBe('none');
  });
});

describe('ctx.services — never checkpointed', () => {
  it('does not write the services value into any durable record', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    const secret = { token: 'super-secret-credential' };

    const wf = workflow({ name: 'durable-check' }).execute(async function* (ctx: WorkflowContext) {
      // Read services (proving they were available) but DO NOT return them — the
      // return value is durable by design, so returning the secret would be the
      // workflow's own doing, not a leak of the services channel.
      const present = (ctx.services as { token: string }).token.length > 0;
      // A durable yield forces a checkpoint write mid-run.
      yield* ctx.memo('step', async () => 'step-done');
      return present ? 'had-services' : 'no-services';
    });
    engine.register(wf);

    const handle = await engine.start('durable-check', null, {
      id: 'durable-run',
      services: secret,
    });
    expect(await handle.result()).toBe('had-services');

    // Scan every persisted key for the workflow; the services value must never
    // appear in any durable record (checkpoint, state, event log, etc.).
    for await (const [key, value] of storage.scan('')) {
      if (!key.includes('durable-run')) continue;
      const text = new TextDecoder().decode(value);
      expect(text).not.toContain('super-secret-credential');
    }
  });
});

describe('ctx.services — worker mode rejection', () => {
  it('throws at start when services is passed under worker execution mode', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({
      storage,
      workflowExecutionMode: 'worker',
      workerExecution: {
        workerUrl: new URL('../../workers/test-browser-worker.ts', import.meta.url),
        poolSize: 1,
      },
    });

    const wf = workflow({ name: 'worker-wf' }).execute(async function* () {
      return 'ok';
    });
    engine.register(wf);

    await expect(engine.start('worker-wf', null, { services: { a: 1 } })).rejects.toThrow(
      /services/i,
    );
  });
});

describe('ctx.services — recovery re-provision', () => {
  it('re-provides services on a fresh engine via resolveWorkflowServices before the generator advances', async () => {
    const storage = new MemoryStorage();
    let firstEngineGenerateCalls = 0;

    const makeWorkflow = () =>
      workflow({ name: 'resumable' }).execute(async function* (ctx: WorkflowContext) {
        const services = ctx.services as { generate: () => string };
        // First step uses services BEFORE the wait — proves the resumed body can
        // call services after recovery for the post-signal step too.
        const before = services.generate();
        yield* ctx.waitForSignal('go');
        const after = services.generate();
        return `${before}|${after}`;
      });

    // First engine: start a workflow that does one step, then waits for a signal.
    const firstEngine = await Engine.create({
      storage,
      recover: false,
      workflows: { resumable: makeWorkflow() },
    });
    await firstEngine.start('resumable', null, {
      id: 'resume-run',
      services: {
        generate: () => {
          firstEngineGenerateCalls++;
          return 'first';
        },
      },
    });
    await flush(); // let it reach waitForSignal
    expect(firstEngineGenerateCalls).toBe(1);

    // Simulate a crash: a brand-new engine over the same storage, with NO
    // in-process services for this run — only a resolver that rebuilds them.
    let resolverCalls = 0;
    const secondEngine = await Engine.create({
      storage,
      recover: false, // recover manually so we can assert on the handle
      workflows: { resumable: makeWorkflow() },
      resolveWorkflowServices: (info) => {
        resolverCalls++;
        expect(info.workflowId).toBe('resume-run');
        expect(info.workflowType).toBe('resumable');
        return {
          status: 'available',
          services: { generate: () => 'second' },
        };
      },
    });

    const handles = await secondEngine.recoverAll();
    expect(handles).toHaveLength(1);
    expect(resolverCalls).toBe(1);

    const resumed = handles[0]!;
    await resumed.signal('go');
    // The post-signal generate() runs on the SECOND engine's services.
    expect(await resumed.result()).toBe('second|second');
  });

  it('fails just the recovered run when the resolver reports unavailable, not the engine', async () => {
    const storage = new MemoryStorage();
    const wf = workflow({ name: 'unresolvable' }).execute(async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('go');
      return (ctx.services as { v: number }).v;
    });
    const firstEngine = await Engine.create({
      storage,
      recover: false,
      workflows: { unresolvable: wf },
    });
    await firstEngine.start('unresolvable', null, { id: 'unresolvable-run', services: { v: 1 } });
    await flush();

    const secondEngine = await Engine.create({
      storage,
      recover: false,
      workflows: { unresolvable: wf },
      resolveWorkflowServices: () => ({ status: 'unavailable', reason: 'no config for run' }),
    });

    // recoverAll itself must not throw — the engine survives; the unresolvable
    // run is failed, not propagated.
    await expect(secondEngine.recoverAll()).resolves.toBeDefined();
    await flush();

    // The single unresolvable run is now terminally failed (not left running,
    // which a later boot would re-attempt forever).
    const summary = await secondEngine.get('unresolvable-run');
    expect(summary?.status).toBe('failed');
  });

  it('recovers a healthy sibling run even when another run is unavailable', async () => {
    const storage = new MemoryStorage();
    const wf = workflow({ name: 'sibling' }).execute(async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('go');
      return (ctx.services as { v: number }).v;
    });
    const firstEngine = await Engine.create({
      storage,
      recover: false,
      workflows: { sibling: wf },
    });
    await firstEngine.start('sibling', null, { id: 'bad-run', services: { v: 1 } });
    await firstEngine.start('sibling', null, { id: 'good-run', services: { v: 2 } });
    await flush();

    // The resolver fails only 'bad-run'; 'good-run' resolves. A throw on the bad
    // run must NOT abort recoverAll's loop before the good run is recovered.
    const secondEngine = await Engine.create({
      storage,
      recover: false,
      workflows: { sibling: wf },
      resolveWorkflowServices: (info) =>
        info.workflowId === 'bad-run'
          ? { status: 'unavailable', reason: 'bad' }
          : { status: 'available', services: { v: 99 } },
    });

    await secondEngine.recoverAll();
    await flush();

    const badSummary = await secondEngine.get('bad-run');
    expect(badSummary?.status).toBe('failed');
    // The healthy sibling resumed and can still run to completion.
    const good = secondEngine.getHandle('good-run');
    await good.signal('go');
    expect(await good.result()).toBe(99);
  });
});

describe('ctx.services — terminal cleanup', () => {
  it('clears the per-run services after the workflow completes', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    const wf = workflow({ name: 'cleanup-wf' }).execute(async function* (ctx: WorkflowContext) {
      return (ctx.services as { v: number }).v;
    });
    engine.register(wf);

    const internals = getInternals(engine);
    const handle = await engine.start('cleanup-wf', null, {
      id: 'cleanup-run',
      services: { v: 7 },
    });
    // The services are held in engine memory while the run is live.
    expect(internals.workflowServices.has('cleanup-run')).toBe(true);

    await handle.result();
    await flush();

    // Terminal cleanup must drop the per-run services, else a long-running engine
    // leaks one entry (and a credential-bearing closure) per completed run.
    expect(internals.workflowServices.has('cleanup-run')).toBe(false);
  });
});

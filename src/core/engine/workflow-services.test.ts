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

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import type { WorkflowContext } from '../types.ts';
import { workflow } from '../types.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { cleanupWorkflowStorage } from './termination/cleanup.ts';

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

    // Scan EVERY persisted record; the services value must never appear in any
    // durable record (checkpoint, state, event log, etc.). The sentinel string
    // is unique enough that an unfiltered scan cannot false-positive.
    for await (const [, value] of storage.scan('')) {
      const text = new TextDecoder().decode(value);
      expect(text).not.toContain('super-secret-credential');
    }
    await engine[Symbol.asyncDispose]();
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
    await engine[Symbol.asyncDispose]();
  });
});

describe('ctx.services — recovery re-provision', () => {
  const makeResumable = () =>
    workflow({ name: 'resumable' }).execute(async function* (ctx: WorkflowContext) {
      const services = ctx.services as { generate: () => string };
      // First step uses services BEFORE the wait — proves the resumed body can
      // call services after recovery for the post-signal step too.
      const before = services.generate();
      yield* ctx.waitForSignal('go');
      const after = services.generate();
      return `${before}|${after}`;
    });

  it('re-provides services on a fresh engine via resolveWorkflowServices before the generator advances', async () => {
    const storage = new MemoryStorage();
    let firstEngineGenerateCalls = 0;

    // First engine: start a workflow that does one step, then waits for a signal.
    const firstEngine = await Engine.create({
      storage,
      recover: false,
      workflows: { resumable: makeResumable() },
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
    // Dispose the first engine: one engine per durable store, and a faithful
    // crash leaves nothing live in the original process.
    await firstEngine[Symbol.asyncDispose]();

    // A brand-new engine over the same storage, with NO in-process services for
    // this run — only an async resolver that rebuilds them (async is the
    // realistic case: rebuilding a client does I/O).
    let resolverCalls = 0;
    const secondEngine = await Engine.create({
      storage,
      recover: false, // recover manually so we can assert on the handle
      workflows: { resumable: makeResumable() },
      resolveWorkflowServices: async (info) => {
        resolverCalls++;
        expect(info.workflowId).toBe('resume-run');
        expect(info.workflowType).toBe('resumable');
        await Promise.resolve();
        return { status: 'available', services: { generate: () => 'second' } };
      },
    });

    const handles = await secondEngine.recoverAll();
    expect(handles).toHaveLength(1);
    expect(resolverCalls).toBe(1);

    const resumed = handles[0]!;
    await resumed.signal('go');
    // The post-signal generate() runs on the SECOND engine's services.
    expect(await resumed.result()).toBe('second|second');
    await secondEngine[Symbol.asyncDispose]();
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
    await firstEngine[Symbol.asyncDispose]();

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
    await secondEngine[Symbol.asyncDispose]();
  });

  it('fails a SUSPENDED run on cross-process resume when its services are unavailable (not stuck suspended)', async () => {
    // Regression: cross-process resume of a suspended run runs the unavailable-
    // services fail path BEFORE the suspended→running flip, while status is still
    // 'suspended'. failWorkflow must accept 'suspended' (FORCIBLY_TERMINABLE_STATUSES)
    // or the fail no-ops, resume aborts, and the run is stranded 'suspended' with
    // result() pending forever.
    const storage = new MemoryStorage();
    const wf = workflow({ name: 'suspend-unresolvable' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.waitForSignal('go');
      return (ctx.services as { v: number }).v;
    });
    const firstEngine = await Engine.create({
      storage,
      recover: false,
      workflows: { 'suspend-unresolvable': wf },
    });
    const handle = await firstEngine.start('suspend-unresolvable', null, {
      id: 'suspend-unresolvable-run',
      services: { v: 1 },
    });
    await flush();
    await handle.suspend();
    const suspendedState = await firstEngine.get('suspend-unresolvable-run');
    expect(suspendedState?.status).toBe('suspended');
    await firstEngine[Symbol.asyncDispose]();

    const secondEngine = await Engine.create({
      storage,
      recover: false,
      workflows: { 'suspend-unresolvable': wf },
      resolveWorkflowServices: () => ({ status: 'unavailable', reason: 'no config for run' }),
    });
    // Explicit resume of the suspended run: the unavailable resolver must fail the
    // run terminally rather than leave it stranded 'suspended'.
    await secondEngine.resume('suspend-unresolvable-run');
    await flush();
    const resumedState = await secondEngine.get('suspend-unresolvable-run');
    expect(resumedState?.status).toBe('failed');
    await secondEngine[Symbol.asyncDispose]();
  });

  it('resumes a no-services run on a fresh engine without consulting the resolver', async () => {
    // A run that was started WITHOUT services must recover normally even when the
    // engine has a fail-closed resolver. The resolver exists to rebuild services
    // for runs that originally had them; consulting it for a no-services run would
    // fail a perfectly healthy workflow. The durable "expects services" marker is
    // what lets the recovery seam tell the two cases apart on a fresh process.
    const storage = new MemoryStorage();
    const wf = workflow({ name: 'plain' }).execute(async function* (ctx: WorkflowContext) {
      yield* ctx.waitForSignal('go');
      return ctx.services === undefined ? 'no-services' : 'unexpected-services';
    });
    const firstEngine = await Engine.create({
      storage,
      recover: false,
      workflows: { plain: wf },
    });
    // No `services` option — this run never expected any.
    await firstEngine.start('plain', null, { id: 'plain-run' });
    await flush();
    await firstEngine[Symbol.asyncDispose]();

    let resolverCalls = 0;
    const secondEngine = await Engine.create({
      storage,
      recover: false,
      workflows: { plain: wf },
      // A fail-closed resolver: if this run ever consults it, the run fails.
      resolveWorkflowServices: () => {
        resolverCalls++;
        return { status: 'unavailable', reason: 'should never be consulted' };
      },
    });

    const handles = await secondEngine.recoverAll();
    expect(handles).toHaveLength(1);
    // The resolver must NOT have been consulted for a run that never had services.
    expect(resolverCalls).toBe(0);

    const resumed = handles[0]!;
    await resumed.signal('go');
    expect(await resumed.result()).toBe('no-services');
    await secondEngine[Symbol.asyncDispose]();
  });

  it('treats a resolver that THROWS as unavailable and still recovers a healthy sibling', async () => {
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
    await firstEngine[Symbol.asyncDispose]();

    // The resolver THROWS for 'bad-run' (a rebuild rejecting), resolves 'good-run'.
    // The throw must be treated as unavailable, not propagated out of recoverAll's
    // loop before the good run is recovered.
    const secondEngine = await Engine.create({
      storage,
      recover: false,
      workflows: { sibling: wf },
      resolveWorkflowServices: (info) => {
        if (info.workflowId === 'bad-run') {
          throw new Error('rebuild failed');
        }
        return { status: 'available', services: { v: 99 } };
      },
    });

    await secondEngine.recoverAll();
    await flush();

    const badSummary = await secondEngine.get('bad-run');
    expect(badSummary?.status).toBe('failed');
    // The healthy sibling resumed and can still run to completion.
    const good = secondEngine.getHandle('good-run');
    await good.signal('go');
    expect(await good.result()).toBe(99);
    await secondEngine[Symbol.asyncDispose]();
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

  it('drops the durable "expects services" marker through the real completion path', async () => {
    // Regression: a services-only run (no start headers, no signals, no forks)
    // must still schedule the deferred durable cleanup that sweeps its marker.
    // Before the fix, only header/signal/fork runs scheduled that cleanup, so the
    // `wf-has-services:` marker leaked once per completed services-only run.
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    const wf = workflow({ name: 'marker-cleanup' }).execute(async function* (ctx: WorkflowContext) {
      return (ctx.services as { v: number }).v;
    });
    engine.register(wf);

    const handle = await engine.start('marker-cleanup', null, {
      id: 'marker-run',
      services: { v: 9 },
    });
    // The durable marker is written atomically with the start batch.
    expect(await storage.get(KEYS.workflowHasServices('marker-run'))).not.toBeNull();

    await handle.result();
    await flush();

    // Completion scheduled the deferred durable cleanup (because the run carries
    // services). Advance the scheduler past the terminal-cleanup delay to fire it
    // — no manual cleanup call. The marker is swept along with the rest of the
    // run's durable scratch, so a fresh engine over this store never re-provisions
    // services for a completed run.
    await engine.scheduler.tick(Date.now() + 120_000);
    expect(await storage.get(KEYS.workflowHasServices('marker-run'))).toBeNull();
    await engine[Symbol.asyncDispose]();
  });

  it('sweeps the durable "expects services" marker via cleanupWorkflowStorage', async () => {
    // Direct unit check on the sweep helper itself, complementing the end-to-end
    // completion-path test above.
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const wf = workflow({ name: 'sweep-wf' }).execute(async function* (ctx: WorkflowContext) {
      return (ctx.services as { v: number }).v;
    });
    engine.register(wf);

    await engine.start('sweep-wf', null, { id: 'sweep-run', services: { v: 1 } });
    expect(await storage.get(KEYS.workflowHasServices('sweep-run'))).not.toBeNull();

    await cleanupWorkflowStorage(getInternals(engine), 'sweep-run', false);
    expect(await storage.get(KEYS.workflowHasServices('sweep-run'))).toBeNull();
    await engine[Symbol.asyncDispose]();
  });

  it('deletes the durable "expects services" marker on purge', async () => {
    // Regression: purge (and retention reclaim, which reuses the same machinery)
    // must delete the marker. A surviving marker on a purged-then-reused id would
    // make recovery re-provision services for a run that never had them.
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const wf = workflow({ name: 'purge-wf' }).execute(async function* (ctx: WorkflowContext) {
      return (ctx.services as { v: number }).v;
    });
    engine.register(wf);

    const handle = await engine.start('purge-wf', null, { id: 'purge-run', services: { v: 1 } });
    await handle.result();
    await flush();
    expect(await storage.get(KEYS.workflowHasServices('purge-run'))).not.toBeNull();

    const purged = await engine.purge();
    expect(purged.deleted).toBeGreaterThanOrEqual(1);
    expect(await storage.get(KEYS.workflowHasServices('purge-run'))).toBeNull();
    await engine[Symbol.asyncDispose]();
  });
});

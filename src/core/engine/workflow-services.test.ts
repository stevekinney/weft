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
import {
  sleepForTesting,
  waitForCondition,
  yieldToEventLoop,
} from '../../testing/fake-timers.test-support.ts';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { encode } from '../codec.ts';
import { DevelopmentWarningEvent } from '../events.ts';
import type { ScheduleOverlapPolicy, WorkflowContext } from '../types.ts';
import { workflow } from '../types.ts';
import { Engine } from './index.ts';
import { getInternals } from './internals.ts';
import { runRetentionSweep } from './retention.ts';
import { cleanupWorkflowStorage } from './termination/cleanup.ts';

/** Drain microtasks so fire-and-forget inline work completes. */
async function flush(): Promise<void> {
  await sleepForTesting(10);
}

/** Advance engine clock and scheduler then drain pending inline work. */
async function tickEngine<TWorkflows extends object, TActivities extends object>(
  engine: Engine<TWorkflows, TActivities>,
  clock: { now: number },
  nextNow: number,
): Promise<void> {
  clock.now = nextNow;
  await engine.scheduler.tick(clock.now);
  await yieldToEventLoop();
  await yieldToEventLoop();
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

  it('passes current launch tags to the recovered services resolver', async () => {
    const storage = new MemoryStorage();
    const wf = workflow({ name: 'tagged-resumable' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.waitForSignal('continue');
      return (ctx.services as { origin: string }).origin;
    });

    const firstEngine = await Engine.create({
      storage,
      recover: false,
      workflows: { 'tagged-resumable': wf },
    });
    const handle = await firstEngine.start('tagged-resumable', null, {
      id: 'tagged-run',
      tags: ['session', 'scheduler-origin'],
      services: { origin: 'first-engine' },
    });
    await handle.removeTags('session');
    await handle.addTags('recovered');
    await flush();
    await firstEngine[Symbol.asyncDispose]();

    const resolverLaunchOptions: unknown[] = [];
    const secondEngine = await Engine.create({
      storage,
      recover: false,
      workflows: { 'tagged-resumable': wf },
      resolveWorkflowServices: (info) => {
        resolverLaunchOptions.push(info.launchOptions);
        return { status: 'available', services: { origin: 'second-engine' } };
      },
    });

    const handles = await secondEngine.recoverAll();
    expect(handles).toHaveLength(1);
    expect(resolverLaunchOptions).toEqual([
      { id: 'tagged-run', tags: ['recovered', 'scheduler-origin'] },
    ]);

    await handles[0]!.signal('continue');
    expect(await handles[0]!.result()).toBe('second-engine');
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

  it('fails a recovered running run that expected services when no resolver is configured', async () => {
    const storage = new MemoryStorage();
    const wf = workflow({ name: 'missing-resolver-running' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const services = ctx.services as { v: number };
      yield* ctx.waitForSignal('go');
      return services.v;
    });
    const firstEngine = await Engine.create({
      storage,
      recover: false,
      workflows: { 'missing-resolver-running': wf },
    });
    await firstEngine.start('missing-resolver-running', null, {
      id: 'missing-resolver-running-run',
      services: { v: 1 },
    });
    await flush();
    await firstEngine[Symbol.asyncDispose]();

    const secondEngine = await Engine.create({
      storage,
      recover: false,
      workflows: { 'missing-resolver-running': wf },
    });
    const warnings: DevelopmentWarningEvent[] = [];
    secondEngine.addEventListener(DevelopmentWarningEvent.type, (event) => {
      warnings.push(event);
    });

    await secondEngine.recoverAll();
    await flush();

    const recoveredState = await secondEngine.get('missing-resolver-running-run');
    expect(recoveredState?.status).toBe('failed');
    expect(recoveredState?.error).toContain('resolveWorkflowServices');
    expect(recoveredState?.failureCategory).toBe('system');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.workflowId).toBe('missing-resolver-running-run');
    expect(warnings[0]!.message).toContain('resolveWorkflowServices');
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

  it('fails a recovered delayed-start run that expected services when no resolver is configured', async () => {
    const storage = new MemoryStorage();
    const clock = { now: 1_000 };
    const bodyRuns: string[] = [];
    const wf = workflow({ name: 'missing-resolver-delayed' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      bodyRuns.push('ran');
      return (ctx.services as { v: number }).v;
    });
    const firstEngine = await Engine.create({
      storage,
      recover: false,
      getNow: () => clock.now,
      workflows: { 'missing-resolver-delayed': wf },
    });
    await firstEngine.start('missing-resolver-delayed', null, {
      id: 'missing-resolver-delayed-run',
      services: { v: 1 },
      startAt: 2_000,
    });
    const pendingState = await firstEngine.get('missing-resolver-delayed-run');
    expect(pendingState?.status).toBe('pending');
    await firstEngine[Symbol.asyncDispose]();

    const secondEngine = await Engine.create({
      storage,
      recover: false,
      getNow: () => clock.now,
      workflows: { 'missing-resolver-delayed': wf },
    });
    const warnings: DevelopmentWarningEvent[] = [];
    secondEngine.addEventListener(DevelopmentWarningEvent.type, (event) => {
      warnings.push(event);
    });

    await secondEngine.recoverAll();
    await tickEngine(secondEngine, clock, 2_000);
    await flush();

    const delayedState = await secondEngine.get('missing-resolver-delayed-run');
    expect(delayedState?.status).toBe('failed');
    expect(delayedState?.error).toContain('resolveWorkflowServices');
    expect(delayedState?.failureCategory).toBe('system');
    expect(bodyRuns).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.workflowId).toBe('missing-resolver-delayed-run');
    expect(warnings[0]!.message).toContain('resolveWorkflowServices');
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

  it('deletes durable schedule-run metadata on purge', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage });
    const wf = workflow({ name: 'purge-schedule-metadata-wf' }).execute(async function* () {
      return 'done';
    });
    engine.register(wf);

    const handle = await engine.start('purge-schedule-metadata-wf', null, {
      id: 'purge-schedule-metadata-run',
    });
    await handle.result();
    await flush();
    await storage.put(
      KEYS.scheduleRun('purge-schedule-metadata-run'),
      encode({ id: 'purge-schedule-metadata', occurrence: 1_767_225_600_000 }),
    );

    const purged = await engine.purge();
    expect(purged.deleted).toBeGreaterThanOrEqual(1);
    expect(await storage.get(KEYS.scheduleRun('purge-schedule-metadata-run'))).toBeNull();
    await engine[Symbol.asyncDispose]();
  });

  it('deletes durable schedule-run metadata during retention sweep', async () => {
    const storage = new MemoryStorage();
    const engine = new Engine({ storage, retention: { completed: 0 } });
    const wf = workflow({ name: 'retention-schedule-metadata-wf' }).execute(async function* () {
      return 'done';
    });
    engine.register(wf);

    const handle = await engine.start('retention-schedule-metadata-wf', null, {
      id: 'retention-schedule-metadata-run',
    });
    await handle.result();
    await flush();
    await storage.put(
      KEYS.scheduleRun('retention-schedule-metadata-run'),
      encode({ id: 'retention-schedule-metadata', occurrence: 1_767_225_600_000 }),
    );

    await runRetentionSweep(
      getInternals(engine),
      () => {},
      () => {},
    );

    expect(await storage.get(KEYS.scheduleRun('retention-schedule-metadata-run'))).toBeNull();
    await engine[Symbol.asyncDispose]();
  });
});

describe('ctx.services — scheduled workflow (engine.schedule)', () => {
  it('provides resolved services to a scheduled workflow occurrence via resolveWorkflowServices', async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const results: string[] = [];
    let resolverCalls = 0;
    const resolverContext: unknown[] = [];

    const engine = new Engine({
      storage: new MemoryStorage(),
      getNow: () => clock.now,
      resolveWorkflowServices: (info) => {
        resolverCalls++;
        resolverContext.push({
          launchOptions: info.launchOptions,
          schedule: info.schedule,
        });
        return { status: 'available' as const, services: { generate: () => 'from-resolver' } };
      },
    });

    const wf = workflow({ name: 'scheduled-with-services' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const services = ctx.services as { generate: () => string };
      const value = services.generate();
      results.push(value);
      return value;
    });
    engine.register(wf);

    const handle = await engine.schedule('scheduled-with-services', null, '* * * * *', {
      id: 'scheduled-services',
    });
    const description = await handle.describe();
    expect(description.nextFireAt).not.toBeNull();

    await tickEngine(engine, clock, description.nextFireAt!);

    // Condition wait rather than a fixed event-loop settle: the inline launch drain
    // is a macrotask, so the body's output is not guaranteed on a fixed number of
    // turns. Wait for it explicitly to keep the test load-insensitive.
    await waitForCondition(() => results.length > 0, { label: 'scheduled occurrence body' });
    expect(resolverCalls).toBeGreaterThanOrEqual(1);
    expect(resolverContext[0]).toEqual({
      launchOptions: expect.objectContaining({ id: expect.any(String) }),
      schedule: { id: 'scheduled-services', occurrence: description.nextFireAt },
    });
    expect(results).toEqual(['from-resolver']);
    await engine[Symbol.asyncDispose]();
  });

  for (const overlap of ['skip', 'cancel-running', 'allow'] as const satisfies readonly Exclude<
    ScheduleOverlapPolicy,
    'queue'
  >[]) {
    it(`re-provides schedule resolver context across recovery for ${overlap} overlap`, async () => {
      const storage = new MemoryStorage();
      const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
      const liveScheduleContexts: unknown[] = [];

      const workflowType = `scheduled-recovery-${overlap}`;
      const scheduleId = `${workflowType}-schedule`;
      const wf = workflow({ name: workflowType }).execute(async function* (ctx: WorkflowContext) {
        const services = ctx.services as { source: string };
        yield* ctx.waitForSignal('release');
        return services.source;
      });

      const firstEngine = await Engine.create({
        storage,
        recover: false,
        getNow: () => clock.now,
        workflows: { [workflowType]: wf },
        resolveWorkflowServices: (info) => {
          liveScheduleContexts.push(info.schedule);
          return { status: 'available', services: { source: 'first-engine' } };
        },
      });

      const schedule = await firstEngine.schedule(
        workflowType,
        null,
        { every: '1m' },
        { id: scheduleId, overlap },
      );
      const description = await schedule.describe();
      const occurrence = description.nextFireAt!;

      await tickEngine(firstEngine, clock, occurrence);
      await flush();
      expect(liveScheduleContexts).toEqual([{ id: scheduleId, occurrence }]);
      await firstEngine[Symbol.asyncDispose]();

      const recoveredScheduleContexts: unknown[] = [];
      const secondEngine = await Engine.create({
        storage,
        recover: false,
        getNow: () => clock.now,
        workflows: { [workflowType]: wf },
        resolveWorkflowServices: (info) => {
          recoveredScheduleContexts.push(info.schedule);
          return { status: 'available', services: { source: 'second-engine' } };
        },
      });

      const handles = await secondEngine.recoverAll();
      expect(handles).toHaveLength(1);
      expect(recoveredScheduleContexts).toEqual([{ id: scheduleId, occurrence }]);
      await handles[0]!.signal('release');
      expect(await handles[0]!.result()).toBe('second-engine');
      await secondEngine[Symbol.asyncDispose]();
    });
  }

  it('re-provides queued-drain schedule context with no occurrence across recovery', async () => {
    const storage = new MemoryStorage();
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const liveScheduleContexts: unknown[] = [];

    const wf = workflow({ name: 'scheduled-queue-drain-recovery' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const services = ctx.services as { source: string };
      yield* ctx.waitForSignal('release');
      return services.source;
    });

    const firstEngine = await Engine.create({
      storage,
      recover: false,
      getNow: () => clock.now,
      workflows: { 'scheduled-queue-drain-recovery': wf },
      resolveWorkflowServices: (info) => {
        liveScheduleContexts.push(info.schedule);
        return { status: 'available', services: { source: 'first-engine' } };
      },
    });

    const schedule = await firstEngine.schedule(
      'scheduled-queue-drain-recovery',
      null,
      { every: '1m' },
      { id: 'scheduled-queue-drain-recovery-schedule', overlap: 'queue' },
    );
    const firstDescription = await schedule.describe();
    await tickEngine(firstEngine, clock, firstDescription.nextFireAt!);
    const secondDescription = await schedule.describe();
    await tickEngine(firstEngine, clock, secondDescription.nextFireAt!);

    const runningRuns = await firstEngine.list({ status: 'running' });
    const firstRun = runningRuns.items[0]!;
    await firstEngine.signal(firstRun.id, 'release');
    await waitForCondition(() => liveScheduleContexts.length === 2, {
      label: 'queued scheduled run drains',
    });
    expect(liveScheduleContexts[1]).toEqual({ id: 'scheduled-queue-drain-recovery-schedule' });
    await firstEngine[Symbol.asyncDispose]();

    const recoveredScheduleContexts: unknown[] = [];
    const secondEngine = await Engine.create({
      storage,
      recover: false,
      getNow: () => clock.now,
      workflows: { 'scheduled-queue-drain-recovery': wf },
      resolveWorkflowServices: (info) => {
        recoveredScheduleContexts.push(info.schedule);
        return { status: 'available', services: { source: 'second-engine' } };
      },
    });

    const handles = await secondEngine.recoverAll();
    expect(handles).toHaveLength(1);
    expect(recoveredScheduleContexts).toEqual([{ id: 'scheduled-queue-drain-recovery-schedule' }]);
    await handles[0]!.signal('release');
    expect(await handles[0]!.result()).toBe('second-engine');
    await secondEngine[Symbol.asyncDispose]();
  });

  it('recovers historical scheduled runs without schedule context when no metadata exists', async () => {
    const storage = new MemoryStorage();
    const wf = workflow({ name: 'historical-scheduled-services' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.waitForSignal('release');
      return (ctx.services as { source: string }).source;
    });
    const firstEngine = await Engine.create({
      storage,
      recover: false,
      workflows: { 'historical-scheduled-services': wf },
    });
    await firstEngine.start('historical-scheduled-services', null, {
      id: 'historical-scheduled-services-run',
      services: { source: 'first-engine' },
    });
    await flush();
    await firstEngine[Symbol.asyncDispose]();

    const recoveredScheduleContexts: unknown[] = [];
    const secondEngine = await Engine.create({
      storage,
      recover: false,
      workflows: { 'historical-scheduled-services': wf },
      resolveWorkflowServices: (info) => {
        recoveredScheduleContexts.push(info.schedule);
        return { status: 'available', services: { source: 'second-engine' } };
      },
    });

    const handles = await secondEngine.recoverAll();
    expect(handles).toHaveLength(1);
    expect(recoveredScheduleContexts).toEqual([undefined]);
    await handles[0]!.signal('release');
    expect(await handles[0]!.result()).toBe('second-engine');
    await secondEngine[Symbol.asyncDispose]();
  });

  it('fails only the occurrence when the resolver returns unavailable — schedule stays active', async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    let callCount = 0;

    const engine = new Engine({
      storage: new MemoryStorage(),
      getNow: () => clock.now,
      resolveWorkflowServices: () => {
        callCount++;
        if (callCount === 1) {
          return { status: 'unavailable' as const, reason: 'first-call-unavailable' };
        }
        return { status: 'available' as const, services: { generate: () => 'recovered' } };
      },
    });

    const results: string[] = [];
    const wf = workflow({ name: 'scheduled-unavailable' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      // Push an observable sentinel BEFORE any services dereference. If the body
      // runs at all (the race lost), 'body-ran' lands even though the subsequent
      // `services.generate()` would throw on undefined — so the length assertion
      // below genuinely catches body execution, not just a body crash.
      results.push('body-ran');
      const services = ctx.services as { generate: () => string };
      results.push(services.generate());
      return 'ok';
    });
    engine.register(wf);

    const schedule = await engine.schedule('scheduled-unavailable', null, '* * * * *');
    const firstDescription = await schedule.describe();

    // First occurrence: resolver unavailable → run fails, schedule stays active.
    await tickEngine(engine, clock, firstDescription.nextFireAt!);
    await flush();

    const scheduleAfterFirst = await schedule.describe();
    expect(scheduleAfterFirst.status).toBe('active');

    // The body must NEVER run on the unavailable path. startScheduledRun starts the
    // run (queuing its inline launch) then awaits failWorkflow; failWorkflow commits
    // 'failed' on the awaited microtask continuation, before the macrotask-scheduled
    // launch drain reads the status gate (inline-launch-queue: status !== 'running'
    // skips the body). The 'body-ran' sentinel never appearing is the direct proof
    // the launch-vs-fail ordering closes the race. The ONLY interleaving that would
    // invalidate this is `startWorkflow` synchronously draining the inline launch
    // queue before it returns; it does not (beginExecutionAwaitingLiveness only
    // enqueues for a non-`defer:false` start and a scheduled run never passes
    // `defer:false`), so this assertion guards that. (The error/category assertions
    // below are the second regression layer: a removed failWorkflow lets the body
    // run and throw a TypeError with category 'application', not 'system'.)
    expect(results).toHaveLength(0);

    // Find the failed workflow run from the first occurrence and assert it failed
    // via the intended unavailableServicesError path, not an incidental body crash.
    const failedRuns = await engine.list({ status: 'failed' });
    expect(failedRuns.items).toHaveLength(1);
    expect(failedRuns.items[0]!.status).toBe('failed');

    // Pin the fault: engine.get returns the full WorkflowState including error and
    // failureCategory, which are absent from the WorkflowSummary returned by list().
    // A regression that removed the failWorkflow call would let the body run with
    // ctx.services === undefined → TypeError, producing a different error message
    // and category ('application' for a body throw, not 'system').
    const failedState = await engine.get(failedRuns.items[0]!.id);
    expect(failedState).toBeDefined();
    expect(failedState!.error).toContain('services unavailable');
    expect(failedState!.failureCategory).toBe('system');

    // Second occurrence: resolver available → run completes successfully. The body
    // pushes its 'body-ran' sentinel, then the resolved service's 'recovered' value.
    const secondDescription = await schedule.describe();
    await tickEngine(engine, clock, secondDescription.nextFireAt!);
    await waitForCondition(() => results.includes('recovered'), {
      label: 'second occurrence body',
    });

    expect(results).toEqual(['body-ran', 'recovered']);
    await engine[Symbol.asyncDispose]();
  });

  it('coerces a resolver that THROWS to unavailable — occurrence fails (system), schedule stays active', async () => {
    // resolveScheduledRunServices wraps the resolver in try/catch and coerces a
    // throw to { status: 'unavailable' } so one bad occurrence cannot escape into
    // the schedule timer's error boundary and pause the whole schedule.
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };

    const engine = new Engine({
      storage: new MemoryStorage(),
      getNow: () => clock.now,
      resolveWorkflowServices: () => {
        throw new Error('resolver-exploded');
      },
    });

    const results: string[] = [];
    const wf = workflow({ name: 'scheduled-resolver-throws' }).execute(async function* () {
      results.push('body-ran');
      return 'ok';
    });
    engine.register(wf);

    const schedule = await engine.schedule('scheduled-resolver-throws', null, '* * * * *');
    const description = await schedule.describe();
    await tickEngine(engine, clock, description.nextFireAt!);
    await flush();

    // The body must never run; the occurrence fails via the unavailable path.
    expect(results).toHaveLength(0);
    const failed = await engine.list({ status: 'failed' });
    expect(failed.items).toHaveLength(1);
    const state = await engine.get(failed.items[0]!.id);
    expect(state!.error).toContain('services unavailable');
    expect(state!.failureCategory).toBe('system');

    // The resolver throw is contained: the schedule itself stays active.
    const scheduleAfterThrow = await schedule.describe();
    expect(scheduleAfterThrow.status).toBe('active');
    await engine[Symbol.asyncDispose]();
  });

  it('fails a recovered scheduled occurrence that expected services when no resolver is configured', async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const storage = new MemoryStorage();
    const results: string[] = [];

    const wf = workflow({ name: 'scheduled-recovery-services' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const services = ctx.services as { generate: () => string };
      results.push(services.generate());
      yield* ctx.waitForSignal('continue');
      return 'done';
    });

    const firstEngine = new Engine({
      storage,
      getNow: () => clock.now,
      resolveWorkflowServices: () => ({
        status: 'available' as const,
        services: { generate: () => 'from-first-engine' },
      }),
    });
    firstEngine.register(wf);

    const schedule = await firstEngine.schedule('scheduled-recovery-services', null, '* * * * *');
    const firstDescription = await schedule.describe();
    await tickEngine(firstEngine, clock, firstDescription.nextFireAt!);
    await waitForCondition(() => results.length === 1, {
      label: 'scheduled occurrence waiting on signal',
    });

    const runningDescription = await schedule.describe();
    const runningOccurrenceId = runningDescription.currentWorkflowId;
    if (runningOccurrenceId === undefined) {
      throw new Error('Expected scheduled occurrence to be running before recovery');
    }
    await firstEngine[Symbol.asyncDispose]();

    const secondEngine = new Engine({
      storage,
      getNow: () => clock.now,
    });
    secondEngine.register(wf);
    const warnings: DevelopmentWarningEvent[] = [];
    secondEngine.addEventListener(DevelopmentWarningEvent.type, (event) => {
      warnings.push(event);
    });

    await secondEngine.recoverAll();
    await flush();

    const recoveredState = await secondEngine.get(runningOccurrenceId);
    expect(recoveredState?.status).toBe('failed');
    expect(recoveredState?.error).toContain('resolveWorkflowServices');
    expect(recoveredState?.failureCategory).toBe('system');
    expect(await storage.get(KEYS.scheduleRun(runningOccurrenceId))).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.workflowId).toBe(runningOccurrenceId);
    expect(warnings[0]!.message).toContain('resolveWorkflowServices');
    await secondEngine[Symbol.asyncDispose]();
  });

  it('a scheduled workflow that does not use services still works when a resolver is configured', async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    let resolverCalls = 0;
    const executions: string[] = [];

    const engine = new Engine({
      storage: new MemoryStorage(),
      getNow: () => clock.now,
      resolveWorkflowServices: () => {
        resolverCalls++;
        return { status: 'available' as const, services: { tag: 'resolver-tag' } };
      },
    });

    const wf = workflow({ name: 'scheduled-no-services' }).execute(async function* (
      _ctx: WorkflowContext,
    ) {
      executions.push('ran');
      return 'done';
    });
    engine.register(wf);

    const schedule = await engine.schedule('scheduled-no-services', null, '* * * * *');
    const description = await schedule.describe();

    await tickEngine(engine, clock, description.nextFireAt!);
    await flush();

    expect(executions).toEqual(['ran']);
    // Resolver consulted because a resolver is configured for this inline engine.
    expect(resolverCalls).toBeGreaterThanOrEqual(1);
    await engine[Symbol.asyncDispose]();
  });

  it('does not consult the resolver for scheduled workflows when none is configured', async () => {
    // Regression: scheduled runs must still work on an engine with no resolver.
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const executions: string[] = [];

    const engine = new Engine({
      storage: new MemoryStorage(),
      getNow: () => clock.now,
      // No resolveWorkflowServices.
    });

    const wf = workflow({ name: 'scheduled-plain' }).execute(async function* () {
      executions.push('ran');
      return 'done';
    });
    engine.register(wf);

    const schedule = await engine.schedule('scheduled-plain', null, '* * * * *');
    const description = await schedule.describe();

    await tickEngine(engine, clock, description.nextFireAt!);
    await flush();

    expect(executions).toEqual(['ran']);
    await engine[Symbol.asyncDispose]();
  });

  it('writes and sweeps the workflowHasServices marker on terminal cleanup when the resolver is configured', async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 0, 0, 0) };
    const storage = new MemoryStorage();
    let firstWorkflowId: string | undefined;

    const engine = new Engine({
      storage,
      getNow: () => clock.now,
      resolveWorkflowServices: ({ workflowId }) => {
        // Pin to the first occurrence only; later occurrences must not overwrite.
        firstWorkflowId ??= workflowId;
        return { status: 'available' as const, services: { v: 1 } };
      },
    });

    const wf = workflow({ name: 'scheduled-marker' }).execute(async function* () {
      return 'ok';
    });
    engine.register(wf);

    const schedule = await engine.schedule('scheduled-marker', null, '* * * * *');
    const description = await schedule.describe();

    // Fire the first occurrence and let it complete.
    await tickEngine(engine, clock, description.nextFireAt!);
    await flush();
    expect(firstWorkflowId).toBeDefined();

    // Positive presence check: marker must have been written before any sweep fires.
    // Without this assertion a regression that never wrote the marker would still pass
    // the toBeNull check below (null === null vacuously).
    expect(await storage.get(KEYS.workflowHasServices(firstWorkflowId!))).not.toBeNull();

    // Pause the schedule so that advancing time to fire the cleanup timer does not
    // spawn new occurrences and race with the marker we are asserting on.
    await schedule.pause();

    // Marker is written at workflow creation time; after terminal cleanup it is swept.
    // Advance past the 60-second TERMINAL_CLEANUP_DELAY_MS to let the cleanup timer fire.
    await engine.scheduler.tick(clock.now + 90_000);
    expect(await storage.get(KEYS.workflowHasServices(firstWorkflowId!))).toBeNull();
    await engine[Symbol.asyncDispose]();
  });
});

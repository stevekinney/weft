import { describe, expect, it } from 'bun:test';
import { sleepForTesting } from '../../testing/fake-timers.test-support.ts';

import { KEYS } from '../../storage/interface.ts';
import { TestEngine } from '../../testing/test-engine.ts';
import { ActivityRegistry } from '../activity-registry.ts';
import { deserializeCheckpoint } from '../checkpoint.ts';
import { decode } from '../codec.ts';
import { copyWorkflowDefinition } from '../engine/construction.ts';
import { buildRegistrationEntry } from '../engine/registration.ts';
import { WorkflowRevisionUnavailableError } from '../engine/revision-errors.ts';
import { WorkflowCompletedEvent, WorkflowStartedEvent } from '../events.ts';
import { buildWorkflowManifestFromDefinition } from '../registry-workflow-manifest.ts';
import { workflowSource } from '../source/index.ts';
import { activity, workflow, type WorkflowContext, type WorkflowDefinition } from '../types.ts';
import { VersionMismatchError } from '../versioning.ts';

async function waitForCheckpointStep(
  engine: TestEngine,
  workflowId: string,
  step: number,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const checkpoints = await engine.listCheckpoints(workflowId);
    if (checkpoints.some((checkpoint) => checkpoint.step === step)) {
      return;
    }
    await sleepForTesting(10);
  }

  throw new Error(`Checkpoint step ${step} was not recorded for workflow "${workflowId}"`);
}

describe('workflow forking', () => {
  it('forks a running workflow and lets the two workflows diverge independently', async () => {
    const engine = new TestEngine();

    engine.register(
      workflow({ name: 'choose-branch' }).execute(async function* (
        ctx: WorkflowContext,
        input: unknown,
      ) {
        const durableContext = ctx;
        const branch = yield* durableContext.waitForSignal('branch');
        const typedInput = input as { label: string };
        return `${typedInput.label}:${String(branch)}`;
      }),
    );

    const original = await engine.start('choose-branch', { label: 'base' }, { id: 'wf-original' });
    const forked = await engine.fork(original.id);

    await engine.signal(original.id, 'branch', 'left');
    await engine.signal(forked.id, 'branch', 'right');

    await expect(original.result()).resolves.toBe('base:left');
    await expect(forked.result()).resolves.toBe('base:right');

    const forkedState = await engine.get(forked.id);
    expect(forkedState).not.toBeNull();
    expect(forkedState).toMatchObject({
      forkedFrom: {
        workflowId: original.id,
      },
    });
    expect(typeof forkedState?.forkedFrom?.step).toBe('number');

    const descendants = await engine.list({
      attributes: [{ key: 'weft:forkedFrom', value: original.id }],
    });
    expect(descendants.items.map((item) => item.id)).toContain(forked.id);

    engine[Symbol.dispose]();
  });

  it('forks from a historical checkpoint without rerunning already completed work', async () => {
    const engine = new TestEngine();
    const executedStages: string[] = [];

    const recordStage = activity({
      name: 'recordStage',
      execute: async (stage: unknown) => {
        const typedStage = String(stage);
        executedStages.push(typedStage);
        return typedStage;
      },
    });

    engine.register(
      workflow({ name: 'historical-fork' }).execute(async function* (ctx: WorkflowContext) {
        const durableContext = ctx;
        const first = yield* durableContext.run(recordStage, 'first');
        const second = yield* durableContext.run(recordStage, 'second');
        yield* durableContext.waitForSignal('hold');
        yield* durableContext.waitForSignal('continue');
        return `${first}:${second}`;
      }),
    );

    const original = await engine.start('historical-fork', null, { id: 'wf-historical' });
    await engine.signal(original.id, 'hold');
    await waitForCheckpointStep(engine, original.id, 4);

    const forked = await engine.fork(original.id, { fromStep: 3 });
    await engine.signal(forked.id, 'hold');
    await engine.signal(forked.id, 'continue');

    await expect(forked.result()).resolves.toBe('first:second');
    expect(executedStages).toEqual(['first', 'second']);

    const forkedState = await engine.get(forked.id);
    expect(forkedState).not.toBeNull();
    expect(forkedState).toMatchObject({
      forkedFrom: {
        workflowId: original.id,
        step: 3,
      },
    });

    await engine.signal(original.id, 'continue');
    await expect(original.result()).resolves.toBe('first:second');

    engine[Symbol.dispose]();
  });

  it('refreshes fork checkpoint timestamps so resumed sleeps use the fork time', async () => {
    const engine = new TestEngine({ startTime: 1_000 });

    engine.register(
      workflow({ name: 'fork-sleep-reference' }).execute(async function* (ctx: WorkflowContext) {
        const durableContext = ctx;
        yield* durableContext.waitForSignal('continue');
        yield* durableContext.sleep('1 hour');
        return 'done';
      }),
    );

    const original = await engine.start('fork-sleep-reference', null, { id: 'wf-sleep-root' });
    const originalResult = original.result();
    const sourceCheckpointBytes = await engine.storage.get(KEYS.checkpoint(original.id));
    expect(sourceCheckpointBytes).not.toBeNull();
    const sourceCheckpoint = deserializeCheckpoint(sourceCheckpointBytes!);

    await engine.advanceTime('2 hours');

    const forked = await engine.fork(original.id);
    const forkCheckpointBytes = await engine.storage.get(KEYS.checkpoint(forked.id));
    expect(forkCheckpointBytes).not.toBeNull();
    const forkCheckpoint = deserializeCheckpoint(forkCheckpointBytes!);

    expect(forkCheckpoint.createdAt).toBe(engine.now);
    expect(forkCheckpoint.createdAt).toBeGreaterThan(sourceCheckpoint.createdAt);

    await engine.signal(forked.id, 'continue');
    await sleepForTesting(0);

    const forkedStateBeforeFinalAdvance = await engine.get(forked.id);
    expect(forkedStateBeforeFinalAdvance?.status).toBe('running');

    await engine.advanceTime('59 minutes');
    const forkedStateBeforeTimerFires = await engine.get(forked.id);
    expect(forkedStateBeforeTimerFires?.status).toBe('running');

    await engine.advanceTime('1 minute');
    await expect(forked.result()).resolves.toBe('done');

    await engine.cancel(original.id);
    await expect(originalResult).rejects.toThrow('Workflow cancelled');
    engine[Symbol.dispose]();
  });

  it('forks a completed workflow from its latest checkpoint and reruns only the terminal step', async () => {
    const engine = new TestEngine();
    const executedStages: string[] = [];
    const terminalSummaries: string[] = [];

    const recordStage = activity({
      name: 'recordTerminalStage',
      execute: async (stage: unknown) => {
        const typedStage = String(stage);
        executedStages.push(typedStage);
        return `${typedStage}-done`;
      },
    });

    engine.register(
      workflow({ name: 'completed-fork' }).execute(async function* (
        ctx: WorkflowContext,
        input: unknown,
      ) {
        const durableContext = ctx;
        const stage = yield* durableContext.run(recordStage, 'prepare');
        const typedInput = String(input);
        return yield* durableContext.memo('terminal-summary', () => {
          terminalSummaries.push(typedInput);
          return `${typedInput}:${stage}`;
        });
      }),
    );

    const original = await engine.start('completed-fork', 'original', { id: 'wf-completed' });
    await expect(original.result()).resolves.toBe('original:prepare-done');
    expect(executedStages).toEqual(['prepare']);
    expect(terminalSummaries).toEqual(['original']);

    const forked = await engine.fork(original.id);
    await expect(forked.result()).resolves.toBe('original:prepare-done');
    expect(executedStages).toEqual(['prepare']);
    expect(terminalSummaries).toEqual(['original', 'original']);

    engine[Symbol.dispose]();
  });

  it('dispatches workflow started before workflow completed for completed workflow forks', async () => {
    const engine = new TestEngine();
    const observedEvents: Array<{ type: string; workflowId: string }> = [];

    engine.addEventListener(WorkflowStartedEvent.type, (event) => {
      observedEvents.push({
        type: event.type,
        workflowId: event.workflowId,
      });
    });
    engine.addEventListener(WorkflowCompletedEvent.type, (event) => {
      observedEvents.push({
        type: event.type,
        workflowId: event.workflowId,
      });
    });

    engine.register(
      workflow({ name: 'completed-ordering' }).execute(async function* () {
        return 'done';
      }),
    );

    const original = await engine.start('completed-ordering', null, { id: 'wf-order-root' });
    await expect(original.result()).resolves.toBe('done');

    const forked = await engine.fork(original.id);
    await expect(forked.result()).resolves.toBe('done');

    const forkedEvents = observedEvents
      .filter((event) => event.workflowId === forked.id)
      .map((event) => event.type);
    expect(forkedEvents).toEqual(['workflow:started', 'workflow:completed']);

    engine[Symbol.dispose]();
  });

  it('records lineage chains across multiple forks', async () => {
    const engine = new TestEngine();

    engine.register(
      workflow({ name: 'lineage-fork' }).execute(async function* (
        _ctx: WorkflowContext,
        input: unknown,
      ) {
        return String(input);
      }),
    );

    const original = await engine.start('lineage-fork', 'root', { id: 'wf-root' });
    await original.result();

    const firstFork = await engine.fork(original.id);
    await firstFork.result();

    const secondFork = await engine.fork(firstFork.id);
    await secondFork.result();

    const firstForkState = await engine.get(firstFork.id);
    const secondForkState = await engine.get(secondFork.id);

    expect(firstForkState).toMatchObject({
      forkedFrom: {
        workflowId: original.id,
      },
    });
    expect(secondForkState).toMatchObject({
      forkedFrom: {
        workflowId: firstFork.id,
      },
    });

    const firstGeneration = await engine.list({
      attributes: [{ key: 'weft:forkedFrom', value: original.id }],
    });
    expect(firstGeneration.items.map((item) => item.id)).toContain(firstFork.id);

    const secondGeneration = await engine.list({
      attributes: [{ key: 'weft:forkedFrom', value: firstFork.id }],
    });
    expect(secondGeneration.items.map((item) => item.id)).toContain(secondFork.id);

    engine[Symbol.dispose]();
  });

  it('keeps fork lineage queryable after cancellation', async () => {
    const engine = new TestEngine();

    engine.register(
      workflow({ name: 'cancelled-fork' }).execute(async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('continue');
        return 'done';
      }),
    );

    const original = await engine.start('cancelled-fork', null, { id: 'wf-cancel-root' });
    const forked = await engine.fork(original.id);
    const forkedResult = forked.result();
    const originalResult = original.result();

    await engine.cancel(forked.id);

    const descendants = await engine.list({
      attributes: [{ key: 'weft:forkedFrom', value: original.id }],
    });
    expect(descendants.items.map((item) => item.id)).toContain(forked.id);

    await engine.cancel(original.id);
    await expect(forkedResult).rejects.toThrow('Workflow cancelled');
    await expect(originalResult).rejects.toThrow('Workflow cancelled');
    engine[Symbol.dispose]();
  });

  it('preserves persisted workflow start headers on forked workflows', async () => {
    const engine = new TestEngine();
    const capturedParentHeaders: Map<string, string>[] = [];

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

    engine.register(
      workflow({ name: 'child' }).execute(async function* () {
        return 'child-complete';
      }),
    );

    engine.register(
      workflow({ name: 'parent-with-headers' }).execute(async function* (ctx: WorkflowContext) {
        const durableContext = ctx;
        yield* durableContext.waitForSignal('continue');
        return yield* durableContext.startChild<string>('child', null);
      }),
    );

    const original = await engine.start('parent-with-headers', null, { id: 'wf-header-root' });
    const forked = await engine.fork(original.id);
    const originalResult = original.result();

    const headerBytes = await engine.storage.get(KEYS.workflowHeaders(forked.id));
    expect(headerBytes).not.toBeNull();
    const persistedHeaders = new Map(decode(headerBytes!) as Array<[string, string]>);
    expect(persistedHeaders.get('traceparent')).toBe(
      '00-abcd1234abcd1234abcd1234abcd1234-ef56ef56ef56ef56-01',
    );
    expect(persistedHeaders.get('tracestate')).toBe('vendor=value');
    expect(persistedHeaders.has('x-auth')).toBe(false);

    await engine.signal(forked.id, 'continue');
    await expect(forked.result()).resolves.toBe('child-complete');
    expect(capturedParentHeaders).toHaveLength(1);
    expect(capturedParentHeaders[0]?.get('traceparent')).toBe(
      '00-abcd1234abcd1234abcd1234abcd1234-ef56ef56ef56ef56-01',
    );
    expect(capturedParentHeaders[0]?.get('tracestate')).toBe('vendor=value');
    expect(capturedParentHeaders[0]?.has('x-auth')).toBe(false);

    await engine.cancel(original.id);
    await expect(originalResult).rejects.toThrow('Workflow cancelled');
    engine[Symbol.dispose]();
  });

  it('preserves workflow function resolution for composition operators after a fork', async () => {
    const engine = new TestEngine();

    engine.register(
      workflow({ name: 'fork-child-function' }).execute(async function* (
        _ctx: WorkflowContext,
        input: unknown,
      ) {
        return Number(input) * 2;
      }),
    );
    engine.register(
      workflow({ name: 'fork-parent-composition' }).execute(async function* (ctx: WorkflowContext) {
        const durableContext = ctx;
        yield* durableContext.waitForSignal('continue');
        return yield* durableContext.map([1, 2], 'fork-child-function');
      }),
    );

    const original = await engine.start('fork-parent-composition', null, {
      id: 'wf-fork-composition-root',
    });
    const forked = await engine.fork(original.id);
    const originalResult = original.result();

    await engine.signal(forked.id, 'continue');
    await expect(forked.result()).resolves.toEqual([2, 4]);

    await engine.cancel(original.id);
    await expect(originalResult).rejects.toThrow('Workflow cancelled');
    engine[Symbol.dispose]();
  });
});

describe('fork revision handling (WFT-21)', () => {
  async function revisionFor(name: string, definition: WorkflowDefinition): Promise<string> {
    const entry = buildRegistrationEntry(name, definition);
    const registered = copyWorkflowDefinition(name, entry);
    const manifest = await buildWorkflowManifestFromDefinition(
      registered,
      new ActivityRegistry().listDefinitions(),
    );
    return manifest.revision;
  }

  it("acceptance criterion: default fork (no options.revision) after a later activation still resolves and persists the SOURCE run's original revision", async () => {
    const type = 'fork-revision-default';
    const definitionV1 = workflow({ name: type, description: 'v1' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.waitForSignal<string>('go');
    });
    const definitionV2 = workflow({ name: type, description: 'v2' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.waitForSignal<string>('go');
    });
    const revisionV1 = await revisionFor(type, definitionV1);
    const revisionV2 = await revisionFor(type, definitionV2);

    const engine = new TestEngine();
    engine.registerSource(
      workflowSource(
        { name: type, location: './v1.ts', exportName: 'v1', revision: revisionV1 },
        async () => ({ v1: definitionV1 }),
      ),
    );

    const original = await engine.start(type, null, { id: 'fork-revision-default-source' });
    const sourceState = await engine.get(original.id);
    expect(sourceState?.revision).toBe(revisionV1);

    // Register AND activate v2 as the catalog's current pointer — AFTER the
    // source run already started and pinned to v1.
    engine.registerSource(
      workflowSource(
        { name: type, location: './v2.ts', exportName: 'v2', revision: revisionV2 },
        async () => ({ v2: definitionV2 }),
      ),
    );
    await engine.resolveWorkflowSource(type, revisionV2);
    await engine.workflows.activate(type, revisionV2);

    const forked = await engine.fork(original.id);
    const forkedState = await engine.get(forked.id);
    expect(forkedState?.revision).toBe(revisionV1);

    await engine.signal(original.id, 'go', 'orig');
    await engine.signal(forked.id, 'go', 'forked');
    await expect(original.result()).resolves.toBe('orig');
    await expect(forked.result()).resolves.toBe('forked');
    engine[Symbol.dispose]();
  });

  it('engine.fork(id, { revision: v2 }) on a dynamic-source type with v1 and v2 both registered resolves and persists v2', async () => {
    const type = 'fork-revision-explicit';
    const definitionV1 = workflow({ name: type, description: 'v1' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.waitForSignal<string>('go');
    });
    const definitionV2 = workflow({ name: type, description: 'v2' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.waitForSignal<string>('go');
    });
    const revisionV1 = await revisionFor(type, definitionV1);
    const revisionV2 = await revisionFor(type, definitionV2);

    const engine = new TestEngine();
    engine.registerSource(
      workflowSource(
        { name: type, location: './v1.ts', exportName: 'v1', revision: revisionV1 },
        async () => ({ v1: definitionV1 }),
      ),
    );

    // v1 is the SOLE registered candidate at start time — unambiguous, so
    // this resolves and installs it without needing an active pointer.
    const original = await engine.start(type, null, { id: 'fork-revision-explicit-source' });
    const sourceSummary = await engine.get(original.id);
    expect(sourceSummary?.revision).toBe(revisionV1);

    // Register v2 as a SECOND candidate only after the source run already
    // pinned to v1 — the explicit fork request below resolves it directly.
    engine.registerSource(
      workflowSource(
        { name: type, location: './v2.ts', exportName: 'v2', revision: revisionV2 },
        async () => ({ v2: definitionV2 }),
      ),
    );

    const forked = await engine.fork(original.id, { revision: revisionV2 });
    const forkedState = await engine.get(forked.id);
    expect(forkedState?.revision).toBe(revisionV2);

    await engine.signal(original.id, 'go', 'orig');
    await engine.signal(forked.id, 'go', 'forked');
    await expect(original.result()).resolves.toBe('orig');
    await expect(forked.result()).resolves.toBe('forked');
    engine[Symbol.dispose]();
  });

  it('engine.fork(id, { revision: "unregistered" }) throws WorkflowRevisionUnavailableError with reason \'not-registered\' and creates no new workflow record', async () => {
    const type = 'fork-revision-unregistered';
    const definitionV1 = workflow({ name: type }).execute(async function* (ctx: WorkflowContext) {
      return yield* ctx.waitForSignal<string>('go');
    });
    const revisionV1 = await revisionFor(type, definitionV1);

    const engine = new TestEngine();
    engine.registerSource(
      workflowSource(
        { name: type, location: './v1.ts', exportName: 'v1', revision: revisionV1 },
        async () => ({ v1: definitionV1 }),
      ),
    );
    const original = await engine.start(type, null, { id: 'fork-revision-unregistered-source' });

    const before = await engine.list({ type });
    let thrown: unknown;
    try {
      await engine.fork(original.id, { revision: 'totally-unregistered-revision' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkflowRevisionUnavailableError);
    expect((thrown as WorkflowRevisionUnavailableError).reason).toBe('not-registered');
    const after = await engine.list({ type });
    // No partial write: the total run count for this type is unchanged.
    expect(after.items.length).toBe(before.items.length);

    await engine.signal(original.id, 'go', 'done');
    await expect(original.result()).resolves.toBe('done');
    engine[Symbol.dispose]();
  });

  it('the same explicit-revision request against an EAGER-registered type whose loaded revision differs throws the same error', async () => {
    const type = 'fork-revision-eager-mismatch';
    const engine = new TestEngine();
    engine.register(
      workflow({ name: type }).execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.waitForSignal<string>('go');
      }),
    );

    const original = await engine.start(type, null, { id: 'fork-revision-eager-source' });
    const eagerSourceSummary = await engine.get(original.id);
    const sourceRevision = eagerSourceSummary?.revision;
    expect(sourceRevision).toBeDefined();

    let thrown: unknown;
    try {
      await engine.fork(original.id, { revision: 'not-the-loaded-revision' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkflowRevisionUnavailableError);
    expect((thrown as WorkflowRevisionUnavailableError).reason).toBe('not-registered');

    await engine.signal(original.id, 'go', 'done');
    await expect(original.result()).resolves.toBe('done');
    engine[Symbol.dispose]();
  });

  it('an explicit-revision request against an EAGER-registered type that exactly matches the loaded revision resolves normally', async () => {
    const type = 'fork-revision-eager-match';
    const definition = workflow({ name: type }).execute(async function* (ctx: WorkflowContext) {
      return yield* ctx.waitForSignal<string>('go');
    });
    const sourceRevision = await revisionFor(type, definition);

    const engine = new TestEngine();
    engine.register(definition);

    const original = await engine.start(type, null, { id: 'fork-revision-eager-match-source' });
    const eagerSourceSummary = await engine.get(original.id);
    expect(eagerSourceSummary?.revision).toBe(sourceRevision);

    const forked = await engine.fork(original.id, { revision: sourceRevision });
    const forkedState = await engine.get(forked.id);
    expect(forkedState?.revision).toBe(sourceRevision);

    await engine.signal(original.id, 'go', 'orig');
    await engine.signal(forked.id, 'go', 'forked');
    await expect(original.result()).resolves.toBe('orig');
    await expect(forked.result()).resolves.toBe('forked');
    engine[Symbol.dispose]();
  });

  it('forking to a revision whose registered version is semver-incompatible with the source checkpoint throws VersionMismatchError', async () => {
    const type = 'fork-revision-incompatible';
    const definitionV1 = workflow({ name: type, version: '1.0.0' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.waitForSignal<string>('go');
    });
    const definitionV2 = workflow({ name: type, version: '2.0.0' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.waitForSignal<string>('go');
    });
    const revisionV1 = await revisionFor(type, definitionV1);
    const revisionV2 = await revisionFor(type, definitionV2);

    const engine = new TestEngine();
    engine.registerSource(
      workflowSource(
        { name: type, location: './v1.ts', exportName: 'v1', revision: revisionV1 },
        async () => ({ v1: definitionV1 }),
      ),
    );

    const original = await engine.start(type, null, {
      id: 'fork-revision-incompatible-source',
    });

    engine.registerSource(
      workflowSource(
        { name: type, location: './v2.ts', exportName: 'v2', revision: revisionV2 },
        async () => ({ v2: definitionV2 }),
      ),
    );

    await expect(engine.fork(original.id, { revision: revisionV2 })).rejects.toThrow(
      VersionMismatchError,
    );

    await engine.signal(original.id, 'go', 'done');
    await expect(original.result()).resolves.toBe('done');
    engine[Symbol.dispose]();
  });
});

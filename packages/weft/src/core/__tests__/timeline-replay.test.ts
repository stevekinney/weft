import { afterEach, describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { decode, encode } from '../codec.ts';
import { Engine } from '../engine.ts';
import { activity, workflow, type ActivityContext, type WorkflowContext } from '../types.ts';

async function waitForRaceLoss(_input: unknown, context?: ActivityContext): Promise<void> {
  if (context === undefined || context.signal.aborted) return;
  await new Promise<void>((resolve) => {
    context.signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

describe('timeline and replay', () => {
  let engine: Engine;

  afterEach(() => {
    engine[Symbol.dispose]();
  });

  it('acceptance criterion: engine.getTimeline(workflowId) returns structured timeline entries for each durable step', async () => {
    let now = 1_000;
    const storage = new MemoryStorage();

    async function loadOrder(input: unknown) {
      const { orderId } = input as { authorization: string; orderId: string };
      now += 25;
      return { accessToken: 'Bearer result-secret', orderId, status: 'loaded' as const };
    }

    async function chargeCard(input: unknown) {
      const { amount, orderId } = input as {
        amount: number;
        cardNumber: string;
        orderId: string;
      };
      now += 40;
      return { amount, cardNumber: '4111 1111 1111 1111', chargeId: 'pay-123', orderId };
    }

    engine = new Engine({ storage, checkpointHistory: 10, getNow: () => now });
    const checkoutWorkflow = workflow({ name: 'checkout', version: '2.0.0' }).execute(
      async function* (ctx: WorkflowContext) {
        const order = yield* ctx.run(loadOrder, {
          authorization: 'Bearer customer-secret',
          orderId: 'order-1',
        });
        return yield* ctx.run(chargeCard, {
          amount: 42,
          cardNumber: '4111111111111111',
          orderId: order.orderId,
        });
      },
    );
    engine.register(checkoutWorkflow);

    const handle = await engine.start('checkout', null, { id: 'wf-timeline' });
    await handle.result();

    const timeline = await engine.getTimeline('wf-timeline');

    expect(timeline).toHaveLength(2);
    expect(timeline[0]).toMatchObject({
      step: 1,
      operationType: 'activity',
      operationLabel: 'loadOrder',
      duration: 25,
      status: 'completed',
      versionTuple: { workflowVersion: '2.0.0' },
    });
    expect(timeline[0]?.inputSummary).toContain('"orderId":"order-1"');
    expect(timeline[0]?.inputSummary).toContain('"authorization":"[REDACTED]"');
    expect(timeline[0]?.outputSummary).toContain('"accessToken":"[REDACTED]"');
    expect(timeline[0]!.timestamp).toBe(1_000);

    expect(timeline[1]).toMatchObject({
      step: 2,
      operationType: 'activity',
      operationLabel: 'chargeCard',
      duration: 40,
      status: 'completed',
      versionTuple: { workflowVersion: '2.0.0' },
    });
    expect(timeline[1]?.inputSummary).toContain('"cardNumber":"[REDACTED]"');
    expect(timeline[1]?.outputSummary).toContain('"cardNumber":"[REDACTED]"');
  });

  it('records every activity retry attempt and retry backoff as separate durable entries', async () => {
    let attempts = 0;
    const retryingActivity = activity({
      name: 'retrying-activity',
      retry: {
        maxAttempts: 2,
        initialBackoff: 0,
        backoffMultiplier: 1,
        maxBackoff: 0,
      },
      execute: async () => {
        attempts++;
        if (attempts === 1) throw new Error('retry me');
        return 'completed';
      },
    });
    const retryWorkflow = workflow({ name: 'timeline-retry' })
      .activities({ 'retrying-activity': retryingActivity })
      .execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.run(retryingActivity);
      });
    const storage = new MemoryStorage();
    engine = new Engine({ storage });
    engine.register(retryWorkflow);

    const handle = await engine.start('timeline-retry', null, { id: 'wf-timeline-retry' });
    await expect(handle.result()).resolves.toBe('completed');

    const initialTimeline = await engine.getTimeline(handle.id);
    expect(
      initialTimeline.map((entry) => ({
        label: entry.operationLabel,
        status: entry.status,
        type: entry.operationType,
      })),
    ).toEqual([
      { label: 'retrying-activity', status: 'failed', type: 'activity' },
      { label: 'sleep', status: 'completed', type: 'sleep' },
      { label: 'retrying-activity', status: 'completed', type: 'activity' },
    ]);

    engine[Symbol.dispose]();
    engine = new Engine({ storage });
    const recoveredTimeline = await engine.getTimeline(handle.id);
    expect(
      recoveredTimeline.map((entry) => ({
        label: entry.operationLabel,
        status: entry.status,
        type: entry.operationType,
      })),
    ).toEqual([
      { label: 'retrying-activity', status: 'failed', type: 'activity' },
      { label: 'sleep', status: 'completed', type: 'sleep' },
      { label: 'retrying-activity', status: 'completed', type: 'activity' },
    ]);
  });

  it('records bounded metadata-only branch details for all, runAll, and keyed and positional race', async () => {
    const first = async () => ({ secret: 'first-result' });
    const second = async () => ({ secret: 'second-result' });
    const storage = new MemoryStorage();
    engine = new Engine({ storage });
    engine.register(
      workflow({ name: 'timeline-coordinators' })
        .activities({ first, second, waitForRaceLoss })
        .execute(async function* (ctx: WorkflowContext) {
          yield* ctx.all([ctx.run('first'), ctx.run('second')]);
          yield* ctx.runAll({ firstNamed: [first], secondNamed: [second] });
          yield* ctx.race([ctx.run('first'), ctx.run('waitForRaceLoss')]);
          return yield* ctx.raceKeyed({
            winner: ctx.run('second'),
            loser: ctx.run('waitForRaceLoss'),
          });
        }),
    );

    const handle = await engine.start('timeline-coordinators', null, {
      id: 'wf-timeline-coordinators',
    });
    await handle.result();
    const timeline = await engine.getTimeline(handle.id);

    expect(timeline[0]?.branches).toEqual([
      expect.objectContaining({ index: 0, outcome: 'fulfilled', operationLabel: 'first' }),
      expect.objectContaining({ index: 1, outcome: 'fulfilled', operationLabel: 'second' }),
    ]);
    expect(timeline[1]?.branches).toEqual([
      expect.objectContaining({ index: 0, key: 'firstNamed', outcome: 'fulfilled' }),
      expect.objectContaining({ index: 1, key: 'secondNamed', outcome: 'fulfilled' }),
    ]);
    expect(timeline[2]?.branches).toEqual([
      expect.objectContaining({ index: 0, outcome: 'won', operationLabel: 'first' }),
      expect.objectContaining({ index: 1, outcome: 'lost', operationLabel: 'waitForRaceLoss' }),
    ]);
    expect(timeline[3]?.branches).toEqual([
      expect.objectContaining({ index: 0, key: 'winner', outcome: 'won' }),
      expect.objectContaining({ index: 1, key: 'loser', outcome: 'lost' }),
    ]);
    expect(JSON.stringify(timeline.flatMap((entry) => entry.branches ?? []))).not.toContain(
      'first-result',
    );

    engine[Symbol.dispose]();
    engine = new Engine({ storage });
    expect(await engine.getTimeline(handle.id)).toEqual(timeline);
  });

  it('bounds coordinator metadata and reports the omitted branch count', async () => {
    const branches: Record<string, readonly [() => Promise<string>]> = {};
    for (let index = 0; index < 101; index++) {
      branches[index === 0 ? 'x'.repeat(600) : `branch-${String(index)}`] = [
        async () => `raw-result-${String(index)}`,
      ];
    }
    engine = new Engine({ storage: new MemoryStorage() });
    engine.register(
      workflow({ name: 'bounded-timeline-coordinator' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        return yield* ctx.runAll(branches);
      }),
    );

    const handle = await engine.start('bounded-timeline-coordinator', null, {
      id: 'wf-bounded-timeline-coordinator',
    });
    await handle.result();
    const timeline = await engine.getTimeline(handle.id);
    const entry = timeline[0];

    expect(entry?.branches).toHaveLength(100);
    expect(entry?.branchesOmitted).toBe(1);
    expect(entry?.branches?.[0]?.key?.length).toBe(512);
    expect(JSON.stringify(entry?.branches)).not.toContain('raw-result');
  });

  it('records rejected all branches and a rejecting race winner without mislabeling losers', async () => {
    const fail = async () => {
      throw new Error('Bearer branch-secret');
    };
    const pass = async () => 'pass';
    engine = new Engine({ storage: new MemoryStorage() });
    engine.register(
      workflow({ name: 'timeline-coordinator-failures' })
        .activities({ fail, pass, waitForRaceLoss })
        .execute(async function* (ctx: WorkflowContext) {
          try {
            yield* ctx.all([ctx.run('pass'), ctx.run('fail')]);
          } catch {
            // The following yield commits the failed coordinator timeline entry.
          }
          try {
            yield* ctx.race([ctx.run('fail'), ctx.run('waitForRaceLoss')]);
          } catch {
            return 'caught';
          }
          return 'unreachable';
        }),
    );

    const handle = await engine.start('timeline-coordinator-failures', null, {
      id: 'wf-timeline-coordinator-failures',
    });
    await expect(handle.result()).resolves.toBe('caught');
    const timeline = await engine.getTimeline(handle.id);

    expect(timeline[0]?.branches).toEqual([
      expect.objectContaining({ index: 0, outcome: 'fulfilled' }),
      expect.objectContaining({ index: 1, outcome: 'rejected' }),
    ]);
    expect(timeline[0]?.branches?.[1]?.errorSummary).toContain('[REDACTED]');
    expect(timeline[1]?.branches).toEqual([
      expect.objectContaining({ index: 0, outcome: 'won' }),
      expect.objectContaining({ index: 1, outcome: 'lost' }),
    ]);
    expect(timeline[1]?.branches?.[0]?.errorSummary).toContain('[REDACTED]');
  });

  it('records ordered speculative children and the coordinator commit or rollback outcome', async () => {
    const pass = async () => 'pass-result';
    const fail = async () => {
      throw new Error('Bearer should-not-be-retained');
    };
    engine = new Engine({ storage: new MemoryStorage() });
    engine.register(
      workflow({ name: 'timeline-speculate' })
        .activities({ fail, pass })
        .execute(async function* (ctx: WorkflowContext, input: { rollback: boolean }) {
          try {
            return yield* ctx.speculate(async function* (branch) {
              yield* branch.run('pass');
              return input.rollback ? yield* branch.run('fail') : yield* branch.run('pass');
            });
          } catch {
            return 'rolled-back';
          }
        }),
    );

    const committed = await engine.start(
      'timeline-speculate',
      { rollback: false },
      {
        id: 'wf-speculate-commit',
      },
    );
    const rolledBack = await engine.start(
      'timeline-speculate',
      { rollback: true },
      {
        id: 'wf-speculate-rollback',
      },
    );
    await Promise.all([committed.result(), rolledBack.result()]);

    const committedTimeline = await engine.getTimeline(committed.id);
    const committedEntry = committedTimeline[0];
    expect(committedEntry?.speculationOutcome).toBe('committed');
    expect(committedEntry?.children).toEqual([
      expect.objectContaining({ index: 0, operationLabel: 'pass', outcome: 'fulfilled' }),
      expect.objectContaining({ index: 1, operationLabel: 'pass', outcome: 'fulfilled' }),
    ]);

    const rolledBackTimeline = await engine.getTimeline(rolledBack.id);
    const rolledBackEntry = rolledBackTimeline[0];
    expect(rolledBackEntry?.speculationOutcome).toBe('rolled-back');
    expect(rolledBackEntry?.children).toEqual([
      expect.objectContaining({ index: 0, operationLabel: 'pass', outcome: 'fulfilled' }),
      expect.objectContaining({ index: 1, operationLabel: 'fail', outcome: 'rejected' }),
    ]);
    expect(rolledBackEntry?.children?.[1]?.errorSummary).toContain('[REDACTED]');
    expect(rolledBackEntry?.children?.[1]?.errorSummary).not.toContain('should-not-be-retained');
  });

  it('acceptance criterion: engine.replayTo(workflowId, step) reconstructs checkpoint state, accumulated results, and event log up to that step', async () => {
    let now = 10_000;
    const storage = new MemoryStorage();

    async function firstStep() {
      now += 5;
      return { apiKey: 'sk-test-123', phase: 'first' as const };
    }

    async function secondStep() {
      now += 10;
      return { phase: 'second' as const };
    }

    async function thirdStep() {
      now += 15;
      return { phase: 'third' as const };
    }

    engine = new Engine({ storage, checkpointHistory: 10, getNow: () => now });
    const threeStepsWorkflow = workflow({ name: 'three-steps', version: '3.1.0' }).execute(
      async function* (ctx: WorkflowContext) {
        yield* ctx.run(firstStep);
        yield* ctx.run(secondStep);
        return yield* ctx.run(thirdStep);
      },
    );
    engine.register(threeStepsWorkflow);

    const handle = await engine.start('three-steps', null, { id: 'wf-replay' });
    await handle.result();

    const timelineBeforeReplay = await engine.getTimeline('wf-replay');
    const checkpointsBeforeReplay = await engine.listCheckpoints('wf-replay');

    const replay = await engine.replayTo('wf-replay', 2);
    const timelineAfterReplay = await engine.getTimeline('wf-replay');
    const checkpointsAfterReplay = await engine.listCheckpoints('wf-replay');

    expect(replay).not.toBeNull();
    expect(replay?.checkpoint).toMatchObject({
      step: 2,
      version: '3.1.0',
    });
    expect(timelineBeforeReplay).toHaveLength(3);
    expect(timelineAfterReplay).toEqual(timelineBeforeReplay);
    expect(checkpointsAfterReplay).toEqual(checkpointsBeforeReplay);
    expect(replay?.accumulatedResults).toEqual([[0, { apiKey: '[REDACTED]', phase: 'first' }]]);
    expect(replay?.accumulatedResults).toHaveLength(1);
    expect(replay?.events.map((event) => event.type)).toEqual([
      'workflow:checkpoint',
      'workflow:checkpoint',
    ]);
    expect(replay?.events).toHaveLength(2);
    // WFT-21: `replayTo()` reports the run's own pinned revision.
    const state = await engine.get('wf-replay');
    expect(state?.revision).toBeDefined();
    expect(replay?.revision).toBe(state?.revision);
  });

  it("acceptance criterion: engine.replayTo(workflowId, step) reports the run's ORIGINAL revision, not the newly active one, after a later activation", async () => {
    const storage = new MemoryStorage();
    engine = new Engine({ storage, checkpointHistory: 10 });
    const olderRevisionWorkflow = workflow({ name: 'replay-revision', version: '1.0.0' }).execute(
      async function* (ctx: WorkflowContext) {
        yield* ctx.run(async () => 'step-one');
        return 'done';
      },
    );
    engine.register(olderRevisionWorkflow);

    const handle = await engine.start('replay-revision', null, { id: 'wf-replay-revision' });
    await handle.result();
    const originalRevisionSummary = await engine.get(handle.id);
    const originalRevision = originalRevisionSummary?.revision;
    expect(originalRevision).toBeDefined();

    // Activate a genuinely different revision for the same name — the run
    // above is pinned to the ORIGINAL revision and must stay that way.
    engine[Symbol.dispose]();
    engine = new Engine({ storage, checkpointHistory: 10 });
    engine.register(
      workflow({ name: 'replay-revision', version: '2.0.0' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        yield* ctx.run(async () => 'step-one');
        return 'done';
      }),
    );

    const replay = await engine.replayTo(handle.id, 1);
    expect(replay?.revision).toBe(originalRevision);
  });

  it('omits `revision` from a replay when the workflow record has since been purged', async () => {
    const storage = new MemoryStorage();
    engine = new Engine({ storage, checkpointHistory: 10 });
    const purgedReplayWorkflow = workflow({ name: 'replay-purged' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.run(async () => 'step-one');
      return 'done';
    });
    engine.register(purgedReplayWorkflow);

    const handle = await engine.start('replay-purged', null, { id: 'wf-replay-purged' });
    await handle.result();
    // Delete only the top-level `WorkflowState` record directly — a real
    // `engine.purge()` also deletes the checkpoint history `replayTo()`
    // itself reads, which would make it return `null` outright rather than
    // exercising the "record gone, checkpoint history still readable"
    // branch `WorkflowReplay.revision`'s own doc describes.
    await storage.delete(KEYS.workflow(handle.id));

    const replay = await engine.replayTo(handle.id, 1);
    expect(replay).not.toBeNull();
    expect('revision' in (replay ?? {})).toBe(false);
  });

  it('omits `revision` from a replay when the workflow record predates revision pinning (legacy, no persisted revision)', async () => {
    const storage = new MemoryStorage();
    engine = new Engine({ storage, checkpointHistory: 10 });
    const legacyReplayWorkflow = workflow({ name: 'replay-legacy' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.run(async () => 'step-one');
      return 'done';
    });
    engine.register(legacyReplayWorkflow);

    const handle = await engine.start('replay-legacy', null, { id: 'wf-replay-legacy' });
    await handle.result();

    // Simulate a legacy record (written before revision pinning existed) by
    // stripping the persisted `revision` field directly in storage.
    const stateBytes = await storage.get(KEYS.workflow(handle.id));
    const state = { ...(decode(stateBytes!) as Record<string, unknown>) };
    delete state['revision'];
    await storage.put(KEYS.workflow(handle.id), encode(state));

    const replay = await engine.replayTo(handle.id, 1);
    expect(replay).not.toBeNull();
    expect('revision' in (replay ?? {})).toBe(false);
  });

  it('omits `revision` from a replay when the workflow record has since been replaced by a later execution under the same id (WFT-21, Codex review round 3, P2)', async () => {
    const storage = new MemoryStorage();
    engine = new Engine({ storage, checkpointHistory: 10 });
    const replaceableWorkflow = workflow({ name: 'replay-replaced' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.run(async () => 'step-one');
      return 'done';
    });
    engine.register(replaceableWorkflow);

    const handle = await engine.start('replay-replaced', null, { id: 'wf-replay-replaced' });
    await handle.result();
    const originalState = await engine.get(handle.id);
    expect(originalState?.revision).toBeDefined();

    // Simulate exactly what `onTerminalConflict: 'start-new'` produces
    // durably — a fresh `WorkflowState` under the SAME id, with a LATER
    // `createdAt`, a DIFFERENT `revision`, and (WFT-21, Codex review round
    // 3, P2) a FRESH `workflowExecutionToken` (a real `start-new` always
    // mints a new one — see `buildInitialIdentitySlice`) — without needing
    // to race the real timing window `replayTo()`'s own two independent
    // reads leave open. This is the state a concurrent replacement would
    // have already committed by the time `replayTo()`'s own state read
    // lands. The token mismatch is now the PRIMARY signal `replayTo()`
    // uses to detect this case — see `resolveReplayRevision()`'s own doc;
    // the `createdAt` mismatch below is kept too, so this test would still
    // catch a regression to the old timestamp-only heuristic.
    const stateBytes = await storage.get(KEYS.workflow(handle.id));
    const replacedState = { ...(decode(stateBytes!) as Record<string, unknown>) };
    replacedState['revision'] = 'sha256:replacement-revision-that-never-produced-this-checkpoint';
    replacedState['createdAt'] = (replacedState['createdAt'] as number) + 1_000_000;
    replacedState['workflowExecutionToken'] =
      'replacement-run-token-that-never-produced-this-checkpoint';
    await storage.put(KEYS.workflow(handle.id), encode(replacedState));

    // The checkpoint at step 1 still belongs to the ORIGINAL execution —
    // `revision` must be omitted rather than misattributed to the
    // replacement's own revision.
    const replay = await engine.replayTo(handle.id, 1);
    expect(replay).not.toBeNull();
    expect('revision' in (replay ?? {})).toBe(false);
  });

  it('correlates a replay by `workflowExecutionToken` even at identical millisecond timestamps, where a `createdAt`-only comparison could not distinguish the runs (WFT-21, Codex review round 3, P2)', async () => {
    const storage = new MemoryStorage();
    engine = new Engine({ storage, checkpointHistory: 10 });
    const replaceableWorkflow = workflow({ name: 'replay-replaced-same-millisecond' }).execute(
      async function* (ctx: WorkflowContext) {
        yield* ctx.run(async () => 'step-one');
        return 'done';
      },
    );
    engine.register(replaceableWorkflow);

    const handle = await engine.start('replay-replaced-same-millisecond', null, {
      id: 'wf-replay-replaced-same-millisecond',
    });
    await handle.result();

    // Simulate a `start-new` replacement that happened to land at the
    // EXACT SAME `createdAt` millisecond as the original run (a real,
    // non-adversarial possibility on a fast clock, or a mocked/frozen
    // `getNow()`) — the pre-round-3 `createdAt >=` heuristic cannot tell
    // these apart (the inequality holds either way), so it would have
    // wrongly attributed the replacement's revision to the original run's
    // checkpoint. The token mismatch alone still catches it.
    const stateBytes = await storage.get(KEYS.workflow(handle.id));
    const replacedState = { ...(decode(stateBytes!) as Record<string, unknown>) };
    replacedState['revision'] =
      'sha256:same-millisecond-replacement-revision-that-never-produced-this-checkpoint';
    replacedState['workflowExecutionToken'] = 'same-millisecond-replacement-run-token';
    await storage.put(KEYS.workflow(handle.id), encode(replacedState));

    const replay = await engine.replayTo(handle.id, 1);
    expect(replay).not.toBeNull();
    expect('revision' in (replay ?? {})).toBe(false);
  });

  it('omits `revision` from a replay when a checkpoint history entry predates the `workflowExecutionToken` field, rather than falling back to a collision-prone `createdAt` comparison (legacy checkpoint, WFT-21, Codex review round 5, P2, tightening round 3)', async () => {
    const storage = new MemoryStorage();
    engine = new Engine({ storage, checkpointHistory: 10 });
    const legacyCheckpointWorkflow = workflow({ name: 'replay-legacy-checkpoint-token' }).execute(
      async function* (ctx: WorkflowContext) {
        yield* ctx.run(async () => 'step-one');
        return 'done';
      },
    );
    engine.register(legacyCheckpointWorkflow);

    const handle = await engine.start('replay-legacy-checkpoint-token', null, {
      id: 'wf-replay-legacy-checkpoint-token',
    });
    await handle.result();
    const state = await engine.get(handle.id);
    expect(state?.revision).toBeDefined();

    // Simulate a checkpoint history entry persisted before this field
    // existed by stripping `workflowExecutionToken` directly from the
    // step-1 checkpoint history record. Round 3's own `createdAt >=`
    // fallback for this case was itself vulnerable to the identical
    // same-millisecond/backward-clock collision it fixed for the general
    // case — round 5 removes that fallback entirely: `resolveReplayRevision()`
    // now omits `revision` whenever either side lacks the token, rather
    // than best-effort guessing via timestamps.
    const historyKey = KEYS.checkpointHistory(handle.id, 1);
    const historyBytes = await storage.get(historyKey);
    expect(historyBytes).not.toBeNull();
    const legacyHistoryEntry = { ...(decode(historyBytes!) as Record<string, unknown>) };
    delete legacyHistoryEntry['workflowExecutionToken'];
    await storage.put(historyKey, encode(legacyHistoryEntry));

    const replay = await engine.replayTo(handle.id, 1);
    expect(replay).not.toBeNull();
    expect(replay?.revision).toBeUndefined();
  });

  it('ignores malformed stored timeline entries and returns results sorted by step', async () => {
    const storage = new MemoryStorage();
    engine = new Engine({ storage, checkpointHistory: 10 });
    const noopWorkflow = workflow({ name: 'noop' }).execute(async function* () {
      return null;
    });
    engine.register(noopWorkflow);

    await storage.put(
      KEYS.timeline('wf-malformed-timeline', 2),
      encode({
        step: 2,
        operationType: 'activity',
        operationLabel: 'second',
        inputSummary: '{}',
        timestamp: 2_000,
        status: 'completed',
      }),
    );
    await storage.put(
      KEYS.timeline('wf-malformed-timeline', 1),
      encode({
        step: 1,
        operationType: 'activity',
        operationLabel: 'first',
        inputSummary: '{}',
        timestamp: 1_000,
        status: 'running',
      }),
    );
    await storage.put(
      KEYS.timeline('wf-malformed-timeline', 3),
      encode({
        step: 3,
        operationType: 'activity',
        operationLabel: 'broken',
        inputSummary: '{}',
        timestamp: 3_000,
        status: 'not-a-real-status',
      }),
    );
    await storage.put(
      KEYS.timeline('wf-malformed-timeline', 4),
      encode({
        step: 0,
        operationType: 'activity',
        operationLabel: 'zero-step',
        inputSummary: '{}',
        timestamp: 4_000,
        status: 'completed',
      }),
    );
    await storage.put(
      KEYS.timeline('wf-malformed-timeline', 5),
      encode({
        step: Number.NaN,
        operationType: 'activity',
        operationLabel: 'nan-step',
        inputSummary: '{}',
        timestamp: 5_000,
        status: 'completed',
      }),
    );
    await storage.put(
      KEYS.timeline('wf-malformed-timeline', 6),
      encode({
        step: 6,
        operationType: 'activity',
        operationLabel: 'infinite-timestamp',
        inputSummary: '{}',
        timestamp: Number.POSITIVE_INFINITY,
        status: 'completed',
      }),
    );
    await storage.put(
      KEYS.timeline('wf-malformed-timeline', 7),
      encode({
        step: 7,
        operationType: 'activity',
        operationLabel: 'nan-duration',
        inputSummary: '{}',
        timestamp: 7_000,
        status: 'completed',
        duration: Number.NaN,
      }),
    );
    await storage.put(KEYS.timeline('wf-malformed-timeline', 8), new Uint8Array([0xc1]));

    const timeline = await engine.getTimeline('wf-malformed-timeline');

    expect(timeline.map((entry) => entry.step)).toEqual([1, 2]);
  });

  it('keeps malformed timeline summary strings unchanged instead of re-quoting them', async () => {
    const storage = new MemoryStorage();
    engine = new Engine({ storage, checkpointHistory: 10 });

    await storage.put(
      KEYS.timeline('wf-summary-fallback', 1),
      encode({
        step: 1,
        operationType: 'activity',
        operationLabel: 'summaries',
        inputSummary: 'undefined',
        outputSummary: '[unserializable]',
        timestamp: 1_000,
        status: 'failed',
      }),
    );

    const timeline = await engine.getTimeline('wf-summary-fallback');

    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.inputSummary).toBe('undefined');
    expect(timeline[0]?.outputSummary).toBe('[unserializable]');
  });

  it('does not overwrite a failed operation timeline duration during workflow failure cleanup', async () => {
    let now = 0;
    const storage = new MemoryStorage();
    engine = new Engine({ storage, checkpointHistory: 10, getNow: () => now++ });

    async function failStep() {
      throw new Error('timeline failure');
    }

    const timelineFailureWorkflow = workflow({ name: 'timeline-failure' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.run(failStep);
    });
    engine.register(timelineFailureWorkflow);

    const handle = await engine.start('timeline-failure', null, { id: 'wf-timeline-failure' });
    await handle.result().catch(() => {});

    const timeline = await engine.getTimeline('wf-timeline-failure');

    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      status: 'failed',
      operationLabel: 'failStep',
    });
    expect(timeline[0]?.duration).toBe(1);
    expect(timeline[0]?.outputSummary).toContain('timeline failure');
  });
});

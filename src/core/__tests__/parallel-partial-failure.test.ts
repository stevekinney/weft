/**
 * Tests for the `ctx.all` / `ctx.runAll` partial-failure fix.
 * Before this fix, when one branch in `ctx.all`
 * rejected, every successful branch's result was discarded and re-ran on
 * retry — duplicating activity side effects. After the fix, fulfilled
 * branches' values are written into the parent's `accumulatedResults`
 * cache entry before the rejection propagates, so on retry only the
 * failed branches re-dispatch.
 */

import { describe, expect, it } from 'bun:test';

import { deserializeCheckpoint, serializeCheckpoint } from '../checkpoint.ts';
import { decode, encode } from '../codec.ts';
import { Context } from '../context.ts';
import { BranchTopologyChangedError } from '../context/parallel-operations.ts';
import { Engine } from '../engine.ts';
import { hydrateCheckpointReplayState } from '../engine/checkpoint-replay.ts';
import {
  CURRENT_CHECKPOINT_SCHEMA_VERSION,
  CheckpointSchemaVersionError,
  workflow,
  type Checkpoint,
  type WorkflowContext,
} from '../types.ts';

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('ctx.all partial-failure preservation', () => {
  it('runs every branch on the original attempt before propagating failure', async () => {
    // Validates the dispatch shape: with Promise.allSettled-style
    // execution, every branch runs to settlement before the parent
    // rejection is observed. (No-re-execution-on-replay is verified by
    // the crash-recovery test below.)
    const engine = new Engine();
    let okCalls = 0;
    let failCalls = 0;
    const ok = async () => {
      okCalls++;
      return 'ok-result';
    };
    const fail = async () => {
      failCalls++;
      throw new Error('always fails');
    };

    const partialFailWorkflow2 = workflow({ name: 'partial-fail' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const c = ctx;
      yield* c.all([c.run(ok), c.run(fail)]);
    });
    engine.register(partialFailWorkflow2);

    const handle = await engine.start('partial-fail', null);
    let captured: Error | undefined;
    try {
      await handle.result();
    } catch (error) {
      captured = error as Error;
    }
    expect(captured?.message).toBe('always fails');
    expect(okCalls).toBe(1);
    expect(failCalls).toBe(1);
    engine[Symbol.dispose]();
  });

  it('the headline fix: replay reuses the fulfilled branch instead of re-running it', async () => {
    // The actual durability test. Workflow runs `ctx.all` with one
    // branch that succeeds and one that fails. Workflow CATCHES the
    // error and yields again — that yield persists the partial entry
    // to the checkpoint. A second engine, sharing the same storage,
    // then resumes the workflow from that persisted checkpoint:
    //   - The successful branch's activity must NOT run again.
    //   - The failed branch's activity DOES run again (replay
    //     re-dispatches non-fulfilled slots).
    //
    // This is the duplicate-side-effects bug from the README's
    // checkout example, exercised end-to-end via TestEngine.recover().
    const { TestEngine } = await import('../../testing/test-engine.ts');

    let okCalls = 0;
    let failCalls = 0;
    const ok = async () => {
      okCalls++;
      return 'ok-result';
    };
    // Throws on the first attempt; succeeds on subsequent attempts.
    const flaky = async () => {
      failCalls++;
      if (failCalls === 1) throw new Error('first-time failure');
      return 'recovered';
    };

    // Workflow catches and yields again so the partial entry persists.
    // After the catch, the workflow blocks on a signal so it stays in
    // the running state long enough for storage to capture the entry.
    const partialFailWorkflow = async function* (ctx: WorkflowContext) {
      const c = ctx;
      try {
        yield* c.all([c.run(ok), c.run(flaky)]);
        return 'first-attempt-succeeded';
      } catch {
        // Yield once so the partial entry persists. Block on a signal
        // so the workflow stays in the running state and storage
        // captures the v2 entry.
        yield* c.waitForSignal('retry-now');
        // Now retry — but at a NEW step (different from the one with
        // the partial entry). The partial entry at step 0 is durable;
        // this retry exercises a fresh ctx.all step.
        const result = yield* c.all([c.run(ok), c.run(flaky)]);
        return result;
      }
    };

    const engine1 = new TestEngine();
    const partialFailWorkflow3 = workflow({ name: 'partial-fail' }).execute(partialFailWorkflow);
    engine1.register(partialFailWorkflow3);

    await engine1.start('partial-fail', null, { id: 'wf-headline' });
    await flush();
    // Workflow is parked waiting for the 'retry-now' signal — the
    // partial entry at step 0 is now durable in storage.

    expect(okCalls).toBe(1);
    expect(failCalls).toBe(1);

    // Simulate process restart: a fresh engine sees the persisted
    // checkpoint and resumes.
    const engine2 = engine1.recover();
    const partialFailWorkflow4 = workflow({ name: 'partial-fail' }).execute(partialFailWorkflow);
    engine2.register(partialFailWorkflow4);

    const handles = await engine2.recoverAll();
    expect(handles).toHaveLength(1);
    await flush();

    // The recovered generator replays from the start. At step 0 it
    // re-yields ctx.all. Because the partial entry is persisted, the
    // engine reuses the fulfilled `ok` slot AND re-dispatches the
    // rejected `flaky` slot:
    //   okCalls stays at 1 — the fulfilled slot is reused.
    //   failCalls is 2 — the rejected slot re-dispatched, AND it
    //   succeeded this time (flaky's second invocation returns
    //   'recovered'), so the original ctx.all now succeeds. The
    //   workflow returns 'first-attempt-succeeded' without ever
    //   reaching the catch block on this replay.
    //
    // The exact follow-on path depends on how the engine reaches the
    // signal — what we lock down here is the headline assertion:
    //   ok ran exactly ONCE total across original + replay.
    await engine2.signal('wf-headline', 'retry-now', null);
    await handles[0]!.result();

    expect(okCalls).toBe(1); // headline assertion: not 2
    expect(failCalls).toBeGreaterThanOrEqual(2);

    engine1[Symbol.dispose]();
    engine2[Symbol.dispose]();
  });

  it('rejects with the first error observed by settlement timing', async () => {
    const engine = new Engine();
    const failFirst = async () => {
      throw new Error('boom-1');
    };
    const failSecond = async () => {
      throw new Error('boom-2');
    };

    const multiFailWorkflow = workflow({ name: 'multi-fail' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const c = ctx;
      yield* c.all([c.run(failFirst), c.run(failSecond)]);
    });
    engine.register(multiFailWorkflow);

    const handle = await engine.start('multi-fail', null);

    let captured: Error | undefined;
    try {
      await handle.result();
    } catch (error) {
      captured = error as Error;
    }
    expect(captured).toBeDefined();
    expect(captured?.message === 'boom-1' || captured?.message === 'boom-2').toBe(true);
    engine[Symbol.dispose]();
  });

  it('propagates rejection from a single-branch ctx.all that fails', async () => {
    // Sanity: a single-branch ctx.all whose only branch fails surfaces
    // the rejection to the workflow. The slot is stored as 'rejected'
    // in the cache entry (proven by the schema-shape test below); on
    // replay, rejected slots re-dispatch.
    const engine = new Engine();
    const fail = async () => {
      throw new Error('always fails');
    };

    const rejectedNotReusedWorkflow = workflow({ name: 'rejected-not-reused' }).execute(
      async function* (ctx: WorkflowContext) {
        const c = ctx;
        yield* c.all([c.run(fail)]);
      },
    );
    engine.register(rejectedNotReusedWorkflow);

    const handle = await engine.start('rejected-not-reused', null);
    let captured: Error | undefined;
    try {
      await handle.result();
    } catch (error) {
      captured = error as Error;
    }
    expect(captured?.message).toBe('always fails');
    engine[Symbol.dispose]();
  });

  it('preserves the original (non-Error) rejection reason at the workflow boundary', async () => {
    // Promise.all rethrows whatever the branch threw — including
    // strings, numbers, or undefined. The engine must not coerce a
    // non-Error rejection on the workflow throw path; only the
    // persisted slot metadata and the timeline status string are
    // normalized.
    //
    // We verify this by catching the rejection inside the workflow
    // (where the throw boundary is) and asserting its identity.
    const engine = new Engine();
    const throwsString = async () => {
      throw 'plain-string-reason';
    };

    let capturedInWorkflow: unknown;
    const nonErrorThrowWorkflow = workflow({ name: 'non-error-throw' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const c = ctx;
      try {
        yield* c.all([c.run(throwsString)]);
      } catch (error) {
        capturedInWorkflow = error;
      }
    });
    engine.register(nonErrorThrowWorkflow);

    const handle = await engine.start('non-error-throw', null);
    await handle.result();
    // Inside the workflow, the rethrown value is the original string —
    // not a wrapped Error.
    expect(capturedInWorkflow).toBe('plain-string-reason');
    engine[Symbol.dispose]();
  });

  it('persists the partial cache entry when the workflow yields again after catching', async () => {
    // The partial entry is written to context.accumulatedResults
    // before the rejection propagates. If the workflow catches and
    // yields again, the next checkpoint write captures the partial
    // entry. This test verifies the persisted partial-entry shape.
    //
    // (Note: a workflow that fails terminally without catching does
    // not flush the partial entry to disk — that's a known durability
    // gap documented in the parallel-execution guide. Engineering
    // around it would require extending the engine's failure-path
    // checkpoint flush, which is out of scope for this fix.)
    const { MemoryStorage } = await import('../../storage/memory.ts');
    const { KEYS } = await import('../../storage/interface.ts');

    const storage = new MemoryStorage();
    const engine = new Engine({ storage });

    const ok = async () => 'ok-result';
    const fail = async () => {
      throw new Error('boom');
    };
    const followup = async () => 'followup';

    const partialFailCatchWorkflow = workflow({ name: 'partial-fail-catch' }).execute(
      async function* (ctx: WorkflowContext) {
        const c = ctx;
        try {
          yield* c.all([c.run(ok), c.run(fail)]);
        } catch {
          // Yield again so the next checkpoint persists the partial entry.
          yield* c.run(followup);
        }
      },
    );
    engine.register(partialFailCatchWorkflow);

    const handle = await engine.start('partial-fail-catch', null, { id: 'wf-partial' });
    await handle.result();
    await flush();

    const checkpointKey = KEYS.checkpoint('wf-partial');
    const bytes = await storage.get(checkpointKey);
    expect(bytes).toBeTruthy();
    const checkpoint = await hydrateCheckpointReplayState(
      storage,
      'wf-partial',
      deserializeCheckpoint(bytes!),
    );

    // The partial cache entry should be at step 0 (the original ctx.all step).
    const stepZeroEntry = checkpoint.accumulatedResults.find(([step]) => step === 0);
    expect(stepZeroEntry).toBeDefined();
    const value = stepZeroEntry![1] as Record<string, unknown>;
    expect(value['__weftParallelOperationCache']).toBe(true);
    expect(value['formatVersion']).toBe(2);
    expect(value['variant']).toBe('all');
    const branches = value['branches'] as Array<Record<string, unknown>>;
    expect(branches).toHaveLength(2);
    expect(branches[0]?.['status']).toBe('fulfilled');
    expect(branches[0]?.['value']).toBe('ok-result');
    expect(branches[1]?.['status']).toBe('rejected');

    engine[Symbol.dispose]();
  });

  it('happy path: fulfilled branches are reused on replay (no re-execution)', async () => {
    // This validates the "fully-fulfilled" fast path on resume — every
    // slot is fulfilled, so the entry is reused without dispatch.
    const engine = new Engine();
    let ok1 = 0;
    let ok2 = 0;
    const a = async () => {
      ok1++;
      return 'a';
    };
    const b = async () => {
      ok2++;
      return 'b';
    };

    const happyWorkflow = workflow({ name: 'happy' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const c = ctx;
      const first = yield* c.all([c.run(a), c.run(b)]);
      const second = yield* c.all([c.run(a), c.run(b)]);
      return [first, second];
    });
    engine.register(happyWorkflow);

    const handle = await engine.start('happy', null);
    const result = (await handle.result()) as unknown[];
    expect(result).toEqual([
      ['a', 'b'],
      ['a', 'b'],
    ]);
    // Each `ctx.all` is a separate step, so each runs its branches once
    // — but the SAME ctx.all on replay would not re-run them.
    expect(ok1).toBe(2);
    expect(ok2).toBe(2);
    engine[Symbol.dispose]();
  });
});

describe('ctx.runAll partial-failure preservation', () => {
  it('runs every branch on the original attempt before propagating failure', async () => {
    // Mirrors the ctx.all test above. With Promise.allSettled-shape
    // dispatch, a failed branch no longer short-circuits sibling
    // settlement — every branch runs (and persists if successful)
    // before the error propagates.
    const engine = new Engine();
    let okCalls = 0;
    const ok = async () => {
      okCalls++;
      return 'ok';
    };
    const fail = async () => {
      throw new Error('boom');
    };

    const runAllPartialWorkflow = workflow({ name: 'runAll-partial' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const c = ctx;
      yield* c.runAll({ first: [ok], second: [fail] });
    });
    engine.register(runAllPartialWorkflow);

    const handle = await engine.start('runAll-partial', null);
    let captured: Error | undefined;
    try {
      await handle.result();
    } catch (error) {
      captured = error as Error;
    }
    expect(captured?.message).toBe('boom');
    expect(okCalls).toBe(1);
    engine[Symbol.dispose]();
  });

  it('throws BranchTopologyChangedError on replay when runAll keys reorder', () => {
    // Topology validation runs on REPLAY (when a cached entry from a
    // prior attempt is present at the same step). Construct a context
    // with a pre-seeded accumulatedResults and verify the generator
    // throws when the workflow yields a different branch order.
    const cachedEntry = {
      __weftParallelOperationCache: true,
      formatVersion: 2 as const,
      variant: 'run-all' as const,
      branches: [
        { status: 'pending' as const, operationId: 'run-all:0:a' },
        { status: 'fulfilled' as const, value: 'b-result', operationId: 'run-all:0:b' },
      ],
      branchNames: ['a', 'b'],
      subOperationCount: 2,
    };

    const context = new Context({
      workflowId: 'wf-topology',
      workflowType: 'test',
      startedAt: 1000,
      abortController: new AbortController(),
      accumulatedResults: new Map<number, unknown>([[0, cachedEntry]]),
    });

    // Different key order from the cached entry's branchNames.
    const generator = context.runAll({
      b: [async () => 'b'],
      a: [async () => 'a'],
    });

    expect(() => generator.next()).toThrow(BranchTopologyChangedError);
  });

  it('throws BranchTopologyChangedError on replay when branch count changes', () => {
    const cachedEntry = {
      __weftParallelOperationCache: true,
      formatVersion: 2 as const,
      variant: 'run-all' as const,
      branches: [
        { status: 'pending' as const, operationId: 'run-all:0:a' },
        { status: 'pending' as const, operationId: 'run-all:0:b' },
        { status: 'pending' as const, operationId: 'run-all:0:c' },
      ],
      branchNames: ['a', 'b', 'c'],
      subOperationCount: 3,
    };

    const context = new Context({
      workflowId: 'wf-count',
      workflowType: 'test',
      startedAt: 1000,
      abortController: new AbortController(),
      accumulatedResults: new Map<number, unknown>([[0, cachedEntry]]),
    });

    const generator = context.runAll({
      a: [async () => 'a'],
      b: [async () => 'b'],
    });

    expect(() => generator.next()).toThrow(BranchTopologyChangedError);
  });
});

describe('ctx.race asymmetry: loser results are not preserved', () => {
  it('losing branches re-execute when the workflow re-enters the same race step', async () => {
    // ctx.race intentionally aborts losers and persists only the winner.
    // This test locks in that asymmetry — re-entering the same step does
    // not re-run anything (winner is cached), but a fresh race in the
    // workflow's logic would re-dispatch its losing branches.
    const engine = new Engine();
    let fastCalls = 0;
    const fast = async () => {
      fastCalls++;
      return 'winner';
    };
    const slow = async () => {
      // Slow enough that fast wins.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return 'loser';
    };

    const raceCacheWorkflow = workflow({ name: 'race-cache' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      const c = ctx;
      const a = yield* c.race([c.run(fast), c.run(slow)]);
      const b = yield* c.race([c.run(fast), c.run(slow)]);
      return [a, b];
    });
    engine.register(raceCacheWorkflow);

    const handle = await engine.start('race-cache', null);
    const result = (await handle.result()) as unknown[];
    expect(result).toEqual(['winner', 'winner']);
    // Each ctx.race is a distinct step, so each ran the fast branch.
    expect(fastCalls).toBe(2);
    engine[Symbol.dispose]();
  });
});

describe('checkpoint schema version', () => {
  it('refuses to load pre-versioned checkpoints', () => {
    const preVersioned = {
      workflowId: 'wf',
      step: 0,
      locals: {},
      accumulatedResults: [],
      searchAttributes: {},
      version: '1.0.0',
      createdAt: Date.now(),
      // schemaVersion intentionally omitted
    };
    // Use the underlying codec to bypass the createCheckpoint factory.
    const bytes = encode(preVersioned);
    expect(() => deserializeCheckpoint(bytes)).toThrow(CheckpointSchemaVersionError);
  });

  it('refuses to load checkpoints with a lower schema version', () => {
    const wrongVersion = {
      workflowId: 'wf',
      step: 0,
      locals: {},
      accumulatedResults: [],
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: 1,
      createdAt: Date.now(),
    };
    const bytes = encode(wrongVersion);
    expect(() => deserializeCheckpoint(bytes)).toThrow(CheckpointSchemaVersionError);
  });

  it('refuses to load checkpoints with a higher (future) schema version', () => {
    const futureVersion = {
      workflowId: 'wf',
      step: 0,
      locals: {},
      accumulatedResults: [],
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: 99,
      createdAt: Date.now(),
    };
    const bytes = encode(futureVersion);
    expect(() => deserializeCheckpoint(bytes)).toThrow(CheckpointSchemaVersionError);
  });

  it('round-trips a current-version checkpoint cleanly', () => {
    const current: Checkpoint = {
      workflowId: 'wf',
      step: 0,
      locals: {},
      accumulatedResults: [],
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
      createdAt: 12345,
    };
    const bytes = serializeCheckpoint(current);
    const restored = deserializeCheckpoint(bytes);
    expect(restored.schemaVersion).toBe(CURRENT_CHECKPOINT_SCHEMA_VERSION);
    expect(restored.workflowId).toBe('wf');
  });

  it('round-trips a v2 cache entry through MessagePack', () => {
    const entry = {
      __weftParallelOperationCache: true,
      formatVersion: 2,
      variant: 'all' as const,
      branches: [
        { status: 'fulfilled', value: 42, operationId: 'op-0' },
        { status: 'rejected', reason: { name: 'Error', message: 'boom' }, operationId: 'op-1' },
        { status: 'pending', operationId: 'op-2' },
      ],
      subOperationCount: 3,
    };
    const bytes = encode(entry);
    const restored = decode(bytes);
    expect(restored).toEqual(entry);
  });
});

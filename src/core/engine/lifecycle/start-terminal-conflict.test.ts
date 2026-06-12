import { describe, expect, it } from 'bun:test';

import { KEYS, type Storage, storageKeys } from '../../../storage/interface.ts';
import { MemoryStorage } from '../../../storage/memory.ts';
import { flushMicrotasks, waitForCondition } from '../../../testing/fake-timers.test-support.ts';
import { TestEngine } from '../../../testing/test-engine.ts';
import { Engine } from '../../engine.ts';
import { StartWorkflowValidationError } from '../../start-workflow-validation.ts';
import { type WorkflowContext, workflow } from '../../types.ts';
import { WorkflowAlreadyExistsError } from '../errors.ts';

/**
 * `onTerminalConflict: 'start-new'` is Weft's `WorkflowIdReusePolicy.ALLOW_DUPLICATE`
 * for terminal runs: restart a finished run under the same id, leave a live run
 * alone, and never accept the policy alongside `idempotencyKey` or a generated id.
 * Weft is one-engine-per-store, so the restart is purge-then-start guarded by the
 * same in-process start reservation a normal start holds.
 */

const echoInput = workflow({ name: 'echo-input' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

const throwsImmediately = workflow({ name: 'throws-immediately' }).execute(async function* () {
  throw new Error('boom');
});

const waitsForever = workflow({ name: 'waits-forever' }).execute(async function* (
  ctx: WorkflowContext,
) {
  return yield* ctx.waitForSignal<string>('release');
});

// A workflow that takes a durable activity step so the run writes a
// `wf:{id}:timeline:{step}` entry — the no-op echo workflow writes none, so it
// cannot prove the timeline-purge gap is closed. An instant activity is used
// (not a sleep) so the step completes without depending on a wall-clock timer.
const stepsOnce = workflow({ name: 'steps-once' })
  .activities({ noop: { execute: async () => 'ok' } })
  .execute(async function* (ctx: WorkflowContext) {
    yield* ctx.run('noop');
    return 'stepped';
  });

function createEngine(storage: Storage = new MemoryStorage()): Engine {
  const engine = new Engine({ storage });
  engine.register(echoInput);
  engine.register(throwsImmediately);
  engine.register(waitsForever);
  engine.register(stepsOnce);
  return engine;
}

async function countKeysWithPrefix(storage: Storage, prefix: string): Promise<number> {
  let count = 0;
  for await (const _key of storageKeys(storage, prefix)) count += 1;
  return count;
}

/** Load a workflow's status, or `undefined` when no record exists. */
async function statusOf(engine: Engine, id: string): Promise<string | undefined> {
  const state = await engine.get(id);
  return state?.status;
}

function isRejected<T>(outcome: PromiseSettledResult<T>): outcome is PromiseRejectedResult {
  return outcome.status === 'rejected';
}

describe("engine.start onTerminalConflict: 'start-new'", () => {
  it('restarts a completed run under the same id with a fresh result', async () => {
    const engine = createEngine();

    const first = await engine.start('echo-input', 'first', { id: 'reuse-1', defer: false });
    expect(await first.result()).toBe('first');
    expect(await statusOf(engine, 'reuse-1')).toBe('completed');

    const second = await engine.start('echo-input', 'second', {
      id: 'reuse-1',
      onTerminalConflict: 'start-new',
      defer: false,
    });
    expect(second.id).toBe('reuse-1');
    expect(await second.result()).toBe('second');
    expect(await statusOf(engine, 'reuse-1')).toBe('completed');

    engine[Symbol.dispose]();
  });

  it('restarts a failed run under the same id', async () => {
    const engine = createEngine();

    const first = await engine.start('throws-immediately', null, { id: 'reuse-failed' });
    await expect(first.result()).rejects.toThrow('boom');
    await waitForCondition(async () => (await statusOf(engine, 'reuse-failed')) === 'failed', {
      timeoutMs: 2000,
      label: 'first run reached failed',
    });

    const second = await engine.start('echo-input', 'recovered', {
      id: 'reuse-failed',
      onTerminalConflict: 'start-new',
      defer: false,
    });
    expect(await second.result()).toBe('recovered');
    expect(await statusOf(engine, 'reuse-failed')).toBe('completed');

    engine[Symbol.dispose]();
  });

  it('restarts a cancelled run under the same id', async () => {
    const engine = createEngine();

    const first = await engine.start('waits-forever', null, {
      id: 'reuse-cancelled',
      defer: false,
    });
    // Observe the eventual rejection so it does not surface as unhandled.
    const settled = first.result().then(
      () => 'resolved',
      () => 'rejected',
    );
    await engine.cancel('reuse-cancelled');
    expect(await settled).toBe('rejected');
    await waitForCondition(
      async () => (await statusOf(engine, 'reuse-cancelled')) === 'cancelled',
      { timeoutMs: 2000, label: 'first run reached cancelled' },
    );

    const second = await engine.start('echo-input', 'after-cancel', {
      id: 'reuse-cancelled',
      onTerminalConflict: 'start-new',
      defer: false,
    });
    expect(await second.result()).toBe('after-cancel');
    expect(await statusOf(engine, 'reuse-cancelled')).toBe('completed');

    engine[Symbol.dispose]();
  });

  it('restarts a timed-out run under the same id', async () => {
    // Virtual time: a 1s executionTimeout fires deterministically after
    // advanceTime, driving the run to `timed-out` without wall-clock waits.
    await using engine = new TestEngine();
    engine.register(waitsForever);
    engine.register(echoInput);

    const first = await engine.start('waits-forever', null, {
      id: 'reuse-timed-out',
      executionTimeout: '1s',
    });
    const settled = first.result().then(
      () => 'resolved',
      () => 'rejected',
    );
    await engine.advanceTime('2s');
    expect(await settled).toBe('rejected');
    expect(await statusOf(engine, 'reuse-timed-out')).toBe('timed-out');

    const second = await engine.start('echo-input', 'after-timeout', {
      id: 'reuse-timed-out',
      onTerminalConflict: 'start-new',
      defer: false,
    });
    expect(await second.result()).toBe('after-timeout');
    expect(await statusOf(engine, 'reuse-timed-out')).toBe('completed');
  });

  it('throws WorkflowAlreadyExistsError when the existing run is still running', async () => {
    const engine = createEngine();

    const running = await engine.start('waits-forever', null, {
      id: 'still-running',
      defer: false,
    });
    expect(await statusOf(engine, 'still-running')).toBe('running');

    await expect(
      engine.start('echo-input', 'displace', {
        id: 'still-running',
        onTerminalConflict: 'start-new',
      }),
    ).rejects.toBeInstanceOf(WorkflowAlreadyExistsError);

    // The live run is untouched: still running, still resolvable via its signal.
    expect(await statusOf(engine, 'still-running')).toBe('running');
    await engine.signal('still-running', 'release', 'go');
    expect(await running.result()).toBe('go');

    engine[Symbol.dispose]();
  });

  it('throws WorkflowAlreadyExistsError when a delayed (pending) run exists and leaves it intact', async () => {
    // A delayed start is `pending` with an armed timer before it ever runs —
    // the most important non-terminal case, and the one where a purge-before-start
    // would be most damaging. 'start-new' must reject and leave the timer intact.
    await using engine = new TestEngine();
    engine.register(echoInput);

    const delayed = await engine.start('echo-input', 'delayed', {
      id: 'pending-delayed',
      startAfter: '10s',
    });
    expect(await statusOf(engine, 'pending-delayed')).toBe('pending');

    await expect(
      engine.start('echo-input', 'displace', {
        id: 'pending-delayed',
        onTerminalConflict: 'start-new',
      }),
    ).rejects.toBeInstanceOf(WorkflowAlreadyExistsError);

    // The pending run is untouched and still fires when its delay elapses.
    expect(await statusOf(engine, 'pending-delayed')).toBe('pending');
    await engine.advanceTime('11s');
    expect(await delayed.result()).toBe('delayed');
  });

  it("defaults to 'error': a duplicate id on a terminal run still throws", async () => {
    const engine = createEngine();

    const first = await engine.start('echo-input', 'first', { id: 'no-policy', defer: false });
    expect(await first.result()).toBe('first');

    await expect(engine.start('echo-input', 'second', { id: 'no-policy' })).rejects.toBeInstanceOf(
      WorkflowAlreadyExistsError,
    );
    await expect(
      engine.start('echo-input', 'second', { id: 'no-policy', onTerminalConflict: 'error' }),
    ).rejects.toBeInstanceOf(WorkflowAlreadyExistsError);

    engine[Symbol.dispose]();
  });

  describe('validation (rejected before any durable write)', () => {
    it("rejects 'start-new' without an explicit id and writes nothing", async () => {
      const storage = new MemoryStorage();
      const engine = createEngine(storage);
      await expect(
        engine.start('echo-input', null, { onTerminalConflict: 'start-new' }),
      ).rejects.toBeInstanceOf(StartWorkflowValidationError);
      // The validation fires before any id is generated or persisted, so the
      // store holds no workflow records at all.
      expect(await countKeysWithPrefix(storage, 'wf:')).toBe(0);
      engine[Symbol.dispose]();
    });

    it("rejects 'start-new' combined with an idempotencyKey", async () => {
      const engine = createEngine();
      await expect(
        engine.start('echo-input', null, {
          idempotencyKey: 'k',
          onTerminalConflict: 'start-new',
        }),
      ).rejects.toBeInstanceOf(StartWorkflowValidationError);
      engine[Symbol.dispose]();
    });

    it("rejects an idempotencyKey + 'start-new' even on the spent-key dedup path", async () => {
      // engine.start routes idempotencyKey to startWithIdempotency, which returns
      // early on an existing mapping — skipping startWorkflow's own validation.
      // The combination must still be rejected on that path (Codex round-2 #1).
      const engine = createEngine();
      // Seed the idempotency mapping with a first (valid) call.
      const seeded = await engine.start('echo-input', 'seed', {
        idempotencyKey: 'dedup-key',
        defer: false,
      });
      await seeded.result();
      // A repeat call with the same key AND the (illegal) policy must throw, not
      // silently return the existing run.
      await expect(
        engine.start('echo-input', 'again', {
          idempotencyKey: 'dedup-key',
          onTerminalConflict: 'start-new',
        }),
      ).rejects.toBeInstanceOf(StartWorkflowValidationError);
      engine[Symbol.dispose]();
    });

    it('rejects an unknown onTerminalConflict value', async () => {
      const engine = createEngine();
      await expect(
        engine.start('echo-input', null, {
          id: 'bad-policy',
          // Untyped caller smuggling an out-of-union value.
          onTerminalConflict: 'restart' as 'start-new',
        }),
      ).rejects.toBeInstanceOf(StartWorkflowValidationError);
      engine[Symbol.dispose]();
    });
  });

  describe('a rejected start-new leaves the prior terminal run intact (purge is last)', () => {
    it('an oversized restart input does not delete the prior terminal run', async () => {
      const storage = new MemoryStorage();
      const engine = new Engine({ storage, payloadSize: { maxBytes: 64 } });
      engine.register(echoInput);

      const first = await engine.start('echo-input', 'small', {
        id: 'keep-on-reject',
        defer: false,
      });
      expect(await first.result()).toBe('small');
      expect(await statusOf(engine, 'keep-on-reject')).toBe('completed');

      // Oversized restart input: rejected AFTER the duplicate-id decision but
      // BEFORE the destructive purge, so the prior run must survive.
      await expect(
        engine.start('echo-input', 'x'.repeat(1024), {
          id: 'keep-on-reject',
          onTerminalConflict: 'start-new',
        }),
      ).rejects.toThrow();
      const survivor = await engine.get('keep-on-reject');
      expect(survivor?.status).toBe('completed');
      expect(survivor?.input).toBe('small');

      engine[Symbol.dispose]();
    });

    it('an executionTimeout that overflows the timestamp range does not delete the prior run', async () => {
      // executionTimeout is parsed in createInitialWorkflowState — AFTER the
      // duplicate-id decision. With purge-last, this throw must not have deleted
      // the prior terminal run (the generalized form of the oversized-input case).
      const engine = createEngine();
      const first = await engine.start('echo-input', 'original', {
        id: 'overflow-keep',
        defer: false,
      });
      expect(await first.result()).toBe('original');

      await expect(
        engine.start('echo-input', 'replacement', {
          id: 'overflow-keep',
          onTerminalConflict: 'start-new',
          executionTimeout: Number.MAX_SAFE_INTEGER,
        }),
      ).rejects.toThrow();
      const survivor = await engine.get('overflow-keep');
      expect(survivor?.status).toBe('completed');
      expect(survivor?.input).toBe('original');

      engine[Symbol.dispose]();
    });

    it('a create-batch commit failure leaves the prior terminal run fully intact', async () => {
      // The Cursor Bugbot finding: previously the purge committed its own batch
      // BEFORE the create batch, so a failed create stranded the id with no record.
      // Now purge+create are ONE batch — a commit failure rolls back both, so the
      // prior run survives. Inject a one-shot failure on the create commit (the
      // restart's batch carries the new run's `wf:{id}` state put) and assert the
      // prior terminal run is untouched.
      const backing = new MemoryStorage();
      let failNextStatePut = false;
      // Wrap only `batch`; delegate every other method to `backing`. Bind each
      // method to `backing` in the trap — MemoryStorage uses private fields, so a
      // method invoked with the Proxy as `this` would throw. The create commit
      // carries the new run's `wf:commit-fail` state put — fail that one batch once
      // to simulate a mid-commit storage error.
      const storage: Storage = new Proxy(backing, {
        get(target, property, receiver) {
          if (property === 'batch') {
            return async (operations: Parameters<Storage['batch']>[0]) => {
              if (
                failNextStatePut &&
                operations.some(
                  (operation) =>
                    operation.type === 'put' && operation.key === KEYS.workflow('commit-fail'),
                )
              ) {
                failNextStatePut = false;
                throw new Error('injected create-batch failure');
              }
              return target.batch(operations);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const engine = createEngine(storage);

      const first = await engine.start('echo-input', 'survivor', {
        id: 'commit-fail',
        defer: false,
      });
      expect(await first.result()).toBe('survivor');

      failNextStatePut = true;
      await expect(
        engine.start('echo-input', 'replacement', {
          id: 'commit-fail',
          onTerminalConflict: 'start-new',
          defer: false,
        }),
      ).rejects.toThrow('injected create-batch failure');

      // Prior run intact: the purge delete that would have removed it was in the
      // SAME batch as the failed create put, so it never committed. Reads rebuild
      // from storage even though the restart cleared the old run's in-memory caches.
      const survivor = await engine.get('commit-fail');
      expect(survivor?.status).toBe('completed');
      expect(survivor?.input).toBe('survivor');

      engine[Symbol.dispose]();
    });
  });

  it('sweeps the prior run’s timeline keys so a reused id cannot read stale steps', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);

    // `steps-once` takes a durable activity step, so the first run writes a real
    // `wf:{id}:timeline:` entry — the gap this purge prefix fix closes.
    const first = await engine.start('steps-once', null, { id: 'sweep-1', defer: false });
    expect(await first.result()).toBe('stepped');
    expect(await countKeysWithPrefix(storage, KEYS.timelinePrefix('sweep-1'))).toBeGreaterThan(0);

    await engine.start('echo-input', 'fresh', {
      id: 'sweep-1',
      onTerminalConflict: 'start-new',
      defer: false,
    });

    // The restart purged the prior run before creating the new one. The fresh
    // `echo-input` run takes no steps, so zero timeline keys means the old run's
    // timeline lineage was swept (not merely overwritten).
    expect(await countKeysWithPrefix(storage, KEYS.timelinePrefix('sweep-1'))).toBe(0);

    engine[Symbol.dispose]();
  });

  it('does not let the fresh run inherit the prior run’s tags, attributes, or services marker', async () => {
    const storage = new MemoryStorage();
    const engine = createEngine(storage);

    const first = await engine.start('echo-input', 'first', {
      id: 'no-inherit',
      tags: ['old-tag'],
      searchAttributes: { customerId: 'acme' },
      services: { db: {} },
      defer: false,
    });
    await first.result();
    expect(await storage.get(KEYS.workflowHasServices('no-inherit'))).not.toBeNull();

    // Restart with NO tags / attributes / services.
    const second = await engine.start('echo-input', 'second', {
      id: 'no-inherit',
      onTerminalConflict: 'start-new',
      defer: false,
    });
    await second.result();

    const state = await engine.get('no-inherit');
    expect(state?.tags ?? []).not.toContain('old-tag');
    // The prior run's "expects services" marker was swept — the fresh run was
    // started without services, so recovery must not re-provide them.
    expect(await storage.get(KEYS.workflowHasServices('no-inherit'))).toBeNull();
    // The prior run's search-attribute index entry is gone.
    expect(
      await countKeysWithPrefix(storage, KEYS.attributeIndex('customerId', 'acme', 'no-inherit')),
    ).toBe(0);

    engine[Symbol.dispose]();
  });

  it('commits the new run atomically: the overlapping state key carries the NEW run’s value', async () => {
    // Discriminating test for the atomic purge+create fold. The purge delete-set
    // and the create put-set OVERLAP on `wf:{id}` (the workflow state) and the
    // checkpoint key. A non-atomic or wrongly-ordered batch (delete AFTER the put)
    // would clobber the new run's state. Give the overlapping state key a DIFFERENT
    // value old→new (a fresh input) so put-wins is distinguishable from delete-wins.
    //
    // The restart uses `defer: true` so the run parks at `pending` WITHOUT
    // executing — the state read below reflects the START BATCH directly, before
    // any workflow-completion commit could rewrite `wf:{id}`. (With `defer: false`
    // the echo run completes immediately and that completion would re-establish
    // `wf:{id}` with the new input even under a buggy delete-wins start batch,
    // masking the ordering bug. Reading the parked state isolates the start batch.)
    const storage = new MemoryStorage();
    const engine = createEngine(storage);

    const first = await engine.start('echo-input', 'old-input', {
      id: 'atomic-restart',
      defer: false,
    });
    expect(await first.result()).toBe('old-input');

    await engine.start('echo-input', 'new-input', {
      id: 'atomic-restart',
      onTerminalConflict: 'start-new',
      defer: true,
    });

    // The parked run's durable state is exactly what the start batch committed —
    // the new run's `wf:{id}` put survived the same-key delete prepended ahead of
    // it (put-wins). A delete-wins batch would leave no record (engine.get → null).
    const state = await engine.get('atomic-restart');
    expect(state?.input).toBe('new-input');
    expect(state?.status).toBe('pending');
    // The checkpoint key the start batch wrote survived the same-key delete too.
    expect(await storage.get(KEYS.checkpoint('atomic-restart'))).not.toBeNull();

    engine[Symbol.dispose]();
  });

  it('serializes two concurrent start-new calls for one id: exactly one wins', async () => {
    // This is the property that justifies purge-then-start over an atomic CAS
    // batch: the `pendingStarts` reservation is held across purge+create, so two
    // concurrent restarts of the same terminal id cannot both materialize a run.
    // The synchronous `pendingStarts.has` check fires before the first storage
    // await, so the loser rejects deterministically rather than flakily.
    const engine = createEngine();

    const seed = await engine.start('echo-input', 'seed', { id: 'race-restart', defer: false });
    await seed.result();
    expect(await statusOf(engine, 'race-restart')).toBe('completed');

    const startNew = (value: string): Promise<{ id: string }> =>
      engine.start('echo-input', value, {
        id: 'race-restart',
        onTerminalConflict: 'start-new',
        defer: false,
      });

    const settled = await Promise.allSettled([startNew('a'), startNew('b')]);
    const fulfilled = settled.filter(
      (outcome): outcome is PromiseFulfilledResult<{ id: string }> =>
        outcome.status === 'fulfilled',
    );
    const rejected = settled.filter(isRejected);

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(WorkflowAlreadyExistsError);

    // The single winner is the live run. Its durable result is one of the two
    // candidate inputs (whichever won the reservation), proving exactly one run
    // materialized and the loser did not overwrite it.
    const winner = await engine.get('race-restart');
    expect(winner?.status).toBe('completed');
    const durableResult = (await engine.getHandle('race-restart').result()) as string;
    expect(['a', 'b']).toContain(durableResult);
    expect(durableResult).toBe(winner?.input as string);

    engine[Symbol.dispose]();
  });

  it('a stale terminal-cleanup timer for the old run cannot purge the restarted run', async () => {
    // Drive the durable terminal-cleanup timer deterministically: complete the
    // first run, restart under the same id, then advance virtual time past the
    // 60s terminal-cleanup delay so the OLD run's cleanup timer actually fires.
    // Its token-guard reloads state and bails (token mismatch / non-terminal),
    // so it cannot tear down the fresh run that now owns this id.
    await using engine = new TestEngine();
    engine.register(echoInput);
    engine.register(waitsForever);

    const first = await engine.start('echo-input', 'first', { id: 'cleanup-race', defer: false });
    await first.result();

    const second = await engine.start('waits-forever', null, {
      id: 'cleanup-race',
      onTerminalConflict: 'start-new',
      defer: false,
    });
    await flushMicrotasks();
    expect(await statusOf(engine, 'cleanup-race')).toBe('running');

    // Fire the old run's deferred cleanup timer (60s delay) and then some.
    await engine.advanceTime('120s');

    // The restarted run survived the stale cleanup and is still live + signalable.
    expect(await statusOf(engine, 'cleanup-race')).toBe('running');
    await engine.signal('cleanup-race', 'release', 'survived');
    expect(await second.result()).toBe('survived');
  });
});

describe('engine.startOrSignal rejects onTerminalConflict (engine.start-only policy)', () => {
  it('throws when onTerminalConflict is smuggled into startOrSignal options', async () => {
    const engine = createEngine();
    await expect(
      // Cast past the type boundary the way an untyped/transport caller could.
      engine.startOrSignal('echo-input', null, { name: 'go' }, {
        id: 'sos-reject',
        onTerminalConflict: 'start-new',
      } as Record<string, unknown>),
    ).rejects.toBeInstanceOf(StartWorkflowValidationError);
    engine[Symbol.dispose]();
  });
});

import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { sleepForTesting, waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { TestEngine } from '../../testing/test-engine.ts';
import { WorkflowResumedEvent, WorkflowSuspendedEvent } from '../events.ts';
import { normalizeListFilter } from '../list-filter-validation.ts';
import type { WorkflowContext } from '../types.ts';
import { workflow } from '../types.ts';
import { WorkflowSuspendNotSupportedError } from './errors.ts';
import { TERMINAL_STATUSES } from './guards.ts';
import {
  ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING,
  ENGINE_SIGNAL_WAITER_COUNT_FOR_TESTING,
  ENGINE_SLEEP_RESOLVER_COUNT_FOR_TESTING,
  Engine,
} from './index.ts';
import { TERMINAL_WORKFLOW_STATUSES } from './termination.ts';

const workerUrl = new URL('../../workers/test-browser-worker.ts', import.meta.url);

/** Drain microtasks so a deferred inline start advances. */
async function flush(): Promise<void> {
  await sleepForTesting(10);
}

/** Read a workflow's current status (or undefined if it does not exist). */
async function statusOf(engine: Engine, id: string): Promise<string | undefined> {
  const state = await engine.get(id);
  return state?.status;
}

// Parks at a signal so a suspend can land while the run is genuinely paused
// mid-flight (the realistic suspend point), then advances on resume + signal.
const waiter = workflow({ name: 'waits' }).execute(async function* (ctx: WorkflowContext) {
  yield* ctx.waitForSignal('go');
  return 'done';
});

// Parks on ctx.sleep instead of a signal, so a suspend lands while the run is
// blocked on a durable sleep timer (the other realistic suspend point). Drives
// the evictSleepResolversWithoutResolving path: suspend must drop the in-memory
// sleep resolver WITHOUT resolving it and WITHOUT deleting the durable timer.
const sleeper = workflow({ name: 'sleeps' }).execute(async function* (ctx: WorkflowContext) {
  yield* ctx.sleep(5000);
  return 'awake';
});

describe('suspend/resume', () => {
  it('flips a running workflow to the non-terminal suspended status', async () => {
    await using engine = new Engine();
    engine.register(waiter);

    const handle = await engine.start('waits', null, { id: 'sus-1' });
    await flush();
    expect(await statusOf(engine, 'sus-1')).toBe('running');

    await handle.suspend();
    const state = await engine.get('sus-1');
    expect(state?.status).toBe('suspended');
    // The durable checkpoint must survive suspension so resume can re-drive it.
    expect(await engine.getCurrentCheckpointStep('sus-1')).not.toBeNull();
  });

  it('keeps result() pending across suspend, then resolves after resume + completion', async () => {
    await using engine = new Engine();
    engine.register(waiter);

    const handle = await engine.start('waits', null, { id: 'sus-pending' });
    await flush();
    await handle.suspend();

    // The result promise must NOT settle on suspend (unlike cancel, which
    // rejects it). Race it against a short timer to assert it is still pending.
    let settled = false;
    void handle.result().then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await flush();
    expect(settled).toBe(false);

    await handle.resume();
    await flush();
    await engine.signal('sus-pending', 'go');
    expect(await handle.result()).toBe('done');
  });

  it('same-process suspend → resume re-drives the run past the suspend point', async () => {
    // The discriminating test: cross-process resume works trivially (fresh
    // process, no local ownership), but same-process resume must NOT be a no-op
    // via the local-ownership early-return. Assert the run actually advances.
    await using engine = new Engine();
    engine.register(waiter);

    const handle = await engine.start('waits', null, { id: 'sus-same' });
    await flush();
    await handle.suspend();
    expect(await statusOf(engine, 'sus-same')).toBe('suspended');

    await handle.resume();
    await flush();
    // Resume flipped it back to running...
    expect(await statusOf(engine, 'sus-same')).toBe('running');
    // ...and the run is live again: signalling it drives it to completion.
    await engine.signal('sus-same', 'go');
    expect(await handle.result()).toBe('done');
    expect(await statusOf(engine, 'sus-same')).toBe('completed');
  });

  it('is an idempotent no-op when the workflow is not running', async () => {
    await using engine = new Engine();
    engine.register(
      workflow({ name: 'instant' }).execute(async function* () {
        return 1;
      }),
    );

    const handle = await engine.start('instant', null, { id: 'sus-done' });
    expect(await handle.result()).toBe(1);
    expect(await statusOf(engine, 'sus-done')).toBe('completed');

    // Suspending a completed workflow must not change its terminal status.
    await handle.suspend();
    expect(await statusOf(engine, 'sus-done')).toBe('completed');
  });

  it('cancel terminates a suspended workflow and rejects its pending result', async () => {
    // Cancel must be total over non-terminal states: cancelling a suspended
    // workflow transitions it to 'cancelled' AND rejects the still-pending
    // result waiter, so result() cannot hang forever on a suspended-then-
    // abandoned run. (result() taken WHILE suspended — the bootstrap path.)
    await using engine = new Engine();
    engine.register(waiter);

    const handle = await engine.start('waits', null, { id: 'sus-cancel' });
    await flush();
    await handle.suspend();
    expect(await statusOf(engine, 'sus-cancel')).toBe('suspended');

    const resultPromise = handle.result();
    await handle.cancel();
    expect(await statusOf(engine, 'sus-cancel')).toBe('cancelled');
    await expect(resultPromise).rejects.toThrow(/cancelled/i);
  });

  it('rejects a pre-suspend result waiter when a suspended workflow is cancelled', async () => {
    // The other waiter ordering: result() called BEFORE suspend (the existing-
    // resolver path), then the workflow is suspended and cancelled.
    await using engine = new Engine();
    engine.register(waiter);

    const handle = await engine.start('waits', null, { id: 'sus-cancel-pre' });
    await flush();
    const resultPromise = handle.result();
    await handle.suspend();
    expect(await statusOf(engine, 'sus-cancel-pre')).toBe('suspended');
    await handle.cancel();
    expect(await statusOf(engine, 'sus-cancel-pre')).toBe('cancelled');
    await expect(resultPromise).rejects.toThrow(/cancelled/i);
  });

  it('recoverAll skips suspended workflows (no auto-recovery, no throw)', async () => {
    const storage = new MemoryStorage();
    {
      using original = new Engine({ storage });
      original.register(waiter);
      const handle = await original.start('waits', null, { id: 'sus-recover' });
      await flush();
      await handle.suspend();
      expect(await statusOf(original, 'sus-recover')).toBe('suspended');
    }

    await using recovered = new Engine({ storage });
    recovered.register(waiter);
    const handles = await recovered.recoverAll();
    // The suspended workflow is NOT among the auto-recovered handles.
    expect(handles.some((candidate) => candidate.id === 'sus-recover')).toBe(false);
    // ...but it is still visible and still suspended.
    expect(await statusOf(recovered, 'sus-recover')).toBe('suspended');
  });

  it('cross-process: suspend + dispose, then explicit resume in a fresh engine', async () => {
    const storage = new MemoryStorage();
    {
      using original = new Engine({ storage });
      original.register(waiter);
      const handle = await original.start('waits', null, { id: 'sus-xproc' });
      await flush();
      await handle.suspend();
    }

    await using fresh = new Engine({ storage });
    fresh.register(waiter);
    // recoverAll skips it; resume it explicitly.
    await fresh.recoverAll();
    const handle = await fresh.resume('sus-xproc');
    await flush();
    expect(await statusOf(fresh, 'sus-xproc')).toBe('running');
    await fresh.signal('sus-xproc', 'go');
    expect(await handle.result()).toBe('done');
  });

  it('engine.resume throws for a terminal workflow', async () => {
    await using engine = new Engine();
    engine.register(
      workflow({ name: 'instant2' }).execute(async function* () {
        return 1;
      }),
    );
    const handle = await engine.start('instant2', null, { id: 'res-terminal' });
    await handle.result();
    await expect(engine.resume('res-terminal')).rejects.toThrow(/status is "completed"/);
  });

  it('list filter accepts suspended as a valid status', () => {
    // The visibility-filter contract: list({ status: 'suspended' }) must be
    // ACCEPTED by the canonical normalizer, not rejected as an unknown status.
    expect(() => normalizeListFilter({ status: 'suspended' })).not.toThrow();
    expect(normalizeListFilter({ status: 'suspended' }).status).toBe('suspended');
    expect(normalizeListFilter({ status: ['running', 'suspended'] }).status).toEqual([
      'running',
      'suspended',
    ]);
  });

  it('engine.list filters by suspended status', async () => {
    await using engine = new Engine();
    engine.register(waiter);
    const handle = await engine.start('waits', null, { id: 'sus-list' });
    await flush();
    await handle.suspend();

    const suspended = await engine.list({ status: 'suspended' });
    expect(suspended.items.some((summary) => summary.id === 'sus-list')).toBe(true);

    const running = await engine.list({ status: 'running' });
    expect(running.items.some((summary) => summary.id === 'sus-list')).toBe(false);
  });

  it('the two terminal-status sets agree and exclude suspended (drift guard)', () => {
    // guards.ts TERMINAL_STATUSES and termination/cleanup.ts
    // TERMINAL_WORKFLOW_STATUSES are duplicated; they must stay equal, and
    // neither may classify 'suspended' as terminal.
    expect([...TERMINAL_STATUSES].toSorted()).toEqual([...TERMINAL_WORKFLOW_STATUSES].toSorted());
    expect(TERMINAL_STATUSES.has('suspended')).toBe(false);
    expect(TERMINAL_WORKFLOW_STATUSES.has('suspended')).toBe(false);
  });

  it('is idempotent on an already-suspended workflow', async () => {
    await using engine = new Engine();
    engine.register(waiter);
    const handle = await engine.start('waits', null, { id: 'sus-double' });
    await flush();
    await handle.suspend();
    expect(await statusOf(engine, 'sus-double')).toBe('suspended');
    // A second suspend on an already-suspended workflow is a no-op (the CAS is
    // gated to 'running'), not an error.
    await handle.suspend();
    expect(await statusOf(engine, 'sus-double')).toBe('suspended');
  });

  it('evicts the inline park marker on suspend; a signal then buffers and replays on resume', async () => {
    // The discriminating wake-path test. An inline workflow blocked on
    // waitForSignal parks via `parkedInlineWorkflows` (not a persistent
    // signalWaiters entry). Suspend must evict that marker so a signal arriving
    // while suspended buffers durably instead of waking the parked run against
    // its now-gone generator. On resume the buffered signal is consumed.
    await using engine = new Engine();
    engine.register(waiter);

    const handle = await engine.start('waits', null, { id: 'sus-waiter' });
    // Parked on waitForSignal('go') → exactly one parked inline workflow.
    await waitForCondition(() => engine[ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING]() === 1, {
      label: 'inline workflow parked on waitForSignal',
    });

    await handle.suspend();
    // Suspend evicted the park marker (and any signal waiter): no wake path left.
    expect(engine[ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING]()).toBe(0);
    expect(engine[ENGINE_SIGNAL_WAITER_COUNT_FOR_TESTING]()).toBe(0);

    // Signal while suspended: it must buffer durably, NOT drive the parked run.
    await engine.signal('sus-waiter', 'go');
    await flush();
    expect(await statusOf(engine, 'sus-waiter')).toBe('suspended');

    // Resume re-drives; the buffered signal is consumed and the run completes.
    await handle.resume();
    await flush();
    expect(await handle.result()).toBe('done');
  });

  it('a signal fired concurrently with suspend does not wake the run (in-memory teardown precedes the durable commit)', async () => {
    // The RACE complement to the test above. Signal delivery (deliverBufferedSignals)
    // is NOT gated behind the per-workflow serialized write lock and only skips
    // TERMINAL workflows ('suspended' is non-terminal). If suspend committed the
    // durable 'suspended' status BEFORE evicting the in-memory waiter/park-marker,
    // a signal interleaving at that microtask boundary would find a live wake path
    // and drive the not-yet-evicted generator to completion. suspend evicts all
    // in-memory execution state BEFORE the durable commit, so firing the signal and
    // the suspend concurrently must still land 'suspended' with result() unsettled —
    // the signal buffers durably and only replays on a later resume.
    await using engine = new Engine();
    engine.register(waiter);

    const handle = await engine.start('waits', null, { id: 'sus-race' });
    await waitForCondition(() => engine[ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING]() === 1, {
      label: 'inline workflow parked on waitForSignal',
    });

    let settled = false;
    void handle.result().then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    // Fire suspend and the signal concurrently — interleave them at the microtask
    // level rather than the sequential suspend-then-signal ordering above.
    await Promise.all([handle.suspend(), engine.signal('sus-race', 'go')]);
    await flush();

    // The run did NOT advance: it is suspended, not completed, and result() is
    // still pending. The concurrent signal buffered durably instead of waking it.
    expect(await statusOf(engine, 'sus-race')).toBe('suspended');
    expect(settled).toBe(false);
    expect(engine[ENGINE_PARKED_WORKFLOW_COUNT_FOR_TESTING]()).toBe(0);
    expect(engine[ENGINE_SIGNAL_WAITER_COUNT_FOR_TESTING]()).toBe(0);

    // Resume consumes the buffered signal and drives the run to completion.
    await handle.resume();
    await flush();
    expect(await handle.result()).toBe('done');
    expect(await statusOf(engine, 'sus-race')).toBe('completed');
  });

  it('evicts the sleep resolver without resolving it; the durable sleep timer survives and re-arms on resume', async () => {
    // The sleep-case complement to the park-marker/signal test above, and the
    // correctness proof for evictSleepResolversWithoutResolving. An inline run
    // blocked on ctx.sleep registers an in-memory sleep RESOLVER and a durable
    // sleep TIMER. Suspend must DELETE the resolver (not call it — resolving
    // would drive the now-evicted generator) while leaving the durable timer
    // untouched, so resume replays the sleep from storage and the run completes.
    const engine = new TestEngine({ startTime: 0 });
    engine.register(sleeper);
    try {
      const handle = await engine.start('sleeps', null, { id: 'sus-sleep' });
      // Wait until the run has parked on the sleep: exactly one in-memory sleep
      // resolver registered.
      await waitForCondition(() => engine[ENGINE_SLEEP_RESOLVER_COUNT_FOR_TESTING]() === 1, {
        label: 'inline workflow parked on ctx.sleep',
      });

      // The durable sleep timer exists in storage before suspend.
      const sleepTimerIndexKeys = async (): Promise<string[]> => {
        const keys: string[] = [];
        for await (const [key] of engine.storage.scan('timer-idx:sleep:')) keys.push(key);
        return keys;
      };
      const timerKeysBeforeSuspend = await sleepTimerIndexKeys();
      expect(timerKeysBeforeSuspend.length).toBe(1);

      await handle.suspend();
      expect(await statusOf(engine, 'sus-sleep')).toBe('suspended');
      // The in-memory sleep resolver was EVICTED (deleted, not resolved)...
      expect(engine[ENGINE_SLEEP_RESOLVER_COUNT_FOR_TESTING]()).toBe(0);
      // ...but the durable sleep timer SURVIVES so resume can replay it.
      const timerKeysAfterSuspend = await sleepTimerIndexKeys();
      expect(timerKeysAfterSuspend.length).toBe(1);

      // Advancing time while suspended must NOT complete the run: it is parked,
      // not sleeping, and resolving the evicted resolver was never wired up.
      await engine.advanceTime('10 seconds');
      await flush();
      expect(await statusOf(engine, 'sus-sleep')).toBe('suspended');

      // Resume re-drives the generator, which replays the sleep from the durable
      // timer. Because virtual time is already past the fire time, the next scan
      // completes the sleep and the workflow finishes — proving resume re-armed
      // the sleep instead of hanging.
      await handle.resume();
      await flush();
      await engine.advanceTime('1 second');
      await flush();
      expect(await handle.result()).toBe('awake');
      expect(await statusOf(engine, 'sus-sleep')).toBe('completed');
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('preserves in-memory services across an in-process suspend → resume', async () => {
    // suspend deliberately does NOT clear workflowServices (unlike terminal
    // cleanup), so an in-process resume reuses the original non-serialized value.
    const sentinel = { db: 'live-connection' };
    let observed: unknown;
    await using engine = new Engine();
    engine.register(
      workflow({ name: 'reads-services' }).execute(async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('go');
        observed = ctx.services;
        return 'ok';
      }),
    );

    const handle = await engine.start('reads-services', null, {
      id: 'sus-services',
      services: sentinel,
    });
    await flush();
    await handle.suspend();
    await handle.resume();
    await flush();
    await engine.signal('sus-services', 'go');
    expect(await handle.result()).toBe('ok');
    // The resumed run read the SAME services value provided at start.
    expect(observed).toBe(sentinel);
  });

  it('dispatches WorkflowSuspendedEvent on suspend and WorkflowResumedEvent on resume', async () => {
    await using engine = new Engine();
    engine.register(waiter);

    const suspendedIds: string[] = [];
    const resumedIds: string[] = [];
    engine.addEventListener('workflow:suspended', (event) => {
      suspendedIds.push((event as WorkflowSuspendedEvent).workflowId);
    });
    engine.addEventListener('workflow:resumed', (event) => {
      resumedIds.push((event as WorkflowResumedEvent).workflowId);
    });

    const handle = await engine.start('waits', null, { id: 'sus-events' });
    await flush();
    await handle.suspend();
    expect(suspendedIds).toEqual(['sus-events']);

    await handle.resume();
    await flush();
    expect(resumedIds).toContain('sus-events');
  });

  it('re-arms the absolute execution deadline on resume (times out if already past)', async () => {
    // The deadline is absolute wall-clock: suspension does not extend it. A
    // workflow resumed after its deadline has elapsed must time out, not run on.
    const engine = new TestEngine();
    engine.register(waiter);
    try {
      const handle = await engine.start('waits', null, {
        id: 'sus-deadline',
        executionTimeout: '5 seconds',
      });
      handle.result().catch(() => {});
      await flush();
      await handle.suspend();
      expect(await statusOf(engine, 'sus-deadline')).toBe('suspended');

      // Advance virtual time well past the absolute deadline while suspended,
      // then resume. The re-armed timer is already due, so the next scheduler
      // scan times the workflow out instead of letting it run on.
      await engine.advanceTime('10 seconds');
      await handle.resume();
      await flush();
      await engine.advanceTime('1 second');
      await flush();
      expect(await statusOf(engine, 'sus-deadline')).toBe('timed-out');
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('throws WorkflowSuspendNotSupportedError only for a running worker workflow', async () => {
    await using engine = new Engine({
      storage: new MemoryStorage(),
      workflowExecutionMode: 'worker',
      workerExecution: { workerUrl, poolSize: 1, workflowTurnTimeoutMs: 30_000 },
    });
    engine.register(waiter);

    const handle = await engine.start('waits', null, { id: 'sus-worker' });
    await flush();
    // A running worker workflow cannot be parked without cancelling it.
    await expect(handle.suspend()).rejects.toBeInstanceOf(WorkflowSuspendNotSupportedError);

    // State-dependent, not mode-dependent: suspend on an UNKNOWN workflow is a
    // no-op even in worker mode (it never reaches the unsupported-mode throw).
    await expect(engine.suspend('does-not-exist')).resolves.toBeUndefined();
  });
});

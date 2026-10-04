/**
 * What abandoning a workflow after a lost checkpoint compare-and-swap does and
 * refuses to do under `ownership: 'none'`.
 *
 * The loser marks the generation it holds for the id as abandoned (the execution
 * attempt registry, `execution-attempts.ts`), retires its execution, rejects the
 * pending `result()` waiter, evicts the cached handle, and warns. It releases
 * nothing else and writes nothing: every later wake, terminal failure, and
 * `result()` for that generation is refused instead. The two-engine race that
 * produces a real loss lives in `checkpoint-conflict.test.ts`; these tests drive
 * the abandonment directly, or force one loss through a storage wrapper, and
 * watch what the engine writes. `generation-lifecycle-matrix.test.ts` crosses the
 * states a run can be in with the events that reach it.
 */
import { describe, expect, it, mock, spyOn } from 'bun:test';

import { KEYS, type Storage } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import {
  createDeferred,
  expectPromisePending,
  waitForCondition,
  yieldToEventLoop,
} from '../../testing/fake-timers.test-support.ts';
import { rejectionOf } from '../../testing/promise-outcome.test-support.ts';
import { decode, encode } from '../codec/api.ts';
import { durableActivity, DurableActivityScopeError } from '../context/durable-activity.ts';
import type { RemoteActivityBroker, RemoteActivityTaskRequest } from '../remote-activity-broker.ts';
import {
  activity,
  workflow,
  type Checkpoint,
  type EngineOptions,
  type ScheduleState,
  type StartOptions,
  type TimerEntry,
  type WorkflowContext,
  type WorkflowState,
} from '../types.ts';
import { createLifecycleCallbacks } from './callback-creators-core.ts';
import { createScheduleCallbacks } from './callback-creators-schedule.ts';
import {
  adoptLaunchCheckpoint,
  getCommittedCheckpointBytes,
  releaseLaunchCheckpoint,
  releaseSuspendedCheckpoint,
} from './checkpoint-commit-snapshots.ts';
import {
  abandonWorkflowAfterCheckpointConflict,
  emitCheckpointConflictWarning,
  persistCheckpointAbandoningOnConflict,
} from './checkpoint-conflict-abandon.ts';
import {
  WeftWorkflowCheckpointConflictWarning,
  WorkflowCheckpointConflictError,
} from './checkpoint-conflict-error.ts';
import {
  collectConflictWarnings,
  holdFailureAtItsFirstRead,
  interceptConflictWarnings,
  loseGeneration,
  noCallbacks,
  parkedOnSignal,
  readStatus,
  recordWrites,
  rejectionOrPending,
  startParked,
  tokenOf,
  WRITE_METHODS,
  writeOperations,
} from './checkpoint-conflict.test-support.ts';
import { notifyConditionWaiters } from './condition-waiters.ts';
import { WorkflowAlreadyExistsError } from './errors.ts';
import {
  abandonedExecutionAttemptCount,
  abandonExecutionAttempt,
  currentExecutionAttempt,
  isGenerationAbandoned,
  staleFailureGuard,
} from './execution-attempts.ts';
import {
  createWorkflowResultWaiter,
  getGeneratorOwnedWorkflowResultPromise,
} from './handle-result.ts';
import { WorkflowHandle } from './handles.ts';
import { Engine } from './index.ts';
import { getInternals, type EngineInternals } from './internals.ts';
import { resume as resumeFromLifecycle } from './lifecycle.ts';
import { startScheduledRun } from './schedule-run.ts';
import { registerSignalWaiter } from './signals.ts';
import { failWorkflow } from './termination/complete.ts';
import { confirmWakeOwnership } from './wake-ownership-guard.ts';

/**
 * Wrap `base` so the first checkpoint write for `workflowId` after `armed` is
 * set lands behind a checkpoint another writer just replaced, then record every
 * write attempted once that commit has lost.
 */
function createLosingStorage(base: Storage, workflowId: string, armed: { value: boolean }) {
  const checkpointKey = KEYS.checkpoint(workflowId);
  const state = { injected: false, lost: false, writesAfterLoss: [] as string[] };
  const storage = new Proxy(base, {
    get(target, property) {
      const original: unknown = Reflect.get(target, property, target);
      if (typeof original !== 'function') return original;
      const name = String(property);
      if (!WRITE_METHODS.includes(name)) return original.bind(target);
      return async (...argumentsList: unknown[]) => {
        if (state.lost) state.writesAfterLoss.push(name);
        const operations = writeOperations(name, argumentsList);
        const writesCheckpoint =
          operations?.some(
            (operation) => operation.type === 'put' && operation.key === checkpointKey,
          ) === true;
        if (armed.value && !state.injected && writesCheckpoint) {
          state.injected = true;
          await target.put(checkpointKey, new Uint8Array([0xff]));
        }
        const result: unknown = await original.apply(target, argumentsList);
        if (state.injected && result === false) state.lost = true;
        return result;
      };
    },
  });
  return { storage, state };
}

/** Record strategy calls, still calling through, so retirement is observable. */
function observeStrategy(internals: EngineInternals) {
  const retired: string[] = [];
  const cancelled: string[] = [];
  const original = internals.strategy;
  internals.strategy = new Proxy(original, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property, target);
      if (property === 'retireWorkflow') {
        return (workflowId: string) => {
          retired.push(workflowId);
          (member as (id: string) => void).call(target, workflowId);
        };
      }
      if (property === 'cancelWorkflow') {
        return (workflowId: string) => {
          cancelled.push(workflowId);
          (member as (id: string) => void).call(target, workflowId);
        };
      }
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
  return { retired, cancelled, restore: () => (internals.strategy = original) };
}

interceptConflictWarnings();

describe('abandoning a workflow after a lost checkpoint compare-and-swap', () => {
  it('marks the lost generation, retires it, rejects the waiter, evicts the handle, and releases nothing', async () => {
    const watched = recordWrites(new MemoryStorage());
    await using engine = new Engine({ storage: watched.storage });
    const internals = getInternals(engine);
    const handle = await startParked(engine, 'lost-run', 'lost-run');
    const pendingResult = handle.result();
    const strategy = observeStrategy(internals);
    const held = () => [
      internals.checkpoints.has('lost-run'),
      internals.parkedInlineWorkflows.has('lost-run'),
      internals.eventLogHeads.has('lost-run'),
      internals.workflowVersionTuples.has('lost-run'),
      internals.cancelHandlersByWorkflow.has('lost-run'),
      internals.durableInlineOperations.has('lost-run'),
    ];
    const before = held();
    const checkpointBefore = internals.checkpoints.get('lost-run');
    expect(before.slice(0, 2)).toEqual([true, true]);
    expect(internals.handleCache.has('lost-run')).toBe(true);
    watched.writes.length = 0;
    const warning = collectConflictWarnings();

    try {
      loseGeneration(internals, 'lost-run');
      // A second report of the same loss does nothing: one warning, one retire.
      loseGeneration(internals, 'lost-run');
      await warning.received;
    } finally {
      warning.stop();
      strategy.restore();
    }

    const reason = await rejectionOf(pendingResult);
    expect(reason).toBeInstanceOf(WorkflowCheckpointConflictError);
    expect((reason as WorkflowCheckpointConflictError).workflowId).toBe('lost-run');
    expect(isGenerationAbandoned(internals, 'lost-run', tokenOf(internals, 'lost-run'))).toBe(true);
    expect(abandonedExecutionAttemptCount(internals)).toBe(1);
    expect(strategy.retired).toEqual(['lost-run']);
    expect(strategy.cancelled).toEqual([]);
    expect(internals.resultResolvers.has('lost-run')).toBe(false);
    // The cached handle is gone, so a later getHandle() builds a fresh one.
    expect(internals.handleCache.has('lost-run')).toBe(false);
    expect(engine.getHandle('lost-run')).not.toBe(handle);
    // Nothing else was released, and nothing was written.
    expect(held()).toEqual(before);
    expect(internals.checkpoints.get('lost-run')).toBe(checkpointBefore);
    expect(warning.warnings.map((emitted) => emitted.workflowId)).toEqual(['lost-run']);
    expect(watched.writes).toEqual([]);
  });

  it('finishes abandoning when the strategy cannot retire the execution', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    const handle = await startParked(engine, 'unreachable-run', 'unreachable-run');
    const pendingResult = handle.result();
    const activeStrategy = internals.strategy;
    internals.strategy = new Proxy(activeStrategy, {
      get(target, property) {
        if (property === 'retireWorkflow') {
          return () => {
            throw new Error('worker channel closed');
          };
        }
        const original: unknown = Reflect.get(target, property, target);
        return typeof original === 'function' ? original.bind(target) : original;
      },
    });
    const warning = collectConflictWarnings();
    try {
      loseGeneration(internals, 'unreachable-run');
      await warning.received;
    } finally {
      warning.stop();
      internals.strategy = activeStrategy;
    }

    expect(await rejectionOf(pendingResult)).toBeInstanceOf(WorkflowCheckpointConflictError);
    expect(abandonedExecutionAttemptCount(internals)).toBe(1);
    expect(internals.handleCache.has('unreachable-run')).toBe(false);
  });

  it('ignores a loss that does not name the generation the engine currently holds', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    const strategy = observeStrategy(internals);
    adoptLaunchCheckpoint(internals, 'lost-generation', {
      workflowExecutionToken: 'current-generation',
    } as Checkpoint);

    abandonWorkflowAfterCheckpointConflict(
      internals,
      new WorkflowCheckpointConflictError('lost-generation', {
        workflowExecutionToken: 'older-generation',
      }),
    );
    abandonWorkflowAfterCheckpointConflict(
      internals,
      new WorkflowCheckpointConflictError('lost-generation'),
    );
    strategy.restore();

    expect(abandonedExecutionAttemptCount(internals)).toBe(0);
    expect(strategy.retired).toEqual([]);
  });

  it('leaves a replacement generation under the same id alone, through the production start-new path', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    engine.register(parkedOnSignal('replaced-run'));
    const first = await engine.start('replaced-run', null, { id: 'replaced-run' });
    await waitForCondition(() => internals.parkedInlineWorkflows.has('replaced-run'), {
      label: 'first generation parked',
    });
    const firstToken = tokenOf(internals, 'replaced-run');
    await engine.signal('replaced-run', 'go', 'first');
    expect(await first.result()).toBe('first');

    const second = await engine.start('replaced-run', null, {
      id: 'replaced-run',
      onTerminalConflict: 'start-new',
    });
    await waitForCondition(() => internals.parkedInlineWorkflows.has('replaced-run'), {
      label: 'replacement generation parked',
    });
    expect(tokenOf(internals, 'replaced-run')).not.toBe(firstToken);
    const strategy = observeStrategy(internals);
    const warning = collectConflictWarnings();

    // The first generation's commit lost; its error reaches the engine only now.
    abandonWorkflowAfterCheckpointConflict(
      internals,
      new WorkflowCheckpointConflictError('replaced-run', { workflowExecutionToken: firstToken }),
    );
    await yieldToEventLoop();
    warning.stop();
    strategy.restore();

    expect(warning.warnings).toEqual([]);
    expect(strategy.retired).toEqual([]);
    expect(abandonedExecutionAttemptCount(internals)).toBe(0);
    await engine.signal('replaced-run', 'go', 'second');
    expect(await second.result()).toBe('second');
  });

  it('ends an abandonment when the engine launches the id again, and on disposal', async () => {
    const engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    const launch = (token: string | undefined) =>
      adoptLaunchCheckpoint(internals, 'relaunched', {
        workflowExecutionToken: token,
      } as Checkpoint);

    // The engine holds generation 1. A loss that names another generation is not this one's.
    launch('generation-1');
    expect(abandonExecutionAttempt(internals, 'relaunched', undefined)).toBe(false);
    expect(abandonExecutionAttempt(internals, 'relaunched', 'generation-2')).toBe(false);
    expect(abandonedExecutionAttemptCount(internals)).toBe(0);
    expect(abandonExecutionAttempt(internals, 'relaunched', 'generation-1')).toBe(true);
    expect(abandonExecutionAttempt(internals, 'relaunched', 'generation-1')).toBe(false);
    expect(abandonedExecutionAttemptCount(internals)).toBe(1);

    // A replacement generation is a new attempt, so the abandonment ended with the attempt it
    // belonged to; there is no marker left that could apply to a later run under the id.
    launch('generation-2');
    expect(abandonedExecutionAttemptCount(internals)).toBe(0);
    expect(isGenerationAbandoned(internals, 'relaunched', 'generation-1')).toBe(false);

    // Launching the abandoned generation itself again is a new, healthy attempt too.
    launch('generation-1');
    abandonExecutionAttempt(internals, 'relaunched', 'generation-1');
    launch('generation-1');
    expect(abandonedExecutionAttemptCount(internals)).toBe(0);

    // A pre-token run is abandoned under the token-less identity, and a token-bearing
    // replacement ends it like any other.
    launch(undefined);
    expect(abandonExecutionAttempt(internals, 'relaunched', undefined)).toBe(true);
    expect(isGenerationAbandoned(internals, 'relaunched', undefined)).toBe(true);
    launch('generation-3');
    expect(isGenerationAbandoned(internals, 'relaunched', undefined)).toBe(false);

    abandonExecutionAttempt(internals, 'relaunched', 'generation-3');
    await engine[Symbol.asyncDispose]();
    expect(abandonedExecutionAttemptCount(internals)).toBe(0);
    expect(currentExecutionAttempt(internals, 'relaunched')).toBeUndefined();
  });

  it('retires and rejects a pre-token generation and abandons it under the token-less identity', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    const handle = await startParked(engine, 'legacy-run', 'legacy-run');
    const pendingResult = handle.result();
    // A run recovered from before execution tokens existed carries none, and this engine
    // launched it through its launch path.
    const legacyCheckpoint = { ...internals.checkpoints.get('legacy-run')! };
    delete legacyCheckpoint.workflowExecutionToken;
    adoptLaunchCheckpoint(internals, 'legacy-run', legacyCheckpoint);
    const strategy = observeStrategy(internals);
    const warning = collectConflictWarnings();
    try {
      abandonWorkflowAfterCheckpointConflict(
        internals,
        new WorkflowCheckpointConflictError('legacy-run', { workflowExecutionToken: undefined }),
      );
      await warning.received;
    } finally {
      warning.stop();
      strategy.restore();
    }

    expect(await rejectionOf(pendingResult)).toBeInstanceOf(WorkflowCheckpointConflictError);
    expect(strategy.retired).toEqual(['legacy-run']);
    expect(internals.handleCache.has('legacy-run')).toBe(false);
    // The token-less generation is held by an attempt too, so it is refused like any other.
    expect(abandonedExecutionAttemptCount(internals)).toBe(1);
    expect(isGenerationAbandoned(internals, 'legacy-run', undefined)).toBe(true);
    // A second report of the same loss still does nothing.
    abandonWorkflowAfterCheckpointConflict(
      internals,
      new WorkflowCheckpointConflictError('legacy-run', { workflowExecutionToken: undefined }),
    );
    expect(abandonedExecutionAttemptCount(internals)).toBe(1);
    expect(strategy.retired).toEqual(['legacy-run']);
  });

  it('rejects result() through a fresh handle after a pre-token generation was abandoned', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    const handle = await startParked(engine, 'legacy-fresh', 'legacy-fresh');
    const pendingResult = handle.result();
    const legacyCheckpoint = { ...internals.checkpoints.get('legacy-fresh')! };
    delete legacyCheckpoint.workflowExecutionToken;
    adoptLaunchCheckpoint(internals, 'legacy-fresh', legacyCheckpoint);
    const warning = collectConflictWarnings();
    abandonWorkflowAfterCheckpointConflict(
      internals,
      new WorkflowCheckpointConflictError('legacy-fresh', { workflowExecutionToken: undefined }),
    );
    await warning.received;
    warning.stop();
    expect(await rejectionOf(pendingResult)).toBeInstanceOf(WorkflowCheckpointConflictError);

    // The abandoned generation is still the one this engine holds, so a handle obtained
    // after the loss must observe it: under 'none' nothing would ever settle a new waiter.
    const freshReason = await rejectionOrPending(engine.getHandle('legacy-fresh').result());

    expect(freshReason).toBeInstanceOf(WorkflowCheckpointConflictError);
    expect((freshReason as WorkflowCheckpointConflictError).workflowId).toBe('legacy-fresh');
    expect(internals.resultResolvers.has('legacy-fresh')).toBe(false);
  });

  it('refuses wakes for a pre-token generation until a token-bearing replacement or a relaunch ends the abandonment', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    adoptLaunchCheckpoint(internals, 'legacy-wake', {} as Checkpoint);
    expect(abandonExecutionAttempt(internals, 'legacy-wake', undefined)).toBe(true);
    // An id this engine holds no attempt for holds no generation, so there is nothing to
    // refuse, whatever was reported for it.
    expect(abandonExecutionAttempt(internals, 'never-held', undefined)).toBe(false);

    expect(await confirmWakeOwnership(internals, 'legacy-wake', 'signal')).toBe('discard');
    expect(await confirmWakeOwnership(internals, 'never-held', 'signal')).toBe('proceed');

    // A token-bearing replacement can never be the pre-token run.
    adoptLaunchCheckpoint(internals, 'legacy-wake', {
      workflowExecutionToken: 'replacement',
    } as Checkpoint);
    expect(isGenerationAbandoned(internals, 'legacy-wake', undefined)).toBe(false);
    expect(await confirmWakeOwnership(internals, 'legacy-wake', 'signal')).toBe('proceed');

    // Launching the same pre-token generation again ends the abandonment of its earlier attempt.
    adoptLaunchCheckpoint(internals, 'legacy-wake', {} as Checkpoint);
    expect(abandonExecutionAttempt(internals, 'legacy-wake', undefined)).toBe(true);
    expect(await confirmWakeOwnership(internals, 'legacy-wake', 'signal')).toBe('discard');
    adoptLaunchCheckpoint(internals, 'legacy-wake', {} as Checkpoint);
    expect(isGenerationAbandoned(internals, 'legacy-wake', undefined)).toBe(false);
    expect(await confirmWakeOwnership(internals, 'legacy-wake', 'signal')).toBe('proceed');
  });

  it('keeps the abandonment when a resume of the abandoned generation fails after relaunching it', async () => {
    const storage = new MemoryStorage();
    const first = await Engine.create({
      storage,
      recover: false,
      workflows: { 'resume-retry': parkedOnSignal('resume-retry') },
    });
    await first.start('resume-retry', null, { id: 'resume-retry' });
    await waitForCondition(() => getInternals(first).parkedInlineWorkflows.has('resume-retry'), {
      label: 'resume-retry parked on its signal',
    });
    await first[Symbol.asyncDispose]();
    const state = decode((await storage.get(KEYS.workflow('resume-retry')))!) as WorkflowState;
    const token = state.workflowExecutionToken;
    expect(token).toBeDefined();

    // The child-cancellation rehydration runs after the checkpoint is adopted.
    const failingScan = new Proxy(storage, {
      get(target, property) {
        if (property === 'scan') {
          return (prefix: string, ...rest: unknown[]) => {
            if (prefix === KEYS.childCancellationPrefix('resume-retry')) {
              throw new Error('storage scan unavailable');
            }
            return (target.scan as (...args: unknown[]) => unknown)(prefix, ...rest);
          };
        }
        const original: unknown = Reflect.get(target, property, target);
        return typeof original === 'function' ? original.bind(target) : original;
      },
    });
    await using second = await Engine.create({
      storage: failingScan,
      recover: false,
      workflows: { 'resume-retry': parkedOnSignal('resume-retry') },
    });
    const internals = getInternals(second);
    // The engine suspended this generation and then lost it: the checkpoint is released, the
    // attempt stays, and resuming it is what relaunches it.
    adoptLaunchCheckpoint(internals, 'resume-retry', {
      workflowExecutionToken: token,
    } as Checkpoint);
    releaseSuspendedCheckpoint(internals, 'resume-retry', token);
    expect(abandonExecutionAttempt(internals, 'resume-retry', token)).toBe(true);

    expect(await rejectionOf(second.resume('resume-retry'))).toBeInstanceOf(Error);
    expect(isGenerationAbandoned(internals, 'resume-retry', token)).toBe(true);
  });

  it('warns through console.warn where the runtime has no process.emitWarning', () => {
    const warning = new WeftWorkflowCheckpointConflictWarning('browser-run');
    const consoleWarn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      emitCheckpointConflictWarning(warning, null);
      expect(consoleWarn).toHaveBeenCalledWith(warning);
    } finally {
      consoleWarn.mockRestore();
    }
    const emitted: Error[] = [];
    emitCheckpointConflictWarning(warning, { emitWarning: (value) => emitted.push(value) });
    expect(emitted).toEqual([warning]);
  });
});

describe('persistCheckpointAbandoningOnConflict', () => {
  it('returns the persist promise itself, so a successful persist settles with no extra hop', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const persisted = Promise.resolve();

    expect(
      persistCheckpointAbandoningOnConflict(getInternals(engine), 'persisting', () => persisted),
    ).toBe(persisted);
    await persisted;
    expect(abandonedExecutionAttemptCount(getInternals(engine))).toBe(0);
  });

  it('abandons before the caller observes a conflict, and rethrows anything else untouched', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    adoptLaunchCheckpoint(internals, 'persisting', {
      workflowExecutionToken: 'token',
    } as Checkpoint);
    const conflict = new WorkflowCheckpointConflictError('persisting', {
      workflowExecutionToken: 'token',
    });
    const warning = collectConflictWarnings();

    const reason = await rejectionOf(
      persistCheckpointAbandoningOnConflict(internals, 'persisting', () =>
        Promise.reject(conflict),
      ),
    );
    await warning.received;
    warning.stop();

    expect(reason).toBe(conflict);
    expect(isGenerationAbandoned(internals, 'persisting', 'token')).toBe(true);

    const failure = new Error('storage unavailable');
    expect(
      await rejectionOf(
        persistCheckpointAbandoningOnConflict(internals, 'persisting', () =>
          Promise.reject(failure),
        ),
      ),
    ).toBe(failure);
    expect(abandonedExecutionAttemptCount(internals)).toBe(1);
  });

  it('abandons at the durableActivity retry-sleep persist without delivering the error to user code', async () => {
    const base = new MemoryStorage();
    const armed = { value: false };
    const { storage, state } = createLosingStorage(base, 'retry-conflict', armed);
    const observedInMemoCallback: unknown[] = [];
    const observedByWorkflow: unknown[] = [];
    let attempts = 0;
    const flakyTool = activity({
      name: 'flakyTool',
      retry: { maxAttempts: 2, initialBackoff: 1_000, backoffMultiplier: 1, maxBackoff: 1_000 },
      execute: async () => {
        attempts += 1;
        if (attempts === 1) {
          // The retry-sleep checkpoint persist is the next checkpoint write.
          armed.value = true;
          throw new Error('transient failure');
        }
        return 'done';
      },
      verify: (_result, context) =>
        context?.phase === 'pre-dispatch-reconciliation' ? 'not-completed' : true,
    });
    const definition = workflow({ name: 'retry-conflict' })
      .activities({ flakyTool })
      .execute(async function* (context: WorkflowContext) {
        try {
          return yield* context.memo('step-0', async () => {
            try {
              return await durableActivity(flakyTool, { idempotencyKey: 'retry:conflict' });
            } catch (error) {
              observedInMemoCallback.push(error);
              throw error;
            }
          });
        } catch (error) {
          observedByWorkflow.push(error);
          throw error;
        }
      });
    const warning = collectConflictWarnings();
    await using engine = new Engine({ storage, getNow: () => 0 });
    engine.register(definition);

    const handle = await engine.start('retry-conflict', null, { id: 'retry-conflict' });
    const reason = await rejectionOf(handle.result());
    await warning.received;
    warning.stop();

    expect(reason).toBeInstanceOf(WorkflowCheckpointConflictError);
    expect(state.lost).toBe(true);
    // Nothing reaches the generator, and the memo callback sees only its scope
    // closing, as it would for any cancellation, never the conflict.
    expect(observedByWorkflow).toEqual([]);
    expect(observedInMemoCallback).toHaveLength(1);
    expect(observedInMemoCallback[0]).toBeInstanceOf(DurableActivityScopeError);
    expect(state.writesAfterLoss).toEqual([]);
    expect(await readStatus(base, 'retry-conflict')).toBe('running');
    expect(warning.warnings.map((emitted) => emitted.workflowId)).toEqual(['retry-conflict']);
    expect(getInternals(engine).inlineStrategy?.hasGenerator('retry-conflict')).toBe(false);
  });
});

describe('wakes for an abandoned generation', () => {
  it('discards the wake in every ownership mode without consulting the claim registry', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    adoptLaunchCheckpoint(internals, 'marked', { workflowExecutionToken: 'lost' } as Checkpoint);
    adoptLaunchCheckpoint(internals, 'healthy', { workflowExecutionToken: 'fine' } as Checkpoint);
    abandonExecutionAttempt(internals, 'marked', 'lost');

    expect(await confirmWakeOwnership(internals, 'marked', 'signal')).toBe('discard');
    expect(await confirmWakeOwnership(internals, 'healthy', 'signal')).toBe('proceed');
    // A different generation under the marked id is not the abandoned one.
    adoptLaunchCheckpoint(internals, 'marked', {
      workflowExecutionToken: 'replacement',
    } as Checkpoint);
    expect(await confirmWakeOwnership(internals, 'marked', 'signal')).toBe('proceed');
    adoptLaunchCheckpoint(internals, 'marked', { workflowExecutionToken: 'lost' } as Checkpoint);
    abandonExecutionAttempt(internals, 'marked', 'lost');

    internals.workflowClaimRegistry = {
      engineId: 'engine',
      currentEpoch: () => {
        throw new Error('the abandoned generation must be discarded before the registry is read');
      },
    } as never;
    expect(await confirmWakeOwnership(internals, 'marked', 'signal')).toBe('discard');
    internals.workflowClaimRegistry = null;
  });

  it('does not wake the abandoned generation for a delivered signal', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    await startParked(engine, 'signalled-run', 'signalled-run');
    await startParked(engine, 'signalled-bystander', 'signalled-bystander');
    const markedWaiter = mock(() => {});
    const bystanderWaiter = mock(() => {});
    registerSignalWaiter(internals, 'signalled-run', 'signalled-run:go', markedWaiter);
    registerSignalWaiter(
      internals,
      'signalled-bystander',
      'signalled-bystander:go',
      bystanderWaiter,
    );
    const warning = collectConflictWarnings();
    loseGeneration(internals, 'signalled-run');
    await warning.received;
    warning.stop();

    await engine.signal('signalled-run', 'go', 'late');
    await engine.signal('signalled-bystander', 'go', 'on time');
    await yieldToEventLoop();

    expect(markedWaiter).not.toHaveBeenCalled();
    expect(internals.signalWaiters.has('signalled-run:go')).toBe(true);
    expect(bystanderWaiter).toHaveBeenCalledTimes(1);
  });

  it('does not wake the abandoned generation for a condition poke', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    await startParked(engine, 'poked-run', 'poked-run');
    await startParked(engine, 'bystander-run', 'bystander-run');
    const markedWaiter = mock(() => {});
    const bystanderWaiter = mock(() => {});
    internals.conditionWaiters.set('poked-run', markedWaiter);
    internals.conditionWaiters.set('bystander-run', bystanderWaiter);
    const warning = collectConflictWarnings();
    loseGeneration(internals, 'poked-run');
    await warning.received;
    warning.stop();

    notifyConditionWaiters(internals, 'poked-run');
    notifyConditionWaiters(internals, 'bystander-run');
    await yieldToEventLoop();

    expect(markedWaiter).not.toHaveBeenCalled();
    expect(bystanderWaiter).toHaveBeenCalledTimes(1);
  });

  it('does not feed the abandoned generation an async activity completion', async () => {
    const requests: RemoteActivityTaskRequest[] = [];
    const broker: RemoteActivityBroker = {
      async enqueue(request) {
        requests.push(request);
      },
    };
    await using engine = new Engine({ activityExecution: { mode: 'remote', broker } });
    const internals = getInternals(engine);
    const chargeCard = activity({
      name: 'chargeCard',
      execute: async (_input: { orderId: string }): Promise<never> => {
        throw new Error('local execution must never run in remote mode');
      },
    });
    engine.register(
      workflow({ name: 'remote-lost' })
        .activities({ chargeCard })
        .execute(async function* (context: WorkflowContext) {
          return yield* context.run(chargeCard, { orderId: 'ord-1' });
        }),
    );
    await engine.start('remote-lost', null, { id: 'remote-lost' });
    await waitForCondition(() => requests.length > 0, { label: 'activity enqueued' });
    const warning = collectConflictWarnings();
    loseGeneration(internals, 'remote-lost');
    await warning.received;
    warning.stop();
    // A worker or revision-realm engine has no inline strategy: the completion
    // would be fed to the execution strategy, which still holds the stale run.
    const resumed: string[] = [];
    const activeStrategy = internals.strategy;
    internals.strategy = new Proxy(activeStrategy, {
      get(target, property) {
        if (property === 'resumeWorkflow') {
          return (message: { workflowId: string }) => resumed.push(message.workflowId);
        }
        const member: unknown = Reflect.get(target, property, target);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    const inlineStrategy = internals.inlineStrategy;
    internals.inlineStrategy = null;
    try {
      await engine.completeAsyncActivity(requests[0]!.operationId, 'charged');
    } finally {
      internals.inlineStrategy = inlineStrategy;
      internals.strategy = activeStrategy;
    }

    // Delivery would stage the resolution record's deletion and resume the
    // execution; a discarded delivery does neither and leaves the record alone.
    expect(resumed).toEqual([]);
    expect(internals.pendingAtomicWorkflowCommitSideEffects.has('remote-lost')).toBe(false);
  });

  it('keeps the winner durable timers when the loser scheduler fires them', async () => {
    let now = 1_000_000;
    const watched = recordWrites(new MemoryStorage());
    await using engine = await Engine.create({
      storage: watched.storage,
      workflows: {
        'timers-condition': workflow({ name: 'timers-condition' }).execute(async function* (
          context: WorkflowContext,
        ) {
          return yield* context.waitUntil(() => false, '5m');
        }),
        'timers-sleep': workflow({ name: 'timers-sleep' }).execute(async function* (
          context: WorkflowContext,
        ) {
          yield* context.sleep('5m');
          return 'woke';
        }),
      },
      getNow: () => now,
      backgroundTasks: 'manual',
      startScheduler: false,
    });
    const internals = getInternals(engine);
    await engine.start('timers-condition', null, { id: 'condition-run', executionTimeout: '10m' });
    await engine.start('timers-sleep', null, { id: 'sleep-run' });
    await waitForCondition(
      () =>
        internals.conditionWaiters.has('condition-run') &&
        internals.sleepResolversByWorkflow.has('sleep-run'),
      { label: 'both runs parked on a durable timer' },
    );
    const reviewHandler = mock(async () => true);
    internals.reviewEscalationHandlers.set('review-1', reviewHandler);
    const reviewTimer: TimerEntry = {
      id: 'review-escalation:review-1:1000',
      workflowId: 'condition-run',
      fireAt: now + 1_000,
      kind: 'sleep',
      workflowExecutionToken: tokenOf(internals, 'condition-run')!,
    };
    await internals.scheduler.schedule(reviewTimer);
    const timerKeys = async (): Promise<string[]> => {
      const keys: string[] = [];
      for await (const [key] of watched.storage.scan('timer-idx:')) keys.push(key);
      return keys.toSorted();
    };
    const timersBefore = await timerKeys();
    expect(timersBefore.length).toBeGreaterThanOrEqual(4);

    const warning = collectConflictWarnings(2);
    loseGeneration(internals, 'condition-run');
    loseGeneration(internals, 'sleep-run');
    await warning.received;
    warning.stop();
    watched.writes.length = 0;

    // Every timer is due on this engine's scheduler: sleep, condition deadline,
    // execution deadline, and the review escalation.
    now += 11 * 60 * 1000;
    // The scheduler reports each timer it declines through `console.error`, which is how an
    // operator learns the retry is deliberate. Take the reports to assert them.
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    let reports: readonly (readonly unknown[])[];
    try {
      await engine.scheduler.tick(now);
    } finally {
      reports = [...consoleError.mock.calls];
      consoleError.mockRestore();
    }
    const declinedTimers = reports
      .map(([message]) => String(message).replace(/^Timer callback failed for timer (.*):$/, '$1'))
      .toSorted();
    expect(declinedTimers).toEqual(
      [
        'cond:condition-run:0',
        'deadline:condition-run',
        'review-escalation:review-1:1000',
        'sleep:sleep-run:0',
      ].toSorted(),
    );
    for (const [, reason] of reports) {
      expect((reason as Error).message).toContain('was discarded by an engine that does not own');
    }

    // The scheduler retries them: the records stay for the winner, nothing was
    // written, no waiter was woken, and no review handler ran.
    expect(await timerKeys()).toEqual(timersBefore);
    expect(watched.writes).toEqual([]);
    expect(reviewHandler).not.toHaveBeenCalled();
    expect(internals.conditionWaiters.has('condition-run')).toBe(true);
    expect(internals.sleepResolversByWorkflow.has('sleep-run')).toBe(true);
    const conditionState = await engine.get('condition-run');
    const sleepState = await engine.get('sleep-run');
    expect(conditionState?.status).toBe('running');
    expect(sleepState?.status).toBe('running');
  });
});

/**
 * The loser abandons generation A of a parked run (its in-memory checkpoint stays on
 * A) and the winner recovers and finishes A. Both engines run their schedulers
 * manually over one shared clock, so a test chooses which of them ticks, and the
 * winner's generation B is left for the test to start.
 */
async function abandonGenerationAndFinishItOnTheWinner(
  id: string,
  secondWorkflow: ReturnType<typeof parkedOnSignal>,
) {
  const clock = { now: 1_000_000 };
  const storage = new MemoryStorage();
  const workflows = {
    [`${id}-first`]: parkedOnSignal(`${id}-first`),
    [`${id}-second`]: secondWorkflow,
  };
  const engineOptions = {
    storage,
    workflows,
    getNow: () => clock.now,
    backgroundTasks: 'manual' as const,
    startScheduler: false,
  };
  const loser = await Engine.create(engineOptions);
  const loserInternals = getInternals(loser);
  await loser.start(`${id}-first`, null, { id });
  await waitForCondition(() => loserInternals.parkedInlineWorkflows.has(id), {
    label: `${id} generation A parked on the loser`,
  });
  const abandonedToken = tokenOf(loserInternals, id);
  const warning = collectConflictWarnings();
  loseGeneration(loserInternals, id);
  await warning.received;
  warning.stop();

  const winner = await Engine.create(engineOptions);
  const winnerInternals = getInternals(winner);
  await waitForCondition(() => winnerInternals.parkedInlineWorkflows.has(id), {
    label: `${id} generation A recovered by the winner`,
  });
  await winner.signal(id, 'go', 'A done');
  expect(await winner.getHandle(id).result()).toBe('A done');

  const timerKeys = async (): Promise<string[]> => {
    const keys: string[] = [];
    for await (const [key] of storage.scan('timer-idx:')) keys.push(key);
    return keys.toSorted();
  };
  return {
    clock,
    storage,
    loser,
    loserInternals,
    winner,
    winnerInternals,
    abandonedToken,
    timerKeys,
    /** The loser never learned about B: its memory still holds the abandoned A. */
    expectLoserStillHoldsAbandonedGeneration: () => {
      expect(tokenOf(loserInternals, id)).toBe(abandonedToken);
      expect(tokenOf(winnerInternals, id)).not.toBe(abandonedToken);
      expect(isGenerationAbandoned(loserInternals, id, abandonedToken)).toBe(true);
    },
    dispose: async () => {
      await winner[Symbol.asyncDispose]();
      await loser[Symbol.asyncDispose]();
    },
  };
}

/**
 * {@link abandonGenerationAndFinishItOnTheWinner}, then the winner starts generation B
 * under the same id; B sleeps on the winner for `sleepDuration`.
 */
async function replaceAbandonedGenerationOnTheWinner(
  id: string,
  sleepDuration: string,
  executionTimeout?: string,
) {
  const scenario = await abandonGenerationAndFinishItOnTheWinner(
    id,
    workflow({ name: `${id}-second` }).execute(async function* (context: WorkflowContext) {
      yield* context.sleep(sleepDuration);
      return 'woke';
    }),
  );
  const replacement = await scenario.winner.start(`${id}-second`, null, {
    id,
    onTerminalConflict: 'start-new',
    ...(executionTimeout === undefined ? {} : { executionTimeout }),
  });
  await waitForCondition(() => scenario.winnerInternals.sleepResolversByWorkflow.has(id), {
    label: `${id} generation B asleep on the winner`,
  });
  scenario.expectLoserStillHoldsAbandonedGeneration();
  return { ...scenario, replacement };
}

describe('timers of a generation that replaced the one this engine abandoned', () => {
  it('retains the replacement execution deadline for the engine that drives it', async () => {
    const scenario = await replaceAbandonedGenerationOnTheWinner('deadline-run', '30m', '10m');
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const timersBefore = await scenario.timerKeys();
      expect(timersBefore.some((key) => key.includes('deadline'))).toBe(true);
      scenario.clock.now += 11 * 60 * 1000;
      await scenario.loser.scheduler.tick(scenario.clock.now);

      // The loser writes nothing durable: the deadline belongs to generation B, which only the
      // winner drives, so the loser declines it through the scheduler's retry path and leaves
      // the record for the winner's own scheduler to enforce.
      expect(await readStatus(scenario.storage, 'deadline-run')).toBe('running');
      expect(await scenario.timerKeys()).toEqual(timersBefore);
      expect(consoleError).toHaveBeenCalledTimes(1);
      consoleError.mockClear();

      // The engine driving B fires the very same record.
      await scenario.winner.scheduler.tick(scenario.clock.now);
      expect(await readStatus(scenario.storage, 'deadline-run')).toBe('timed-out');
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      await scenario.dispose();
    }
  });

  it('collects a deadline record for a suspended replacement instead of timing it out', async () => {
    const scenario = await replaceAbandonedGenerationOnTheWinner('suspended-run', '30m', '10m');
    try {
      const deadline = (
        decode((await scenario.storage.get(KEYS.workflow('suspended-run')))!) as WorkflowState
      ).executionDeadline!;
      await scenario.winner.suspend('suspended-run');
      expect(await readStatus(scenario.storage, 'suspended-run')).toBe('suspended');

      // The scheduler scanned the record before the suspend deleted B's deadline timer, so it
      // reaches the loser afterwards. A suspended run keeps its absolute deadline for its resume
      // to re-arm, so the loser has no business ending it.
      scenario.clock.now += 11 * 60 * 1000;
      await scenario.loser.fireTimer({
        id: 'deadline:suspended-run',
        workflowId: 'suspended-run',
        fireAt: deadline,
        kind: 'execution-deadline',
      });

      expect(await readStatus(scenario.storage, 'suspended-run')).toBe('suspended');
    } finally {
      await scenario.dispose();
    }
  });

  it('keeps the replacement sleep and review timers for the engine that drives it', async () => {
    const scenario = await replaceAbandonedGenerationOnTheWinner('timers-run', '5m');
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const reviewHandler = mock(async () => true);
      scenario.winnerInternals.reviewEscalationHandlers.set('review-b', reviewHandler);
      await scenario.winnerInternals.scheduler.schedule({
        id: 'review-escalation:review-b:1000',
        workflowId: 'timers-run',
        fireAt: scenario.clock.now + 1_000,
        kind: 'sleep',
        workflowExecutionToken: tokenOf(scenario.winnerInternals, 'timers-run')!,
      });
      const timersBefore = await scenario.timerKeys();
      expect(timersBefore.length).toBeGreaterThanOrEqual(2);

      scenario.clock.now += 6 * 60 * 1000;
      await scenario.loser.scheduler.tick(scenario.clock.now);

      // The loser holds no waiter and no review handler for B: waking or consuming
      // them would only destroy the records the engine driving B still needs.
      expect(await scenario.timerKeys()).toEqual(timersBefore);
      expect(reviewHandler).not.toHaveBeenCalled();
      expect(await readStatus(scenario.storage, 'timers-run')).toBe('running');
      // Both were declined through the scheduler's retry path, which reports each failure.
      expect(consoleError).toHaveBeenCalledTimes(2);
      consoleError.mockClear();

      // The engine driving B fires both from the very same records.
      await scenario.winner.scheduler.tick(scenario.clock.now);
      expect(await scenario.replacement.result()).toBe('woke');
      expect(reviewHandler).toHaveBeenCalledTimes(1);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      await scenario.dispose();
    }
  });
});

describe('failing an abandoned generation', () => {
  async function startParkedEngine(name: string, storage: Storage) {
    const engine = await Engine.create({ storage, recover: false });
    engine.register(parkedOnSignal(name));
    await engine.start(name, null, { id: name });
    return engine;
  }

  it('refuses the terminal write for the marked generation', async () => {
    const storage = new MemoryStorage();
    await using engine = await startParkedEngine('refused-failure', storage);
    const internals = getInternals(engine);
    abandonExecutionAttempt(internals, 'refused-failure', tokenOf(internals, 'refused-failure'));
    const watched = recordWrites(storage);
    internals.storage = watched.storage;

    await failWorkflow(internals, 'refused-failure', new Error('late failure'), noCallbacks);
    internals.storage = storage;

    expect(watched.writes).toEqual([]);
    expect(await readStatus(storage, 'refused-failure')).toBe('running');
  });

  it('still fails a later generation under an id whose earlier generation was abandoned', async () => {
    const storage = new MemoryStorage();
    await using engine = await startParkedEngine('later-generation', storage);
    const internals = getInternals(engine);
    abandonExecutionAttempt(internals, 'later-generation', 'abandoned-generation');

    await failWorkflow(internals, 'later-generation', new Error('pre-launch failure'), noCallbacks);

    expect(await readStatus(storage, 'later-generation')).toBe('failed');
  });

  it('drops a failure already in flight when the run is abandoned before its terminal commit', async () => {
    const storage = new MemoryStorage();
    await using engine = await startParkedEngine('in-flight', storage);
    const internals = getInternals(engine);
    // Hold the failure at its first storage read, as an interleaving turn would.
    const reachedRead = createDeferred();
    const releaseRead = createDeferred();
    internals.storage = new Proxy(storage, {
      get(target, property) {
        const original: unknown = Reflect.get(target, property, target);
        if (typeof original !== 'function') return original;
        if (property === 'get') {
          return async (key: string) => {
            if (key === KEYS.attribute('in-flight')) {
              reachedRead.resolve();
              await releaseRead.promise;
            }
            return original.call(target, key);
          };
        }
        return original.bind(target);
      },
    });

    const failing = failWorkflow(internals, 'in-flight', new Error('late failure'), noCallbacks);
    await reachedRead.promise;
    const warning = collectConflictWarnings();
    loseGeneration(internals, 'in-flight');
    await warning.received;
    warning.stop();
    releaseRead.resolve();
    await failing;
    internals.storage = storage;

    expect(await readStatus(storage, 'in-flight')).toBe('running');
  });

  /**
   * The loser abandons generation A while one of its failures is held at its first
   * storage read; the winner then finishes A and a local `start-new` installs
   * generation B under the same id. With `tokenless`, A is a run recovered from before
   * execution tokens existed. Returns the pieces a test needs to release the held failure
   * and judge what it did to B.
   */
  async function replaceAbandonedGenerationBehindHeldFailure(
    id: string,
    options: { tokenless?: boolean } = {},
  ) {
    const storage = new MemoryStorage();
    const workflows = { [id]: parkedOnSignal(id) };
    const loser = await Engine.create({ storage, recover: false, workflows });
    const internals = getInternals(loser);
    await loser.start(id, null, { id });
    await waitForCondition(() => internals.parkedInlineWorkflows.has(id), {
      label: `${id} generation A parked on the loser`,
    });
    if (options.tokenless === true) {
      const legacyCheckpoint = { ...internals.checkpoints.get(id)! };
      delete legacyCheckpoint.workflowExecutionToken;
      adoptLaunchCheckpoint(internals, id, legacyCheckpoint);
    }
    const abandonedToken = tokenOf(internals, id);

    const held = holdFailureAtItsFirstRead(internals, storage, id);
    const failure = failWorkflow(internals, id, new Error('stale failure of A'), noCallbacks);
    await held.reached;

    const warning = collectConflictWarnings();
    loseGeneration(internals, id);
    await warning.received;
    warning.stop();

    const winner = await Engine.create({ storage, workflows });
    await waitForCondition(() => getInternals(winner).parkedInlineWorkflows.has(id), {
      label: `${id} generation A recovered by the winner`,
    });
    await winner.signal(id, 'go', 'A done');
    expect(await winner.getHandle(id).result()).toBe('A done');
    const replacement = await loser.start(id, null, { id, onTerminalConflict: 'start-new' });
    await waitForCondition(() => internals.parkedInlineWorkflows.has(id), {
      label: `${id} generation B parked on the loser`,
    });
    expect(tokenOf(internals, id)).not.toBe(abandonedToken);
    // The loser's own start-new began a new attempt, which is healthy: the abandonment ended with
    // generation A's attempt, so only that attempt can tell the failure in flight is stale.
    expect(isGenerationAbandoned(internals, id, abandonedToken)).toBe(false);
    expect(currentExecutionAttempt(internals, id)?.abandoned).toBe(false);
    held.writes.length = 0;

    return {
      storage,
      loser,
      internals,
      replacement,
      failure,
      writes: held.writes,
      release: held.release,
      dispose: async () => {
        internals.storage = storage;
        await winner[Symbol.asyncDispose]();
        await loser[Symbol.asyncDispose]();
      },
    };
  }

  it('drops a failure of the abandoned generation that resumes after a replacement was installed', async () => {
    const scenario = await replaceAbandonedGenerationBehindHeldFailure('replaced-failure');
    try {
      scenario.release();
      await scenario.failure;

      // The stale failure belongs to generation A, which the winner already finished;
      // generation B is a different run under the same id and must be left alone.
      expect(scenario.writes).toEqual([]);
      expect(await readStatus(scenario.storage, 'replaced-failure')).toBe('running');
      await scenario.loser.signal('replaced-failure', 'go', 'B done');
      expect(await scenario.replacement.result()).toBe('B done');
    } finally {
      await scenario.dispose();
    }
  });

  it('drops a failure of a pre-token generation that resumes after a token-bearing replacement was installed', async () => {
    const scenario = await replaceAbandonedGenerationBehindHeldFailure('tokenless-failure', {
      tokenless: true,
    });
    try {
      scenario.release();
      await scenario.failure;

      // Adopting the token-bearing replacement ended the pre-token attempt and its abandonment,
      // so nothing but that attempt tells that the failure in flight belongs to the pre-token run.
      expect(scenario.writes).toEqual([]);
      expect(await readStatus(scenario.storage, 'tokenless-failure')).toBe('running');
      expect(isGenerationAbandoned(scenario.internals, 'tokenless-failure', undefined)).toBe(false);
      await scenario.loser.signal('tokenless-failure', 'go', 'B done');
      expect(await scenario.replacement.result()).toBe('B done');
    } finally {
      await scenario.dispose();
    }
  });

  it('still fails the replacement generation for a failure that starts after it was installed', async () => {
    const scenario = await replaceAbandonedGenerationBehindHeldFailure('replacement-fails');
    try {
      // A genuine failure originating from B, after A's abandonment ended with its attempt:
      // the second failure is not held, since the first already used the hold.
      scenario.release();
      await scenario.failure;
      expect(await readStatus(scenario.storage, 'replacement-fails')).toBe('running');

      await failWorkflow(
        scenario.internals,
        'replacement-fails',
        new Error('B failed for real'),
        noCallbacks,
      );

      expect(await readStatus(scenario.storage, 'replacement-fails')).toBe('failed');
    } finally {
      await scenario.dispose();
    }
  });
});

/**
 * Suspending a workflow releases its in-memory checkpoint but keeps the execution attempt this
 * engine made at it, so a checkpoint commit still in flight from before the suspend can lose its
 * compare-and-swap after the checkpoint is gone. The loss is still the loss of a generation this
 * engine drove, and it is abandoned like any other: marked, so a stale terminal failure for it is
 * refused, with its pending result() rejected and the operator warned. A generation the engine
 * holds neither a checkpoint nor an attempt for was released for good and has nothing to abandon.
 */
describe('a lost checkpoint commit for a workflow this engine suspended', () => {
  /** Start a run parked on its signal with a result() pending, then suspend it. */
  async function startSuspendedRun(id: string, options: { preToken?: boolean } = {}) {
    const storage = new MemoryStorage();
    const engine = await Engine.create({
      storage,
      recover: false,
      workflows: { [id]: parkedOnSignal(id) },
    });
    const internals = getInternals(engine);
    const handle = await engine.start(id, null, { id });
    await waitForCondition(() => internals.parkedInlineWorkflows.has(id), {
      label: `${id} parked on its signal`,
    });
    const token = tokenOf(internals, id);
    if (options.preToken === true) {
      // A run recovered from before tokens existed: stored without one, and launched by this
      // engine through its launch path with a checkpoint that has none.
      for (const key of [KEYS.workflow(id), KEYS.checkpoint(id)]) {
        const record = { ...(decode((await storage.get(key))!) as Record<string, unknown>) };
        delete record['workflowExecutionToken'];
        await storage.put(key, encode(record));
      }
      const legacyCheckpoint = { ...internals.checkpoints.get(id)! };
      delete legacyCheckpoint.workflowExecutionToken;
      adoptLaunchCheckpoint(internals, id, legacyCheckpoint);
    }
    const pending = handle.result();
    await engine.suspend(id);

    // Suspension released the checkpoint and kept the attempt and the result() waiter.
    expect(internals.checkpoints.has(id)).toBe(false);
    expect(currentExecutionAttempt(internals, id)).toBeDefined();
    expect(internals.resultResolvers.has(id)).toBe(true);
    expect(await readStatus(storage, id)).toBe('suspended');
    return {
      storage,
      engine,
      internals,
      pending,
      token: options.preToken === true ? undefined : token,
    };
  }

  function loseCommit(internals: EngineInternals, id: string, token: string | undefined): void {
    abandonWorkflowAfterCheckpointConflict(
      internals,
      new WorkflowCheckpointConflictError(id, { workflowExecutionToken: token }),
    );
  }

  it('abandons a suspended pre-token generation: marks it, rejects result(), evicts the handle, and warns', async () => {
    const id = 'suspended-pre-token';
    const run = await startSuspendedRun(id, { preToken: true });
    const warning = collectConflictWarnings();
    try {
      loseCommit(run.internals, id, undefined);

      expect(await rejectionOrPending(run.pending)).toBeInstanceOf(WorkflowCheckpointConflictError);
      await yieldToEventLoop();
      expect(warning.warnings.map((warned) => warned.workflowId)).toEqual([id]);
      expect(isGenerationAbandoned(run.internals, id, undefined)).toBe(true);
      expect(abandonedExecutionAttemptCount(run.internals)).toBe(1);
      expect(run.internals.handleCache.has(id)).toBe(false);
      expect(run.internals.resultResolvers.has(id)).toBe(false);
    } finally {
      warning.stop();
      await run.engine[Symbol.asyncDispose]();
    }
  });

  it('refuses a terminal failure still in flight for a suspended pre-token generation after the loss', async () => {
    const id = 'suspended-stale-failure';
    const run = await startSuspendedRun(id, { preToken: true });
    const warning = collectConflictWarnings();
    try {
      loseCommit(run.internals, id, undefined);
      expect(await rejectionOrPending(run.pending)).toBeInstanceOf(WorkflowCheckpointConflictError);
      const watched = recordWrites(run.storage);
      run.internals.storage = watched.storage;

      await failWorkflow(run.internals, id, new Error('stale failure'), noCallbacks);
      run.internals.storage = run.storage;

      expect(watched.writes).toEqual([]);
      expect(await readStatus(run.storage, id)).toBe('suspended');
    } finally {
      warning.stop();
      run.internals.storage = run.storage;
      await run.engine[Symbol.asyncDispose]();
    }
  });

  it('abandons a suspended token-bearing generation the same way', async () => {
    const id = 'suspended-token-bearing';
    const run = await startSuspendedRun(id);
    expect(run.token).toBeDefined();
    const warning = collectConflictWarnings();
    try {
      loseCommit(run.internals, id, run.token);

      expect(await rejectionOrPending(run.pending)).toBeInstanceOf(WorkflowCheckpointConflictError);
      await yieldToEventLoop();
      expect(warning.warnings.map((warned) => warned.workflowId)).toEqual([id]);
      expect(isGenerationAbandoned(run.internals, id, run.token)).toBe(true);
      expect(run.internals.handleCache.has(id)).toBe(false);

      const watched = recordWrites(run.storage);
      run.internals.storage = watched.storage;
      await failWorkflow(run.internals, id, new Error('stale failure'), noCallbacks);
      run.internals.storage = run.storage;
      expect(watched.writes).toEqual([]);
      expect(await readStatus(run.storage, id)).toBe('suspended');
    } finally {
      warning.stop();
      run.internals.storage = run.storage;
      await run.engine[Symbol.asyncDispose]();
    }
  });

  it('retires the attempt of a generation another engine replaced when this engine suspends the replacement', async () => {
    const id = 'suspended-replacement';
    const storage = new MemoryStorage();
    const engine = await Engine.create({
      storage,
      recover: false,
      workflows: { [id]: parkedOnSignal(id) },
    });
    const internals = getInternals(engine);
    const warning = collectConflictWarnings();
    try {
      const handle = await engine.start(id, null, { id });
      await waitForCondition(() => internals.parkedInlineWorkflows.has(id), {
        label: `${id} parked on its signal`,
      });
      const launchedToken = tokenOf(internals, id);
      expect(launchedToken).toBeDefined();
      // Another engine replaced the stored generation under the same id, so the run this
      // engine suspends is the replacement, and not the generation it launched.
      for (const key of [KEYS.workflow(id), KEYS.checkpoint(id)]) {
        const record = decode((await storage.get(key))!) as Record<string, unknown>;
        await storage.put(key, encode({ ...record, workflowExecutionToken: 'replacement' }));
      }
      const pending = handle.result();
      // Disposal rejects a result() that is still pending, which must not outlive a failed assertion.
      void pending.catch(() => {});

      await engine.suspend(id);
      expect(await readStatus(storage, id)).toBe('suspended');

      // The attempt launched a generation other than the suspended one, so there is nothing
      // of the suspended run for it to hold.
      expect(currentExecutionAttempt(internals, id)).toBeUndefined();

      // A commit of the generation it launched losing its race afterwards says nothing about
      // the suspended replacement: no abandonment, no warning, no rejected result().
      loseCommit(internals, id, launchedToken);
      await yieldToEventLoop();
      expect(warning.warnings).toEqual([]);
      expect(abandonedExecutionAttemptCount(internals)).toBe(0);
      expect(await rejectionOrPending(pending)).toBe('pending');
    } finally {
      warning.stop();
      await engine[Symbol.asyncDispose]();
    }
  });

  it('ignores a loss that names a different generation than the one the suspended attempt launched', async () => {
    const id = 'suspended-other-generation';
    const run = await startSuspendedRun(id);
    const warning = collectConflictWarnings();
    try {
      loseCommit(run.internals, id, 'older-generation');
      loseCommit(run.internals, id, undefined);

      expect(await rejectionOrPending(run.pending)).toBe('pending');
      await yieldToEventLoop();
      expect(warning.warnings).toEqual([]);
      expect(abandonedExecutionAttemptCount(run.internals)).toBe(0);
      expect(run.internals.resultResolvers.has(id)).toBe(true);
    } finally {
      warning.stop();
      await run.engine[Symbol.asyncDispose]();
    }
  });

  it('ignores a loss for a generation this engine released when its run finished', async () => {
    const id = 'finished-pre-token';
    const storage = new MemoryStorage();
    const engine = await Engine.create({
      storage,
      recover: false,
      workflows: { [id]: parkedOnSignal(id) },
    });
    const internals = getInternals(engine);
    const warning = collectConflictWarnings();
    try {
      const handle = await engine.start(id, null, { id });
      await waitForCondition(() => internals.parkedInlineWorkflows.has(id), {
        label: `${id} parked on its signal`,
      });
      const legacyCheckpoint = { ...internals.checkpoints.get(id)! };
      delete legacyCheckpoint.workflowExecutionToken;
      adoptLaunchCheckpoint(internals, id, legacyCheckpoint);
      await engine.signal(id, 'go', 'done');
      expect(await handle.result()).toBe('done');
      // Finishing released the checkpoint and the attempt along with it.
      expect(internals.checkpoints.has(id)).toBe(false);
      expect(currentExecutionAttempt(internals, id)).toBeUndefined();

      loseCommit(internals, id, undefined);

      await yieldToEventLoop();
      expect(warning.warnings).toEqual([]);
      expect(abandonedExecutionAttemptCount(internals)).toBe(0);
    } finally {
      warning.stop();
      await engine[Symbol.asyncDispose]();
    }
  });

  it('ends the abandonment when this engine resumes the suspended generation it abandoned', async () => {
    const id = 'suspended-then-resumed';
    const run = await startSuspendedRun(id);
    const warning = collectConflictWarnings();
    try {
      loseCommit(run.internals, id, run.token);
      expect(await rejectionOrPending(run.pending)).toBeInstanceOf(WorkflowCheckpointConflictError);
      expect(abandonedExecutionAttemptCount(run.internals)).toBe(1);

      const resumed = await run.engine.resume(id);

      expect(abandonedExecutionAttemptCount(run.internals)).toBe(0);
      await run.engine.signal(id, 'go', 'resumed');
      expect(await resumed.result()).toBe('resumed');
    } finally {
      warning.stop();
      await run.engine[Symbol.asyncDispose]();
    }
  });
});

/**
 * A terminal failure belongs to the execution attempt that raised it: the launch this engine
 * made of the stored generation, until the engine launches the id again. A failure still in
 * flight from an earlier attempt must never be written over a later one, whether that later
 * attempt runs a replacement generation or the very same generation relaunched.
 */
describe('failing from an execution attempt this engine no longer holds', () => {
  /** Strip the execution token from the stored run and the held checkpoint: a run recovered from before tokens existed. */
  async function makeRunPreToken(internals: EngineInternals, storage: Storage, id: string) {
    for (const key of [KEYS.workflow(id), KEYS.checkpoint(id)]) {
      const record = { ...(decode((await storage.get(key))!) as Record<string, unknown>) };
      delete record['workflowExecutionToken'];
      await storage.put(key, encode(record));
    }
    const heldCheckpoint = { ...internals.checkpoints.get(id)! };
    delete heldCheckpoint.workflowExecutionToken;
    // The engine launched the pre-token run through its launch path, so it holds an attempt for it.
    adoptLaunchCheckpoint(internals, id, heldCheckpoint);
    expect(tokenOf(internals, id)).toBeUndefined();
  }

  async function startParkedRun(id: string, options: { preToken?: boolean } = {}) {
    const storage = new MemoryStorage();
    const engine = await Engine.create({
      storage,
      recover: false,
      workflows: { [id]: parkedOnSignal(id) },
    });
    const internals = getInternals(engine);
    const first = await engine.start(id, null, { id });
    await waitForCondition(() => internals.parkedInlineWorkflows.has(id), {
      label: `${id} parked on its signal`,
    });
    if (options.preToken === true) await makeRunPreToken(internals, storage, id);
    return { storage, engine, internals, first };
  }

  it('drops a failure of a generation this engine replaced through start-new, with nothing abandoned', async () => {
    const id = 'replaced-healthy';
    const { storage, engine, internals, first } = await startParkedRun(id);
    try {
      const held = holdFailureAtItsFirstRead(internals, storage, id);
      const failure = failWorkflow(internals, id, new Error('stale failure of A'), noCallbacks);
      await held.reached;

      // A finishes and a local start-new installs B under the same id while A's failure waits.
      await engine.signal(id, 'go', 'A done');
      expect(await first.result()).toBe('A done');
      const replacement = await engine.start(id, null, { id, onTerminalConflict: 'start-new' });
      await waitForCondition(() => internals.parkedInlineWorkflows.has(id), {
        label: `${id} generation B parked`,
      });
      held.writes.length = 0;
      held.release();
      await failure;
      internals.storage = storage;

      expect(held.writes).toEqual([]);
      expect(await readStatus(storage, id)).toBe('running');
      await engine.signal(id, 'go', 'B done');
      expect(await replacement.result()).toBe('B done');
    } finally {
      internals.storage = storage;
      await engine[Symbol.asyncDispose]();
    }
  });

  /**
   * The engine abandons generation A while one of its failures is held at its first storage
   * read, then launches that same stored generation again: the abandonment ends, and the
   * failure in flight must still be refused, because it belongs to the earlier attempt.
   */
  async function relaunchSameGenerationBehindHeldFailure(
    id: string,
    options: { preToken?: boolean } = {},
  ) {
    const { storage, engine, internals } = await startParkedRun(id, options);
    const abandonedToken = tokenOf(internals, id);
    const held = holdFailureAtItsFirstRead(internals, storage, id);
    const failure = failWorkflow(internals, id, new Error('stale failure of A'), noCallbacks);
    await held.reached;

    const warning = collectConflictWarnings();
    loseGeneration(internals, id);
    await warning.received;
    warning.stop();
    expect(isGenerationAbandoned(internals, id, abandonedToken)).toBe(true);

    // The same forced replay a claim reclaim performs, which adopts A's checkpoint again.
    const relaunched = await resumeFromLifecycle(
      internals,
      id,
      createLifecycleCallbacks(engine),
      undefined,
      { forceReplayFromStorage: true },
    );
    await waitForCondition(() => internals.parkedInlineWorkflows.has(id), {
      label: `${id} generation A parked again`,
    });
    expect(tokenOf(internals, id)).toBe(abandonedToken);
    // The relaunch ended the abandonment, so only the attempt can tell the failure is stale.
    expect(isGenerationAbandoned(internals, id, abandonedToken)).toBe(false);
    held.writes.length = 0;
    held.release();
    await failure;
    internals.storage = storage;
    return { storage, engine, internals, relaunched, writes: held.writes };
  }

  it('drops a failure of an earlier attempt after this engine relaunches the same generation', async () => {
    const id = 'relaunched-failure';
    const scenario = await relaunchSameGenerationBehindHeldFailure(id);
    try {
      expect(scenario.writes).toEqual([]);
      expect(await readStatus(scenario.storage, id)).toBe('running');
      await scenario.engine.signal(id, 'go', 'A relaunched');
      expect(await scenario.relaunched.result()).toBe('A relaunched');
    } finally {
      await scenario.engine[Symbol.asyncDispose]();
    }
  });

  it('drops a failure of an earlier attempt after this engine relaunches the same pre-token generation', async () => {
    const id = 'relaunched-pre-token-failure';
    const scenario = await relaunchSameGenerationBehindHeldFailure(id, { preToken: true });
    try {
      expect(scenario.writes).toEqual([]);
      expect(await readStatus(scenario.storage, id)).toBe('running');
      await scenario.engine.signal(id, 'go', 'A relaunched');
      expect(await scenario.relaunched.result()).toBe('A relaunched');
    } finally {
      await scenario.engine[Symbol.asyncDispose]();
    }
  });

  it('still fails the attempt the engine currently holds, after an earlier one was relaunched', async () => {
    const id = 'relaunched-then-failed';
    const scenario = await relaunchSameGenerationBehindHeldFailure(id);
    try {
      await failWorkflow(scenario.internals, id, new Error('A failed for real'), noCallbacks);

      expect(await readStatus(scenario.storage, id)).toBe('failed');
    } finally {
      await scenario.engine[Symbol.asyncDispose]();
    }
  });

  it('judges an execution failure by the attempt it began under, which only a launch of the id changes', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    const stored = { workflowExecutionToken: 'generation-a' } as WorkflowState;
    const generationA = { workflowExecutionToken: 'generation-a' } as Checkpoint;
    adoptLaunchCheckpoint(internals, 'attempts', generationA);
    const executionFailure = staleFailureGuard(internals, 'attempts', 'execution');
    const launchFailure = staleFailureGuard(internals, 'attempts', 'launch');
    expect(executionFailure(stored)).toBe(false);

    // Committing a step replaces the in-memory checkpoint object but not the attempt.
    internals.checkpoints.set('attempts', { ...generationA, step: 1 });
    expect(executionFailure(stored)).toBe(false);

    // Launching the same generation again is a new attempt, and the failure began under the
    // earlier one. A launch failure never carried an attempt, and one that begins now does.
    adoptLaunchCheckpoint(internals, 'attempts', { ...generationA });
    expect(executionFailure(stored)).toBe(true);
    expect(launchFailure(stored)).toBe(false);
    const currentFailure = staleFailureGuard(internals, 'attempts', 'execution');
    expect(currentFailure(stored)).toBe(false);

    // The attempt ends with the checkpoint it belonged to.
    releaseLaunchCheckpoint(internals, 'attempts');
    expect(currentFailure(stored)).toBe(true);
    expect(staleFailureGuard(internals, 'attempts', 'execution')(stored)).toBe(false);
  });
});

/**
 * A start or prepare this engine rejects before it adopts a launch checkpoint did nothing to
 * the id's in-memory run, so a live run under the same id keeps everything it holds: the
 * execution attempt a failure in flight is judged by, its checkpoint and committed bytes, its
 * headers, version tuple, services, and terminal-cleanup membership. Only a start that adopted
 * a launch checkpoint has anything of its own to unwind.
 */
describe('rejecting a launch for an id this engine is already running', () => {
  /** Give every run a start header, so the engine holds headers and tracks terminal cleanup for it. */
  function addStartHeaderInterceptor(engine: Engine): void {
    engine.addInterceptor({
      workflowStart: (interception, next) => {
        interception.headers.set('x-trace', 'live-run');
        next(interception);
      },
    });
  }

  async function startLiveRun(
    id: string,
    resolveWorkflowServices?: EngineOptions['resolveWorkflowServices'],
  ) {
    const storage = new MemoryStorage();
    const engine = await Engine.create({
      storage,
      recover: false,
      ...(resolveWorkflowServices === undefined ? {} : { resolveWorkflowServices }),
    });
    engine.register(parkedOnSignal(id));
    addStartHeaderInterceptor(engine);
    const internals = getInternals(engine);
    const handle = await engine.start(id, null, { id, services: { owner: 'the live run' } });
    await waitForCondition(() => internals.parkedInlineWorkflows.has(id), {
      label: `${id} parked on its signal`,
    });
    return { storage, engine, internals, handle };
  }

  /** Everything the engine holds in memory for the id, by identity where it is an object. */
  function holdings(internals: EngineInternals, id: string) {
    return {
      attempt: currentExecutionAttempt(internals, id),
      checkpoint: internals.checkpoints.get(id),
      committedBytes: getCommittedCheckpointBytes(internals, id),
      headers: internals.workflowHeaders.get(id),
      versionTuple: internals.workflowVersionTuples.get(id),
      services: internals.workflowServices.get(id),
      cleanupTracked: internals.workflowsNeedingTerminalCleanup.has(id),
    };
  }

  const rejectedLaunches = [
    {
      label: 'a start of the running id',
      reject: (engine: Engine, id: string) => engine.start(id, null, { id }),
    },
    {
      label: 'a start of an unregistered type under the running id',
      reject: (engine: Engine, id: string) => engine.start('unregistered-type', null, { id }),
    },
    {
      label: 'a prepare of the running id',
      reject: (engine: Engine, id: string) => engine.prepare(id, null, { id }),
    },
  ];

  for (const [index, { label, reject }] of rejectedLaunches.entries()) {
    it(`still fails the live run for a failure in flight when ${label} is rejected`, async () => {
      const id = `rejected-launch-failure-${index}`;
      const { storage, engine, internals } = await startLiveRun(id);
      try {
        const held = holdFailureAtItsFirstRead(internals, storage, id);
        const failure = failWorkflow(
          internals,
          id,
          new Error('failure of the live run'),
          noCallbacks,
        );
        await held.reached;

        expect(await rejectionOf(reject(engine, id))).toBeInstanceOf(Error);

        held.release();
        await failure;
        internals.storage = storage;

        expect(await readStatus(storage, id)).toBe('failed');
      } finally {
        internals.storage = storage;
        await engine[Symbol.asyncDispose]();
      }
    });

    it(`leaves everything the live run holds untouched when ${label} is rejected`, async () => {
      const id = `rejected-launch-holdings-${index}`;
      const { storage, engine, internals, handle } = await startLiveRun(id);
      try {
        const before = holdings(internals, id);
        expect(before.attempt).toBeDefined();
        expect(before.checkpoint).toBeDefined();
        expect(before.committedBytes).toBeDefined();
        expect(before.headers?.get('x-trace')).toBe('live-run');
        expect(before.versionTuple).toBeDefined();
        expect(before.services).toEqual({ owner: 'the live run' });
        expect(before.cleanupTracked).toBe(true);

        expect(await rejectionOf(reject(engine, id))).toBeInstanceOf(Error);

        const after = holdings(internals, id);
        expect(after.attempt).toBe(before.attempt);
        expect(after.checkpoint).toBe(before.checkpoint);
        expect(after.committedBytes).toEqual(before.committedBytes);
        expect(after.headers).toBe(before.headers);
        expect(after.versionTuple).toBe(before.versionTuple);
        expect(after.services).toBe(before.services);
        expect(after.cleanupTracked).toBe(true);
        expect(internals.pendingStarts.has(id)).toBe(false);

        // The run it belongs to is still driven: it takes its signal and completes.
        await engine.signal(id, 'go', 'still running');
        expect(await handle.result()).toBe('still running');
      } finally {
        internals.storage = storage;
        await engine[Symbol.asyncDispose]();
      }
    });
  }

  it('unwinds everything a start that adopted a launch checkpoint left behind', async () => {
    const id = 'adopted-then-failed';
    const storage = new MemoryStorage();
    const engine = await Engine.create({ storage, recover: false });
    engine.register(parkedOnSignal(id));
    addStartHeaderInterceptor(engine);
    const internals = getInternals(engine);
    try {
      // The create commit fails after the start adopted its launch checkpoint.
      const refusedCommit = new Error('the create commit was refused');
      internals.storage = new Proxy(storage, {
        get(target, property) {
          const original: unknown = Reflect.get(target, property, target);
          if (typeof original !== 'function') return original;
          if (property === 'batch' || property === 'conditionalBatch') {
            return () => Promise.reject(refusedCommit);
          }
          return original.bind(target);
        },
      });

      expect(await rejectionOf(engine.start(id, null, { id, services: { owner: 'doomed' } }))).toBe(
        refusedCommit,
      );
      internals.storage = storage;

      const after = holdings(internals, id);
      expect(after.attempt).toBeUndefined();
      expect(after.checkpoint).toBeUndefined();
      expect(after.committedBytes).toBeUndefined();
      expect(after.headers).toBeUndefined();
      expect(after.versionTuple).toBeUndefined();
      expect(after.services).toBeUndefined();
      expect(after.cleanupTracked).toBe(false);
      expect(internals.pendingStarts.has(id)).toBe(false);
    } finally {
      internals.storage = storage;
      await engine[Symbol.asyncDispose]();
    }
  });

  it("leaves nothing in memory when a scheduled occurrence's start is rejected before adopting a checkpoint", async () => {
    const storage = new MemoryStorage();
    const engine = await Engine.create({
      storage,
      recover: false,
      resolveWorkflowServices: () => ({
        status: 'available',
        services: { owner: 'the occurrence' },
      }),
    });
    const internals = getInternals(engine);
    try {
      // The occurrence resolves its services and owes terminal cleanup, but it installs neither
      // until its start has committed, and the start rejects its unregistered type before it
      // adopts anything.
      const schedule = {
        id: 'unregistered-schedule',
        workflowType: 'never-registered',
        input: null,
      };

      const failure = await rejectionOf(
        startScheduledRun(internals, schedule as ScheduleState, createScheduleCallbacks(engine), {
          workflowId: 'unregistered-occurrence',
        }),
      );

      expect(failure).toBeInstanceOf(Error);
      expect(internals.workflowServices.has('unregistered-occurrence')).toBe(false);
      expect(internals.workflowsNeedingTerminalCleanup.has('unregistered-occurrence')).toBe(false);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('leaves the winning launch its services and cleanup membership when a concurrent drain of the same queued run is rejected', async () => {
    const id = 'drained-twice';
    const storage = new MemoryStorage();
    const resolved: object[] = [];
    const engine = await Engine.create({
      storage,
      recover: false,
      resolveWorkflowServices: () => {
        const services = { owner: `resolution ${resolved.length + 1}` };
        resolved.push(services);
        return { status: 'available', services };
      },
    });
    engine.register(parkedOnSignal(id));
    const internals = getInternals(engine);
    try {
      // A terminal handoff and a cadence tick draining the same persisted queued run both
      // call startScheduledRun with its id. The first to reach startWorkflow reserves the id.
      const schedule = { id: 'drained-schedule', workflowType: id, input: null } as ScheduleState;
      const callbacks = createScheduleCallbacks(engine);
      const [winner, loser] = await Promise.allSettled([
        startScheduledRun(internals, schedule, callbacks, { workflowId: id }),
        startScheduledRun(internals, schedule, callbacks, { workflowId: id }),
      ]);

      expect(winner.status).toBe('fulfilled');
      expect(loser.status).toBe('rejected');
      expect((loser as PromiseRejectedResult).reason).toBeInstanceOf(WorkflowAlreadyExistsError);
      // The winner's own services object, not the loser's replacement and not nothing.
      expect(resolved).toHaveLength(2);
      expect(internals.workflowServices.get(id)).toBe(resolved[0]);
      expect(internals.workflowsNeedingTerminalCleanup.has(id)).toBe(true);

      // The run it launched is still driven, and completing it sweeps what it holds.
      await waitForCondition(() => internals.parkedInlineWorkflows.has(id), {
        label: `${id} parked on its signal`,
      });
      await engine.signal(id, 'go', 'drained once');
      expect(await engine.getHandle(id).result()).toBe('drained once');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('leaves a live run its services and cleanup membership when a scheduled occurrence for its id is rejected', async () => {
    const id = 'occupied-occurrence';
    const { storage, engine, internals, handle } = await startLiveRun(id, () => ({
      status: 'available',
      services: { owner: 'the occurrence' },
    }));
    try {
      const before = holdings(internals, id);
      expect(before.services).toEqual({ owner: 'the live run' });
      expect(before.cleanupTracked).toBe(true);

      const schedule = { id: 'occupied-schedule', workflowType: id, input: null } as ScheduleState;
      const failure = await rejectionOf(
        startScheduledRun(internals, schedule, createScheduleCallbacks(engine), { workflowId: id }),
      );

      expect(failure).toBeInstanceOf(WorkflowAlreadyExistsError);
      const after = holdings(internals, id);
      expect(after.services).toBe(before.services);
      expect(after.cleanupTracked).toBe(true);
      expect(after.attempt).toBe(before.attempt);
      expect(after.checkpoint).toBe(before.checkpoint);

      await engine.signal(id, 'go', 'still running');
      expect(await handle.result()).toBe('still running');
    } finally {
      internals.storage = storage;
      await engine[Symbol.asyncDispose]();
    }
  });
});

/**
 * A failure raised while this engine launches, resumes, or recovers the stored
 * generation happens before it adopts that generation's checkpoint, so whatever
 * the engine still holds in memory for the id is an earlier, abandoned generation
 * and says nothing about which generation is failing.
 */
describe('failing a replacement before this engine adopts its checkpoint', () => {
  async function abandonThenReplaceWithServicesRun(id: string, startOptions: StartOptions) {
    const scenario = await abandonGenerationAndFinishItOnTheWinner(
      id,
      workflow({ name: `${id}-second` }).execute(async function* (context: WorkflowContext) {
        yield* context.sleep('30m');
        return 'woke';
      }),
    );
    // Neither engine has a services resolver, so an engine that launches B on its own can
    // never re-provide the services it recorded.
    await scenario.winner.start(`${id}-second`, null, {
      id,
      onTerminalConflict: 'start-new',
      services: { recorded: true },
      ...startOptions,
    });
    scenario.expectLoserStillHoldsAbandonedGeneration();
    return scenario;
  }

  async function readState(base: Storage, workflowId: string): Promise<WorkflowState> {
    return decode((await base.get(KEYS.workflow(workflowId)))!) as WorkflowState;
  }

  it('fails a delayed-start replacement whose services are unavailable, instead of dropping the failure', async () => {
    const scenario = await abandonThenReplaceWithServicesRun('delayed-fails', {
      startAfter: '5m',
    });
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await readStatus(scenario.storage, 'delayed-fails')).toBe('pending');
      const timerKeysBefore = await scenario.timerKeys();
      const delayedStartKeys = timerKeysBefore.filter((key) => key.includes('delayed'));
      expect(delayedStartKeys.length).toBeGreaterThanOrEqual(1);

      scenario.clock.now += 6 * 60 * 1000;
      await scenario.loser.scheduler.tick(scenario.clock.now);

      // The loser's memory still holds the abandoned A, but the failure belongs to B, which
      // the loser is launching. Dropping it would leave B `running` with no engine driving
      // it, while the scheduler counts its only durable timer as processed.
      const state = await readState(scenario.storage, 'delayed-fails');
      expect(state.status).toBe('failed');
      expect(state.error).toContain('services unavailable');
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      await scenario.dispose();
    }
  });

  it('judges a launch failure by the stored generation alone, even when the held one is abandoned mid-flight', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    adoptLaunchCheckpoint(internals, 'judged', {
      workflowExecutionToken: 'generation-a',
    } as Checkpoint);
    const storedReplacement = { workflowExecutionToken: 'generation-b' } as WorkflowState;
    // Both failures begin while the engine still holds a healthy generation A in memory.
    const executionFailure = staleFailureGuard(internals, 'judged', 'execution');
    const launchFailure = staleFailureGuard(internals, 'judged', 'launch');
    expect(executionFailure(storedReplacement)).toBe(false);
    expect(launchFailure(storedReplacement)).toBe(false);

    // A is then abandoned while they are in flight: the execution's own failure is A's and
    // must not land on the replacement, but a launch failure belongs to the replacement.
    abandonExecutionAttempt(internals, 'judged', 'generation-a');
    expect(executionFailure(storedReplacement)).toBe(true);
    expect(launchFailure(storedReplacement)).toBe(false);

    // The engine then launches B itself and loses it. Either origin is refused once the stored
    // generation is the one the engine holds and has abandoned; the execution failure began under
    // an attempt the engine has left, which refuses it on its own.
    adoptLaunchCheckpoint(internals, 'judged', {
      workflowExecutionToken: 'generation-b',
    } as Checkpoint);
    expect(launchFailure(storedReplacement)).toBe(false);
    abandonExecutionAttempt(internals, 'judged', 'generation-b');
    expect(executionFailure(storedReplacement)).toBe(true);
    expect(launchFailure(storedReplacement)).toBe(true);
  });

  it('fails a recovered replacement whose services are unavailable when the abandoning engine resumes it', async () => {
    const scenario = await abandonThenReplaceWithServicesRun('resume-fails', {});
    try {
      // Only the abandoning engine drives B from here on.
      await scenario.winner[Symbol.asyncDispose]();
      expect(await readStatus(scenario.storage, 'resume-fails')).toBe('running');

      // `engine.resume()` hands back the abandoned handle because the engine still holds a
      // checkpoint for the id, so drive the same forced replay a claim reclaim does.
      await resumeFromLifecycle(
        getInternals(scenario.loser),
        'resume-fails',
        createLifecycleCallbacks(scenario.loser),
        undefined,
        { forceReplayFromStorage: true },
      );

      const state = await readState(scenario.storage, 'resume-fails');
      expect(state.status).toBe('failed');
      expect(state.error).toContain('services unavailable');
    } finally {
      await scenario.loser[Symbol.asyncDispose]();
    }
  });
});

describe('result() for an abandoned generation', () => {
  it('rejects for a fresh handle without reading storage, while the generation is current', async () => {
    const storage = new MemoryStorage();
    let reads = 0;
    const counting = new Proxy(storage, {
      get(target, property) {
        const original: unknown = Reflect.get(target, property, target);
        if (typeof original !== 'function') return original;
        if (property === 'get') {
          return (...argumentsList: unknown[]) => {
            reads += 1;
            return original.apply(target, argumentsList);
          };
        }
        return original.bind(target);
      },
    });
    await using engine = new Engine({ storage: counting });
    const internals = getInternals(engine);
    await startParked(engine, 'fresh-handle', 'fresh-handle');
    const warning = collectConflictWarnings();
    loseGeneration(internals, 'fresh-handle');
    await warning.received;
    warning.stop();
    reads = 0;

    const freshHandle = new WorkflowHandle('fresh-handle', internals.engine);
    const reason = await rejectionOf(freshHandle.result());

    expect(reason).toBeInstanceOf(WorkflowCheckpointConflictError);
    expect((reason as WorkflowCheckpointConflictError).workflowId).toBe('fresh-handle');
    expect((reason as WorkflowCheckpointConflictError).workflowExecutionToken).toBe(
      tokenOf(internals, 'fresh-handle'),
    );
    expect(reads).toBe(0);
    expect(internals.resultResolvers.has('fresh-handle')).toBe(false);
  });

  it('is untouched for a workflow whose generation was not abandoned', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    const handle = await startParked(engine, 'healthy-run', 'healthy-run');
    await startParked(engine, 'lost-neighbour', 'lost-neighbour');
    const warning = collectConflictWarnings();
    loseGeneration(internals, 'lost-neighbour');
    await warning.received;
    warning.stop();

    await engine.signal('healthy-run', 'go', 'fine');
    expect(await handle.result()).toBe('fine');
  });
});

describe('a child this engine abandoned', () => {
  it('never reports a failure to the parent awaiting it, and mutates nothing', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    const waiter = createWorkflowResultWaiter(internals, 'abandoned-child');
    const viewedByParent = getGeneratorOwnedWorkflowResultPromise(
      internals,
      'abandoned-child',
      'parent',
    );

    waiter.reject(new WorkflowCheckpointConflictError('abandoned-child'));
    await yieldToEventLoop();

    await expectPromisePending(viewedByParent);
    expect(abandonedExecutionAttemptCount(internals)).toBe(0);
  });

  it('still surfaces every other child failure, including another workflow conflict', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    const internals = getInternals(engine);
    const failure = new Error('child failed');
    const failedChild = createWorkflowResultWaiter(internals, 'failed-child');
    const viewOfFailure = getGeneratorOwnedWorkflowResultPromise(
      internals,
      'failed-child',
      'parent',
    );
    failedChild.reject(failure);
    const unrelatedConflict = new WorkflowCheckpointConflictError('grandchild');
    const conflictedChild = createWorkflowResultWaiter(internals, 'other-child');
    const viewOfConflict = getGeneratorOwnedWorkflowResultPromise(
      internals,
      'other-child',
      'parent',
    );
    conflictedChild.reject(unrelatedConflict);

    expect(await rejectionOf(viewOfFailure)).toBe(failure);
    expect(await rejectionOf(viewOfConflict)).toBe(unrelatedConflict);
  });
});

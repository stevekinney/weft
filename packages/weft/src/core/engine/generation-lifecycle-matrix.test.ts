/**
 * Lifecycle state matrix for the execution generation an engine holds for one workflow id.
 *
 * A workflow id can be abandoned by a lost checkpoint compare-and-swap, failed by a terminal
 * write already in flight, woken by a timer or a signal, awaited through a handle, and torn
 * down by disposal, completion, a purge, or a suspend, and every one of those used to ask
 * "which generation does this engine hold for this id?" through whichever structure it
 * happened to read. This file crosses the engine-local states a run can be in with the events
 * that arrive at it, and asserts the one outcome COR-1408 specifies for every cell:
 *
 * - the loser writes nothing durable;
 * - `result()` rejects with `WorkflowCheckpointConflictError` instead of hanging, for a
 *   waiter that already exists and for a handle obtained after the loss, in every state that
 *   still holds the generation, including a suspended one;
 * - a failure raised by an attempt this engine no longer holds is dropped, and a failure of
 *   the attempt it does hold still lands;
 * - an engine that holds nothing for the id (the run finished, was purged, or the engine was
 *   disposed) has nothing to abandon, so a loss reported then warns about nothing.
 *
 * The cells observe behaviour only: warnings emitted, durable writes attempted, how a
 * `result()` settled, and the stored status. A table entry is the complete expected
 * observation, so a new path that reads the wrong structure fails exactly the cells it gets
 * wrong.
 */
import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import {
  createDeferred,
  waitForCondition,
  yieldToEventLoop,
} from '../../testing/fake-timers.test-support.ts';
import { decode } from '../codec/api.ts';
import {
  activity,
  workflow,
  type AnyWorkflowDefinition,
  type WorkflowContext,
  type WorkflowState,
} from '../types.ts';
import { createLifecycleCallbacks } from './callback-creators-core.ts';
import { abandonWorkflowAfterCheckpointConflict } from './checkpoint-conflict-abandon.ts';
import { WorkflowCheckpointConflictError } from './checkpoint-conflict-error.ts';
import {
  collectConflictWarnings,
  holdFailureAtItsFirstRead,
  interceptConflictWarnings,
  noCallbacks,
  parkedOnSignal,
  recordWrites,
  tokenOf,
} from './checkpoint-conflict.test-support.ts';
import { currentExecutionAttempt } from './execution-attempts.ts';
import { Engine } from './index.ts';
import { getInternals, type EngineInternals } from './internals.ts';
import { resume as resumeFromLifecycle } from './lifecycle.ts';
import { failWorkflow } from './termination/complete.ts';
import { confirmWakeOwnership } from './wake-ownership-guard.ts';

const STATES = [
  'running',
  'parked',
  'sleeping',
  'suspended',
  'completed',
  'disposed',
  'purged',
  'relaunched',
  'resumed',
  'replaced',
] as const;

const EVENTS = [
  'loss',
  'existing-waiter',
  'fresh-result',
  'fresh-result-after-loss',
  'stale-failure',
  'current-failure',
  'wake-or-timer',
  'post-dispose-conflict',
] as const;

type StateName = (typeof STATES)[number];
type EventName = (typeof EVENTS)[number];

/** What a cell records: everything its event made this engine do, and the stored status. */
type Observation = {
  readonly outcome: string;
  readonly warnings: number;
  readonly wrote: boolean;
  readonly status: string;
};

/** What a scene has to arrange before its last transition, because the event needs it from earlier. */
type Arm = 'none' | 'waiter' | 'failure';

type Scene = {
  readonly id: string;
  readonly engine: Engine;
  readonly internals: EngineInternals;
  readonly backing: MemoryStorage;
  readonly clock: { now: number };
  /** The generation token a lost checkpoint commit names: what the engine held last. */
  token: string | undefined;
  writes: string[];
  disposed: boolean;
  /** A `result()` requested while the run was in the state the scene ends in. */
  waiter?: Promise<unknown>;
  /** A terminal failure raised under the attempt the engine held earlier, held at its first read. */
  failure?: Promise<void>;
  releaseFailure?: () => void;
  releaseActivity?: () => void;
  /** What makes the held failure's attempt no longer the one the engine holds, when the scene has not already. */
  makeFailureStale: () => void;
};

type Workflows = Record<string, AnyWorkflowDefinition>;

function createScene(id: string, workflows: Workflows): Scene {
  const clock = { now: 1_000_000 };
  const backing = new MemoryStorage();
  const watched = recordWrites(backing);
  const engine = new Engine({
    storage: watched.storage,
    getNow: () => clock.now,
    backgroundTasks: 'manual',
  });
  for (const definition of Object.values(workflows)) engine.register(definition);
  const internals = getInternals(engine);
  const scene: Scene = {
    id,
    engine,
    internals,
    backing,
    clock,
    token: undefined,
    writes: watched.writes,
    disposed: false,
    makeFailureStale: () => reportLoss(scene),
  };
  return scene;
}

async function waitForParked(scene: Scene): Promise<void> {
  await waitForCondition(() => scene.internals.parkedInlineWorkflows.has(scene.id), {
    label: `${scene.id} parked on its signal`,
  });
}

function reportLoss(scene: Scene): void {
  abandonWorkflowAfterCheckpointConflict(
    scene.internals,
    new WorkflowCheckpointConflictError(scene.id, { workflowExecutionToken: scene.token }),
  );
}

/** Report a loss as a setup step, and wait for its warning so no event counts it. */
async function loseDuringSetup(scene: Scene): Promise<void> {
  const warning = collectConflictWarnings();
  reportLoss(scene);
  await warning.received;
  warning.stop();
}

function armWaiter(scene: Scene, handle: { result(): Promise<unknown> }): void {
  scene.waiter = handle.result();
  // Settled before the event looks at it for the states that tear the run down; not unhandled.
  scene.waiter.catch(() => {});
}

async function armFailure(scene: Scene): Promise<void> {
  const held = holdFailureAtItsFirstRead(scene.internals, scene.backing, scene.id);
  scene.failure = failWorkflow(scene.internals, scene.id, new Error('stale failure'), noCallbacks);
  await held.reached;
  scene.releaseFailure = held.release;
  scene.writes = held.writes;
}

/** Start the scene's workflow, parked on its signal, with whatever the event arms for. */
async function startParkedScene(
  state: StateName,
  id: string,
  arm: Arm,
  { armFailureNow }: { armFailureNow: boolean },
): Promise<{ scene: Scene; handle: Awaited<ReturnType<Engine['start']>> }> {
  const scene = createScene(id, { [state]: parkedOnSignal(state) });
  const handle = await scene.engine.start(state, null, { id });
  await waitForParked(scene);
  scene.token = tokenOf(scene.internals, id);
  if (arm === 'waiter') armWaiter(scene, handle);
  if (arm === 'failure' && armFailureNow) await armFailure(scene);
  return { scene, handle };
}

const BUILDERS: Record<StateName, (id: string, arm: Arm) => Promise<Scene>> = {
  async running(id, arm) {
    const entered = createDeferred();
    const release = createDeferred();
    const gate = activity({
      name: 'gate',
      execute: async (_input: { id: string }) => {
        entered.resolve();
        await release.promise;
        return 'gate-open';
      },
    });
    const scene = createScene(id, {
      running: workflow({ name: 'running' })
        .activities({ gate })
        .execute(async function* (context: WorkflowContext) {
          return yield* context.run(gate, { id });
        }),
    });
    scene.releaseActivity = () => release.resolve();
    const handle = await scene.engine.start('running', null, { id });
    await entered.promise;
    scene.token = tokenOf(scene.internals, id);
    if (arm === 'waiter') armWaiter(scene, handle);
    if (arm === 'failure') await armFailure(scene);
    return scene;
  },

  async parked(id, arm) {
    const { scene } = await startParkedScene('parked', id, arm, { armFailureNow: true });
    return scene;
  },

  async sleeping(id, arm) {
    const scene = createScene(id, {
      sleeping: workflow({ name: 'sleeping' }).execute(async function* (context: WorkflowContext) {
        yield* context.sleep('5m');
        return 'woke';
      }),
    });
    const handle = await scene.engine.start('sleeping', null, { id });
    await waitForCondition(() => scene.internals.sleepResolversByWorkflow.has(id), {
      label: `${id} asleep on a durable timer`,
    });
    scene.token = tokenOf(scene.internals, id);
    if (arm === 'waiter') armWaiter(scene, handle);
    if (arm === 'failure') await armFailure(scene);
    return scene;
  },

  async suspended(id, arm) {
    const { scene } = await startParkedScene('suspended', id, arm, { armFailureNow: false });
    await scene.engine.suspend(id);
    // Suspension released the checkpoint; only the attempt still says which generation this was.
    expect(scene.internals.checkpoints.has(id)).toBe(false);
    if (arm === 'failure') await armFailure(scene);
    return scene;
  },

  async completed(id, arm) {
    const { scene, handle } = await startParkedScene('completed', id, arm, {
      armFailureNow: true,
    });
    await scene.engine.signal(id, 'go', 'done');
    expect(await handle.result()).toBe('done');
    scene.makeFailureStale = () => {};
    return scene;
  },

  async disposed(id, arm) {
    const { scene } = await startParkedScene('disposed', id, arm, { armFailureNow: true });
    await scene.engine[Symbol.asyncDispose]();
    scene.disposed = true;
    scene.makeFailureStale = () => {};
    return scene;
  },

  async purged(id, arm) {
    const { scene, handle } = await startParkedScene('purged', id, arm, { armFailureNow: true });
    await scene.engine.signal(id, 'go', 'done');
    expect(await handle.result()).toBe('done');
    const purged = await scene.engine.purge();
    expect(purged.deleted).toBe(1);
    scene.makeFailureStale = () => {};
    return scene;
  },

  async relaunched(id, arm) {
    const { scene } = await startParkedScene('relaunched', id, 'none', { armFailureNow: false });
    if (arm === 'failure') await armFailure(scene);
    // This engine loses generation A, then launches that same stored generation again: a new
    // attempt at the same generation, which no longer counts as abandoned.
    await loseDuringSetup(scene);
    const relaunched = await resumeFromLifecycle(
      scene.internals,
      id,
      createLifecycleCallbacks(scene.engine),
      undefined,
      { forceReplayFromStorage: true },
    );
    await waitForParked(scene);
    expect(tokenOf(scene.internals, id)).toBe(scene.token);
    if (arm === 'waiter') armWaiter(scene, relaunched);
    scene.makeFailureStale = () => {};
    return scene;
  },

  async resumed(id, arm) {
    const { scene } = await startParkedScene('resumed', id, 'none', { armFailureNow: false });
    if (arm === 'failure') await armFailure(scene);
    // The same forced replay a claim reclaim performs, with no loss: this engine launches the
    // generation it already drives a second time, so a failure begun under the first launch is
    // an earlier attempt's although nothing was ever abandoned.
    const resumed = await resumeFromLifecycle(
      scene.internals,
      id,
      createLifecycleCallbacks(scene.engine),
      undefined,
      { forceReplayFromStorage: true },
    );
    await waitForParked(scene);
    expect(tokenOf(scene.internals, id)).toBe(scene.token);
    if (arm === 'waiter') armWaiter(scene, resumed);
    scene.makeFailureStale = () => {};
    return scene;
  },

  async replaced(id, arm) {
    const { scene, handle } = await startParkedScene('replaced', id, 'none', {
      armFailureNow: false,
    });
    if (arm === 'failure') await armFailure(scene);
    // Generation A finishes and a local start-new installs generation B under the same id.
    await scene.engine.signal(id, 'go', 'A done');
    expect(await handle.result()).toBe('A done');
    const replacement = await scene.engine.start('replaced', null, {
      id,
      onTerminalConflict: 'start-new',
    });
    await waitForParked(scene);
    scene.token = tokenOf(scene.internals, id);
    if (arm === 'waiter') armWaiter(scene, replacement);
    scene.makeFailureStale = () => {};
    return scene;
  },
};

async function storedStatus(scene: Scene): Promise<string> {
  const bytes = await scene.backing.get(KEYS.workflow(scene.id));
  return bytes === null ? 'absent' : (decode(bytes) as WorkflowState).status;
}

/** How a promise settled, or `pending` when it had not after one event-loop turn. */
async function settlement(promise: Promise<unknown>): Promise<string> {
  const outcome = await Promise.race([
    promise.then(
      (value) => `resolved:${String(value)}`,
      (reason: unknown) =>
        `rejected:${reason instanceof Error ? reason.constructor.name : String(reason)}`,
    ),
    yieldToEventLoop().then(() => 'pending'),
  ]);
  return outcome;
}

/** Run an event against the scene, counting the warnings it caused and the writes it attempted. */
async function observe(scene: Scene, act: () => Promise<string>): Promise<Observation> {
  const warning = collectConflictWarnings();
  scene.writes.length = 0;
  try {
    const outcome = await act();
    await yieldToEventLoop();
    return {
      outcome,
      warnings: warning.warnings.filter((warned) => warned.workflowId === scene.id).length,
      wrote: scene.writes.length > 0,
      status: await storedStatus(scene),
    };
  } finally {
    warning.stop();
  }
}

async function timerOutcome(scene: Scene): Promise<string> {
  try {
    await scene.engine.fireTimer({
      id: `deadline:${scene.id}`,
      workflowId: scene.id,
      fireAt: scene.clock.now,
      kind: 'execution-deadline',
    });
    return 'settled';
  } catch (error) {
    if (error instanceof Error && error.message.includes('retaining it in storage')) {
      return 'retained';
    }
    return `rejected:${error instanceof Error ? error.constructor.name : String(error)}`;
  }
}

const ARMS: Record<EventName, Arm> = {
  loss: 'none',
  'existing-waiter': 'waiter',
  'fresh-result': 'none',
  'fresh-result-after-loss': 'none',
  'stale-failure': 'failure',
  'current-failure': 'none',
  'wake-or-timer': 'none',
  'post-dispose-conflict': 'none',
};

const EVENT_RUNNERS: Record<EventName, (scene: Scene) => Promise<Observation>> = {
  loss: (scene) =>
    observe(scene, async () => {
      reportLoss(scene);
      return `wake:${await confirmWakeOwnership(scene.internals, scene.id, 'signal')}`;
    }),

  'existing-waiter': (scene) =>
    observe(scene, async () => {
      reportLoss(scene);
      return `waiter:${await settlement(scene.waiter!)}`;
    }),

  'fresh-result': (scene) =>
    observe(scene, async () => {
      return `result:${await settlement(scene.engine.getHandle(scene.id).result())}`;
    }),

  'fresh-result-after-loss': (scene) =>
    observe(scene, async () => {
      reportLoss(scene);
      return `result:${await settlement(scene.engine.getHandle(scene.id).result())}`;
    }),

  'stale-failure': (scene) =>
    observe(scene, async () => {
      scene.makeFailureStale();
      scene.releaseFailure!();
      await scene.failure;
      return scene.writes.length === 0 ? 'failure:dropped' : 'failure:wrote';
    }),

  'current-failure': (scene) =>
    observe(scene, async () => {
      await failWorkflow(scene.internals, scene.id, new Error('current failure'), noCallbacks);
      return scene.writes.length === 0 ? 'failure:dropped' : 'failure:wrote';
    }),

  'wake-or-timer': (scene) =>
    observe(scene, async () => {
      reportLoss(scene);
      const wake = await confirmWakeOwnership(scene.internals, scene.id, 'signal');
      return `wake:${wake} timer:${await timerOutcome(scene)}`;
    }),

  'post-dispose-conflict': async (scene) => {
    if (!scene.disposed) {
      await scene.engine[Symbol.asyncDispose]();
      scene.disposed = true;
    }
    return observe(scene, async () => {
      reportLoss(scene);
      const attempt = currentExecutionAttempt(scene.internals, scene.id);
      const result = await settlement(scene.engine.getHandle(scene.id).result());
      return `attempt:${attempt === undefined ? 'none' : 'held'} result:${result}`;
    });
  },
};

const settled = (outcome: string, status: string): Observation => ({
  outcome,
  warnings: 0,
  wrote: false,
  status,
});
/** The engine holds the generation, so the loss abandons it: one warning and nothing written. */
const abandoned = (outcome: string, status = 'running'): Observation => ({
  outcome,
  warnings: 1,
  wrote: false,
  status,
});
const wrote = (outcome: string, status: string): Observation => ({
  outcome,
  warnings: 0,
  wrote: true,
  status,
});

const CONFLICT = 'rejected:WorkflowCheckpointConflictError';
const DISPOSED = 'rejected:EngineDisposedError';

/**
 * The expected observation of every cell. States that still hold the generation abandon it on
 * a loss, including a suspended one that released its checkpoint; the states that hold nothing
 * (`completed`, `disposed`, `purged`) ignore it. `relaunched` and `replaced` are healthy again:
 * the abandonment ended with the attempt that suffered it.
 */
const EXPECTED: Record<EventName, Partial<Record<StateName, Observation>>> = {
  loss: {
    running: abandoned('wake:discard'),
    parked: abandoned('wake:discard'),
    sleeping: abandoned('wake:discard'),
    suspended: abandoned('wake:discard', 'suspended'),
    completed: settled('wake:proceed', 'completed'),
    disposed: settled('wake:proceed', 'running'),
    purged: settled('wake:proceed', 'absent'),
    relaunched: abandoned('wake:discard'),
    resumed: abandoned('wake:discard'),
    replaced: abandoned('wake:discard'),
  },
  'existing-waiter': {
    running: abandoned(`waiter:${CONFLICT}`),
    parked: abandoned(`waiter:${CONFLICT}`),
    sleeping: abandoned(`waiter:${CONFLICT}`),
    suspended: abandoned(`waiter:${CONFLICT}`, 'suspended'),
    completed: settled('waiter:resolved:done', 'completed'),
    disposed: settled(`waiter:${DISPOSED}`, 'running'),
    purged: settled('waiter:resolved:done', 'absent'),
    relaunched: abandoned(`waiter:${CONFLICT}`),
    resumed: abandoned(`waiter:${CONFLICT}`),
    replaced: abandoned(`waiter:${CONFLICT}`),
  },
  'fresh-result': {
    running: settled('result:pending', 'running'),
    parked: settled('result:pending', 'running'),
    sleeping: settled('result:pending', 'running'),
    suspended: settled('result:pending', 'suspended'),
    completed: settled('result:resolved:done', 'completed'),
    disposed: settled(`result:${DISPOSED}`, 'running'),
    purged: settled('result:rejected:Error', 'absent'),
    relaunched: settled('result:pending', 'running'),
    resumed: settled('result:pending', 'running'),
    replaced: settled('result:pending', 'running'),
  },
  'fresh-result-after-loss': {
    running: abandoned(`result:${CONFLICT}`),
    parked: abandoned(`result:${CONFLICT}`),
    sleeping: abandoned(`result:${CONFLICT}`),
    suspended: abandoned(`result:${CONFLICT}`, 'suspended'),
    completed: settled('result:resolved:done', 'completed'),
    disposed: settled(`result:${DISPOSED}`, 'running'),
    purged: settled('result:rejected:Error', 'absent'),
    relaunched: abandoned(`result:${CONFLICT}`),
    resumed: abandoned(`result:${CONFLICT}`),
    replaced: abandoned(`result:${CONFLICT}`),
  },
  'stale-failure': {
    running: abandoned('failure:dropped'),
    parked: abandoned('failure:dropped'),
    sleeping: abandoned('failure:dropped'),
    suspended: abandoned('failure:dropped', 'suspended'),
    completed: settled('failure:dropped', 'completed'),
    disposed: settled('failure:dropped', 'running'),
    purged: settled('failure:dropped', 'absent'),
    relaunched: settled('failure:dropped', 'running'),
    resumed: settled('failure:dropped', 'running'),
    replaced: settled('failure:dropped', 'running'),
  },
  'current-failure': {
    running: wrote('failure:wrote', 'failed'),
    parked: wrote('failure:wrote', 'failed'),
    sleeping: wrote('failure:wrote', 'failed'),
    suspended: wrote('failure:wrote', 'failed'),
    completed: settled('failure:dropped', 'completed'),
    purged: settled('failure:dropped', 'absent'),
    relaunched: wrote('failure:wrote', 'failed'),
    resumed: wrote('failure:wrote', 'failed'),
    replaced: wrote('failure:wrote', 'failed'),
  },
  'wake-or-timer': {
    running: abandoned('wake:discard timer:retained'),
    parked: abandoned('wake:discard timer:retained'),
    sleeping: abandoned('wake:discard timer:retained'),
    suspended: abandoned('wake:discard timer:settled', 'suspended'),
    completed: settled('wake:proceed timer:settled', 'completed'),
    purged: settled('wake:proceed timer:settled', 'absent'),
    relaunched: abandoned('wake:discard timer:retained'),
    resumed: abandoned('wake:discard timer:retained'),
    replaced: abandoned('wake:discard timer:retained'),
  },
  'post-dispose-conflict': {
    running: settled(`attempt:none result:${DISPOSED}`, 'running'),
    parked: settled(`attempt:none result:${DISPOSED}`, 'running'),
    sleeping: settled(`attempt:none result:${DISPOSED}`, 'running'),
    suspended: settled(`attempt:none result:${DISPOSED}`, 'suspended'),
    completed: settled(`attempt:none result:${DISPOSED}`, 'completed'),
    disposed: settled(`attempt:none result:${DISPOSED}`, 'running'),
    purged: settled(`attempt:none result:${DISPOSED}`, 'absent'),
    relaunched: settled(`attempt:none result:${DISPOSED}`, 'running'),
    resumed: settled(`attempt:none result:${DISPOSED}`, 'running'),
    replaced: settled(`attempt:none result:${DISPOSED}`, 'running'),
  },
};

/**
 * The registry and the in-memory checkpoints agree once an event has played out. A checkpoint
 * the engine holds has an attempt for the same generation; an attempt with no checkpoint is a
 * suspended run's, the one state in which the engine holds a generation and no checkpoint; and
 * a disposed engine holds neither. The first two are what let every reader of the registry
 * stand in for a reader of the checkpoint; the last is what keeps disposal from retaining a
 * workflow id and token, or from letting a late loss abandon a run nobody drives.
 */
async function expectRegistryAgreesWithCheckpoints(scene: Scene): Promise<void> {
  const checkpoint = scene.internals.checkpoints.get(scene.id);
  const attempt = currentExecutionAttempt(scene.internals, scene.id);
  if (scene.disposed) {
    expect({ checkpoint, attempt }).toEqual({ checkpoint: undefined, attempt: undefined });
  } else if (checkpoint !== undefined) {
    expect(attempt).toBeDefined();
    expect(attempt?.workflowExecutionToken).toBe(checkpoint.workflowExecutionToken);
  } else if (attempt !== undefined) {
    expect(await storedStatus(scene)).toBe('suspended');
  }
}

/**
 * Cells this matrix does not exercise, each with the reason. A failure that begins, or a timer
 * that fires, on an engine that was already disposed carries no attempt for the registry to
 * judge: the write is decided by the stored status alone, exactly as on main, and whether a
 * disposed engine may write at all is a question about disposal, not about which generation
 * the engine holds. The disposed cells that do concern the registry (a failure already in
 * flight when the engine was disposed, a lost commit reported afterwards, a `result()`
 * requested afterwards) are all in the table above.
 */
const NOT_EXERCISED: ReadonlyArray<readonly [EventName, StateName, string]> = [
  [
    'current-failure',
    'disposed',
    'a failure beginning after disposal holds no attempt; the guard defers to the stored status, as on main',
  ],
  [
    'wake-or-timer',
    'disposed',
    'a timer fired by hand on a disposed engine is judged by the stored status, as on main',
  ],
];

interceptConflictWarnings();

describe('generation lifecycle matrix', () => {
  it('accounts for every state and event exactly once', () => {
    const exercised = EVENTS.flatMap((event) =>
      STATES.filter((state) => EXPECTED[event][state] !== undefined).map(
        (state) => `${event}/${state}`,
      ),
    );
    const declined = NOT_EXERCISED.map(([event, state]) => `${event}/${state}`);
    const everyCell = EVENTS.flatMap((event) => STATES.map((state) => `${event}/${state}`));
    expect([...exercised, ...declined].toSorted()).toEqual(everyCell.toSorted());
    expect(NOT_EXERCISED.every(([, , reason]) => reason.length > 0)).toBe(true);
  });

  for (const event of EVENTS) {
    describe(event, () => {
      for (const state of STATES) {
        const expected = EXPECTED[event][state];
        if (expected === undefined) continue;
        it(`${state} state`, async () => {
          const scene = await BUILDERS[state](`${state}--${event}`, ARMS[event]);
          try {
            expect(await EVENT_RUNNERS[event](scene)).toEqual(expected);
            await expectRegistryAgreesWithCheckpoints(scene);
          } finally {
            scene.releaseFailure?.();
            scene.releaseActivity?.();
            if (!scene.disposed) await scene.engine[Symbol.asyncDispose]();
          }
        });
      }
    });
  }
});

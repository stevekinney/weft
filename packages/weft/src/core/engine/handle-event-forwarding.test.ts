/**
 * COR-1605: a workflow handle observes every workflow-scoped event the engine
 * dispatches for its workflow, not only the terminal events termination
 * forwards to it.
 *
 * `Engine.dispatchEvent` forwards each event that names a workflow to that
 * workflow's cached handle, and the handle's event iterator subscribes to every
 * kind in `WeftEventMap`. These cover each event family through a real
 * workflow, cross-workflow isolation, the iterator's replay and buffering
 * contract, and a guard that fails when a new event kind is not forwarded.
 */
import { describe, expect, it, jest } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Glob } from 'bun';

import { nextAsyncPendingToken } from '../../testing/async-activity.test-support.ts';
import {
  ActivityAsyncPendingEvent,
  ActivityCompletedEvent,
  ActivityFailedEvent,
  ActivityStartedEvent,
  AlertFiredEvent,
  AlertResolvedEvent,
  AttributesChangedEvent,
  CheckpointSizeWarningEvent,
  CleanupWarningEvent,
  ConstraintViolatedEvent,
  DevelopmentWarningEvent,
  LeaseHealthChangedEvent,
  QueueDepthChangedEvent,
  RealmStateChangedEvent,
  RemoteActivityCancellationRequestedEvent,
  RemoteActivityQueuedEvent,
  ScheduleAttemptedEvent,
  ScheduleFiredEvent,
  ScheduleMissedFireEvent,
  ScheduleSkippedEvent,
  SignalDeliveredEvent,
  SignalReceivedEvent,
  SignalWaitingEvent,
  StorageSizeReportedEvent,
  StreamChunkEvent,
  TaskAttemptTransitionEvent,
  TaskResultDeadLetteredEvent,
  TaskResultDeliveryEvent,
  UpdateCompletedEvent,
  UpdateReceivedEvent,
  WorkerConnectedEvent,
  WorkerDeploymentChangedEvent,
  WorkerDisconnectedEvent,
  WorkerRegistrationRejectedEvent,
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowDefinitionRegisteredEvent,
  WorkflowFailedEvent,
  WorkflowRecoverySkippedEvent,
  WorkflowResumedEvent,
  WorkflowRevisionActivatedEvent,
  WorkflowRevisionActivationRejectedEvent,
  WorkflowRevisionDrainingEvent,
  WorkflowRevisionInstalledEvent,
  WorkflowRevisionRemovedEvent,
  WorkflowSourceLoadCancelledEvent,
  WorkflowSourceLoadFailedEvent,
  WorkflowSourceLoadReadyEvent,
  WorkflowSourceLoadStartedEvent,
  WorkflowStartedEvent,
  WorkflowSuspendedEvent,
  WorkflowTeardownEvent,
  WorkflowTimedOutEvent,
  type WeftEventMap,
} from '../events.ts';
import { getWorkflowIdFromEvent } from '../events/workflow-event-id.ts';
import { WORKFLOW_TERMINAL_EVENT_TYPES } from '../events/workflow-events.ts';
import { ReviewCompletedEvent, ReviewRequestedEvent } from '../review/events.ts';
import { activity, workflow, type ActivityContext, type WorkflowContext } from '../types.ts';
import {
  WORKFLOW_HANDLE_EVENT_BUFFER_LIMIT,
  WorkflowHandleEventOverflowError,
  createWorkflowHandleEventIterator,
} from './handle-iteration.ts';
import type { WorkflowHandle } from './handles.ts';
import { Engine } from './index.ts';
import { nextSignalWaiting } from './signal-wait-tracking.test-support.ts';

/**
 * One factory per `WeftEventMap` kind. The mapped type makes this exhaustive:
 * a kind added to the map fails type-checking here until it has a factory, and
 * the guard below then proves the engine forwards it to the handle when it
 * names a workflow.
 */
const EVENT_FACTORIES: { [K in keyof WeftEventMap]: (workflowId: string) => WeftEventMap[K] } = {
  'workflow:definition-registered': () => new WorkflowDefinitionRegisteredEvent('guard-type'),
  'workflow:started': (id) => new WorkflowStartedEvent(id, 'guard-type', null),
  'workflow:completed': (id) => new WorkflowCompletedEvent(id, 'synthetic', 1),
  'workflow:failed': (id) => new WorkflowFailedEvent(id, new Error('synthetic')),
  'workflow:cancelled': (id) => new WorkflowCancelledEvent(id),
  'workflow:timed-out': (id) => new WorkflowTimedOutEvent(id, 'execution', 1),
  'workflow:resumed': (id) => new WorkflowResumedEvent(id, 3),
  'workflow:suspended': (id) => new WorkflowSuspendedEvent(id),
  'workflow:recovery-skipped': (id) =>
    new WorkflowRecoverySkippedEvent(id, 'guard-type', 'type-not-registered'),
  'workflow:teardown': (id) => new WorkflowTeardownEvent(id, 'guard-type', 'completed', 1),
  'activity:started': (id) => new ActivityStartedEvent('operation-1', id, 'guard-activity', 1),
  'activity:completed': (id) => new ActivityCompletedEvent('operation-1', id, 'guard-activity', 5),
  'activity:failed': (id) =>
    new ActivityFailedEvent('operation-1', id, 'guard-activity', new Error('synthetic'), 1),
  'activity:async-pending': (id) =>
    new ActivityAsyncPendingEvent('token-1', 'operation-1', id, 'guard-activity', 1),
  'activity:remote-queued': (id) => new RemoteActivityQueuedEvent('operation-1', id, 'queue-1'),
  'activity:remote-cancellation-requested': (id) =>
    new RemoteActivityCancellationRequestedEvent('token-1', id),
  'task:dead-lettered': (id) =>
    new TaskResultDeadLetteredEvent({
      operationId: 'operation-1',
      workflowId: id,
      errorMessage: 'synthetic',
    }),
  'task:result-delivery': (id) =>
    new TaskResultDeliveryEvent({
      operationId: 'operation-1',
      workflowId: id,
      activityName: 'guard-activity',
      queue: 'queue-1',
      transport: 'webSocket',
      attemptTokenDigest: 'digest',
      outcome: 'acknowledged',
      disposition: 'duplicate',
    }),
  'task:attempt-transition': (id) =>
    new TaskAttemptTransitionEvent({
      operationId: 'operation-1',
      workflowId: id,
      activityName: 'guard-activity',
      attempt: 1,
      attemptTokenDigest: 'digest',
      workerSessionId: 'session-1',
      crossBuildRetry: false,
    }),
  'signal:received': (id) => new SignalReceivedEvent(id, 'guard-signal', 'payload'),
  'signal:waiting': (id) => new SignalWaitingEvent(id, 'guard-signal'),
  'signal:delivered': (id) => new SignalDeliveredEvent(id, 'guard-signal'),
  'schedule:fired': (id) => new ScheduleFiredEvent('schedule-1', id, 1),
  'human-review:requested': (id) => new ReviewRequestedEvent(id, 'review-1', 'approval', ['a']),
  'human-review:completed': (id) =>
    new ReviewCompletedEvent(id, 'review-1', 'approved', 'reviewer', 5),
  'attributes:changed': (id) => new AttributesChangedEvent(id, { priority: 'high' }),
  'schedule:missed-fire': () => new ScheduleMissedFireEvent('schedule-1', 2, 0, 10, 'late'),
  'schedule:attempted': () => new ScheduleAttemptedEvent('schedule-1', 1),
  'schedule:skipped': () => new ScheduleSkippedEvent('schedule-1', 1, 'skip'),
  'update:received': (id) => new UpdateReceivedEvent('update-1', id, 'rename', 'payload'),
  'update:completed': (id) => new UpdateCompletedEvent('update-1', id, 'rename', 'result'),
  'checkpoint:size-warning': (id) => new CheckpointSizeWarningEvent(id, 1024, 2),
  'development:warning': (id) => new DevelopmentWarningEvent(id, 'synthetic', ['field']),
  'cleanup:warning': (id) => new CleanupWarningEvent('guard', new Error('synthetic'), id),
  'storage:size-reported': () => new StorageSizeReportedEvent(1024),
  'worker:connected': () => new WorkerConnectedEvent('worker-1', 'queue-1', ['a'], 1),
  'worker:disconnected': () => new WorkerDisconnectedEvent('worker-1', 0),
  'alert:fired': () => new AlertFiredEvent('failure-rate', 0.5, 0.9),
  'alert:resolved': () => new AlertResolvedEvent('failure-rate', 0.5, 0.1),
  'constraint:violated': (id) => new ConstraintViolatedEvent(id, 'limit', 'workflow', 'warn'),
  'catalog:revision-installed': () => new WorkflowRevisionInstalledEvent('guard-type', 'r1'),
  'catalog:revision-activated': () =>
    new WorkflowRevisionActivatedEvent('guard-type', 'r1', 1, undefined),
  'catalog:activation-rejected': () =>
    new WorkflowRevisionActivationRejectedEvent('guard-type', 'r1', 'conflict'),
  'catalog:revision-draining': () => new WorkflowRevisionDrainingEvent('guard-type', 'r1'),
  'catalog:revision-removed': () => new WorkflowRevisionRemovedEvent('guard-type', 'r1'),
  'workflow-source:load-started': () =>
    new WorkflowSourceLoadStartedEvent('guard-type', 'r1', 'module'),
  'workflow-source:load-ready': () =>
    new WorkflowSourceLoadReadyEvent('guard-type', 'r1', 'module', 5),
  'workflow-source:load-failed': () =>
    new WorkflowSourceLoadFailedEvent('guard-type', 'r1', 'module', 5, 'system'),
  'workflow-source:load-cancelled': () =>
    new WorkflowSourceLoadCancelledEvent('guard-type', 'r1', 'module'),
  'realm:state-changed': () => new RealmStateChangedEvent('realm-1', 'r1', 'ready', 0),
  'lease:health-changed': () => new LeaseHealthChangedEvent('healthy'),
  'worker:registration-rejected': () =>
    new WorkerRegistrationRejectedEvent('worker-1', 'registration_rejected'),
  'worker:deployment-changed': () =>
    new WorkerDeploymentChangedEvent('billing', 'b1', 'draining', 3),
  'stream:chunk': (id) => new StreamChunkEvent(id, 'progress', 0),
  'queue:depth-changed': () => new QueueDepthChangedEvent('payments', 3),
};

const EVENT_KINDS = Object.keys(EVENT_FACTORIES) as (keyof WeftEventMap)[];

/** Kinds that never name a workflow, so they stay on the engine. */
const ENGINE_SCOPED_KINDS: (keyof WeftEventMap)[] = [
  'workflow:definition-registered',
  'schedule:missed-fire',
  'schedule:attempted',
  'schedule:skipped',
  'storage:size-reported',
  'worker:connected',
  'worker:disconnected',
  'alert:fired',
  'alert:resolved',
  'catalog:revision-installed',
  'catalog:revision-activated',
  'catalog:activation-rejected',
  'catalog:revision-draining',
  'catalog:revision-removed',
  'workflow-source:load-started',
  'workflow-source:load-ready',
  'workflow-source:load-failed',
  'workflow-source:load-cancelled',
  'realm:state-changed',
  'lease:health-changed',
  'worker:registration-rejected',
  'worker:deployment-changed',
  'queue:depth-changed',
];

/** Kinds termination forwards to the handle itself, after its supersession check. */
const TERMINATION_FORWARDED_KINDS = new Set<string>([
  ...WORKFLOW_TERMINAL_EVENT_TYPES,
  WorkflowSuspendedEvent.type,
]);

const approvalThenAfter = workflow({ name: 'approval-then-after' }).execute(async function* (
  ctx: WorkflowContext,
) {
  const approval = yield* ctx.waitForSignal<string>('approval');
  const after = yield* ctx.waitForSignal<string>('after');
  return { approval, after };
});

const awaitCallback = activity({
  name: 'awaitCallback',
  execute: (_input: void, context?: ActivityContext): unknown => context!.completeAsync(),
});

const goThenCallback = workflow({ name: 'go-then-callback' })
  .activities({ awaitCallback })
  .execute(async function* (ctx: WorkflowContext) {
    yield* ctx.waitForSignal('go');
    return yield* ctx.run(awaitCallback);
  });

const remoteWork = activity({ name: 'remoteWork', execute: async (_input: void) => 'local' });

const goThenRemote = workflow({ name: 'go-then-remote' })
  .activities({ remoteWork })
  .execute(async function* (ctx: WorkflowContext) {
    yield* ctx.waitForSignal('go');
    return yield* ctx.run(remoteWork);
  });

const renameThenFinish = workflow({ name: 'rename-then-finish' }).execute(async function* (
  ctx: WorkflowContext,
) {
  let name = 'initial';
  ctx.onUpdate('rename', (next) => {
    name = next as string;
    return name;
  });
  yield* ctx.waitForSignal('tag');
  ctx.setAttribute('stage', 'tagged');
  yield* ctx.waitForSignal('finish');
  return name;
});

function createEngine(options: ConstructorParameters<typeof Engine>[0] = {}): Engine {
  const engine = new Engine(options);
  for (const definition of [approvalThenAfter, goThenCallback, goThenRemote, renameThenFinish]) {
    engine.register(definition);
  }
  return engine;
}

/**
 * Start draining `handle`'s event iterator. The first `next()` runs the
 * iterator body up to its first `await`, so its listeners are attached before
 * this returns, and every later dispatch is observed.
 */
function iterateHandle(handle: WorkflowHandle): { events: Event[]; done: Promise<void> } {
  const events: Event[] = [];
  const done = (async () => {
    for await (const event of handle) events.push(event);
  })();
  return { events, done };
}

/**
 * Record, in dispatch order, every event engine listeners observe for
 * `workflowId`, up to and including its first terminal event.
 */
function recordEngineEvents(engine: Engine, workflowId: string): Event[] {
  const events: Event[] = [];
  let terminated = false;
  const listener = (event: Event): void => {
    if (terminated || getWorkflowIdFromEvent(event) !== workflowId) return;
    events.push(event);
    if (WORKFLOW_TERMINAL_EVENT_TYPES.has(event.type)) terminated = true;
  };
  for (const kind of EVENT_KINDS) engine.addEventListener(kind, listener);
  return events;
}

function typesOf(events: readonly Event[]): string[] {
  return events.map((event) => event.type);
}

describe('workflow handles receive non-terminal engine events', () => {
  it('delivers signal events in dispatch order, ending with the terminal event', async () => {
    await using engine = createEngine();
    const handle = await engine.start('approval-then-after', null, { id: 'signals-1' });
    await nextSignalWaiting(engine, 'signals-1', 'approval');

    const engineEvents = recordEngineEvents(engine, 'signals-1');
    const { events, done } = iterateHandle(handle);
    const afterWaiting = nextSignalWaiting(engine, 'signals-1', 'after');
    await engine.signal('signals-1', 'approval', 'yes');
    await afterWaiting;
    await engine.signal('signals-1', 'after', 'done');
    await done;

    expect(events).toEqual(engineEvents);
    expect(typesOf(events)).toContain('signal:received');
    const waiting = events.filter((event) => event instanceof SignalWaitingEvent);
    expect(waiting.map((event) => event.signalName)).toEqual(['after']);
    expect(events.at(-1)).toBeInstanceOf(WorkflowCompletedEvent);
    expect(typesOf(events).filter((type) => type === 'workflow:completed')).toHaveLength(1);
  });

  it('delivers the async-activity event', async () => {
    await using engine = createEngine();
    const handle = await engine.start('go-then-callback', null, { id: 'async-1' });
    await nextSignalWaiting(engine, 'async-1', 'go');

    const engineEvents = recordEngineEvents(engine, 'async-1');
    const { events, done } = iterateHandle(handle);
    const token = nextAsyncPendingToken(engine);
    await engine.signal('async-1', 'go', null);
    await engine.completeAsyncActivity(await token, 'called-back');
    await done;

    expect(events).toEqual(engineEvents);
    const pending = events.find((event) => event instanceof ActivityAsyncPendingEvent);
    expect(pending?.workflowId).toBe('async-1');
    expect(pending?.token).toBe(await token);
    expect(events.at(-1)).toBeInstanceOf(WorkflowCompletedEvent);
  });

  it('delivers the remote-activity event', async () => {
    await using engine = createEngine({ activityExecution: { mode: 'remote' } });
    const handle = await engine.start('go-then-remote', null, { id: 'remote-1' });
    await nextSignalWaiting(engine, 'remote-1', 'go');

    const engineEvents = recordEngineEvents(engine, 'remote-1');
    const { events, done } = iterateHandle(handle);
    const queued = Promise.withResolvers<void>();
    engine.addEventListener(RemoteActivityQueuedEvent.type, () => queued.resolve(), {
      once: true,
    });
    await engine.signal('remote-1', 'go', null);
    await queued.promise;
    await handle.cancel();
    await done;

    expect(events).toEqual(engineEvents);
    const remote = events.find((event) => event instanceof RemoteActivityQueuedEvent);
    expect(remote?.workflowId).toBe('remote-1');
    expect(events.at(-1)).toBeInstanceOf(WorkflowCancelledEvent);
  });

  it('delivers update and attribute events', async () => {
    await using engine = createEngine();
    const handle = await engine.start('rename-then-finish', null, { id: 'updates-1' });
    await nextSignalWaiting(engine, 'updates-1', 'tag');

    const engineEvents = recordEngineEvents(engine, 'updates-1');
    const { events, done } = iterateHandle(handle);
    expect(await engine.update('updates-1', 'rename', 'renamed')).toBe('renamed');
    const finishWaiting = nextSignalWaiting(engine, 'updates-1', 'finish');
    await engine.signal('updates-1', 'tag', null);
    await finishWaiting;
    await engine.signal('updates-1', 'finish', null);
    await done;

    expect(events).toEqual(engineEvents);
    const types = typesOf(events);
    expect(types.indexOf('update:received')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('update:completed')).toBeGreaterThan(types.indexOf('update:received'));
    const attributes = events.find((event) => event instanceof AttributesChangedEvent);
    expect(attributes?.changes).toEqual({ stage: 'tagged' });
    expect(events.at(-1)).toBeInstanceOf(WorkflowCompletedEvent);
  });

  it('delivers workflow:suspended exactly once', async () => {
    await using engine = createEngine();
    const handle = await engine.start('approval-then-after', null, { id: 'suspend-1' });
    await nextSignalWaiting(engine, 'suspend-1', 'approval');

    const suspended: Event[] = [];
    handle.addEventListener(WorkflowSuspendedEvent.type, (event) => suspended.push(event));
    await engine.suspend('suspend-1');

    expect(suspended).toHaveLength(1);
    expect((suspended[0] as WorkflowSuspendedEvent).workflowId).toBe('suspend-1');
  });
});

describe('workflow handle event isolation and replay', () => {
  it('never delivers another workflow’s events', async () => {
    await using engine = createEngine();
    const first = await engine.start('approval-then-after', null, { id: 'isolated-a' });
    const second = await engine.start('approval-then-after', null, { id: 'isolated-b' });
    await Promise.all([
      nextSignalWaiting(engine, 'isolated-a', 'approval'),
      nextSignalWaiting(engine, 'isolated-b', 'approval'),
    ]);

    const firstIteration = iterateHandle(first);
    const secondIteration = iterateHandle(second);
    engine.dispatchEvent(new AttributesChangedEvent('isolated-other', { stray: true }));
    for (const id of ['isolated-a', 'isolated-b']) {
      const afterWaiting = nextSignalWaiting(engine, id, 'after');
      await engine.signal(id, 'approval', id);
      await afterWaiting;
      await engine.signal(id, 'after', id);
    }
    await Promise.all([firstIteration.done, secondIteration.done]);

    for (const [id, events] of [
      ['isolated-a', firstIteration.events],
      ['isolated-b', secondIteration.events],
    ] as const) {
      expect(events.map(getWorkflowIdFromEvent)).toEqual(events.map(() => id));
      expect(typesOf(events)).toContain('signal:received');
      expect(events.at(-1)).toBeInstanceOf(WorkflowCompletedEvent);
    }
  });

  it('does not replay non-terminal events dispatched before iteration began', async () => {
    await using engine = createEngine();
    const handle = await engine.start('approval-then-after', null, { id: 'replay-1' });
    await nextSignalWaiting(engine, 'replay-1', 'approval');

    engine.dispatchEvent(new AttributesChangedEvent('replay-1', { phase: 'before' }));
    const { events, done } = iterateHandle(handle);
    engine.dispatchEvent(new AttributesChangedEvent('replay-1', { phase: 'during' }));
    await handle.cancel();
    await done;

    const phases = events
      .filter((event) => event instanceof AttributesChangedEvent)
      .map((event) => event.changes['phase']);
    expect(phases).toEqual(['during']);
    expect(events.at(-1)).toBeInstanceOf(WorkflowCancelledEvent);
  });

  it('buffers every event for a slow consumer in order and releases its listeners', async () => {
    await using engine = createEngine();
    const handle = await engine.start('approval-then-after', null, { id: 'slow-1' });
    await nextSignalWaiting(engine, 'slow-1', 'approval');
    const added = jest.spyOn(handle, 'addEventListener');
    const removed = jest.spyOn(handle, 'removeEventListener');

    const iterator = handle[Symbol.asyncIterator]();
    const first = iterator.next();
    const total = 500;
    for (let index = 0; index < total; index += 1) {
      engine.dispatchEvent(new AttributesChangedEvent('slow-1', { index }));
    }
    await handle.cancel();
    // Dispatched after the terminal event: iteration ends with the terminal
    // event, so this is not queued behind it.
    engine.dispatchEvent(new AttributesChangedEvent('slow-1', { index: total }));

    const events: Event[] = [];
    let next = await first;
    while (next.done !== true) {
      events.push(next.value);
      // The consumer yields to the event loop between pulls, as a slow one would.
      await new Promise<void>((resolve) => setImmediate(resolve));
      next = await iterator.next();
    }

    const indexes = events
      .filter((event) => event instanceof AttributesChangedEvent)
      .map((event) => event.changes['index']);
    expect(indexes).toEqual(Array.from({ length: total }, (_, index) => index));
    expect(events.at(-1)).toBeInstanceOf(WorkflowCancelledEvent);
    expect(added.mock.calls.length).toBeGreaterThan(0);
    expect(removed.mock.calls.map(([type]) => type).toSorted()).toEqual(
      added.mock.calls.map(([type]) => type).toSorted(),
    );
  });

  it('bounds the buffer for a consumer that stops pulling, then reports the overflow', async () => {
    // Regression (COR-1605 spec audit): the handle now receives every workflow
    // event, so an unbounded per-iterator queue would grow for the rest of the
    // workflow's life behind a consumer that stopped pulling.
    const handle = new EventTarget();
    const added = jest.spyOn(handle, 'addEventListener');
    const removed = jest.spyOn(handle, 'removeEventListener');
    const iterator = createWorkflowHandleEventIterator(
      handle,
      async () => null,
      () => null,
    );

    // The first pull attaches the listeners; nothing is pulled after it while
    // the burst arrives, so the consumer falls behind by `overflow` events.
    const first = iterator.next();
    const overflow = 25;
    for (let index = 0; index < WORKFLOW_HANDLE_EVENT_BUFFER_LIMIT + overflow; index += 1) {
      handle.dispatchEvent(new AttributesChangedEvent('bounded-1', { index }));
    }

    const indexes: unknown[] = [];
    let caught: unknown;
    try {
      for (let next = await first; next.done !== true; next = await iterator.next()) {
        if (next.value instanceof AttributesChangedEvent) indexes.push(next.value.changes['index']);
        if (indexes.length === 1) {
          // Pulling frees room, but nothing after the first drop is buffered:
          // the consumer must not see later events past a silent gap, and the
          // terminal event that arrives after the overflow is dropped too.
          handle.dispatchEvent(new AttributesChangedEvent('bounded-1', { index: 'late' }));
          handle.dispatchEvent(new WorkflowCompletedEvent('bounded-1', null, 0));
          handle.dispatchEvent(
            new AttributesChangedEvent('bounded-1', { index: 'after-terminal' }),
          );
        }
      }
    } catch (error) {
      caught = error;
    }

    expect(indexes).toEqual(
      Array.from({ length: WORKFLOW_HANDLE_EVENT_BUFFER_LIMIT }, (_, index) => index),
    );
    expect(caught).toBeInstanceOf(WorkflowHandleEventOverflowError);
    expect(caught).toMatchObject({
      code: 'WorkflowHandleEventOverflowError',
      droppedCount: overflow + 2,
      limit: WORKFLOW_HANDLE_EVENT_BUFFER_LIMIT,
    });
    expect(added.mock.calls.length).toBeGreaterThan(0);
    expect(removed.mock.calls.map(([type]) => type).toSorted()).toEqual(
      added.mock.calls.map(([type]) => type).toSorted(),
    );
  });
});

describe('workflow handle forwarding guard', () => {
  it('has a factory for every event class the engine defines', () => {
    const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
    const declared = new Set<string>();
    const files = [...new Glob('events/*.ts').scanSync(sourceRoot), 'review/events.ts'];
    for (const file of files) {
      if (file.endsWith('.test.ts')) continue;
      const source = readFileSync(join(sourceRoot, file), 'utf8');
      for (const match of source.matchAll(/static readonly type = '([^']+)'/g)) {
        declared.add(match[1]!);
      }
    }

    expect([...declared].toSorted()).toEqual([...EVENT_KINDS].toSorted());
  });

  it('classifies each kind as workflow-scoped or engine-scoped by its workflowId', () => {
    const engineScoped = EVENT_KINDS.filter(
      (kind) => getWorkflowIdFromEvent(EVENT_FACTORIES[kind]('guard-1')) === undefined,
    );

    expect(engineScoped).toEqual(ENGINE_SCOPED_KINDS);
  });

  it('forwards every workflow-scoped kind to the handle and nothing else', async () => {
    await using engine = createEngine();
    const handle = await engine.start('approval-then-after', null, { id: 'guard-1' });
    await nextSignalWaiting(engine, 'guard-1', 'approval');
    const { events, done } = iterateHandle(handle);

    const dispatched = new Set<Event>();
    const expected: Event[] = [];
    for (const kind of EVENT_KINDS) {
      const event = EVENT_FACTORIES[kind]('guard-1');
      dispatched.add(event);
      if (!TERMINATION_FORWARDED_KINDS.has(kind) && getWorkflowIdFromEvent(event) === 'guard-1') {
        expected.push(event);
      }
      engine.dispatchEvent(event);
    }
    await handle.cancel();
    await done;

    const forwarded = events.filter((event) => dispatched.has(event));
    expect(typesOf(forwarded)).toEqual(typesOf(expected));
    expect(forwarded).toEqual(expected);
    expect(expected).toHaveLength(
      EVENT_KINDS.length - ENGINE_SCOPED_KINDS.length - TERMINATION_FORWARDED_KINDS.size,
    );
    expect(events.at(-1)).toBeInstanceOf(WorkflowCancelledEvent);
  });
});

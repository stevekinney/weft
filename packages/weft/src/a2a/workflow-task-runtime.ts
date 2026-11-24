/**
 * Keeps a workflow agent's A2A tasks in line with the workflows they serve.
 *
 * A task changes only by reconciliation: the runtime reads the workflow from
 * `engine.get`, projects it through `workflow-task-projection.ts`, and commits the
 * difference to the task's durable event log, then hands each appended event to the
 * push-notification sender. It reconciles a task whenever a request reads it, and
 * whenever the engine reports a lifecycle or signal event for its workflow, so a
 * streaming subscriber follows the workflow live and a task whose workflow changed
 * while no handler ran catches up on its next read.
 *
 * The persisted `waitingForSignals` still names a signal for a moment after the
 * signal is delivered, and a workflow that waits for the same name again lists it
 * once more. So after a delivery the runtime records the name it delivered and
 * treats it as consumed until the engine reports a new `signal:waiting` for that
 * name, or a reconciliation reads the workflow without the name listed. Every name
 * delivered is kept, so a workflow waiting on several signals at once, such as
 * `ctx.all` over two waits, has each answered wait hidden until the engine catches
 * up. The record is in memory: a restart forgets it, and the persisted list is then
 * read as it stands.
 *
 * Engine retention can purge a terminal workflow before the runtime has reconciled
 * its outcome, for example while no handler runs. A task whose workflow then reads
 * as `null` is settled from the terminal event this process heard for it, if any, so
 * a sweep that lands while that event is being reconciled loses nothing. Otherwise it
 * is settled as `FAILED`, with a status message saying the workflow record is gone,
 * since the engine keeps no trace of a purged run's outcome. That is safe to
 * conclude from a task record alone: the executor writes a task only after
 * `engine.get` has returned its workflow, so a workflow still being started has no
 * task record to settle, and its reads find no task.
 *
 * @module a2a/workflow-task-runtime
 */

import { type Task, TaskState, type TaskStatus } from '@a2a-js/sdk';
import type { PushNotificationSender, User } from '@a2a-js/sdk/server';
import { ServerCallContext } from '@a2a-js/sdk/server';

import type { Engine } from '../core/engine.ts';
import type { SignalWaitingEvent } from '../core/events/signal-events.ts';
import type {
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
} from '../core/events/workflow-events.ts';
import type { WorkflowState } from '../core/types/state.ts';
import { type A2ACallerScope, callerScope } from './store-support.ts';
import type {
  StoredWorkflowTask,
  TaskCommit,
  TaskEventLog,
  TaskMutation,
  TaskOwner,
} from './task-event-log.ts';
import {
  agentMessage,
  isTerminalTaskState,
  reconcileTask,
  statusUpdateEvent,
  withStatus,
  type WorkflowOutcome,
  type WorkflowResultArtifacts,
} from './workflow-task-projection.ts';

/** The engine events after which a workflow's task may read differently. */
const RECONCILING_EVENTS = [
  'workflow:started',
  'workflow:completed',
  'workflow:failed',
  'workflow:cancelled',
  'workflow:timed-out',
  'workflow:suspended',
  'workflow:resumed',
  'signal:waiting',
  'signal:received',
  'signal:delivered',
] as const;

const SIGNAL_WAITING = 'signal:waiting';

/** The outcome each terminal engine event reports, read off the event itself. */
function outcomeOf(event: Event): WorkflowOutcome | undefined {
  switch (event.type) {
    case 'workflow:completed':
      return { status: 'completed', result: (event as WorkflowCompletedEvent).result };
    case 'workflow:failed':
      return { status: 'failed', error: (event as WorkflowFailedEvent).error.message };
    case 'workflow:cancelled':
      return { status: 'cancelled' };
    case 'workflow:timed-out':
      return { status: 'timed-out' };
    default:
      return undefined;
  }
}

/** The status message of a task settled because its workflow was purged. */
export const PURGED_WORKFLOW_MESSAGE =
  'The workflow record is gone: the engine purged it before this task recorded its outcome.';

/** The change that settles `task` once its workflow is purged, or `undefined` if it ended. */
function settlePurgedTask(task: Task, timestamp: string): TaskMutation | undefined {
  if (isTerminalTaskState(task.status?.state)) return undefined;
  const status: TaskStatus = {
    state: TaskState.TASK_STATE_FAILED,
    message: agentMessage(task, PURGED_WORKFLOW_MESSAGE),
    timestamp,
  };
  const next = withStatus(task, status);
  return { task: next, events: [statusUpdateEvent(next, status)] };
}

/** The owner record a caller's tasks carry. */
export function taskOwnerOf(context: ServerCallContext): TaskOwner {
  const user = context.user;
  return {
    tenant: context.tenant ?? '',
    authenticated: user?.isAuthenticated === true,
    userName: user?.userName ?? '',
  };
}

/** A call context with the owner's scope, for work no request is waiting on. */
export function contextOfOwner(owner: TaskOwner): ServerCallContext {
  const user: User = { isAuthenticated: owner.authenticated, userName: owner.userName };
  return new ServerCallContext({
    user,
    ...(owner.tenant === '' ? {} : { tenant: owner.tenant }),
  });
}

/** What the runtime remembers of one workflow's signal deliveries. */
type DeliveryTracker = {
  /** Advanced by every `signal:waiting` for the workflow while it is tracked. */
  generation: number;
  /** The generation each signal name's latest `signal:waiting` advanced to. */
  readonly announced: Map<string, number>;
  /**
   * Names delivered whose wait the engine has neither dropped nor announced again,
   * each with the runtime's delivery count when it was recorded.
   */
  readonly consumed: Map<string, number>;
  /** Deliveries begun and neither recorded nor abandoned. */
  inFlight: number;
};

export type WorkflowTaskRuntimeOptions = {
  readonly engine: Engine;
  readonly namespace: string;
  readonly log: TaskEventLog;
  readonly sender: PushNotificationSender;
  readonly now: () => number;
  readonly onError: (error: unknown) => void;
  /** The artifacts a completed workflow's result is published as. */
  readonly artifactsOf: WorkflowResultArtifacts;
};

export type WorkflowTaskRuntime = {
  scopeOf(context: ServerCallContext): A2ACallerScope;
  /**
   * Bring the task in line with its workflow and return it, or `undefined` when the
   * caller's scope holds no such task.
   */
  reconcile(taskId: string, context: ServerCallContext): Promise<StoredWorkflowTask | undefined>;
  /** Commit `commit`'s events to push delivery, in order. */
  publish(commit: TaskCommit | undefined, context: ServerCallContext): Promise<void>;
  /** The signal waits of `state` still open, discounting every signal just delivered. */
  liveWaits(state: WorkflowState): readonly string[];
  /** Note the signal generation before a delivery. */
  beginDelivery(taskId: string): number;
  /** Record that `name` was delivered, unless a new wait for it began since `generation`. */
  recordDelivery(taskId: string, name: string, generation: number): void;
  /** Forget a delivery that failed. */
  abandonDelivery(taskId: string): void;
  /** Resolves once every reconciliation started by an engine event has settled. */
  idle(): Promise<void>;
  /** Stop listening to the engine. */
  dispose(): void;
};

export function createWorkflowTaskRuntime(
  options: WorkflowTaskRuntimeOptions,
): WorkflowTaskRuntime {
  const { engine, namespace, log, sender, now, onError, artifactsOf } = options;
  /** Workflows with a delivery in flight or a consumed name still recorded. */
  const trackers = new Map<string, DeliveryTracker>();
  /**
   * Terminal outcomes heard from engine events whose reconciliation is still running,
   * so a workflow purged meanwhile settles with its real outcome.
   */
  const heardOutcomes = new Map<string, WorkflowOutcome>();
  /** Deliveries recorded so far, so a read can tell which records it predates. */
  let recorded = 0;
  /** One reconciliation at a time per task, so commits arrive in order. */
  const chains = new Map<string, Promise<unknown>>();
  const background = new Set<Promise<void>>();
  let disposed = false;

  function liveWaits(state: WorkflowState): readonly string[] {
    const waits = state.waitingForSignals ?? [];
    const consumed = trackers.get(state.id)?.consumed;
    if (consumed === undefined || consumed.size === 0) return waits;
    return waits.filter((name) => !consumed.has(name));
  }

  function release(workflowId: string, tracker: DeliveryTracker): void {
    if (tracker.inFlight === 0 && tracker.consumed.size === 0) trackers.delete(workflowId);
  }

  /**
   * Forget each consumed name `state` no longer lists: the engine took the signal.
   * Only names recorded before the read began (`readAt`) count, since a read that
   * started earlier may predate the wait itself.
   */
  function forgetDroppedWaits(state: WorkflowState, readAt: number): void {
    const tracker = trackers.get(state.id);
    if (tracker === undefined) return;
    const waits = new Set(state.waitingForSignals ?? []);
    for (const [name, at] of tracker.consumed) {
      if (at <= readAt && !waits.has(name)) tracker.consumed.delete(name);
    }
    release(state.id, tracker);
  }

  function signalWaiting(workflowId: string, signalName: string): void {
    const tracker = trackers.get(workflowId);
    if (tracker === undefined) return;
    tracker.generation += 1;
    tracker.announced.set(signalName, tracker.generation);
    tracker.consumed.delete(signalName);
    release(workflowId, tracker);
  }

  function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = chains.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    chains.set(key, next);
    const evict = (): void => {
      if (chains.get(key) === next) chains.delete(key);
    };
    void next.then(evict, evict);
    return next;
  }

  async function publish(commit: TaskCommit | undefined, context: ServerCallContext) {
    if (commit === undefined) return;
    for (const entry of commit.appended) {
      try {
        await sender.send(entry.event, context, commit.stored.task);
      } catch (error) {
        onError(error);
      }
    }
  }

  function reconcileInScope(
    scope: A2ACallerScope,
    taskId: string,
    context: ServerCallContext,
  ): Promise<StoredWorkflowTask | undefined> {
    return serialize(`${scope.tenant}\0${scope.owner}\0${taskId}`, async () => {
      const readAt = recorded;
      const state = await engine.get(taskId);
      const timestamp = new Date(now()).toISOString();
      if (state === null) {
        trackers.delete(taskId);
        const heard = heardOutcomes.get(taskId);
        const commit = await log.commit(scope, taskId, (stored) =>
          heard === undefined
            ? settlePurgedTask(stored.task, timestamp)
            : reconcileTask(stored.task, heard, [], timestamp, artifactsOf),
        );
        await publish(commit, context);
        return commit?.stored;
      }
      forgetDroppedWaits(state, readAt);
      const waits = liveWaits(state);
      const commit = await log.commit(scope, taskId, (stored) =>
        reconcileTask(stored.task, state, waits, timestamp, artifactsOf),
      );
      await publish(commit, context);
      return commit?.stored;
    });
  }

  async function reconcileWorkflow(workflowId: string): Promise<void> {
    const owner = await log.findOwner(workflowId);
    if (owner === undefined || disposed) return;
    const context = contextOfOwner(owner);
    await reconcileInScope(callerScope(namespace, context), workflowId, context);
  }

  const listener = (event: Event): void => {
    const workflowId: unknown = (event as Event & { workflowId?: unknown }).workflowId;
    if (typeof workflowId !== 'string') return;
    if (event.type === SIGNAL_WAITING) {
      signalWaiting(workflowId, (event as SignalWaitingEvent).signalName);
    } else if (event.type.startsWith('workflow:') && event.type !== 'workflow:started') {
      trackers.delete(workflowId);
    }
    const outcome = outcomeOf(event);
    if (outcome !== undefined) heardOutcomes.set(workflowId, outcome);
    const work = reconcileWorkflow(workflowId)
      .catch(onError)
      .finally(() => {
        if (outcome !== undefined && heardOutcomes.get(workflowId) === outcome) {
          heardOutcomes.delete(workflowId);
        }
      });
    background.add(work);
    void work.finally(() => background.delete(work));
  };
  for (const type of RECONCILING_EVENTS) engine.addEventListener(type, listener);

  return {
    scopeOf: (context) => callerScope(namespace, context),
    reconcile: (taskId, context) =>
      reconcileInScope(callerScope(namespace, context), taskId, context),
    publish,
    liveWaits,
    beginDelivery(taskId) {
      let tracker = trackers.get(taskId);
      if (tracker === undefined) {
        tracker = { generation: 0, announced: new Map(), consumed: new Map(), inFlight: 0 };
        trackers.set(taskId, tracker);
      }
      tracker.inFlight += 1;
      return tracker.generation;
    },
    recordDelivery(taskId, name, generation) {
      const tracker = trackers.get(taskId);
      if (tracker === undefined) return;
      tracker.inFlight -= 1;
      // A wait for `name` announced after the delivery began is a new wait, not this one.
      if ((tracker.announced.get(name) ?? 0) <= generation) {
        recorded += 1;
        tracker.consumed.set(name, recorded);
      }
      release(taskId, tracker);
    },
    abandonDelivery(taskId) {
      const tracker = trackers.get(taskId);
      if (tracker === undefined) return;
      tracker.inFlight -= 1;
      release(taskId, tracker);
    },
    async idle() {
      while (background.size > 0) await Promise.allSettled(background);
    },
    dispose() {
      disposed = true;
      for (const type of RECONCILING_EVENTS) engine.removeEventListener(type, listener);
    },
  };
}

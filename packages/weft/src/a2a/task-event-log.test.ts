import { describe, expect, test } from 'bun:test';

import { type StreamResponse, type Task, TaskState } from '@a2a-js/sdk';

import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { callContext } from './a2a-store.test-support.ts';
import { manualScheduler } from './push-delivery.test-support.ts';
import { callerScope, encodeRecord, workflowTaskKey } from './store-support.ts';
import { createTaskEventLog, type TaskEventEntry } from './task-event-log.ts';
import { createWeftA2ATaskStore } from './task-store.ts';
import { statusUpdateEvent, withStatus } from './workflow-task-projection.ts';

const NAMESPACE = 'event-log';
const OWNER = { tenant: '', authenticated: true, userName: 'alice' };

function submitted(id = 'task-1'): Task {
  return {
    id,
    contextId: 'context-1',
    status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: undefined },
    artifacts: [],
    history: [],
    metadata: undefined,
  };
}

function moveTo(task: Task, state: TaskState): { task: Task; events: StreamResponse[] } {
  const status = { state, message: undefined, timestamp: undefined };
  const next = withStatus(task, status);
  return { task: next, events: [statusUpdateEvent(next, status)] };
}

function sequenceOf(result: IteratorResult<TaskEventEntry, void>): number {
  return result.value?.sequence ?? -1;
}

function setup() {
  const storage = new MemoryStorage();
  let clock = 0;
  const log = createTaskEventLog({ storage, namespace: NAMESPACE, now: () => (clock += 1) });
  const scope = callerScope(NAMESPACE, callContext({ user: 'alice' }));
  return { storage, log, scope };
}

describe('the task event log', () => {
  test('creates a task once, with its owner record and first events', async () => {
    const { log, scope } = setup();

    const created = await log.create(scope, OWNER, { task: submitted(), events: [] });
    const again = await log.create(scope, OWNER, { task: submitted(), events: [] });

    expect(created).toMatchObject({ stored: { sequence: -1 } });
    expect(again).toBeUndefined();
    const otherScope = callerScope(NAMESPACE, callContext({ user: 'bob' }));
    const foreign = await log.create(
      otherScope,
      { ...OWNER, userName: 'bob' },
      {
        task: submitted(),
        events: [],
      },
    );
    expect(foreign).toBe('foreign');
    expect(await log.read(otherScope, 'task-1')).toBeUndefined();
    expect(await log.findOwner('task-1')).toEqual(OWNER);
    expect(await log.findOwner('task-2')).toBeUndefined();
    expect(await log.commit(scope, 'task-2', () => undefined)).toBeUndefined();
  });

  test('ignores an owner record it cannot read', async () => {
    const { storage, log, scope } = setup();
    await storage.put(workflowTaskKey(NAMESPACE, 'task-1'), encodeRecord({ tenant: 1 }));

    expect(await log.findOwner('task-1')).toBeUndefined();
    // Creating a task under it fails closed: no reader can say the caller owns it.
    expect(await log.create(scope, OWNER, { task: submitted(), events: [] })).toBe('foreign');
  });

  test('numbers events from zero and records the last one on the task', async () => {
    const { log, scope } = setup();
    await log.create(scope, OWNER, moveTo(submitted(), TaskState.TASK_STATE_SUBMITTED));

    const commit = await log.commit(scope, 'task-1', (stored) =>
      moveTo(stored.task, TaskState.TASK_STATE_WORKING),
    );
    const unchanged = await log.commit(scope, 'task-1', () => undefined);

    expect(commit?.appended.map((entry) => entry.cursor)).toEqual(['1']);
    expect(commit?.stored.sequence).toBe(1);
    expect(unchanged?.appended).toEqual([]);
    const read = await log.read(scope, 'task-1');
    expect(read?.sequence).toBe(1);
  });

  test('follows from a cursor through replay into live events, reading a gap back from storage', async () => {
    const { storage, log, scope } = setup();
    await log.create(scope, OWNER, moveTo(submitted(), TaskState.TASK_STATE_SUBMITTED));
    await log.commit(scope, 'task-1', (stored) =>
      moveTo(stored.task, TaskState.TASK_STATE_WORKING),
    );
    // A second log over the same storage commits without notifying the first one's followers.
    const other = createTaskEventLog({ storage, namespace: NAMESPACE, now: () => 0 });

    const followed: TaskEventEntry[] = [];
    const follower = log.follow(scope, 'task-1', 0);
    const replayed = await follower.next();
    followed.push(replayed.value as TaskEventEntry);
    const live = follower.next();
    await other.commit(scope, 'task-1', (stored) =>
      moveTo(stored.task, TaskState.TASK_STATE_INPUT_REQUIRED),
    );
    await log.commit(scope, 'task-1', (stored) =>
      moveTo(stored.task, TaskState.TASK_STATE_WORKING),
    );
    const notified = await live;
    const gapRead = await follower.next();
    followed.push(notified.value as TaskEventEntry, gapRead.value as TaskEventEntry);
    // The duplicate notification of event 3 is skipped; the next live event follows.
    const after = follower.next();
    await log.commit(scope, 'task-1', (stored) =>
      moveTo(stored.task, TaskState.TASK_STATE_COMPLETED),
    );
    const next = await after;
    followed.push(next.value as TaskEventEntry);
    await follower.return();

    expect(followed.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4]);
  });

  test('re-reads storage on its interval while idle, replaying what another log committed once each', async () => {
    const { storage, scope } = setup();
    const scheduler = manualScheduler();
    const log = createTaskEventLog({
      storage,
      namespace: NAMESPACE,
      now: () => 0,
      recheck: { intervalMs: 250, schedule: scheduler.schedule },
    });
    // Another process's log over the same storage: its commits notify no follower here.
    const other = createTaskEventLog({ storage, namespace: NAMESPACE, now: () => 0 });
    await log.create(scope, OWNER, moveTo(submitted(), TaskState.TASK_STATE_SUBMITTED));
    const followed: number[] = [];
    const follower = log.follow(scope, 'task-1', 0);

    // Idle: the follower arms a re-read, and the other log commits two events.
    let armed = scheduler.nextTimer();
    const first = follower.next();
    const firstTimer = await armed;
    expect(firstTimer.delayMs).toBe(250);
    for (const state of [TaskState.TASK_STATE_WORKING, TaskState.TASK_STATE_INPUT_REQUIRED]) {
      await other.commit(scope, 'task-1', (stored) => moveTo(stored.task, state));
    }
    scheduler.fire();
    followed.push(sequenceOf(await first));
    followed.push(sequenceOf(await follower.next()));

    // A re-read that finds nothing new arms the next one and yields nothing.
    armed = scheduler.nextTimer();
    const third = follower.next();
    await armed;
    armed = scheduler.nextTimer();
    scheduler.fire();
    const idleTimer = await armed;

    // A commit through this log wakes the follower at once and cancels the re-read.
    await log.commit(scope, 'task-1', (stored) =>
      moveTo(stored.task, TaskState.TASK_STATE_WORKING),
    );
    followed.push(sequenceOf(await third));
    expect(idleTimer.cancelled).toBe(true);

    armed = scheduler.nextTimer();
    const fourth = follower.next();
    const lastTimer = await armed;
    await other.commit(scope, 'task-1', (stored) =>
      moveTo(stored.task, TaskState.TASK_STATE_COMPLETED),
    );
    scheduler.fire();
    followed.push(sequenceOf(await fourth));
    expect(lastTimer.cancelled).toBe(true);

    await follower.return();
    expect(followed).toEqual([1, 2, 3, 4]);
  });

  test('returns once its signal aborts while idle, leaving no re-read armed and no listener', async () => {
    const { storage, scope } = setup();
    const scheduler = manualScheduler();
    const log = createTaskEventLog({
      storage,
      namespace: NAMESPACE,
      now: () => 0,
      recheck: { intervalMs: 250, schedule: scheduler.schedule },
    });
    await log.create(scope, OWNER, moveTo(submitted(), TaskState.TASK_STATE_SUBMITTED));
    const request = new AbortController();
    const follower = log.follow(scope, 'task-1', 0, request.signal);

    // Idle with a re-read armed; the generator's own return() would wait behind it.
    const armed = scheduler.nextTimer();
    const pending = follower.next();
    const timer = await armed;
    request.abort();

    // The abort cancels the re-read at once and ends the follower.
    expect(timer.cancelled).toBe(true);
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(scheduler.timers).toHaveLength(1);
    // A later commit finds no follower left to notify.
    await log.commit(scope, 'task-1', (stored) =>
      moveTo(stored.task, TaskState.TASK_STATE_WORKING),
    );
    expect(scheduler.timers).toHaveLength(1);
  });

  test('returns at once, after replaying, when its signal has already aborted', async () => {
    const { log, scope } = setup();
    await log.create(scope, OWNER, moveTo(submitted(), TaskState.TASK_STATE_SUBMITTED));
    const followed: TaskEventEntry[] = [];
    for await (const entry of log.follow(scope, 'task-1', -1, AbortSignal.abort())) {
      followed.push(entry);
    }
    expect(followed.map((entry) => entry.sequence)).toEqual([0]);
  });

  test('is kept by a task store save and removed with its task by prune, but for its owner record', async () => {
    const { storage, log, scope } = setup();
    let now = 0;
    const taskStore = createWeftA2ATaskStore({
      storage,
      namespace: NAMESPACE,
      terminalRetentionMs: 10,
      now: () => now,
    });
    await log.create(scope, OWNER, moveTo(submitted(), TaskState.TASK_STATE_SUBMITTED));
    const done = await log.commit(scope, 'task-1', (stored) =>
      moveTo(stored.task, TaskState.TASK_STATE_COMPLETED),
    );
    await taskStore.save(done?.stored.task as Task, callContext({ user: 'alice' }));
    const read = await log.read(scope, 'task-1');
    expect(read?.sequence).toBe(1);

    now = 100;
    expect(await taskStore.prune()).toBe(1);

    expect(await log.read(scope, 'task-1')).toBeUndefined();
    // The owner record outlives the task, as the engine's start idempotency mapping does.
    expect(await log.findOwner('task-1')).toEqual(OWNER);
    const remaining: string[] = [];
    for await (const [key] of storage.scan('a2a:')) remaining.push(key);
    expect(remaining).toEqual([workflowTaskKey(NAMESPACE, 'task-1')]);
  });

  test('refuses another owner, and lets the same owner create again, once a task was pruned', async () => {
    const { storage, log, scope } = setup();
    let now = 0;
    const taskStore = createWeftA2ATaskStore({
      storage,
      namespace: NAMESPACE,
      terminalRetentionMs: 10,
      now: () => now,
    });
    await log.create(scope, OWNER, moveTo(submitted(), TaskState.TASK_STATE_COMPLETED));
    now = 100;
    expect(await taskStore.prune()).toBe(1);

    const westScope = callerScope(NAMESPACE, callContext({ user: 'alice', tenant: 'west' }));
    const foreign = await log.create(
      westScope,
      { ...OWNER, tenant: 'west' },
      moveTo(submitted(), TaskState.TASK_STATE_SUBMITTED),
    );
    const recreated = await log.create(
      scope,
      OWNER,
      moveTo(submitted(), TaskState.TASK_STATE_SUBMITTED),
    );

    expect(foreign).toBe('foreign');
    expect(await log.read(westScope, 'task-1')).toBeUndefined();
    expect(recreated).toMatchObject({ stored: { sequence: 0 } });
    const stored = await log.read(scope, 'task-1');
    expect(stored?.task.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
    expect(await log.findOwner('task-1')).toEqual(OWNER);
  });
});

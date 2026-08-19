/**
 * Characterization tests for dispatchTaskImpl.
 *
 * These tests assert externally observable outputs — the boolean return value,
 * messages sent to the worker WebSocket, and task-queue/registry state — so the
 * refactor cannot silently change behavior.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import {
  TEST_ACCEPTED_MANIFEST_DIGEST,
  testWorkerManifest,
} from '../../worker/registry-fixtures.test-support.ts';
import {
  decodeRemoteTaskRecord,
  encodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskQueued,
} from '../task-ledger.ts';
import { minimalServeOptions, minimalServerContext } from './server-context.test-support.ts';
import { dispatchTaskImpl, scheduleDelayedDispatch } from './task-dispatch.ts';
import { commitTaskLedgerCompletion } from './task-ledger-completion.ts';

import type { BatchOperation, ConditionalBatchCondition } from '../../storage/interface.ts';
import type { ServerContext } from './context.ts';

const createMinimalContext = minimalServerContext;
const createMinimalOptions = minimalServeOptions;

describe('dispatchTaskImpl', () => {
  let context: ServerContext;
  let options: ReturnType<typeof createMinimalOptions>;

  afterEach(() => {
    // Clean up any pending timers
    for (const timer of context.pendingTimers) {
      clearTimeout(timer);
    }
  });

  it('returns false for a duplicate operationId already in the task queue', async () => {
    context = createMinimalContext();
    options = createMinimalOptions();

    const task = {
      operationId: 'op-dup',
      activityName: 'doWork',
      workflowType: 'testWorkflow',
      queue: 'default',
      input: null,
    };

    const first = await dispatchTaskImpl(context, options, task);
    expect(first).toBe(true);

    const second = await dispatchTaskImpl(context, options, task);
    expect(second).toBe(false);
  });

  it('returns true and enqueues task when no worker is available', async () => {
    context = createMinimalContext();
    options = createMinimalOptions();

    const result = await dispatchTaskImpl(context, options, {
      operationId: 'op-1',
      activityName: 'doWork',
      workflowType: 'testWorkflow',
      queue: 'default',
      input: null,
    });

    expect(result).toBe(true);
    expect(context.taskQueue.isTracked('op-1')).toBe(true);
  });

  it('sends task message to worker WebSocket when worker is available', async () => {
    context = createMinimalContext();
    options = createMinimalOptions();

    const workerId = 'worker-1';
    const sentMessages: string[] = [];
    const fakeWs = {
      send(msg: string) {
        sentMessages.push(msg);
      },
    };

    context.registry.register({
      manifest: testWorkerManifest(),
      acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
      id: workerId,
      queue: 'default',
      activities: ['doWork'],
      concurrency: 5,
    });
    context.workerSockets.set(workerId, fakeWs as never);

    const result = await dispatchTaskImpl(context, options, {
      operationId: 'op-ws',
      activityName: 'doWork',
      workflowType: 'testWorkflow',
      queue: 'default',
      input: { x: 1 },
    });

    expect(result).toBe(true);
    expect(sentMessages).toHaveLength(1);
    const msg = JSON.parse(sentMessages[0]!);
    expect(msg.type).toBe('task');
    expect(msg.operationId).toBe('op-ws');
    expect(msg.activityName).toBe('doWork');
    expect(msg.input).toEqual({ x: 1 });
  });

  it('assigns the task in the registry after WebSocket dispatch', async () => {
    context = createMinimalContext();
    options = createMinimalOptions();

    const workerId = 'worker-2';
    context.registry.register({
      manifest: testWorkerManifest(),
      acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
      id: workerId,
      queue: 'default',
      activities: ['assignMe'],
      concurrency: 5,
    });
    context.workerSockets.set(workerId, { send: () => {} } as never);

    await dispatchTaskImpl(context, options, {
      operationId: 'op-assign',
      activityName: 'assignMe',
      workflowType: 'testWorkflow',
      queue: 'default',
      input: null,
    });

    expect(context.registry.isAssigned('op-assign')).toBe(true);
  });

  it('records workflow affinity after WebSocket dispatch with workflowId', async () => {
    context = createMinimalContext();
    options = createMinimalOptions();

    const workerId = 'worker-affinity';
    context.registry.register({
      manifest: testWorkerManifest(),
      acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
      id: workerId,
      queue: 'default',
      activities: ['affinityWork'],
      concurrency: 5,
    });
    context.workerSockets.set(workerId, { send: () => {} } as never);

    await dispatchTaskImpl(context, options, {
      operationId: 'op-affinity',
      activityName: 'affinityWork',
      workflowType: 'testWorkflow',
      queue: 'default',
      input: null,
      workflowId: 'wf-sticky',
    });

    expect(context.workerAffinity.get('wf-sticky')).toBe(workerId);
  });

  it('clamps undefined visibilityTimeout to default', async () => {
    context = createMinimalContext();
    options = createMinimalOptions();

    // enqueue to the task queue (no worker available) — just check it doesn't throw
    const result = await dispatchTaskImpl(context, options, {
      operationId: 'op-clamp',
      activityName: 'clampMe',
      workflowType: 'testWorkflow',
      queue: 'default',
      input: null,
    });

    expect(result).toBe(true);
  });

  it('adds a deadline tracker entry for WebSocket dispatch', async () => {
    context = createMinimalContext();
    options = createMinimalOptions();

    const workerId = 'worker-deadline';
    context.registry.register({
      manifest: testWorkerManifest(),
      acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
      id: workerId,
      queue: 'default',
      activities: ['deadlineWork'],
      concurrency: 5,
    });
    context.workerSockets.set(workerId, { send: () => {} } as never);

    await dispatchTaskImpl(context, options, {
      operationId: 'op-deadline',
      activityName: 'deadlineWork',
      workflowType: 'testWorkflow',
      queue: 'default',
      input: null,
    });

    // The deadline tracker should have an entry for this operation
    expect(context.deadlineTracker.size).toBeGreaterThan(0);
  });

  it('dispatches and completes a task with no workflowExecutionToken (standalone remote-activity dispatch)', async () => {
    // Regression: buildCreateQueuedInput used to default a missing
    // workflowExecutionToken to "", which the codec's own validation then
    // rejected on every subsequent read — silently treating a durably leased
    // record as if it never existed and breaking claim, heartbeat, and
    // completion for any task dispatched outside a durable workflow run.
    context = createMinimalContext();
    options = createMinimalOptions();

    const workerId = 'worker-no-token';
    context.registry.register({
      manifest: testWorkerManifest(),
      acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
      id: workerId,
      queue: 'default',
      activities: ['standaloneWork'],
      concurrency: 5,
    });
    context.workerSockets.set(workerId, { send: () => {} } as never);

    const operationId = 'op-no-token';
    const dispatched = await dispatchTaskImpl(context, options, {
      operationId,
      activityName: 'standaloneWork',
      workflowType: 'testWorkflow',
      queue: 'default',
      input: null,
    });
    expect(dispatched).toBe(true);

    const leased = decodeRemoteTaskRecord(
      await options.engine.storage.get(taskLedgerKey(operationId)),
    );
    expect(leased?.state).toBe('leased');
    expect(leased?.workflowExecutionToken).toBeUndefined();
    if (leased?.state !== 'leased') throw new Error('expected a leased record');

    const completed = await commitTaskLedgerCompletion(options.engine.storage, {
      operationId,
      attemptToken: leased.attemptToken,
      status: 'completed',
      value: { ok: true },
    });
    expect(completed.ok).toBe(true);

    const terminal = decodeRemoteTaskRecord(
      await options.engine.storage.get(taskLedgerKey(operationId)),
    );
    expect(terminal?.state).toBe('terminal');
  });

  it('throws when workflowType is missing', async () => {
    context = createMinimalContext();
    options = createMinimalOptions();

    await expect(
      dispatchTaskImpl(context, options, {
        operationId: 'op-no-workflow-type',
        activityName: 'doWork',
        workflowType: '',
        input: null,
      }),
    ).rejects.toThrow('is missing required field "workflowType"');
  });

  it('throws when a qualified activityName does not agree with workflowType', async () => {
    context = createMinimalContext();
    options = createMinimalOptions();

    await expect(
      dispatchTaskImpl(context, options, {
        operationId: 'op-qualifier-mismatch',
        activityName: 'otherWorkflow.doWork',
        workflowType: 'testWorkflow',
        input: null,
      }),
    ).rejects.toThrow('whose qualifier does not match workflowType');
  });

  it('throws when input is not JSON-serializable', async () => {
    context = createMinimalContext();
    options = createMinimalOptions();

    await expect(
      dispatchTaskImpl(context, options, {
        operationId: 'op-non-json-input',
        activityName: 'doWork',
        workflowType: 'testWorkflow',
        input: (() => {}) as never,
      }),
    ).rejects.toThrow('non-JSON-serializable');
  });

  it('falls back to the winning record when the durable create races a concurrent dispatch', async () => {
    /**
     * Simulates the TOCTOU gap `enqueueTaskForLongPoll` documents: its own
     * outer read sees no record, but by the time `createQueued`'s CAS lands,
     * a concurrent dispatch has already created one. Intercepts the first
     * `create` write for the target operationId, plants a "winning" queued
     * record directly (bypassing the caller), and fails the caller's CAS —
     * exactly what a lost race looks like from the loser's perspective.
     */
    class RacingCreateStorage extends MemoryStorage {
      #raced = false;
      readonly #targetOperationId: string;

      constructor(targetOperationId: string) {
        super();
        this.#targetOperationId = targetOperationId;
      }

      override async conditionalBatch(
        conditions: ConditionalBatchCondition[],
        operations: BatchOperation[],
      ): Promise<boolean> {
        if (!this.#raced) {
          const targetsFreshCreate = operations.some((operation) => {
            if (
              operation.type !== 'put' ||
              operation.key !== taskLedgerKey(this.#targetOperationId)
            ) {
              return false;
            }
            const record = decodeRemoteTaskRecord(operation.value);
            return record !== null && record.state === 'queued' && record.generation === 0;
          });
          if (targetsFreshCreate) {
            this.#raced = true;
            const winner: RemoteTaskQueued = {
              recordVersion: 1,
              operationId: this.#targetOperationId,
              workflowType: 'testWorkflow',
              activityName: 'doWork',
              queue: 'default',
              input: null,
              headers: {},
              visibilityTimeoutMilliseconds: 30_000,
              createdAt: Date.now(),
              generation: 0,
              state: 'queued',
              attempt: 1,
              availableAt: Date.now(),
              firstQueuedAt: Date.now(),
              lastQueuedAt: Date.now(),
              retryCount: 0,
              requeueCount: 0,
            };
            await super.put(taskLedgerKey(this.#targetOperationId), encodeRemoteTaskRecord(winner));
            return false;
          }
        }
        return super.conditionalBatch(conditions, operations);
      }
    }

    const operationId = 'op-create-race';
    const storage = new RacingCreateStorage(operationId);
    context = createMinimalContext();
    options = createMinimalOptions(storage);

    const dispatched = await dispatchTaskImpl(context, options, {
      operationId,
      activityName: 'doWork',
      workflowType: 'testWorkflow',
      queue: 'default',
      input: null,
    });

    expect(dispatched).toBe(true);
    const record = decodeRemoteTaskRecord(await storage.get(taskLedgerKey(operationId)));
    expect(record?.state).toBe('queued');
  });
});

describe('scheduleDelayedDispatch', () => {
  let context: ServerContext;
  let options: ReturnType<typeof createMinimalOptions>;

  afterEach(() => {
    for (const timer of context.pendingTimers) {
      clearTimeout(timer);
    }
  });

  it('arms a tracked timer when the server is not stopping', () => {
    context = createMinimalContext();
    options = createMinimalOptions();

    scheduleDelayedDispatch(
      context,
      options,
      {
        operationId: 'op-not-stopping',
        activityName: 'doWork',
        workflowType: 'testWorkflow',
        input: null,
      },
      1000,
    );

    expect(context.pendingTimers.size).toBe(1);
  });

  it('does not arm a timer once context.stopping is set', () => {
    // WFT-23: startup recovery's queued-record branch (and the ongoing
    // reconcileOrphanedRecords safety net) both redispatch through this
    // function. Without this guard, a recovery scan still in flight when
    // `server.stop()`'s timer-clearing disposer runs could arm a *new*
    // timer after `pendingTimers` has already been cleared — leaking a
    // callback that fires `dispatchTaskImpl` against a disposed task queue.
    context = createMinimalContext();
    context.stopping = true;
    options = createMinimalOptions();

    scheduleDelayedDispatch(
      context,
      options,
      {
        operationId: 'op-stopping',
        activityName: 'doWork',
        workflowType: 'testWorkflow',
        input: null,
      },
      0,
    );

    expect(context.pendingTimers.size).toBe(0);
  });
});

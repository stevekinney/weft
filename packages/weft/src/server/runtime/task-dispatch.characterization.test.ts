/**
 * Characterization tests for dispatchTaskImpl.
 *
 * These tests assert externally observable outputs — the boolean return value,
 * messages sent to the worker WebSocket, and task-queue/registry state — so the
 * refactor cannot silently change behavior.
 */

import { afterEach, describe, expect, it } from 'bun:test';

import { encode } from '../../core/codec.ts';
import { KEYS } from '../../storage/interface.ts';
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
        input: () => {},
      }),
    ).rejects.toThrow('non-JSON-serializable');
  });

  it('throws when operationId is the exact string "." (WFT-95)', async () => {
    context = createMinimalContext();
    options = createMinimalOptions();

    await expect(
      dispatchTaskImpl(context, options, {
        operationId: '.',
        activityName: 'doWork',
        workflowType: 'testWorkflow',
        input: null,
      }),
    ).rejects.toThrow('invalid "operationId"');
  });

  it('throws when operationId is the exact string ".." (WFT-95)', async () => {
    context = createMinimalContext();
    options = createMinimalOptions();

    await expect(
      dispatchTaskImpl(context, options, {
        operationId: '..',
        activityName: 'doWork',
        workflowType: 'testWorkflow',
        input: null,
      }),
    ).rejects.toThrow('invalid "operationId"');
  });

  it('allows an operationId that merely contains a dot character (WFT-95)', async () => {
    context = createMinimalContext();
    options = createMinimalOptions();

    await expect(
      dispatchTaskImpl(context, options, {
        operationId: 'op.v2.retry',
        activityName: 'doWork',
        workflowType: 'testWorkflow',
        input: null,
      }),
    ).resolves.toBe(true);
  });

  it('throws when workflowRevision is an empty string (WFT-20)', async () => {
    context = createMinimalContext();
    options = createMinimalOptions();

    await expect(
      dispatchTaskImpl(context, options, {
        operationId: 'op-empty-revision',
        activityName: 'doWork',
        workflowType: 'testWorkflow',
        input: null,
        workflowRevision: '',
      }),
    ).rejects.toThrow('invalid "workflowRevision"');
  });

  it('throws when workflowRevision exceeds the bounded identifier byte limit (WFT-20)', async () => {
    context = createMinimalContext();
    options = createMinimalOptions();

    await expect(
      dispatchTaskImpl(context, options, {
        operationId: 'op-oversized-revision',
        activityName: 'doWork',
        workflowType: 'testWorkflow',
        input: null,
        workflowRevision: 'x'.repeat(10_000),
      }),
    ).rejects.toThrow('invalid "workflowRevision"');
  });

  it("reuses the durable ledger record's revision, not the caller's, for an already-queued long-poll hint (WFT-20)", async () => {
    // A concurrent dispatch for the same operationId may have already
    // written a `queued` ledger record carrying a DIFFERENT revision than
    // this caller supplies. The long-poll match hint must reflect the
    // durable record a worker will actually claim and be authorized to
    // complete against — not whichever caller happened to reuse it.
    const operationId = 'op-reuse-ledger-revision';
    const storage = new MemoryStorage();
    const existing: RemoteTaskQueued = {
      recordVersion: 1,
      operationId,
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
      workflowRevision: 'ledger-revision',
    };
    await storage.put(taskLedgerKey(operationId), encodeRemoteTaskRecord(existing));

    context = createMinimalContext();
    options = createMinimalOptions(storage);

    const dispatched = await dispatchTaskImpl(context, options, {
      operationId,
      activityName: 'doWork',
      workflowType: 'testWorkflow',
      queue: 'default',
      input: null,
      workflowRevision: 'caller-revision',
    });

    expect(dispatched).toBe(true);
    const [pending] = context.taskQueue.peekPending('default');
    expect(pending?.operationId).toBe(operationId);
    expect(pending?.workflowRevision).toBe('ledger-revision');
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

// ---------------------------------------------------------------------------
// WFT-20: dispatch-time revision staleness gate
// ---------------------------------------------------------------------------

describe('dispatchTaskImpl revision staleness (WFT-20)', () => {
  let context: ServerContext;

  afterEach(() => {
    for (const timer of context.pendingTimers) {
      clearTimeout(timer);
    }
  });

  function minimalWorkflowState(overrides: { id: string; revision?: string }): unknown {
    return {
      id: overrides.id,
      type: 'testWorkflow',
      status: 'running',
      input: null,
      createdAt: 1,
      updatedAt: 1,
      startedAt: 1,
      versionTuple: { workflowVersion: '1' },
      ...(overrides.revision !== undefined && { revision: overrides.revision }),
    };
  }

  it('rejects a dispatch whose workflowRevision disagrees with the persisted run, before any reservation or ledger write', async () => {
    context = createMinimalContext();
    const storage = new MemoryStorage();
    const options = createMinimalOptions(storage);
    await storage.put(
      KEYS.workflow('wf-stale'),
      encode(minimalWorkflowState({ id: 'wf-stale', revision: 'revision-current' })),
    );

    await expect(
      dispatchTaskImpl(context, options, {
        operationId: 'op-stale-revision',
        activityName: 'doWork',
        workflowType: 'testWorkflow',
        queue: 'default',
        input: null,
        workflowId: 'wf-stale',
        workflowRevision: 'revision-stale',
      }),
    ).rejects.toThrow(/revision "revision-stale".*revision "revision-current"|stale/i);

    // No worker capacity reserved, no ledger record created.
    expect(context.registry.isAssigned('op-stale-revision')).toBe(false);
    expect(context.taskQueue.isTracked('op-stale-revision')).toBe(false);
    expect(await storage.get(taskLedgerKey('op-stale-revision'))).toBeNull();
  });

  it('accepts a dispatch whose workflowRevision matches the persisted run', async () => {
    context = createMinimalContext();
    const storage = new MemoryStorage();
    const options = createMinimalOptions(storage);
    await storage.put(
      KEYS.workflow('wf-fresh'),
      encode(minimalWorkflowState({ id: 'wf-fresh', revision: 'revision-current' })),
    );

    const result = await dispatchTaskImpl(context, options, {
      operationId: 'op-fresh-revision',
      activityName: 'doWork',
      workflowType: 'testWorkflow',
      queue: 'default',
      input: null,
      workflowId: 'wf-fresh',
      workflowRevision: 'revision-current',
    });

    expect(result).toBe(true);
    expect(context.taskQueue.isTracked('op-fresh-revision')).toBe(true);
  });

  it('accepts a dispatch with workflowRevision when no persisted run exists yet', async () => {
    context = createMinimalContext();
    const options = createMinimalOptions();

    const result = await dispatchTaskImpl(context, options, {
      operationId: 'op-no-persisted-run',
      activityName: 'doWork',
      workflowType: 'testWorkflow',
      queue: 'default',
      input: null,
      workflowId: 'wf-never-persisted',
      workflowRevision: 'revision-anything',
    });

    expect(result).toBe(true);
  });

  it('carries workflowRevision through to the WebSocket task message', async () => {
    context = createMinimalContext();
    const options = createMinimalOptions();
    const sentMessages: string[] = [];
    context.registry.register({
      manifest: testWorkerManifest(),
      acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
      id: 'worker-revision',
      queue: 'default',
      activities: ['doWork'],
      concurrency: 5,
    });
    context.workerSockets.set('worker-revision', {
      send: (msg: string) => sentMessages.push(msg),
    } as never);

    await dispatchTaskImpl(context, options, {
      operationId: 'op-ws-revision',
      activityName: 'doWork',
      workflowType: 'testWorkflow',
      queue: 'default',
      input: null,
      workflowRevision: 'revision-echoed',
    });

    expect(sentMessages).toHaveLength(1);
    const msg = JSON.parse(sentMessages[0]!);
    expect(msg.workflowRevision).toBe('revision-echoed');
  });
});

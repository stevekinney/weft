/**
 * COR-1973 — `weft.tasks.deadletters.retry` against the real dispatch path:
 * a result that cannot be persisted dead-letters the task, the operation
 * queues it again, and the dispatcher claims it as a new attempt while the
 * dead attempt stays in the history.
 */

import { describe, expect, it } from 'bun:test';

import { principalFromApiKey } from "../embedded/backchannel/src/index.ts";
import { createOperationRegistry, executeOperation } from "../embedded/backchannel/src/internals.ts";
import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { encode } from '../core/codec.ts';
import {
  decodeTaskAttemptRecord,
  taskAttemptPrefix,
  type TaskAttemptRecord,
} from '../core/task-ledger/task-attempt.ts';
import {
  decodeRemoteTaskRecord,
  encodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskQueued,
} from '../core/task-ledger/task-ledger.ts';
import { KEYS } from '../storage/keys.ts';
import {
  manifestForActivities,
  TEST_ACCEPTED_MANIFEST_DIGEST,
} from '../worker/registry-fixtures.test-support.ts';
import { createRetryTaskDeadLetterOperation } from './operations/retry-task-dead-letter.ts';
import {
  FailingTerminalCommitStorage,
  minimalServeOptions,
  minimalServerContext,
} from './runtime/server-context.test-support.ts';
import { dispatchTaskImpl } from './runtime/task-dispatch.ts';
import { taskDispatchFromLedgerRecord } from './runtime/task-reconciliation.ts';
import { applyWorkerTaskResult } from './runtime/task-result-application.ts';

import type { ServeOptions } from './index.ts';
import type { ServerContext } from './runtime/context.ts';

function registerWorker(context: ServerContext, workerId: string): string[] {
  context.registry.register({
    manifest: manifestForActivities(['test.charge']),
    acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
    id: workerId,
    queue: 'default',
    activities: ['test.charge'],
    concurrency: 5,
  });
  const sent: string[] = [];
  context.workerSockets.set(workerId, { send: (message: string) => sent.push(message) } as never);
  return sent;
}

function lastAttemptToken(sent: readonly string[]): string {
  const last = sent.at(-1);
  if (last === undefined) throw new Error('Expected the worker to have been sent a task');
  return (JSON.parse(last) as { attemptToken: string }).attemptToken;
}

async function attemptsOf(
  options: ServeOptions,
  operationId: string,
): Promise<TaskAttemptRecord[]> {
  const attempts: TaskAttemptRecord[] = [];
  for await (const [, value] of options.engine.storage.scan(taskAttemptPrefix(operationId))) {
    const decoded = decodeTaskAttemptRecord(value);
    if (decoded !== null) attempts.push(decoded);
  }
  return attempts.toSorted((left, right) => left.attempt - right.attempt);
}

function retry(
  options: ServeOptions,
  operationId: string,
  redispatch: (r: RemoteTaskQueued) => void,
) {
  return executeOperation(
    'weft.tasks.deadletters.retry',
    { operationId },
    {
      principal: principalFromApiKey({ subject: 'operator', scopes: ['system:admin'] }),
      host: options.engine,
      transport: 'http-rest',
      registry: createOperationRegistry([
        createRetryTaskDeadLetterOperation({ redispatchQueuedTask: redispatch }),
      ]),
    },
  );
}

describe('weft.tasks.deadletters.retry on the dispatch path', () => {
  it('queues a real dead letter again: the next claim is attempt 2 beside the dead attempt 1, and attempt 1 is refused', async () => {
    const storage = new FailingTerminalCommitStorage('op-e2e');
    const options = minimalServeOptions(storage);
    const context = minimalServerContext();
    const sent = registerWorker(context, 'w-1');

    await dispatchTaskImpl(context, options, {
      operationId: 'op-e2e',
      workflowType: 'test',
      activityName: 'test.charge',
      queue: 'default',
      input: null,
    });
    const deadToken = lastAttemptToken(sent);
    // The transport frees the worker slot before it commits the result
    // (`handleTaskResult`), so a dead letter holds no assignment.
    context.registry.completeTask('op-e2e');
    const applied = await applyWorkerTaskResult(
      options,
      undefined,
      { operationId: 'op-e2e', attemptToken: deadToken, status: 'completed', value: { ok: 1 } },
      'w-1',
    );
    expect(applied.ok && applied.disposition).toBe('dead-lettered');

    const redispatches: Promise<unknown>[] = [];
    const result = await retry(options, 'op-e2e', (record) => {
      redispatches.push(
        dispatchTaskImpl(context, options, taskDispatchFromLedgerRecord(record), {
          redispatch: true,
        }),
      );
    });
    expect(result.ok).toBe(true);
    await Promise.all(redispatches);

    const record = decodeRemoteTaskRecord(await storage.get(taskLedgerKey('op-e2e')));
    expect(record?.state).toBe('leased');
    expect(record?.state === 'leased' && record.attempt).toBe(2);
    expect(record?.state === 'leased' && record.requeueCount).toBe(1);

    const attempts = await attemptsOf(options, 'op-e2e');
    expect(attempts.map((attempt) => [attempt.attempt, attempt.disposition])).toEqual([
      [1, 'deadLettered'],
      [2, 'leased'],
    ]);

    // The dead attempt's token is not the lease holder any more.
    const stale = await applyWorkerTaskResult(
      options,
      undefined,
      { operationId: 'op-e2e', attemptToken: deadToken, status: 'completed', value: { ok: 1 } },
      'w-1',
    );
    expect(stale.ok).toBe(false);

    // The new attempt's token is accepted (this storage still fails the terminal
    // commit, so it dead-letters again, which is a result the ledger took).
    const fresh = await applyWorkerTaskResult(
      options,
      undefined,
      {
        operationId: 'op-e2e',
        attemptToken: lastAttemptToken(sent),
        status: 'completed',
        value: 2,
      },
      'w-1',
    );
    expect(fresh.ok).toBe(true);
  });

  it('leaves the task queued when the dispatch is stale because the workflow revision moved', async () => {
    const storage = new MemoryStorage();
    const options = minimalServeOptions(storage);
    const context = minimalServerContext();
    registerWorker(context, 'w-1');
    await storage.put(
      KEYS.workflow('wf-moved'),
      encode({ id: 'wf-moved', type: 'test', status: 'running', input: null, revision: 'rev-2' }),
    );
    await storage.put(
      taskLedgerKey('op-moved'),
      encodeRemoteTaskRecord({
        recordVersion: 1,
        operationId: 'op-moved',
        workflowId: 'wf-moved',
        workflowType: 'test',
        workflowRevision: 'rev-1',
        activityName: 'test.charge',
        queue: 'default',
        input: null,
        headers: {},
        visibilityTimeoutMilliseconds: 30_000,
        createdAt: 0,
        generation: 3,
        state: 'deadLettered',
        attemptToken: 'attempt-token',
        attempt: 1,
        pendingStatus: 'completed',
        pendingResultDigest: 'digest',
        retryCount: 0,
        requeueCount: 0,
        deadLetteredAt: 1,
        persistenceFailureReason: 'lost the compare-and-swap race',
      }),
    );

    let redispatch: Promise<unknown> | undefined;
    const result = await retry(options, 'op-moved', (record) => {
      redispatch = dispatchTaskImpl(context, options, taskDispatchFromLedgerRecord(record), {
        redispatch: true,
      });
      // Observed below; the production hook logs and drops the same rejection.
      redispatch.catch(() => {});
    });

    // The retry itself committed; only the immediate dispatch was refused as stale.
    expect(result.ok).toBe(true);
    const failure = await redispatch?.then(
      () => null,
      (error: unknown) => error,
    );
    expect(String(failure)).toMatch(/stale/);
    const record = decodeRemoteTaskRecord(await storage.get(taskLedgerKey('op-moved')));
    expect(record?.state).toBe('queued');
    // The ledger sweep (`reconcileOrphanedRecords`) is what dispatches it later.
  });
});

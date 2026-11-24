import { describe, expect, it } from 'bun:test';

import { principalFromApiKey, type AuthorizationScope } from "../../embedded/backchannel/src/index.ts";
import { createOperationRegistry, executeOperation } from "../../embedded/backchannel/src/internals.ts";
import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { encode } from '../../core/codec.ts';
import type { Engine } from '../../core/engine.ts';
import { digestAttemptToken } from '../../core/task-ledger/task-attempt-runtime.ts';
import {
  encodeTaskAttemptRecord,
  taskAttemptKey,
  type TaskAttemptRecord,
} from '../../core/task-ledger/task-attempt.ts';
import {
  beginCompletion,
  claimQueued,
  renewAttemptLease,
} from '../../core/task-ledger/task-ledger-transitions.ts';
import {
  decodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskQueued,
} from '../../core/task-ledger/task-ledger.ts';
import {
  appendTaskResultDelivery,
  encodeTaskResultDeliveryHistory,
  taskResultDeliveryKey,
} from '../../core/task-ledger/task-result-delivery.ts';
import { MetricsCollector } from '../../observability/metrics.ts';
import { KEYS } from '../../storage/keys.ts';
import { handleRequest } from '../handler.ts';
import { clearTaskDeadLetterOperation } from './clear-task-dead-letter.ts';
import { getTaskDeadLetterOperation } from './get-task-deliveries.ts';
import {
  createEngine,
  deadLetteredFixture,
  leasedFixture,
  putLedgerRecord,
  queuedFixture,
  terminalFixture,
} from './get-task-diagnostics.test-support.ts';
import {
  createRetryTaskDeadLetterOperation,
  retryTaskDeadLetterRestBinding,
} from './retry-task-dead-letter.ts';

type RetryOptions = Parameters<typeof createRetryTaskDeadLetterOperation>[0];

function runRetry(
  host: unknown,
  input: { operationId: string; attemptTokenDigest?: string },
  options: RetryOptions = {},
  scopes: ReadonlyArray<AuthorizationScope> = ['system:admin'],
) {
  const operation = createRetryTaskDeadLetterOperation(options);
  return executeOperation('weft.tasks.deadletters.retry', input, {
    principal: principalFromApiKey({ subject: 'operator', scopes }),
    host,
    transport: 'http-rest',
    registry: createOperationRegistry([operation]),
  });
}

async function readRecord(storage: MemoryStorage, operationId: string) {
  return decodeRemoteTaskRecord(await storage.get(taskLedgerKey(operationId)));
}

function deadAttemptRecord(operationId: string, attemptToken: string, attempt: number) {
  const record: TaskAttemptRecord = {
    recordVersion: 1,
    operationId,
    attempt,
    attemptTokenDigest: digestAttemptToken(attemptToken),
    workerSessionId: 'worker-1',
    claimedAt: 1_000,
    disposition: 'deadLettered',
    dispositionAt: 9_000,
    dispositionReason: 'lost the compare-and-swap race',
  };
  return record;
}

async function putRunningWorkflow(
  storage: MemoryStorage,
  workflowId: string,
  status: string,
  workflowExecutionToken?: string,
) {
  await storage.put(
    KEYS.workflow(workflowId),
    encode({
      id: workflowId,
      type: 'test',
      status,
      ...(workflowExecutionToken === undefined ? {} : { workflowExecutionToken }),
      input: null,
      versionTuple: { workflowVersion: '0.0.0' },
      createdAt: 1,
      startedAt: 1,
      updatedAt: 1,
    }),
  );
}

describe('weft.tasks.deadletters.retry', () => {
  it('queues a dead-lettered task under the same id with a new attempt and one more requeue', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    await putLedgerRecord(
      storage,
      deadLetteredFixture({ operationId: 'op-retry', attempt: 2, requeueCount: 3, retryCount: 1 }),
    );
    const metricsCollector = new MetricsCollector();
    const redispatched: RemoteTaskQueued[] = [];

    const result = await runRetry(
      engine,
      { operationId: 'op-retry' },
      { metricsCollector, redispatchQueuedTask: (record) => redispatched.push(record) },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected retry to succeed');
    expect(result.value).toEqual({
      operationId: 'op-retry',
      state: 'queued',
      attempt: 3,
      requeueCount: 4,
    });
    const record = await readRecord(storage, 'op-retry');
    expect(record?.state).toBe('queued');
    expect(record?.operationId).toBe('op-retry');
    expect(record !== null && 'attempt' in record && record.attempt).toBe(3);
    expect(redispatched).toHaveLength(1);
    expect(redispatched[0]?.operationId).toBe('op-retry');
    // The operator retry is a requeue and a retry; both counters see it once.
    const snapshot = metricsCollector.snapshot();
    const requeues = snapshot['weft.task.requeues'];
    expect(requeues?.type === 'counter' && requeues.value).toBe(1);
    const retries = snapshot['weft.task.retries'];
    expect(retries?.type === 'counter' && retries.value).toBe(1);
  });

  it('keeps the dead attempt record and delivery history', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    await putLedgerRecord(
      storage,
      deadLetteredFixture({ operationId: 'op-history', attemptToken: 'token-1', attempt: 1 }),
    );
    const attemptKey = taskAttemptKey('op-history', digestAttemptToken('token-1'));
    await storage.put(
      attemptKey,
      encodeTaskAttemptRecord(deadAttemptRecord('op-history', 'token-1', 1)),
    );
    await storage.put(
      taskResultDeliveryKey('op-history'),
      encodeTaskResultDeliveryHistory(
        appendTaskResultDelivery(null, 'op-history', {
          attemptTokenDigest: digestAttemptToken('token-1'),
          transport: 'longPoll',
          submittedStatus: 'completed',
          receivedAt: 9_000,
          outcome: 'acknowledged',
          disposition: 'dead-lettered',
        }),
      ),
    );
    const attemptBefore = await storage.get(attemptKey);
    const historyBefore = await storage.get(taskResultDeliveryKey('op-history'));

    const result = await runRetry(engine, { operationId: 'op-history' });
    expect(result.ok).toBe(true);

    expect(await storage.get(attemptKey)).toEqual(attemptBefore);
    expect(await storage.get(taskResultDeliveryKey('op-history'))).toEqual(historyBefore);
  });

  it('refuses an old attempt token after the retry: no result, no heartbeat', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    await putLedgerRecord(
      storage,
      deadLetteredFixture({ operationId: 'op-stale', attemptToken: 'token-old', attempt: 1 }),
    );
    const retried = await runRetry(engine, { operationId: 'op-stale' });
    expect(retried.ok).toBe(true);

    const queued = await readRecord(storage, 'op-stale');
    expect(
      beginCompletion(queued, {
        attemptToken: 'token-old',
        pendingStatus: 'completed',
        pendingResultDigest: 'digest',
      }).ok,
    ).toBe(false);
    expect(
      renewAttemptLease(
        queued,
        { attemptToken: 'token-old', workerSessionId: 'worker-1', leaseDurationMilliseconds: 1 },
        1,
      ).ok,
    ).toBe(false);

    // After a new claim the old token is still not the holder.
    if (queued === null || queued.state !== 'queued') throw new Error('expected queued');
    const claim = claimQueued(
      queued,
      {
        expectedGeneration: queued.generation,
        attemptToken: 'token-new',
        workerSessionId: 'worker-2',
        leaseDurationMilliseconds: 30_000,
      },
      Date.now(),
    );
    if (!claim.ok) throw new Error('expected claim');
    expect(
      beginCompletion(claim.nextRecord, {
        attemptToken: 'token-old',
        pendingStatus: 'completed',
        pendingResultDigest: 'digest',
      }).ok,
    ).toBe(false);
    expect(
      renewAttemptLease(
        claim.nextRecord,
        { attemptToken: 'token-old', workerSessionId: 'worker-2', leaseDurationMilliseconds: 1 },
        1,
      ).ok,
    ).toBe(false);
  });

  it('two concurrent retries produce exactly one requeue', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    await putLedgerRecord(storage, deadLetteredFixture({ operationId: 'op-race' }));
    const metricsCollector = new MetricsCollector();
    const redispatched: RemoteTaskQueued[] = [];
    const options = {
      metricsCollector,
      redispatchQueuedTask: (r: RemoteTaskQueued) => redispatched.push(r),
    };

    const results = await Promise.all([
      runRetry(engine, { operationId: 'op-race' }, options),
      runRetry(engine, { operationId: 'op-race' }, options),
    ]);

    const succeeded = results.filter((result) => result.ok);
    const refused = results.filter((result) => !result.ok);
    expect(succeeded).toHaveLength(1);
    expect(refused).toHaveLength(1);
    const fault = refused[0];
    if (fault === undefined || fault.ok) throw new Error('expected a refusal');
    expect(fault.fault.code).toBe('Conflict');
    const record = await readRecord(storage, 'op-race');
    expect(record?.state).toBe('queued');
    expect(record?.state === 'queued' && record.requeueCount).toBe(1);
    expect(redispatched).toHaveLength(1);
    const requeues = metricsCollector.snapshot()['weft.task.requeues'];
    expect(requeues?.type === 'counter' && requeues.value).toBe(1);
  });

  it('refuses a task that is not dead-lettered with Conflict and changes nothing', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    for (const fixture of [
      queuedFixture({ operationId: 'op-queued' }),
      leasedFixture({ operationId: 'op-leased' }),
      terminalFixture({ operationId: 'op-terminal' }),
    ]) {
      await putLedgerRecord(storage, fixture);
      const before = await storage.get(taskLedgerKey(fixture.operationId));

      const result = await runRetry(engine, { operationId: fixture.operationId });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected a refusal');
      expect(result.fault.code).toBe('Conflict');
      expect(result.fault.code === 'Conflict' && result.fault.data.reason).toBe(
        'not-dead-lettered',
      );
      expect(await storage.get(taskLedgerKey(fixture.operationId))).toEqual(before);
    }
  });

  it('faults NotFound when no task has the operation id', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);

    const result = await runRetry(engine, { operationId: 'never-dispatched' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected NotFound');
    expect(result.fault.code).toBe('NotFound');
  });

  it('requires system:admin', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    await putLedgerRecord(storage, deadLetteredFixture({ operationId: 'op-scoped' }));
    const before = await storage.get(taskLedgerKey('op-scoped'));

    for (const scopes of [['system:read'], ['workflows:write']] as const) {
      const result = await runRetry(engine, { operationId: 'op-scoped' }, {}, scopes);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected Forbidden');
      expect(result.fault.code).toBe('Forbidden');
    }
    expect(await storage.get(taskLedgerKey('op-scoped'))).toEqual(before);
  });

  it('retry then clear faults NotFound, and clear then retry faults NotFound', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    await putLedgerRecord(storage, deadLetteredFixture({ operationId: 'op-retry-clear' }));
    await putLedgerRecord(storage, deadLetteredFixture({ operationId: 'op-clear-retry' }));
    const clearRegistry = createOperationRegistry([clearTaskDeadLetterOperation]);
    const clear = (operationId: string) =>
      executeOperation(
        'weft.tasks.diagnostics.deadletters.clear',
        { operationId },
        {
          principal: principalFromApiKey({ subject: 'operator', scopes: ['system:admin'] }),
          host: engine,
          transport: 'http-rest',
          registry: clearRegistry,
        },
      );

    const retried = await runRetry(engine, { operationId: 'op-retry-clear' });
    expect(retried.ok).toBe(true);
    const clearedAfterRetry = await clear('op-retry-clear');
    expect(clearedAfterRetry.ok).toBe(false);
    if (clearedAfterRetry.ok) throw new Error('expected NotFound');
    expect(clearedAfterRetry.fault.code).toBe('NotFound');

    const cleared = await clear('op-clear-retry');
    expect(cleared.ok).toBe(true);
    const retriedAfterClear = await runRetry(engine, { operationId: 'op-clear-retry' });
    expect(retriedAfterClear.ok).toBe(false);
    if (retriedAfterClear.ok) throw new Error('expected NotFound');
    expect(retriedAfterClear.fault.code).toBe('NotFound');
  });

  it('answers NotFound from weft.tasks.deadletters.get after a retry', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    await putLedgerRecord(storage, deadLetteredFixture({ operationId: 'op-get' }));

    const retried = await runRetry(engine, { operationId: 'op-get' });
    expect(retried.ok).toBe(true);

    const result = await executeOperation(
      'weft.tasks.deadletters.get',
      { operationId: 'op-get' },
      {
        principal: principalFromApiKey({ subject: 'operator', scopes: ['system:admin'] }),
        host: engine,
        transport: 'http-rest',
        registry: createOperationRegistry([getTaskDeadLetterOperation]),
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected NotFound');
    expect(result.fault.code).toBe('NotFound');
  });

  it('refuses a digest that is not the dead-lettered attempt, and accepts the one that is', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    await putLedgerRecord(
      storage,
      deadLetteredFixture({ operationId: 'op-digest', attemptToken: 'token-7' }),
    );
    const before = await storage.get(taskLedgerKey('op-digest'));

    const mismatch = await runRetry(engine, {
      operationId: 'op-digest',
      attemptTokenDigest: digestAttemptToken('token-other'),
    });
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) throw new Error('expected a refusal');
    expect(mismatch.fault.code).toBe('Conflict');
    expect(mismatch.fault.code === 'Conflict' && mismatch.fault.data.reason).toBe(
      'dead-letter-changed',
    );
    expect(await storage.get(taskLedgerKey('op-digest'))).toEqual(before);

    const match = await runRetry(engine, {
      operationId: 'op-digest',
      attemptTokenDigest: digestAttemptToken('token-7'),
    });
    expect(match.ok).toBe(true);
  });

  it('refuses when the owning workflow has finished or is gone, and retries when it is running', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    await putLedgerRecord(
      storage,
      deadLetteredFixture({ operationId: 'op-done', workflowId: 'wf-done' }),
    );
    await putLedgerRecord(
      storage,
      deadLetteredFixture({ operationId: 'op-gone', workflowId: 'wf-gone' }),
    );
    await putLedgerRecord(
      storage,
      deadLetteredFixture({ operationId: 'op-live', workflowId: 'wf-live' }),
    );
    await putRunningWorkflow(storage, 'wf-done', 'completed');
    await putRunningWorkflow(storage, 'wf-live', 'running');

    for (const operationId of ['op-done', 'op-gone']) {
      const before = await storage.get(taskLedgerKey(operationId));
      const result = await runRetry(engine, { operationId });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected a refusal');
      expect(result.fault.code).toBe('Conflict');
      expect(result.fault.code === 'Conflict' && result.fault.data.reason).toBe(
        'workflow-finished',
      );
      expect(await storage.get(taskLedgerKey(operationId))).toEqual(before);
    }

    const live = await runRetry(engine, { operationId: 'op-live' });
    expect(live.ok).toBe(true);
  });

  it('refuses a task that belongs to an earlier run of a workflow id a newer run now holds', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    await putLedgerRecord(
      storage,
      deadLetteredFixture({
        operationId: 'op-old-run',
        workflowId: 'wf-restarted',
        workflowExecutionToken: 'run-a',
      }),
    );
    await putLedgerRecord(
      storage,
      deadLetteredFixture({
        operationId: 'op-same-run',
        workflowId: 'wf-same',
        workflowExecutionToken: 'run-a',
      }),
    );
    // Run B started under the same workflow id after run A was cancelled.
    await putRunningWorkflow(storage, 'wf-restarted', 'running', 'run-b');
    await putRunningWorkflow(storage, 'wf-same', 'running', 'run-a');
    const before = await storage.get(taskLedgerKey('op-old-run'));
    const redispatched: RemoteTaskQueued[] = [];
    const metricsCollector = new MetricsCollector();

    const refused = await runRetry(
      engine,
      { operationId: 'op-old-run' },
      { metricsCollector, redispatchQueuedTask: (record) => redispatched.push(record) },
    );

    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('expected a refusal');
    expect(refused.fault.code).toBe('Conflict');
    expect(refused.fault.code === 'Conflict' && refused.fault.data.reason).toBe(
      'workflow-finished',
    );
    expect(await storage.get(taskLedgerKey('op-old-run'))).toEqual(before);
    expect(redispatched).toHaveLength(0);
    const requeues = metricsCollector.snapshot()['weft.task.requeues'];
    expect(requeues?.type === 'counter' ? requeues.value : 0).toBe(0);

    const sameRun = await runRetry(engine, { operationId: 'op-same-run' });
    expect(sameRun.ok).toBe(true);
  });

  it('refuses with Conflict concurrent-change when every pass loses the compare-and-swap', async () => {
    class AlwaysLosesStorage extends MemoryStorage {
      attempts = 0;

      override async conditionalBatch(): Promise<boolean> {
        this.attempts += 1;
        return false;
      }
    }
    const storage = new AlwaysLosesStorage();
    await using engine = createEngine(storage);
    await putLedgerRecord(storage, deadLetteredFixture({ operationId: 'op-churn' }));
    const before = await storage.get(taskLedgerKey('op-churn'));
    const metricsCollector = new MetricsCollector();
    const redispatched: RemoteTaskQueued[] = [];

    const result = await runRetry(
      engine,
      { operationId: 'op-churn' },
      { metricsCollector, redispatchQueuedTask: (record) => redispatched.push(record) },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.fault.code).toBe('Conflict');
    expect(result.fault.code === 'Conflict' && result.fault.data.reason).toBe('concurrent-change');
    expect(storage.attempts).toBe(3);
    expect(await storage.get(taskLedgerKey('op-churn'))).toEqual(before);
    expect(redispatched).toHaveLength(0);
    expect(metricsCollector.snapshot()['weft.task.requeues']).toBeUndefined();
  });

  it('discovery-only construction still retries, with no dispatcher and no metrics', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    await putLedgerRecord(storage, deadLetteredFixture({ operationId: 'op-bare' }));

    const result = await runRetry(engine, { operationId: 'op-bare' });

    expect(result.ok).toBe(true);
    const record = await readRecord(storage, 'op-bare');
    expect(record?.state).toBe('queued');
  });
});

describe('POST /v1/tasks/detail/:operationId/dead-letter/retry', () => {
  async function post(
    engine: Engine,
    operationId: string,
    body?: BodyInit,
    scopes: ReadonlyArray<AuthorizationScope> = ['system:admin'],
  ) {
    return handleRequest(
      new Request(`http://localhost/v1/tasks/detail/${operationId}/dead-letter/retry`, {
        method: 'POST',
        ...(body === undefined ? {} : { body, headers: { 'content-type': 'application/json' } }),
      }),
      engine,
      {
        operationRegistry: createOperationRegistry([createRetryTaskDeadLetterOperation()]),
        restBindings: [retryTaskDeadLetterRestBinding],
        authContext: {
          method: 'api-key',
          principal: principalFromApiKey({ subject: 'operator', scopes }),
        },
      },
    );
  }

  it('retries with no body, answers the queued summary, and refuses a second call', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    await putLedgerRecord(storage, deadLetteredFixture({ operationId: 'op-rest', attempt: 1 }));

    const first = await post(engine, 'op-rest');
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      operationId: 'op-rest',
      state: 'queued',
      attempt: 2,
      requeueCount: 1,
    });

    const second = await post(engine, 'op-rest');
    expect(second.status).toBe(409);
  });

  it('reads attemptTokenDigest from the body and takes the operation id from the path', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    await putLedgerRecord(
      storage,
      deadLetteredFixture({ operationId: 'op-body', attemptToken: 'token-9' }),
    );
    await putLedgerRecord(storage, deadLetteredFixture({ operationId: 'op-other' }));

    const mismatch = await post(
      engine,
      'op-body',
      JSON.stringify({ attemptTokenDigest: 'not-the-digest', operationId: 'op-other' }),
    );
    expect(mismatch.status).toBe(409);

    const match = await post(
      engine,
      'op-body',
      JSON.stringify({
        attemptTokenDigest: digestAttemptToken('token-9'),
        operationId: 'op-other',
      }),
    );
    expect(match.status).toBe(200);
    // The body's operationId did not redirect the retry.
    const untouched = await readRecord(storage, 'op-other');
    expect(untouched?.state).toBe('deadLettered');
  });

  it('rejects an unknown body key and a body that is not an object, changing nothing', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    await putLedgerRecord(storage, deadLetteredFixture({ operationId: 'op-strict' }));

    const unknownKey = await post(engine, 'op-strict', JSON.stringify({ force: true }));
    expect(unknownKey.status).toBe(400);
    const notAnObject = await post(engine, 'op-strict', JSON.stringify(['x']));
    expect(notAnObject.status).toBe(400);
    const untouched = await readRecord(storage, 'op-strict');
    expect(untouched?.state).toBe('deadLettered');
  });

  it('answers 403 without system:admin and 404 for an unknown task', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    await putLedgerRecord(storage, deadLetteredFixture({ operationId: 'op-403' }));

    const forbidden = await post(engine, 'op-403', undefined, ['system:read']);
    expect(forbidden.status).toBe(403);
    const missing = await post(engine, 'op-missing');
    expect(missing.status).toBe(404);
  });
});

import { describe, expect, it } from 'bun:test';

import { encode } from '../../core/codec.ts';
import { encodeRemoteTaskRecord, taskLedgerKey } from '../../core/task-ledger/task-ledger.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import * as fixture from './get-task-detail.test-support.ts';

describe('weft.tasks.get', () => {
  it('faults NotFound for an operationId that was never dispatched', async () => {
    const storage = new MemoryStorage();
    const engine = fixture.createEngine(storage);

    const result = await fixture.runGetTaskDetail(engine, 'never-dispatched');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected NotFound fault');
    expect(result.fault.code).toBe('NotFound');
  });

  it('faults EngineFailure, not NotFound, when the ledger key exists but does not decode', async () => {
    const storage = new MemoryStorage();
    const engine = fixture.createEngine(storage);
    await storage.put(taskLedgerKey('corrupt-op'), encode({ invalid: true }));

    const result = await fixture.runGetTaskDetail(engine, 'corrupt-op');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected EngineFailure fault');
    expect(result.fault.code).toBe('EngineFailure');
  });

  it('faults EngineFailure when the decoded record has a different operationId than requested', async () => {
    // Simulates a storage-integrity problem: operation B's record living
    // under operation A's key (manual repair gone wrong, import, or
    // corruption). Must not silently hand back B's data for an A lookup.
    const storage = new MemoryStorage();
    const engine = fixture.createEngine(storage);
    await storage.put(
      taskLedgerKey('op-a'),
      encodeRemoteTaskRecord(fixture.queuedFixture({ operationId: 'op-b' })),
    );

    const result = await fixture.runGetTaskDetail(engine, 'op-a');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected EngineFailure fault');
    expect(result.fault.code).toBe('EngineFailure');
  });

  it('rejects an operationId larger than the ledger byte limit with InvalidParams, not a storage lookup', async () => {
    const storage = new MemoryStorage();
    const engine = fixture.createEngine(storage);
    const oversized = 'x'.repeat(600);

    const result = await fixture.runGetTaskDetail(engine, oversized);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected InvalidParams fault');
    expect(result.fault.code).toBe('InvalidParams');
  });

  it('projects only the declared retryPolicy and executionRequirement fields, tolerating additive properties the ledger itself does not reject', async () => {
    // isValidRetryPolicy/isValidExecutionRequirement only check known
    // fields; a same-process dispatch caller can attach extra properties
    // that the ledger happily stores. Returning that object through a
    // .strict() schema verbatim would EngineFailure an otherwise valid,
    // running task.
    const storage = new MemoryStorage();
    const engine = fixture.createEngine(storage);
    await fixture.putLedgerRecord(
      storage,
      fixture.queuedFixture({
        retryPolicy: {
          maxAttempts: 3,
          initialBackoff: '1s',
          backoffMultiplier: 2,
          maxBackoff: '30s',
          // @ts-expect-error deliberately additive field the ledger's own validator ignores
          unexpectedFutureField: 'should be stripped',
        },
        executionRequirement: {
          deploymentName: 'billing-service',
          // @ts-expect-error deliberately additive field the ledger's own validator ignores
          unexpectedFutureField: 'should also be stripped',
        },
      }),
    );

    const result = await fixture.runGetTaskDetail(engine, 'op-queued');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success, not EngineFailure from strict validation');
    expect(result.value).toMatchObject({
      retryPolicy: {
        maxAttempts: 3,
        initialBackoff: '1s',
        backoffMultiplier: 2,
        maxBackoff: '30s',
      },
      executionRequirement: { deploymentName: 'billing-service' },
    });
    expect(JSON.stringify(result.value)).not.toContain('unexpectedFutureField');
  });

  it('reports workflowExecutionToken when the task is workflow-bound', async () => {
    const storage = new MemoryStorage();
    const engine = fixture.createEngine(storage);
    await fixture.putLedgerRecord(
      storage,
      fixture.queuedFixture({ workflowExecutionToken: 'exec-token-abc' }),
    );

    const result = await fixture.runGetTaskDetail(engine, 'op-queued');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value).toMatchObject({ workflowExecutionToken: 'exec-token-abc' });
  });

  it('reports a queued task with envelope fields, header keys only, and no header values', async () => {
    const storage = new MemoryStorage();
    const engine = fixture.createEngine(storage);
    await fixture.putLedgerRecord(storage, fixture.queuedFixture());

    const result = await fixture.runGetTaskDetail(engine, 'op-queued');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value).toEqual({
      operationId: 'op-queued',
      workflowId: 'wf-1',
      workflowType: 'test',
      activityName: 'charge',
      queue: 'billing',
      priority: 7,
      headerKeys: ['x-trace-id', 'authorization'],
      visibilityTimeoutMilliseconds: 30_000,
      createdAt: 1_000,
      attempt: 1,
      state: 'queued',
      retryCount: 0,
      requeueCount: 0,
      availableAt: 1_000,
      firstQueuedAt: 1_000,
      lastQueuedAt: 1_000,
      // COR-205: every state's envelope includes attempt history — empty
      // here because this fixture's ledger record was hand-built directly
      // into storage, never claimed through the real claim path that would
      // have written a TaskAttemptRecord.
      attempts: [],
    });
    expect(JSON.stringify(result.value)).not.toContain('Bearer secret');
  });

  it('reports the retained retry and routing envelope when configured', async () => {
    const storage = new MemoryStorage();
    const engine = fixture.createEngine(storage);
    await fixture.putLedgerRecord(
      storage,
      fixture.queuedFixture({
        retryPolicy: {
          maxAttempts: 5,
          initialBackoff: '1s',
          backoffMultiplier: 2,
          maxBackoff: '30s',
        },
        scheduleToCloseDeadline: 999_999,
        executionRequirement: { deploymentName: 'billing-service', buildId: 'build-42' },
        fairShareKey: 'tenant-1',
        stickyWorkflowId: 'wf-1',
      }),
    );

    const result = await fixture.runGetTaskDetail(engine, 'op-queued');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value).toMatchObject({
      retryPolicy: {
        maxAttempts: 5,
        initialBackoff: '1s',
        backoffMultiplier: 2,
        maxBackoff: '30s',
      },
      scheduleToCloseDeadline: 999_999,
      executionRequirement: { deploymentName: 'billing-service', buildId: 'build-42' },
      fairShareKey: 'tenant-1',
      stickyWorkflowId: 'wf-1',
    });
  });

  it('omits the retry and routing envelope fields entirely when not configured', async () => {
    const storage = new MemoryStorage();
    const engine = fixture.createEngine(storage);
    await fixture.putLedgerRecord(storage, fixture.leasedFixture());

    const result = await fixture.runGetTaskDetail(engine, 'op-leased');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value).not.toHaveProperty('retryPolicy');
    expect(result.value).not.toHaveProperty('scheduleToCloseDeadline');
    expect(result.value).not.toHaveProperty('executionRequirement');
    expect(result.value).not.toHaveProperty('fairShareKey');
    expect(result.value).not.toHaveProperty('stickyWorkflowId');
  });

  it('reports a leased task without attemptToken, workerSessionId, or executionIdentity', async () => {
    const storage = new MemoryStorage();
    const engine = fixture.createEngine(storage);
    await fixture.putLedgerRecord(storage, fixture.leasedFixture());

    const result = await fixture.runGetTaskDetail(engine, 'op-leased');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value.state).toBe('leased');
    expect(result.value).not.toHaveProperty('attemptToken');
    expect(result.value).not.toHaveProperty('workerSessionId');
    expect(result.value).not.toHaveProperty('executionIdentity');
    if (result.value.state === 'leased') {
      expect(result.value.leaseDeadline).toBe(60_000);
      expect(result.value.lastHeartbeatAt).toBe(2_500);
      // No attemptDeadline recorded on this fixture — a clock, not identity,
      // so its absence is projected as absence, not defaulted to a value.
      expect(result.value).not.toHaveProperty('attemptDeadline');
    }
  });

  it("reports a leased task's attemptDeadline when the record carries one (COR-220)", async () => {
    const storage = new MemoryStorage();
    const engine = fixture.createEngine(storage);
    await fixture.putLedgerRecord(storage, fixture.leasedFixture({ attemptDeadline: 180_000 }));

    const result = await fixture.runGetTaskDetail(engine, 'op-leased');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    if (result.value.state !== 'leased') throw new Error('expected leased state');
    expect(result.value.attemptDeadline).toBe(180_000);
  });
});

import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import { principalFromJwtClaims } from '../principal.ts';
import { createLiveOperationRegistry, REST_BINDINGS } from '../rest-bindings.ts';
import * as fixture from './get-task-detail.test-support.ts';
import {
  getTaskDetailOperation,
  getTaskDetailOutputSchema,
  getTaskDetailRestBinding,
} from './get-task-detail.ts';
import { systemReadAuthContext } from './operation-registry-test-helpers.test-support.ts';

describe('weft.tasks.get — projection', () => {
  it('reports a completing task with pendingStatus and resultDigest, not the raw result value', async () => {
    const storage = new MemoryStorage();
    const engine = fixture.createEngine(storage);
    await fixture.putLedgerRecord(storage, fixture.completingFixture());

    const result = await fixture.runGetTaskDetail(engine, 'op-completing');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    if (result.value.state !== 'completing') throw new Error('expected completing state');
    expect(result.value.pendingStatus).toBe('completed');
    expect(result.value.resultDigest).toBe('digest-abc');
  });

  it('reports a cancelling task with cancellation reason and requested-at timestamp', async () => {
    const storage = new MemoryStorage();
    const engine = fixture.createEngine(storage);
    await fixture.putLedgerRecord(storage, fixture.cancellingFixture());

    const result = await fixture.runGetTaskDetail(engine, 'op-cancelling');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    if (result.value.state !== 'cancelling') throw new Error('expected cancelling state');
    expect(result.value.cancellationReason).toBe('operator requested');
    expect(result.value.cancellationRequestedAt).toBe(3_000);
  });

  it('reports a resolved terminal task with disposition, resultDigest, adoption, and resultStatus', async () => {
    const storage = new MemoryStorage();
    const engine = fixture.createEngine(storage);
    await fixture.putLedgerRecord(
      storage,
      fixture.terminalResolvedFixture({ adopted: true, adoptedAt: 4_500 }),
    );

    const result = await fixture.runGetTaskDetail(engine, 'op-terminal');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    if (result.value.state !== 'terminal') throw new Error('expected terminal state');
    if (result.value.disposition !== 'resolved') throw new Error('expected resolved disposition');
    expect(result.value.resultDigest).toBe('digest-abc');
    expect(result.value.adopted).toBe(true);
    expect(result.value.adoptedAt).toBe(4_500);
    expect(result.value.resultStatus).toBe('completed');
    expect(result.value).not.toHaveProperty('cancellationReason');
  });

  it('reports a cancelled terminal task with cancellationReason, not resultStatus, and never leaks the synthetic resultDigest that embeds attemptToken', async () => {
    const storage = new MemoryStorage();
    const engine = fixture.createEngine(storage);
    // task-ledger-transitions-cancellation.ts builds a leased-origin
    // cancellation's resultDigest as `cancelled:${operationId}:${attemptToken}`
    // — this fixture mirrors that exact shape to prove the token doesn't leak.
    await fixture.putLedgerRecord(
      storage,
      fixture.terminalCancelledFixture({
        resultDigest: 'cancelled:op-terminal-cancelled:super-secret-attempt-token',
      }),
    );

    const result = await fixture.runGetTaskDetail(engine, 'op-terminal-cancelled');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    if (result.value.state !== 'terminal') throw new Error('expected terminal state');
    if (result.value.disposition !== 'cancelled') throw new Error('expected cancelled disposition');
    expect(result.value.cancellationReason).toBe('operator requested');
    expect(result.value).not.toHaveProperty('resultStatus');
    expect(result.value).not.toHaveProperty('resultDigest');
    expect(JSON.stringify(result.value)).not.toContain('super-secret-attempt-token');
  });

  it('reports a retry-exhausted terminal task with its error, no retryCount/requeueCount, and never leaks the synthetic resultDigest that embeds attemptToken', async () => {
    const storage = new MemoryStorage();
    const engine = fixture.createEngine(storage);
    // task-ledger-transitions.ts builds a retry-exhausted resultDigest as
    // `retry-exhausted:${operationId}:${attemptToken}` — same proof as above.
    await fixture.putLedgerRecord(
      storage,
      fixture.terminalRetryExhaustedFixture({
        resultDigest: 'retry-exhausted:op-terminal-exhausted:super-secret-attempt-token',
      }),
    );

    const result = await fixture.runGetTaskDetail(engine, 'op-terminal-exhausted');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    if (result.value.state !== 'terminal') throw new Error('expected terminal state');
    if (result.value.disposition !== 'retryExhausted')
      throw new Error('expected retryExhausted disposition');
    expect(result.value.error).toBe('boom');
    expect(result.value).not.toHaveProperty('retryCount');
    expect(result.value).not.toHaveProperty('requeueCount');
    expect(result.value).not.toHaveProperty('resultDigest');
    expect(JSON.stringify(result.value)).not.toContain('super-secret-attempt-token');
  });

  it('reports a dead-lettered task with pendingStatus, resultDigest, and reason, never the raw pending value', async () => {
    const storage = new MemoryStorage();
    const engine = fixture.createEngine(storage);
    await fixture.putLedgerRecord(storage, fixture.deadLetteredFixture());

    const result = await fixture.runGetTaskDetail(engine, 'op-dead');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    if (result.value.state !== 'deadLettered') throw new Error('expected deadLettered state');
    expect(result.value.pendingStatus).toBe('completed');
    expect(result.value.resultDigest).toBe('digest-pending');
    expect(result.value.persistenceFailureReason).toBe('storage exhausted');
    expect(JSON.stringify(result.value)).not.toContain('do not leak');
  });

  it('requires system:read scope', async () => {
    const storage = new MemoryStorage();
    const engine = fixture.createEngine(storage);
    await fixture.putLedgerRecord(storage, fixture.queuedFixture());

    const result = await executeOperation(
      'weft.tasks.get',
      { operationId: 'op-queued' },
      {
        principal: principalFromJwtClaims({ sub: 'user', scope: 'workflows:read' }),
        engine,
        transport: 'jsonRpcStdio',
        registry: createOperationRegistry([getTaskDetailOperation]),
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected authorization failure');
    expect(result.fault.code).toBe('Forbidden');
  });

  it('resolves GET /v1/tasks/detail/:operationId through the real REST router', async () => {
    const storage = new MemoryStorage();
    const engine = fixture.createEngine(storage);
    await fixture.putLedgerRecord(storage, fixture.queuedFixture());

    const response = await handleRequest(
      new Request('http://localhost/v1/tasks/detail/op-queued', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([getTaskDetailOperation]),
        restBindings: [getTaskDetailRestBinding],
        ...systemReadAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    const body = getTaskDetailOutputSchema.parse(await response.json());
    expect(body.state).toBe('queued');
    expect(body.operationId).toBe('op-queued');
  });

  it('returns 404 through the real REST router for an unknown operationId', async () => {
    const storage = new MemoryStorage();
    const engine = fixture.createEngine(storage);

    const response = await handleRequest(
      new Request('http://localhost/v1/tasks/detail/never-dispatched', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([getTaskDetailOperation]),
        restBindings: [getTaskDetailRestBinding],
        ...systemReadAuthContext(),
      },
    );

    expect(response.status).toBe(404);
  });

  it('a task whose operationId equals an existing literal /v1/tasks/... sibling ("diagnostics") is reachable through the detail namespace', async () => {
    // Regression guard for the exact case a bare GET /v1/tasks/:operationId
    // would have broken: an operationId equal to a sibling literal path
    // segment. /detail/ structurally cannot collide (different segment
    // count from every other /v1/tasks/... binding), so this must resolve
    // to the task, not to weft.tasks.diagnostics.
    const storage = new MemoryStorage();
    const engine = fixture.createEngine(storage);
    await fixture.putLedgerRecord(storage, fixture.queuedFixture({ operationId: 'diagnostics' }));

    const response = await handleRequest(
      new Request('http://localhost/v1/tasks/detail/diagnostics', { method: 'GET' }),
      engine,
      {
        operationRegistry: createLiveOperationRegistry(),
        restBindings: REST_BINDINGS,
        ...systemReadAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    const body = getTaskDetailOutputSchema.parse(await response.json());
    expect(body.operationId).toBe('diagnostics');
    expect(body.state).toBe('queued');
  });

  it('GET /v1/tasks/diagnostics still resolves to weft.tasks.diagnostics through the full static registry', async () => {
    const storage = new MemoryStorage();
    const engine = fixture.createEngine(storage);

    const response = await handleRequest(
      new Request('http://localhost/v1/tasks/diagnostics', { method: 'GET' }),
      engine,
      {
        operationRegistry: createLiveOperationRegistry(),
        restBindings: REST_BINDINGS,
        ...systemReadAuthContext(),
      },
    );

    expect(response.status).toBe(200);
    const body = recordBody(await response.json());
    expect(body).toHaveProperty('items');
    expect(body).toHaveProperty('summary');
  });
});

function recordBody(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected object response body');
  }
  return Object.fromEntries(Object.entries(value));
}

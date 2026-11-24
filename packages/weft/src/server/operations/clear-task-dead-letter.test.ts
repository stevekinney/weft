import { describe, expect, it } from 'bun:test';

import { type AuthorizationScope, principalFromApiKey } from "../../embedded/backchannel/src/index.ts";
import { createOperationRegistry, executeOperation } from "../../embedded/backchannel/src/internals.ts";
import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { Engine } from '../../core/engine.ts';
import { taskLedgerKey } from '../../core/task-ledger/task-ledger.ts';
import { clearTaskDeadLetterOperation } from './clear-task-dead-letter.ts';
import {
  createEngine,
  deadLetteredFixture,
  putLedgerRecord,
  queuedFixture,
} from './get-task-diagnostics.test-support.ts';

function runClear(engine: Engine, operationId: string, scopes: ReadonlyArray<AuthorizationScope>) {
  const operationRegistry = createOperationRegistry([clearTaskDeadLetterOperation]);
  return executeOperation(
    'weft.tasks.diagnostics.deadletters.clear',
    { operationId },
    {
      principal: principalFromApiKey({ subject: 'operator', scopes }),
      host: engine,
      transport: 'http-rest',
      registry: operationRegistry,
    },
  );
}

describe('weft.tasks.diagnostics.deadletters.clear', () => {
  it('deletes a dead-lettered ledger record, freeing the operationId', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    await putLedgerRecord(storage, deadLetteredFixture({ operationId: 'op-to-clear' }));

    const result = await runClear(engine, 'op-to-clear', ['system:admin']);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected clear to succeed');
    expect(result.value).toEqual({ ok: true });
    expect(await storage.get(taskLedgerKey('op-to-clear'))).toBeNull();
  });

  it('faults NotFound when no dead-lettered record exists for the operationId', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);

    const result = await runClear(engine, 'never-dispatched', ['system:admin']);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected NotFound fault');
    expect(result.fault.code).toBe('NotFound');
  });

  it('faults NotFound rather than clearing a record that is not currently dead-lettered', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    await putLedgerRecord(storage, queuedFixture({ operationId: 'still-queued' }));

    const result = await runClear(engine, 'still-queued', ['system:admin']);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected NotFound fault');
    expect(result.fault.code).toBe('NotFound');
    expect(await storage.get(taskLedgerKey('still-queued'))).not.toBeNull();
  });

  it('requires system admin scope', async () => {
    const storage = new MemoryStorage();
    await using engine = createEngine(storage);
    await putLedgerRecord(storage, deadLetteredFixture({ operationId: 'op-scoped' }));

    const result = await runClear(engine, 'op-scoped', ['system:read']);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected authorization failure');
    expect(result.fault.code).toBe('Forbidden');
  });
});

/**
 * Unit tests for `commitTaskLedgerDelete` (WFT-24) — the conditional-delete
 * counterpart to `commitTaskLedgerTransition`. `commitTaskLedgerTransition`
 * itself has no dedicated unit file; it is exercised indirectly through
 * `server/index.test.ts` and the runtime characterization suites. This file
 * targets `commitTaskLedgerDelete`'s own retry/CAS-loss behavior, which
 * those indirect call sites (retention reaping, dead-letter clearing) only
 * ever exercise with `maxAttempts: 1`.
 */

import { describe, expect, it } from 'bun:test';

import type { BatchOperation, ConditionalBatchCondition } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { canDeleteRetainedTerminalTask } from '../task-ledger-transitions.ts';
import {
  decodeRemoteTaskRecord,
  encodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskTerminalResolved,
} from '../task-ledger.ts';
import { commitTaskLedgerDelete } from './task-ledger-runtime.ts';

function terminalFixture(
  overrides: Partial<RemoteTaskTerminalResolved> = {},
): RemoteTaskTerminalResolved {
  return {
    recordVersion: 1,
    operationId: 'op-1',
    workflowType: 'test',
    activityName: 'charge',
    queue: 'default',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: 0,
    generation: 3,
    state: 'terminal',
    disposition: 'resolved',
    attempt: 1,
    attemptToken: 'attempt-1',
    status: 'completed',
    resultDigest: 'digest-1',
    terminalAt: 4_000,
    adopted: true,
    retentionGeneration: 0,
    ...overrides,
  };
}

/** Loses the first `losses` conditionalBatch calls, then delegates normally. */
class LosesCasNTimesStorage extends MemoryStorage {
  #remainingLosses: number;

  constructor(losses: number) {
    super();
    this.#remainingLosses = losses;
  }

  override async conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    if (this.#remainingLosses > 0) {
      this.#remainingLosses -= 1;
      return false;
    }
    return super.conditionalBatch(conditions, operations);
  }
}

describe('commitTaskLedgerDelete', () => {
  it('deletes the record when the precondition passes', async () => {
    const storage = new MemoryStorage();
    const record = terminalFixture();
    await storage.put(taskLedgerKey(record.operationId), encodeRemoteTaskRecord(record));

    const result = await commitTaskLedgerDelete(
      storage,
      record.operationId,
      (current) => canDeleteRetainedTerminalTask(current, { expectedRetentionGeneration: 0 }),
      1,
    );

    expect(result.ok).toBe(true);
    expect(await storage.get(taskLedgerKey(record.operationId))).toBeNull();
  });

  it('returns the precondition rejection without touching storage', async () => {
    const storage = new MemoryStorage();
    const record = terminalFixture({ adopted: false });
    await storage.put(taskLedgerKey(record.operationId), encodeRemoteTaskRecord(record));

    const result = await commitTaskLedgerDelete(
      storage,
      record.operationId,
      (current) => canDeleteRetainedTerminalTask(current, { expectedRetentionGeneration: 0 }),
      1,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('terminal task is not yet adopted');
    const stillThere = decodeRemoteTaskRecord(await storage.get(taskLedgerKey(record.operationId)));
    expect(stillThere).not.toBeNull();
  });

  it('retries a lost CAS and eventually deletes', async () => {
    const storage = new LosesCasNTimesStorage(2);
    const record = terminalFixture();
    await storage.put(taskLedgerKey(record.operationId), encodeRemoteTaskRecord(record));

    const result = await commitTaskLedgerDelete(
      storage,
      record.operationId,
      (current) => canDeleteRetainedTerminalTask(current, { expectedRetentionGeneration: 0 }),
      3,
    );

    expect(result.ok).toBe(true);
    expect(await storage.get(taskLedgerKey(record.operationId))).toBeNull();
  });

  it('exhausts retries and reports a lost-CAS reason', async () => {
    const storage = new LosesCasNTimesStorage(5);
    const record = terminalFixture();
    await storage.put(taskLedgerKey(record.operationId), encodeRemoteTaskRecord(record));

    const result = await commitTaskLedgerDelete(
      storage,
      record.operationId,
      (current) => canDeleteRetainedTerminalTask(current, { expectedRetentionGeneration: 0 }),
      2,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('lost the compare-and-swap race deleting operation');
    const stillThere = decodeRemoteTaskRecord(await storage.get(taskLedgerKey(record.operationId)));
    expect(stillThere).not.toBeNull();
  });

  it('rejects when no record exists for the operationId', async () => {
    const storage = new MemoryStorage();

    const result = await commitTaskLedgerDelete(
      storage,
      'never-dispatched',
      (current) => canDeleteRetainedTerminalTask(current, { expectedRetentionGeneration: 0 }),
      1,
    );

    expect(result.ok).toBe(false);
  });
});

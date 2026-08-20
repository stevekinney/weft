/**
 * Unit tests for commitTaskLedgerCompletion's crash-resumption branch: a
 * submitter retrying the identical result against an already-`completing`
 * record (same attemptToken, same pendingResultDigest) must skip straight to
 * `commitTerminalResult` instead of rejecting the legitimate resubmission.
 */

import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { sha256Hex } from '../../worker/manifest/content-digest.ts';
import {
  decodeRemoteTaskRecord,
  encodeRemoteTaskRecord,
  taskLedgerKey,
  type RemoteTaskCompleting,
} from '../task-ledger.ts';
import { FailingTerminalCommitStorage } from './server-context.test-support.ts';
import { commitTaskLedgerCompletion } from './task-ledger-completion.ts';

function completingFixture(overrides: Partial<RemoteTaskCompleting> = {}): RemoteTaskCompleting {
  const now = Date.now();
  return {
    recordVersion: 1,
    operationId: 'op-1',
    workflowType: 'test',
    activityName: 'test.charge',
    queue: 'default',
    input: null,
    headers: {},
    visibilityTimeoutMilliseconds: 30_000,
    createdAt: now,
    generation: 2,
    state: 'completing',
    attemptToken: 'attempt-token',
    workerSessionId: 'worker-1',
    attempt: 1,
    leaseDeadline: now + 30_000,
    firstQueuedAt: now,
    lastQueuedAt: now,
    startedAt: now,
    lastHeartbeatAt: now,
    retryCount: 0,
    requeueCount: 0,
    pendingStatus: 'completed',
    pendingResultDigest: 'placeholder',
    ...overrides,
  };
}

describe('commitTaskLedgerCompletion', () => {
  it('resumes a crash window by skipping straight to the terminal commit when the digest and token match', async () => {
    const storage = new MemoryStorage();
    const resultDigest = await sha256Hex(
      JSON.stringify({ status: 'completed', value: { ok: true }, error: null }),
    );
    const completing = completingFixture({ pendingResultDigest: resultDigest });
    await storage.put(taskLedgerKey(completing.operationId), encodeRemoteTaskRecord(completing));

    const result = await commitTaskLedgerCompletion(storage, {
      operationId: completing.operationId,
      attemptToken: completing.attemptToken,
      status: 'completed',
      value: { ok: true },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected commitTaskLedgerCompletion to resume successfully');
    expect(result.completing).toEqual(completing);
    expect(result.terminal.state).toBe('terminal');
    expect(result.terminal.resultDigest).toBe(resultDigest);

    const persisted = decodeRemoteTaskRecord(
      await storage.get(taskLedgerKey(completing.operationId)),
    );
    expect(persisted?.state).toBe('terminal');
  });

  it('rejects a resubmission against a completing record whose digest differs', async () => {
    const storage = new MemoryStorage();
    const completing = completingFixture({
      pendingResultDigest: await sha256Hex(
        JSON.stringify({ status: 'completed', value: 'original', error: null }),
      ),
    });
    await storage.put(taskLedgerKey(completing.operationId), encodeRemoteTaskRecord(completing));

    const result = await commitTaskLedgerCompletion(storage, {
      operationId: completing.operationId,
      attemptToken: completing.attemptToken,
      status: 'completed',
      value: 'a genuinely different result',
    });

    expect(result.ok).toBe(false);
  });

  it('dead-letters a resumed crash-window completion whose terminal commit keeps losing the CAS', async () => {
    const storage = new FailingTerminalCommitStorage('op-1');
    const resultDigest = await sha256Hex(
      JSON.stringify({ status: 'completed', value: { ok: true }, error: null }),
    );
    const completing = completingFixture({ pendingResultDigest: resultDigest });
    await storage.put(taskLedgerKey(completing.operationId), encodeRemoteTaskRecord(completing));

    const result = await commitTaskLedgerCompletion(storage, {
      operationId: completing.operationId,
      attemptToken: completing.attemptToken,
      status: 'completed',
      value: { ok: true },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected commitTaskLedgerCompletion to fail');
    expect(result.deadLettered?.state).toBe('deadLettered');
    expect(result.deadLettered?.operationId).toBe(completing.operationId);
    expect(result.deadLettered?.persistenceFailureReason).toBe(result.reason);

    const persisted = decodeRemoteTaskRecord(
      await storage.get(taskLedgerKey(completing.operationId)),
    );
    expect(persisted?.state).toBe('deadLettered');
  });
});

/**
 * COR-219 residual: `EngineOwnedRemoteActivityBroker.enqueue` must not treat
 * a malformed existing ledger record the same as an absent one.
 *
 * `decodeRemoteTaskRecord` returns `null` both when no bytes exist at a key
 * and when bytes exist but fail schema validation (see its own doc comment
 * and `task-ledger.test.ts`'s `decodeRemoteTaskRecord(encode({ state:
 * 'queued' }))` case). `enqueue`'s idempotent-replay guard used to read
 * straight through that collapsed `null`, so a malformed record at a
 * replayed operationId was silently overwritten by a fresh `queued` write —
 * `commitTaskLedgerTransition` treats `current === null` as "safe to
 * create," and the CAS's `expectedValue` is the exact (malformed) bytes just
 * read, so the overwrite genuinely succeeds. This file locks in the fix:
 * bytes present but undecodable must surface a typed, diagnosed error and
 * leave the corrupt bytes untouched.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { encode } from '../codec.ts';
import { PersistedDataCorruptError } from '../persisted-data-incompatible-error.ts';
import type { RemoteActivityTaskRequest } from '../remote-activity-broker.ts';
import { taskLedgerKey } from '../task-ledger/task-ledger.ts';
import { EngineOwnedRemoteActivityBroker } from './remote-activity-broker.ts';

function fixtureRequest(
  overrides: Partial<RemoteActivityTaskRequest> = {},
): RemoteActivityTaskRequest {
  return {
    operationId: 'op-malformed-1',
    workflowId: 'wf-1',
    workflowType: 'test-workflow',
    activityName: 'chargeCard',
    input: { orderId: 'ord-1' },
    headers: {},
    ...overrides,
  };
}

describe('EngineOwnedRemoteActivityBroker malformed-record handling (COR-219)', () => {
  it('throws PersistedDataCorruptError instead of silently overwriting a malformed existing ledger record', async () => {
    const storage = new MemoryStorage();
    const key = taskLedgerKey('op-malformed-1');
    // Valid MessagePack, invalid `RemoteTaskRecord` shape — exactly the
    // `decodeRemoteTaskRecord` case that collapses to `null` (see
    // `task-ledger.test.ts`), distinct from the key being entirely absent.
    const malformedBytes = encode({ state: 'queued' });
    await storage.batch([{ type: 'put', key, value: malformedBytes }]);

    let enqueuedCount = 0;
    const broker = new EngineOwnedRemoteActivityBroker(storage, {}, () => {
      enqueuedCount += 1;
    });

    await expect(broker.enqueue(fixtureRequest())).rejects.toBeInstanceOf(
      PersistedDataCorruptError,
    );
    await expect(broker.enqueue(fixtureRequest())).rejects.toThrow(/op-malformed-1|corrupt/i);

    // The malformed bytes must survive untouched — no overwrite, no fresh
    // `queued` record silently created in their place.
    const stillThere = await storage.get(key);
    expect(stillThere).not.toBeNull();
    expect(stillThere).toEqual(malformedBytes);

    // Never a "fresh enqueue" hint for a call that refused to enqueue.
    expect(enqueuedCount).toBe(0);
  });

  it('still enqueues normally when the key is genuinely absent (control case)', async () => {
    const storage = new MemoryStorage();
    let enqueuedCount = 0;
    const broker = new EngineOwnedRemoteActivityBroker(storage, {}, () => {
      enqueuedCount += 1;
    });

    await broker.enqueue(fixtureRequest({ operationId: 'op-fresh-1' }));

    const bytes = await storage.get(taskLedgerKey('op-fresh-1'));
    expect(bytes).not.toBeNull();
    expect(enqueuedCount).toBe(1);
  });

  it('treats an existing well-formed record as an idempotent replay, not an error (control case)', async () => {
    const storage = new MemoryStorage();
    let enqueuedCount = 0;
    const broker = new EngineOwnedRemoteActivityBroker(storage, {}, () => {
      enqueuedCount += 1;
    });

    await broker.enqueue(fixtureRequest({ operationId: 'op-replay-1' }));
    expect(enqueuedCount).toBe(1);

    // A second `enqueue` for the same operationId (a workflow replay
    // deriving the same deterministic token) must be a silent no-op, not an
    // error and not a second enqueue hint.
    await broker.enqueue(fixtureRequest({ operationId: 'op-replay-1' }));
    expect(enqueuedCount).toBe(1);
  });
});

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

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { rejectionOf, throwingRejectionOf } from '../../testing/promise-outcome.test-support.ts';
import { encode } from '../codec.ts';
import { PersistedDataCorruptError } from '../persisted-data-incompatible-error.ts';
import type { RemoteActivityTaskRequest } from '../remote-activity-broker.ts';
import { decodeRemoteTaskRecord, taskLedgerKey } from '../task-ledger/task-ledger.ts';
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

    expect(await rejectionOf(broker.enqueue(fixtureRequest()))).toBeInstanceOf(
      PersistedDataCorruptError,
    );
    expect(await throwingRejectionOf(broker.enqueue(fixtureRequest()))).toThrow(
      /op-malformed-1|corrupt/i,
    );

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

  it('copies the persisted workflow worker binding into the queued task envelope', async () => {
    const storage = new MemoryStorage();
    await storage.put(
      KEYS.workflow('wf-bound'),
      encode({
        id: 'wf-bound',
        type: 'checkout',
        status: 'running',
        input: null,
        versionTuple: { workflowVersion: '1' },
        revision: 'revision-1',
        createdAt: 1,
        updatedAt: 1,
        workerBinding: {
          current: {
            workflowId: 'wf-bound',
            workflowType: 'checkout',
            deploymentName: 'billing',
            buildId: 'build-1',
            artifactDigest: 'sha256:artifact',
            manifestDigest: 'sha256:manifest',
            routingGeneration: 7,
            workflowRevision: 'revision-1',
            workflowContractHash: 'sha256:workflow',
            activityContracts: {
              charge: 'sha256:charge',
              refund: 'sha256:refund',
            },
            activityName: 'charge',
            activityContractHash: 'sha256:charge',
            boundAt: 2,
            checkpointId: 'checkpoint-1',
          },
          history: [],
        },
      }),
    );
    const broker = new EngineOwnedRemoteActivityBroker(storage, {}, () => {});

    await broker.enqueue(
      fixtureRequest({
        operationId: 'op-bound-refund',
        workflowId: 'wf-bound',
        workflowType: 'checkout',
        activityName: 'refund',
      }),
    );

    const record = decodeRemoteTaskRecord(await storage.get(taskLedgerKey('op-bound-refund')));
    expect(record?.state).toBe('queued');
    expect(record?.workflowWorkerBinding?.routingGeneration).toBe(7);
    expect(record?.executionRequirement).toEqual({
      deploymentName: 'billing',
      buildId: 'build-1',
      artifactDigest: 'sha256:artifact',
      workflowRevision: 'revision-1',
      activityContractHash: 'sha256:refund',
    });
  });
});

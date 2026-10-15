import { describe, expect, it, spyOn } from 'bun:test';

import { encode } from '../../core/codec.ts';
import { TaskResultDeliveryEvent } from '../../core/events.ts';
import { taskLedgerKey } from '../../core/task-ledger/task-ledger.ts';
import {
  decodeTaskResultDeliveryHistory,
  taskResultDeliveryKey,
} from '../../core/task-ledger/task-result-delivery.ts';
import type { BatchOperation, ConditionalBatchCondition } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import type { ServeOptions } from '../index.ts';
import { leasedFixture, putLedgerRecord } from '../operations/get-task-detail.test-support.ts';
import { principalFromApiKey } from '../principal.ts';
import { minimalServerContext } from './server-context.test-support.ts';
import { recordTaskResultDelivery } from './task-result-delivery-recorder.ts';
import { handleTaskResultRequest } from './task-result-submission.ts';

function optionsFor(storage: MemoryStorage, events: Event[] = []): ServeOptions {
  return {
    engine: {
      storage,
      dispatchEvent: (event: Event) => {
        events.push(event);
        return true;
      },
    },
    port: 0,
  } as unknown as ServeOptions;
}

const submission = {
  operationId: 'op-leased',
  attemptToken: 'attempt-token',
  transport: 'webSocket',
  workerId: 'worker-session-1',
  submittedStatus: 'completed',
} as const;

async function readHistory(storage: MemoryStorage, operationId = 'op-leased') {
  return decodeTaskResultDeliveryHistory(await storage.get(taskResultDeliveryKey(operationId)));
}

class LosingCasStorage extends MemoryStorage {
  attempts = 0;
  override async conditionalBatch(
    _conditions: readonly ConditionalBatchCondition[],
    _operations: readonly BatchOperation[],
  ): Promise<boolean> {
    this.attempts++;
    return false;
  }
}

class ThrowingStorage extends MemoryStorage {
  override async get(_key: string): Promise<Uint8Array | null> {
    throw new Error('storage offline');
  }
}

describe('recordTaskResultDelivery', () => {
  it('never records an unknown-operation rejection, even when a record exists', async () => {
    const storage = new MemoryStorage();
    await putLedgerRecord(storage, leasedFixture());
    await recordTaskResultDelivery(optionsFor(storage), submission, {
      outcome: 'rejected',
      rejectionCode: 'unknown-operation',
      reason: 'unknown',
    });
    expect(await readHistory(storage)).toBeNull();
  });

  it('records an oversized-payload acknowledgement and announces only non-applied outcomes', async () => {
    const storage = new MemoryStorage();
    const events: Event[] = [];
    await putLedgerRecord(storage, leasedFixture());
    await recordTaskResultDelivery(optionsFor(storage, events), submission, {
      outcome: 'acknowledged',
      disposition: 'applied',
      oversizedPayload: true,
    });
    await recordTaskResultDelivery(optionsFor(storage, events), submission, {
      outcome: 'acknowledged',
      disposition: 'dead-lettered',
    });
    const history = await readHistory(storage);
    expect(
      history?.entries.map((entry) => entry.outcome === 'acknowledged' && entry.disposition),
    ).toEqual(['applied', 'dead-lettered']);
    expect(history?.entries[0]).toMatchObject({ oversizedPayload: true });
    expect(history?.entries[1]).not.toHaveProperty('oversizedPayload');
    expect(events).toHaveLength(1);
    const [event] = events;
    if (!(event instanceof TaskResultDeliveryEvent)) throw new Error('Expected a delivery event');
    expect(event.disposition).toBe('dead-lettered');
    expect(event.rejectionCode).toBeUndefined();
    expect(event.queue).toBe('default');
  });

  it('records history but dispatches no event when the ledger bytes do not decode', async () => {
    const storage = new MemoryStorage();
    const events: Event[] = [];
    await storage.put(taskLedgerKey('op-leased'), encode({ invalid: true }));
    await recordTaskResultDelivery(optionsFor(storage, events), submission, {
      outcome: 'acknowledged',
      disposition: 'duplicate',
    });
    const history = await readHistory(storage);
    expect(history?.entries).toHaveLength(1);
    expect(events).toHaveLength(0);
  });

  it('omits a workerId that is not a bounded identifier', async () => {
    const storage = new MemoryStorage();
    await putLedgerRecord(storage, leasedFixture());
    await recordTaskResultDelivery(
      optionsFor(storage),
      { ...submission, workerId: 'w'.repeat(10_000) },
      { outcome: 'acknowledged', disposition: 'applied' },
    );
    const history = await readHistory(storage);
    expect(history?.entries[0]).not.toHaveProperty('workerId');
  });

  it('leaves rejection text alone when the submitted token is empty', async () => {
    const storage = new MemoryStorage();
    await putLedgerRecord(storage, leasedFixture());
    await recordTaskResultDelivery(
      optionsFor(storage),
      { ...submission, attemptToken: '' },
      { outcome: 'rejected', rejectionCode: 'stale-attempt', reason: 'stale attempt' },
    );
    const history = await readHistory(storage);
    expect(history?.entries[0]).toMatchObject({ reason: 'stale attempt' });
  });

  it('logs and gives up after repeatedly losing the compare-and-swap', async () => {
    const storage = new LosingCasStorage();
    await putLedgerRecord(storage, leasedFixture());
    using consoleError = spyOn(console, 'error').mockImplementation(() => {});
    await recordTaskResultDelivery(optionsFor(storage), submission, {
      outcome: 'acknowledged',
      disposition: 'applied',
    });
    expect(storage.attempts).toBe(3);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it('never throws past the caller when storage fails', async () => {
    using consoleError = spyOn(console, 'error').mockImplementation(() => {});
    await recordTaskResultDelivery(optionsFor(new ThrowingStorage()), submission, {
      outcome: 'acknowledged',
      disposition: 'applied',
    });
    expect(consoleError).toHaveBeenCalledTimes(1);
  });
});

describe('long-poll oversized results', () => {
  it('record the synthesized failure as an oversized acknowledgement', async () => {
    const storage = new MemoryStorage();
    await putLedgerRecord(storage, leasedFixture());
    const context = minimalServerContext({ registry: null as never });
    (context as { payloadSizeMaxBytes: number | null }).payloadSizeMaxBytes = 16;
    const url = 'http://localhost/v1/tasks/default/result';
    const response = await handleTaskResultRequest(
      context,
      optionsFor(storage),
      new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operationId: 'op-leased',
          workerId: 'worker-session-1',
          attemptToken: 'attempt-token',
          status: 'completed',
          value: 'x'.repeat(64),
        }),
      }),
      new URL(url),
      principalFromApiKey({ subject: 'worker', scopes: ['workers:write'] }),
    );
    expect(response?.status).toBe(413);
    const history = await readHistory(storage);
    expect(history?.entries).toEqual([
      expect.objectContaining({
        transport: 'longPoll',
        outcome: 'acknowledged',
        disposition: 'applied',
        oversizedPayload: true,
        submittedStatus: 'completed',
      }),
    ]);
  });
});
